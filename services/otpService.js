'use strict';
/**
 * OmniSMS — Service OTP (One-Time Password)
 *
 * Génère, stocke et valide des codes OTP à 6 chiffres.
 * Transport : Infobip SMS (déjà intégré dans le projet).
 * Stockage  : Firestore collection `otp_codes` avec TTL de 10 minutes.
 *
 * Endpoints exposés via routes/otp.js :
 *   POST /api/auth/send-otp    → Envoyer un OTP au numéro
 *   POST /api/auth/verify-otp  → Valider un OTP et activer le compte
 *
 * Sécurité :
 *   - Code à 6 chiffres aléatoire
 *   - TTL 10 minutes
 *   - Max 3 tentatives par code
 *   - Cooldown 60s entre envois successifs
 *   - Document supprimé après vérification réussie
 */

const crypto = require('crypto');
const { logger } = require('../middleware/logger');

/* ── Infobip (requis pour envoyer les OTP) ─────────────────── */
let infobip = null;
try { infobip = require('./infobip'); } catch (_) {}

/* ── Firestore helper ──────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

/* ── Constantes ────────────────────────────────────────────── */
const OTP_TTL_MS      = 10 * 60 * 1000;  // 10 minutes
const OTP_COOLDOWN_MS = 60 * 1000;        // 60 secondes entre envois
const OTP_MAX_TRIES   = 3;                // Max tentatives de vérification
const OTP_LENGTH      = 6;               // Longueur du code

/* ── Générer un code OTP ───────────────────────────────────── */
/**
 * Générer un code OTP à 6 chiffres cryptographiquement sécurisé.
 * @returns {string} code OTP (ex: "482931")
 */
function generateOtpCode() {
  const min = Math.pow(10, OTP_LENGTH - 1);        // 100000
  const max = Math.pow(10, OTP_LENGTH) - 1;        // 999999
  const range = max - min + 1;
  const bytes = crypto.randomBytes(4);
  const num   = bytes.readUInt32BE(0);
  return String(min + (num % range));
}

/* ── Envoyer un OTP ─────────────────────────────────────────── */
/**
 * Générer un OTP, le stocker dans Firestore et l'envoyer par SMS.
 *
 * @param {string} phone - Numéro E.164 (+22670123456)
 * @param {string} [userId] - UID Firestore si connu (post-register)
 * @returns {Promise<{ success: boolean, message: string, cooldown?: number }>}
 */
async function sendOtp(phone, userId = null) {
  if (!phone) {
    return { success: false, message: 'Numéro de téléphone requis.' };
  }

  const db = getDb();

  // 1. Vérifier le cooldown (éviter le spam)
  if (db) {
    try {
      const existing = await db.collection('otp_codes').doc(phone).get();
      if (existing.exists) {
        const data = existing.data();
        const sentAt = new Date(data.sentAt).getTime();
        const elapsed = Date.now() - sentAt;
        if (elapsed < OTP_COOLDOWN_MS) {
          const remaining = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
          return {
            success  : false,
            message  : `Attendez ${remaining} secondes avant de renvoyer un OTP.`,
            cooldown : remaining,
            code     : 'OTP_COOLDOWN',
          };
        }
      }
    } catch (e) {
      logger.warn('[OTP] Impossible de vérifier cooldown', { error: e.message });
    }
  }

  // 2. Générer le code
  const code    = generateOtpCode();
  const sentAt  = new Date().toISOString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  // 3. Stocker dans Firestore (doc ID = numéro normalisé)
  if (db) {
    try {
      await db.collection('otp_codes').doc(phone).set({
        phone,
        userId    : userId || null,
        code,       // En production, hashé ; ici en clair pour simplicité Firestore TTL
        sentAt,
        expiresAt,
        tries     : 0,
        verified  : false,
      });
    } catch (e) {
      logger.error('[OTP] Impossible de stocker OTP Firestore', { error: e.message });
      return { success: false, message: 'Erreur serveur — impossible de créer l\'OTP.' };
    }
  }

  // 4. Envoyer par SMS via Infobip
  if (!infobip || !infobip.isConfigured()) {
    // Mode dev/test : log le code (NE PAS faire en production)
    logger.warn('[OTP] Infobip non configuré — code OTP (TEST SEULEMENT)', { phone, code });
    return {
      success : true,
      message : 'OTP généré (Infobip non configuré — vérifiez les logs serveur).',
      devCode : process.env.NODE_ENV !== 'production' ? code : undefined,
    };
  }

  try {
    const smsResult = await infobip.sendSMS({
      to  : phone,
      text: `Votre code OmniSMS : ${code}\nValable 10 minutes. Ne le partagez pas.`,
      from: process.env.INFOBIP_SENDER_ID || 'OmniSMS',
    });

    if (smsResult.success) {
      logger.info('[OTP] SMS OTP envoyé', { phone, messageId: smsResult.messageId });
      return {
        success : true,
        message : `Code envoyé au ${phone}. Valable 10 minutes.`,
      };
    } else {
      logger.error('[OTP] Échec envoi SMS OTP', { phone, error: smsResult.error });
      return {
        success : false,
        message : 'Impossible d\'envoyer le SMS. Réessayez.',
        code    : 'SMS_SEND_FAILED',
      };
    }
  } catch (smsErr) {
    logger.error('[OTP] Erreur SMS OTP', { phone, error: smsErr.message });
    return { success: false, message: 'Erreur lors de l\'envoi du SMS.', code: 'SMS_ERROR' };
  }
}

