'use strict';
/**
 * OmniSMS — Service OTP (One-Time Password) — vérification du numéro à l'inscription.
 *
 * Réutilise le parcours historique (routes/otp.js : send-otp / verify-otp) en corrigeant
 * les failles d'audit :
 *   - le code n'est JAMAIS stocké en clair (HMAC-SHA256) ni journalisé ;
 *   - comparaison en temps constant (timingSafeEqual) ;
 *   - consommation transactionnelle quand disponible (anti courses / brute force parallèle) ;
 *   - limites par numéro/heure et par IP/heure (rateStore Redis/mémoire) + cooldown de renvoi ;
 *   - transporteur abstrait : OTP_PROVIDER = auto (Infobip si configuré) | infobip | gateway
 *     (INfiniReach — déconseillé pour l'OTP : dépend du téléphone passerelle, exige
 *     OTP_ALLOW_GATEWAY_TRANSPORT=true) | none (aucun envoi, réponse d'erreur contrôlée —
 *     jamais de faux succès, jamais de simulation) ;
 *   - injection de transporteur pour les TESTS UNIQUEMENT (_setTransportForTests —
 *     refusée si NODE_ENV=production) : aucun code fixe accepté en production.
 *
 * Sécurité :
 *   - durée configurable OTP_CODE_TTL_MINUTES (défaut 5) ;
 *   - max essais OTP_MAX_VERIFY_ATTEMPTS (défaut 5) puis invalidation ;
 *   - invalidation de tout code précédent à chaque nouvelle demande (délai minimal de renvoi) ;
 *   - réponses neutres (pas d'énumération de comptes) ;
 *   - journalisation SANS code, jeton ni secret.
 */

const crypto = require('crypto');
const { logger } = require('../middleware/logger');

/* ── Firestore helper ──────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

/* ── Config (validée avec défauts sûrs) ────────────────────── */
const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const OTP_TTL_MS      = num(process.env.OTP_CODE_TTL_MINUTES, 5, 1, 30) * 60 * 1000;
const OTP_COOLDOWN_MS = num(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60, 15, 600) * 1000;
const OTP_MAX_TRIES   = num(process.env.OTP_MAX_VERIFY_ATTEMPTS, 5, 1, 10);
const OTP_PER_PHONE_H = num(process.env.OTP_MAX_PER_PHONE_PER_HOUR, 5, 1, 60);
const OTP_PER_IP_H    = num(process.env.OTP_MAX_PER_IP_PER_HOUR, 20, 1, 500);
const OTP_LENGTH      = 6;

const hmac = (value) =>
  crypto.createHmac('sha256', String(process.env.JWT_SECRET || 'omnisms-otp')).update(String(value)).digest('hex');

/* ── Transporteur (fournisseur d'envoi) ────────────────────── */
let _testTransport = null; // injection tests uniquement

function _setTransportForTests(transport) {
  if (String(process.env.NODE_ENV).toLowerCase() === 'production') {
    throw new Error('_setTransportForTests interdit en production.');
  }
  _testTransport = transport || null;
}

function resolveTransport() {
  if (_testTransport) return { name: 'test', send: _testTransport };
  const provider = String(process.env.OTP_PROVIDER || 'auto').trim().toLowerCase();
  try {
    const infobip = require('./infobip');
    if ((provider === 'auto' || provider === 'infobip') && infobip && infobip.isConfigured()) {
      return {
        name: 'infobip',
        send: (phone, text) => infobip.sendSMS({
          to  : phone,
          text,
          from: process.env.INFOBIP_SENDER_ID || 'OmniSMS',
        }),
      };
    }
  } catch (_) { /* infobip indisponible */ }
  if (provider === 'gateway') {
    // Déconseillé pour l'OTP : dépend du téléphone passerelle (quota 402 actuel,
    // indisponibilité = plus d'inscriptions). Double clé volontaire.
    if (String(process.env.OTP_ALLOW_GATEWAY_TRANSPORT || '').toLowerCase() !== 'true') {
      return null;
    }
    try {
      const smsGateway = require('./smsGateway');
      if (smsGateway && smsGateway.isConfigured()) {
        return {
          name: 'gateway',
          send: (phone, text) => smsGateway.sendSMS({ to: phone, text, ttl: 600 }),
        };
      }
    } catch (_) { /* smsGateway indisponible */ }
  }
  return null;
}

/* ── Générer un code OTP (6 chiffres, sans biais) ──────────── */
function generateOtpCode() {
  const min = Math.pow(10, OTP_LENGTH - 1);
  const max = Math.pow(10, OTP_LENGTH) - 1;
  const range = max - min + 1;
  // Rejection sampling : élimine le biais du modulo
  const limit = Math.floor(0x100000000 / range) * range;
  let num2 = 0;
  do {
    num2 = crypto.randomBytes(4).readUInt32BE(0);
  } while (num2 >= limit);
  return String(min + (num2 % range));
}