/* ── Vérifier un OTP ─────────────────────────────────────────── */
/**
 * Vérifier un code OTP et activer le compte si valide.
 *
 * @param {string} phone - Numéro E.164
 * @param {string} code  - Code saisi par l'utilisateur
 * @returns {Promise<{ success: boolean, message: string, userId?: string, token?: string }>}
 */
async function verifyOtp(phone, code) {
  if (!phone || !code) {
    return { success: false, message: 'Numéro et code OTP requis.' };
  }

  const db = getDb();
  if (!db) {
    return { success: false, message: 'Base de données indisponible.' };
  }

  try {
    const snap = await db.collection('otp_codes').doc(phone).get();

    if (!snap.exists) {
      return {
        success : false,
        message : 'Aucun OTP en attente pour ce numéro. Demandez un nouveau code.',
        code    : 'OTP_NOT_FOUND',
      };
    }

    const data = snap.data();

    // Vérifier expiration
    if (new Date(data.expiresAt) < new Date()) {
      await db.collection('otp_codes').doc(phone).delete();
      return {
        success : false,
        message : 'Code OTP expiré. Demandez un nouveau code.',
        code    : 'OTP_EXPIRED',
      };
    }

    // Vérifier nombre de tentatives
    if ((data.tries || 0) >= OTP_MAX_TRIES) {
      await db.collection('otp_codes').doc(phone).delete();
      return {
        success : false,
        message : 'Trop de tentatives. Demandez un nouveau code OTP.',
        code    : 'OTP_MAX_TRIES',
      };
    }

    // Incrémenter le compteur de tentatives
    await db.collection('otp_codes').doc(phone).update({
      tries: (data.tries || 0) + 1,
    });

    // Vérifier le code
    if (data.code !== String(code).trim()) {
      return {
        success       : false,
        message       : 'Code OTP incorrect.',
        code          : 'OTP_INVALID',
        triesRemaining: OTP_MAX_TRIES - ((data.tries || 0) + 1),
      };
    }

    // Code correct — activer le compte
    const userId = data.userId;

    // Marquer le numéro comme vérifié dans la collection users
    let activatedUser = null;
    if (userId) {
      try {
        await db.collection('users').doc(userId).update({
          phoneVerified: true,
          updatedAt    : new Date().toISOString(),
        });

        const userSnap = await db.collection('users').doc(userId).get();
        if (userSnap.exists) {
          activatedUser = { id: userId, ...userSnap.data() };
          delete activatedUser.password; // Ne pas exposer le hash
        }
      } catch (e) {
        logger.error('[OTP] Impossible d\'activer le compte', { userId, error: e.message });
      }
    } else {
      // Chercher l'utilisateur par numéro de téléphone
      try {
        const userSnap = await db.collection('users').where('phone', '==', phone).limit(1).get();
        if (!userSnap.empty) {
          const userDoc = userSnap.docs[0];
          await userDoc.ref.update({
            phoneVerified: true,
            updatedAt    : new Date().toISOString(),
          });
          const userData = userDoc.data();
          activatedUser = { id: userDoc.id, ...userData };
          delete activatedUser.password;
        }
      } catch (e) {
        logger.error('[OTP] Impossible de trouver l\'utilisateur par téléphone', { phone, error: e.message });
      }
    }

    // Supprimer l'OTP après vérification réussie
    await db.collection('otp_codes').doc(phone).delete();

    logger.info('[OTP] Vérification réussie, compte activé', { phone, userId: activatedUser?.id });

    return {
      success      : true,
      message      : 'Numéro vérifié. Votre compte est activé.',
      userId       : activatedUser?.id || null,
      user         : activatedUser,
      phoneVerified: true,
    };

  } catch (err) {
    logger.error('[OTP] Erreur vérification OTP', { phone, error: err.message });
    return { success: false, message: 'Erreur serveur lors de la vérification OTP.' };
  }
}

module.exports = { sendOtp, verifyOtp, generateOtpCode };