/* ── Texte SMS (1 segment si possible) ─────────────────────── */
function buildSmsText(code) {
  const minutes = Math.round(OTP_TTL_MS / 60000);
  return `Votre code OmniSMS : ${code}\nValable ${minutes} min. Ne le partagez pas.`;
}

/* ── Envoyer un OTP ─────────────────────────────────────────── */
/**
 * @param {string} phone - Numéro E.164
 * @param {object} [opts] { userId, ip }
 * @returns {Promise<{ success: boolean, message: string, code?: string, cooldown?: number }>}
 */
async function sendOtp(phone, opts = {}) {
  const userId = opts.userId || null;
  const ip = opts.ip || null;
  if (!phone) {
    return { success: false, message: 'Numéro de téléphone requis.' };
  }

  const db = getDb();
  const docId = `h:${hmac(phone)}`;
  const rateStore = require('./rateStore');

  // 0. Limites par numéro et par IP (fenêtre 1 h) — anti spam / énumération
  try {
    const phoneLimit = await rateStore.hit(`rate:otp:phone:${hmac(phone)}`, 3600 * 1000, OTP_PER_PHONE_H);
    if (phoneLimit && phoneLimit.allowed === false) {
      return { success: false, message: 'Trop de demandes pour ce numéro. Réessayez plus tard.', code: 'OTP_RATE_LIMITED' };
    }
    if (ip) {
      const ipLimit = await rateStore.hit(`rate:otp:ip:${hmac(ip)}`, 3600 * 1000, OTP_PER_IP_H);
      if (ipLimit && ipLimit.allowed === false) {
        return { success: false, message: 'Trop de demandes. Réessayez plus tard.', code: 'OTP_RATE_LIMITED' };
      }
    }
  } catch (_) { /* rateStore indisponible : le cooldown doc ci-dessous reste */ }

  // 1. Cooldown de renvoi (délai minimal) — remplace et invalide l'ancien code
  if (db) {
    try {
      const existing = await db.collection('otp_codes').doc(docId).get();
      if (existing.exists) {
        const data = existing.data();
        const elapsed = Date.now() - new Date(data.sentAt).getTime();
        if (elapsed < OTP_COOLDOWN_MS) {
          const remaining = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
          return {
            success  : false,
            message  : `Attendez ${remaining} secondes avant de demander un nouveau code.`,
            cooldown : remaining,
            code     : 'OTP_COOLDOWN',
          };
        }
      }
    } catch (e) {
      logger.warn('[OTP] Cooldown non vérifiable', { error: e.message });
    }
  }

  // 2. Résoudre le transporteur — JAMAIS de faux succès
  const transport = resolveTransport();
  if (!transport) {
    logger.warn('[OTP] Aucun transporteur OTP disponible (OTP_PROVIDER/Infobip non configuré)');
    return {
      success : false,
      message : 'Le service de vérification est momentanément indisponible. Réessayez plus tard.',
      code    : 'OTP_PROVIDER_UNAVAILABLE',
    };
  }

  // 3. Générer puis stocker l'EMPREINTE du code (jamais le code)
  const code = generateOtpCode();
  const sentAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  if (db) {
    try {
      await db.collection('otp_codes').doc(docId).set({
        phoneHmac : hmac(phone),
        codeHmac  : hmac(`${phone}:${code}`),
        userId    : userId || null,
        purpose   : 'registration',
        sentAt,
        expiresAt,
        tries        : 0,
        maxTries     : OTP_MAX_TRIES,
        verified     : false,
        consumed     : false,
      });
    } catch (e) {
      logger.error('[OTP] Impossible de stocker l\'OTP', { error: e.message });
      return { success: false, message: 'Erreur serveur — impossible de créer l\'OTP.', code: 'OTP_STORE_FAILED' };
    }
  }

  // 4. Envoyer
  try {
    const smsResult = await transport.send(phone, buildSmsText(code));
    if (smsResult && smsResult.success) {
      // Journal SANS code : identifiant fournisseur + destination masquée
      logger.info('[OTP] SMS OTP envoyé', { phone: phone.replace(/\d{4}$/, '****'), transport: transport.name, messageId: smsResult.messageId || null });
      return {
        success : true,
        message : `Code envoyé au ${phone.replace(/\d{4}$/, '****')}. Valable ${Math.round(OTP_TTL_MS / 60000)} minutes.`,
      };
    }
    logger.warn('[OTP] Échec envoi SMS OTP (fournisseur)', { phone: phone.replace(/\d{4}$/, '****'), transport: transport.name, error: (smsResult && smsResult.error) || 'unknown' });
    return { success: false, message: 'Impossible d\'envoyer le SMS. Réessayez.', code: 'SMS_SEND_FAILED' };
  } catch (smsErr) {
    logger.error('[OTP] Erreur transporteur OTP', { transport: transport.name, error: smsErr.message });
    return { success: false, message: 'Erreur lors de l\'envoi du SMS.', code: 'SMS_ERROR' };
  }
}

/* ── Vérifier un OTP ─────────────────────────────────────────── */
/**
 * Vérifie le code et (sur succès) consomme l'OTP. L'activation du compte
 * (users.phoneVerified / verificationRequired) est faite par l'appelant
 * (routes/otp.js) après un résultat positif — seul le backend peut marquer
 * « vérifié », jamais une réponse frontend.
 *
 * @returns {Promise<{ success: boolean, message: string, code?: string, triesRemaining?: number }>}
 */
async function verifyOtp(phone, code) {
  if (!phone || !code) {
    return { success: false, message: 'Numéro et code OTP requis.' };
  }

  const db = getDb();
  if (!db) {
    return { success: false, message: 'Base de données indisponible.', code: 'OTP_DB_UNAVAILABLE' };
  }

  const docId = `h:${hmac(phone)}`;
  const ref = db.collection('otp_codes').doc(docId);
  const nowIso = new Date().toISOString();

  try {
    // Consommation transactionnelle si disponible (anti validations simultanées) ;
    // sinon lecture/écriture séquentielle (mono-instance).
    const outcome = await (db.runTransaction
      ? db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { code: 'OTP_NOT_FOUND' };
        const data = snap.data();
        const check = precheck(data);
        if (check) {
          if (check.code === 'OTP_EXPIRED' || check.code === 'OTP_MAX_TRIES') {
            tx.delete(ref);
          }
          return check;
        }
        const codeOk = timingSafeEqualCode(phone, code, data.codeHmac);
        tx.update(ref, codeOk
          ? { consumed: true, verified: true, consumedAt: nowIso }
          : { tries: (data.tries || 0) + 1, lastAttemptAt: nowIso });
        return codeOk ? { ok: true, data } : { code: 'OTP_INVALID', triesRemaining: data.maxTries - ((data.tries || 0) + 1), data };
      })
      : (async () => {
        const snap = await ref.get();
        if (!snap.exists) return { code: 'OTP_NOT_FOUND' };
        const data = snap.data();
        const check = precheck(data);
        if (check) {
          if (check.code === 'OTP_EXPIRED' || check.code === 'OTP_MAX_TRIES') await ref.delete();
          return check;
        }
        const codeOk = timingSafeEqualCode(phone, code, data.codeHmac);
        await ref.update(codeOk
          ? { consumed: true, verified: true, consumedAt: nowIso }
          : { tries: (data.tries || 0) + 1, lastAttemptAt: nowIso });
        return codeOk ? { ok: true, data } : { code: 'OTP_INVALID', triesRemaining: data.maxTries - ((data.tries || 0) + 1), data };
      })());

    if (outcome.ok) {
      logger.info('[OTP] Code vérifié (consommé)', { phone: phone.replace(/\d{4}$/, '****'), userId: outcome.data.userId || null });
      return { success: true, message: 'Numéro vérifié.', userId: outcome.data.userId || null };
    }
    if (outcome.code === 'OTP_INVALID') {
      return {
        success: false,
        message: 'Code OTP incorrect.',
        code: 'OTP_INVALID',
        triesRemaining: Math.max(0, outcome.triesRemaining),
      };
    }
    const messages = {
      OTP_NOT_FOUND : 'Aucun code en attente pour ce numéro. Demandez un nouveau code.',
      OTP_EXPIRED   : 'Code expiré. Demandez un nouveau code.',
      OTP_MAX_TRIES : 'Trop de tentatives. Demandez un nouveau code.',
      OTP_CONSUMED  : 'Code déjà utilisé. Demandez un nouveau code.',
    };
    return { success: false, message: messages[outcome.code] || 'Code invalide.', code: outcome.code };

    /* -- sous-fonctions -- */
    function precheck(data) {
      if (data.consumed) return { code: 'OTP_CONSUMED' };
      if (new Date(data.expiresAt) < new Date()) return { code: 'OTP_EXPIRED' };
      if ((data.tries || 0) >= (data.maxTries || OTP_MAX_TRIES)) return { code: 'OTP_MAX_TRIES' };
      return null;
    }
  } catch (err) {
    logger.error('[OTP] Erreur vérification OTP', { error: err.message });
    return { success: false, message: 'Erreur serveur lors de la vérification OTP.', code: 'OTP_VERIFY_ERROR' };
  }
}

function timingSafeEqualCode(phone, provided, storedHmac) {
  try {
    const a = Buffer.from(hmac(`${phone}:${String(provided).trim()}`), 'hex');
    const b = Buffer.from(String(storedHmac || ''), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

module.exports = {
  sendOtp,
  verifyOtp,
  generateOtpCode,
  _setTransportForTests,
  _config: () => ({ OTP_TTL_MS, OTP_COOLDOWN_MS, OTP_MAX_TRIES, OTP_PER_PHONE_H, OTP_PER_IP_H }),
};
