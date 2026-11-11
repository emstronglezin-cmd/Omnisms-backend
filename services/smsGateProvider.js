'use strict';
/**
 * OmniSMS — SMSGateProvider (passerelle SMS open source)
 *
 * Contrat officiel (docs.sms-gate.app, dépôt android-sms-gateway/server —
 * api/requests.http + guide d'authentification, vérifiés le 14/10/2026) :
 *   POST {prefix}/auth/token          (Basic)  {ttl, scopes} → {access_token, refresh_token, expires_at}
 *   POST {prefix}/auth/token/refresh  (Bearer refresh) → nouvelle paire (rotation, l'ancienne révoquée)
 *   POST {prefix}/messages            {message, phoneNumbers[], ttl?, withDeliveryReport?, deviceId?} → id
 *   GET  {prefix}/messages/{id}       → état : Pending | Sent | Delivered | Failed
 *   GET  {prefix}/health
 *   prefix par défaut : /3rdparty/v1 (cloud api.sms-gate.app ET serveur privé auto-hébergé).
 *
 * Sécurité : aucun secret dans les logs (jamais Authorization, mot de passe,
 * contenu de message) ; OTP recommandé via SERVEUR PRIVÉ (docs/SMSGATE_MIGRATION.md).
 *
 * Anti-doublon : après un résultat AMBIGU (timeout/5xx), l'association
 * `messageId OmniSMS → id SMSGate` est mémorisée ; une nouvelle tentative du
 * même message VÉRIFIE le statut avant de renvoyer (pas de double SMS).
 */

const { logger } = require('../middleware/logger');

/* ── Configuration ──────────────────────────────────────────── */
function cfg() {
  return {
    // ── Noms Render du propriétaire (SMS_GATEWAY_*) EN PRIORITÉ, alias SMSGATE_* conservés ──
    // SMS_GATEWAY_LOGIN / SMS_GATEWAY_PASSWORD / SMS_GATEWAY_DEVICE_ID /
    // SMS_GATEWAY_SERVER_ADDRESS = valeurs fournies par l'application SMSGate.
    baseUrl   : normalizeBaseUrl(process.env.SMSGATE_BASE_URL || process.env.SMS_GATEWAY_SERVER_ADDRESS || ''),
    username  : String(process.env.SMSGATE_USERNAME || process.env.SMS_GATEWAY_LOGIN || '').trim(),
    password  : String(process.env.SMSGATE_PASSWORD || process.env.SMS_GATEWAY_PASSWORD || '').trim(),
    deviceId  : String(process.env.SMSGATE_DEVICE_ID || process.env.SMS_GATEWAY_DEVICE_ID || '').trim(),
    timeoutMs : Math.min(Math.max(Number(process.env.SMSGATE_REQUEST_TIMEOUT_MS) || 10000, 1000), 60000),
    authMode  : normalizeAuthMode(process.env.SMSGATE_AUTH_MODE || process.env.SMS_GATEWAY_AUTH_MODE),
    prefix    : (process.env.SMSGATE_API_PREFIX !== undefined || process.env.SMS_GATEWAY_API_PREFIX !== undefined)
      ? String(process.env.SMSGATE_API_PREFIX !== undefined ? process.env.SMSGATE_API_PREFIX : process.env.SMS_GATEWAY_API_PREFIX)
      : '/3rdparty/v1',
    ttlSec    : Math.min(Math.max(Number(process.env.SMSGATE_TOKEN_TTL_SECONDS) || 3600, 60), 86400),
  };
}

/** URL de base : sans slash final ; https:// ajouté si l'app fournit un hôte nu. */
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
/** Mode d'auth : 'basic' | 'jwt' | 'auto' (défaut : JWT, repli Basic automatique). */
let _authModeOverride = null; // 'auto' → bascule réelle (basic) après échec de l'endpoint JWT
let _authFlipFlops = 0;       // alternances Basic↔JWT (auto-réparation, plafonnées)
/** Hôte du serveur configuré (jamais de secret : host seul, userinfo exclu). */
function _hostOf(u) {
  try { return new URL(u).host; } catch (_) { return String(u || '').replace(/^[a-z]+:\/\//i, '').split('/')[0] || '?'; }
}
function normalizeAuthMode(raw) {
  const v = String(raw === undefined || raw === null ? 'auto' : raw).trim().toLowerCase();
  if (v === 'basic') return 'basic';
  if (v === 'jwt') return 'jwt';
  return _authModeOverride || 'auto';
}

function isConfigured() {
  const c = cfg();
  return !!(c.baseUrl && c.username && c.password);
}

/**
 * true si SMSGate est actif : la présence des credentials (4 variables du
 * propriétaire sur Render, ou alias SMSGATE_*) EST le signal d'activation.
 * OFFLINE_SMS_PROVIDER=smsgate reste valable ; = 'none' désactive tout.
 * (Déploie le transport sans exiger un changement supplémentaire sur Render.)
 */
function isEnabled() {
  const selected = String(process.env.OFFLINE_SMS_PROVIDER || '').toLowerCase().trim();
  if (selected === 'none') return false;
  return isConfigured();
}

function maskPhone(phone) { return String(phone || '').replace(/\d{4}$/, '****'); }

/** Validation numéro international (E.164 souple) — rejet local avant appel réseau. */
function isValidPhone(phone) {
  return /^\+[1-9]\d{6,14}$/.test(String(phone || '').trim());
}

/* ── Jetons JWT (cache + rotation) ──────────────────────────── */
const SCOPES = ['messages:send', 'messages:read', 'devices:list'];
let _token = null; // { accessToken, refreshToken, expiresAtMs }

function basicHeader() {
  const c = cfg();
  return 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
}

async function apiFetch(url, options, timeoutMs) {
  // Node ≥ 18 : fetch global ; AbortController pour le timeout.
  // _fetchImpl : injection pour les TESTS uniquement (jamais en production).
  const doFetch = _fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || cfg().timeoutMs);
  try {
    return await doFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options, timeoutMs) {
  const res = await apiFetch(url, options, timeoutMs);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { status: res.status, ok: res.ok, body };
}

async function obtainTokenPair() {
  const c = cfg();
  const out = await fetchJson(`${c.baseUrl}${c.prefix}/auth/token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicHeader() },
    body   : JSON.stringify({ ttl: c.ttlSec, scopes: SCOPES }),
  });
  if (!out.ok || !out.body || !out.body.access_token) {
    const err = new Error(`SMSGate auth échouée (HTTP ${out.status})`);
    err.statusCode = out.status;
    throw err;
  }
  return {
    accessToken : String(out.body.access_token),
    refreshToken: String(out.body.refresh_token || ''),
    expiresAtMs : out.body.expires_at ? Date.parse(out.body.expires_at) : Date.now() + c.ttlSec * 1000,
  };
}

async function refreshTokenPair() {
  const c = cfg();
  if (!_token || !_token.refreshToken) return obtainTokenPair();
  const out = await fetchJson(`${c.baseUrl}${c.prefix}/auth/token/refresh`, {
    method : 'POST',
    headers: { Authorization: `Bearer ${_token.refreshToken}` },
  }, c.timeoutMs);
  if (!out.ok || !out.body || !out.body.access_token) {
    // refresh invalide/expiré → ré-authentification complète
    return obtainTokenPair();
  }
  return {
    accessToken : String(out.body.access_token),
    refreshToken: String(out.body.refresh_token || _token.refreshToken),
    expiresAtMs : out.body.expires_at ? Date.parse(out.body.expires_at) : Date.now() + c.ttlSec * 1000,
  };
}

/** Jeton d'accès valide (renouvelle 60 s avant expiration, avec rotation). */
async function getAccessToken() {
  const mode = cfg().authMode;
  if (mode === 'basic') return null; // Basic : pas de jeton
  if (mode === 'jwt') {
    if (_token && _token.expiresAtMs - 60000 > Date.now()) return _token.accessToken;
    _token = _token ? await refreshTokenPair() : await obtainTokenPair();
    return _token.accessToken;
  }
  // mode 'auto' : JWT d'abord ; si l'endpoint /auth/token n'existe pas sur ce
  // serveur (401/403/404/405) → repli PERMANENT en Basic (identifiants app).
  try {
    if (_token && _token.expiresAtMs - 60000 > Date.now()) return _token.accessToken;
    _token = _token ? await refreshTokenPair() : await obtainTokenPair();
    return _token.accessToken;
  } catch (err) {
    const sc = err && err.statusCode;
    if (sc === 401 || sc === 403 || sc === 404 || sc === 405) {
      _authModeOverride = 'basic';
      _token = null;
      logger.warn('[SMSGate] endpoint JWT indisponible sur ce serveur → auth Basic utilisée');
      return null;
    }
    throw err; // réseau/quota : ambiguity gérée par l'appelant
  }
}

function authHeader(token) {
  return token ? { Authorization: `Bearer ${token}` } : { Authorization: basicHeader() };
}

/** Invalide le jeton en cache (401 → re-auth avant retry unique). */
function invalidateToken() { _token = null; }

/* ── Anti-doublon (résultats ambigus) ───────────────────────── */
const MAX_MEMO = 2000;
const _sentMemo = new Map(); // messageId OmniSMS → { gwId, at }

function memoSet(messageId, gwId) {
  if (!messageId) return;
  if (_sentMemo.size >= MAX_MEMO) {
    const oldest = _sentMemo.keys().next().value;
    _sentMemo.delete(oldest);
  }
  _sentMemo.set(String(messageId), { gwId, at: Date.now() });
}

function memoGet(messageId) {
  const e = messageId ? _sentMemo.get(String(messageId)) : null;
  return e && (Date.now() - e.at) < 24 * 3600 * 1000 ? e.gwId : null;
}

/* ── États SMSGate → OmniSMS ────────────────────────────────── */
function mapState(smsgateState) {
  switch (String(smsgateState || '').toLowerCase()) {
    case 'pending'  : return 'pending';
    case 'sent'     : return 'sent';
    case 'delivered': return 'delivered';
    case 'failed'   : return 'failed';
    default         : return 'pending';
  }
}

/* ── Envoi ──────────────────────────────────────────────────── */
/**
 * Envoie un SMS via SMSGate.
 * @param {object} p { to, text, messageId?, ttl? }
 * @returns {Promise<{success:boolean, gatewayMessageId?:string, state?:string, provider:string, statusCode?:number, error?:string, ambiguous?:boolean}>}
 */
async function sendSMS(p = {}) {
  const { to, text, messageId = null, ttl = null } = p;
  if (!to || !text) {
    return { success: false, provider: 'smsgate', error: 'to et text requis' };
  }
  if (!isConfigured()) {
    return { success: false, provider: 'smsgate', error: 'SMSGATE_BASE_URL/USERNAME/PASSWORD manquants', statusCode: 503 };
  }
  if (!isValidPhone(to)) {
    logger.warn('[SMSGate] Numéro invalide rejeté localement', { to: maskPhone(to) });
    return { success: false, provider: 'smsgate', error: 'INVALID_PHONE', statusCode: 400 };
  }

  const c = cfg();

  // Résultat ambigu précédent pour ce message → vérifier avant de renvoyer
  const previousGwId = memoGet(messageId);
  if (previousGwId) {
    try {
      const st = await checkStatus(previousGwId);
      if (st.found && st.state !== 'failed') {
        logger.info('[SMSGate] Retry d’un message déjà accepté — aucun double envoi', { messageId: messageId ? String(messageId).slice(0, 8) : null, state: st.state });
        return { success: true, gatewayMessageId: previousGwId, state: st.state, provider: 'smsgate', deduped: true };
      }
    } catch (_) { /* statut injoignable → on tente un nouvel envoi (SMS perdu préféré au doublon inversé ? non : on renvoie) */ }
  }

  const payload = {
    message           : String(text),
    phoneNumbers      : [String(to).trim()],
    withDeliveryReport: true,
  };
  if (ttl) payload.ttl = Math.min(Math.max(Number(ttl) || 3600, 60), 86400);
  if (c.deviceId) payload.deviceId = c.deviceId;

  logger.info('[SMSGATE] Sending SMS', { to: maskPhone(to), deviceId: c.deviceId || null, ttl: payload.ttl || null, messageId: messageId ? String(messageId).slice(0, 12) : null });
  let lastRejection = 0; // dernier statut HTTP d'authentification rejetée
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const token = await getAccessToken();
      const out = await fetchJson(`${c.baseUrl}${c.prefix}/messages`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(token) },
        body   : JSON.stringify(payload),
      });

      if (out.status === 401) lastRejection = 401;
      if (out.status === 401 && cfg().authMode !== 'basic') {
        // 401 sur /messages : le jeton JWT est refusé par le serveur.
        //  - mode auto  → repli en Basic (identifiants app = vérité terrain) :
        //    sans cela, le JWT rejeté restait en cache → 401 persistant sur
        //    CHAQUE envoi (cause du bug prod) ;
        //  - mode jwt explicite → invalidation + re-auth (boucle bornée).
        if (cfg().authMode === 'auto') {
          _authModeOverride = 'basic';
          _token = null;
          logger.warn('[SMSGate] 401 sur /messages avec JWT → repli Basic (identifiants app)', { server: _hostOf(c.baseUrl) });
        } else {
          invalidateToken();
        }
        continue;
      }
      if (out.status === 401 && cfg().authMode === 'basic' && _authModeOverride === 'basic' && _authFlipFlops < 3) {
        // Basic refusé LUI AUSSI (alors que c'est NOUS qui avions basculé) :
        // JWT ET Basic sont rejetés → identifiants/serveur à vérifier, OU
        // rejet JWT transitoire. Auto-réparation BORNÉE : re-tenter le JWT
        // (re-auth complète), max 3 alternances par process ; sinon échec
        // honnête. Jamais de secret dans les logs (host seul).
        _authFlipFlops++;
        _authModeOverride = null;
        _token = null;
        logger.warn(`[SMSGate] 401 Basic également refusé → re-tentative JWT (auto-réparation ${_authFlipFlops}/3)`, { server: _hostOf(c.baseUrl) });
        continue;
      }
      if (out.status === 429) {
        logger.warn('[SMSGATE] SMS failed (limite fournisseur 429)', { to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: 429, error: 'RATE_LIMITED' };
      }
      if (out.status >= 500) {
        // Ambigu : l'API a pu accepter le message malgré l'erreur
        logger.warn('[SMSGATE] Gateway unavailable (HTTP 5xx — résultat ambigu)', { status: out.status, to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: out.status, error: 'PROVIDER_ERROR', ambiguous: true };
      }
      if (!out.ok) {
        const authUsed = cfg().authMode === 'basic' ? 'Basic' : 'JWT';
        const host = _hostOf(c.baseUrl);
        logger.warn('[SMSGATE] SMS failed (rejet fournisseur)', { status: out.status, auth: authUsed, server: host, to: maskPhone(to) });
        const detail = (out.body && (out.body.message || out.body.error)) || `HTTP_${out.status}`;
        return { success: false, provider: 'smsgate', statusCode: out.status,
          error: out.status === 401
            ? `${detail} — auth ${authUsed} refusée par le serveur SMSGate « ${host} » (vérifier SMS_GATEWAY_LOGIN/PASSWORD : identifiants app du téléphone ; et SMS_GATEWAY_SERVER_ADDRESS : MÊME serveur que l application passerelle)`
            : detail };
      }

      // id retourné : string | array | {id}
      let gwId = out.body && out.body.id;
      if (Array.isArray(gwId)) gwId = gwId[0];
      if (gwId && typeof gwId === 'object') gwId = gwId.id;
      if (!gwId) {
        logger.warn('[SMSGATE] SMS failed (réponse sans id — ambigu)', { to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: out.status, error: 'NO_MESSAGE_ID', ambiguous: true };
      }

      memoSet(messageId, String(gwId));
      logger.info('[SMSGATE] SMS accepted', { to: maskPhone(to), gatewayMessageId: String(gwId).slice(0, 12), ttl: payload.ttl || null });
      return { success: true, gatewayMessageId: String(gwId), state: 'pending', provider: 'smsgate', statusCode: out.status };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (attempt === 1 && !aborted) {
        // erreur réseau ponctuelle → un seul retry immédiat
        continue;
      }
      logger.error('[SMSGATE] Gateway unavailable (réseau/timeout)', { to: maskPhone(to), error: aborted ? `timeout après ${c.timeoutMs} ms` : err.message });
      return { success: false, provider: 'smsgate', statusCode: 0, error: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', ambiguous: true };
    }
  }
  if (lastRejection === 401) {
    // Toutes les tentatives d'authentification ont été refusées : échec
    // HONNÊTE et actionnable (host seul — jamais de secret).
    return { success: false, provider: 'smsgate', statusCode: 401, error: `AUTH_REJECTED — JWT et Basic refusés par le serveur SMSGate « ${_hostOf(c.baseUrl)} » (vérifier SMS_GATEWAY_LOGIN/PASSWORD : identifiants app du téléphone ; SMS_GATEWAY_SERVER_ADDRESS : MÊME serveur que l application passerelle)` };
  }
  return { success: false, provider: 'smsgate', statusCode: 0, error: 'NETWORK_ERROR', ambiguous: true };
}

/* ── Statut d'un message ────────────────────────────────────── */
/**
 * @returns {Promise<{found:boolean, state?:string, terminal:boolean, raw?:object}>}
 */
async function checkStatus(gatewayMessageId) {
  if (!gatewayMessageId || !isConfigured()) return { found: false };
  const c = cfg();
  try {
    const token = await getAccessToken();
    const out = await fetchJson(`${c.baseUrl}${c.prefix}/messages/${encodeURIComponent(String(gatewayMessageId))}`, {
      method : 'GET',
      headers: { ...authHeader(token) },
    });
    if (out.status === 404) return { found: false };
    if (out.status === 401 && cfg().authMode !== 'basic') {
      // Même cause/réparation que sendSMS : en mode auto, un JWT refusé bascule
      // PERMANENTMENT en Basic au lieu de réessayer indéfiniment le même jeton.
      if (cfg().authMode === 'auto') {
        _authModeOverride = 'basic';
        _token = null;
        logger.warn('[SMSGate] 401 sur /messages/{id} avec JWT → repli Basic permanent');
      } else {
        invalidateToken();
      }
      const token2 = await getAccessToken();
      const retry = await fetchJson(`${c.baseUrl}${c.prefix}/messages/${encodeURIComponent(String(gatewayMessageId))}`, {
        method : 'GET',
        headers: { ...authHeader(token2) },
      });
      if (!retry.ok) return { found: false };
      return fromStatusBody(retry.body);
    }
    if (!out.ok) return { found: false };
    return fromStatusBody(out.body);
  } catch (err) {
    logger.warn('[SMSGate] Statut injoignable', { error: err.message });
    return { found: false };
  }

  function fromStatusBody(body) {
    const state = mapState(body && (body.state || body.status));
    if (state === 'delivered') logger.info('[SMSGATE] SMS delivery confirmed', { gatewayMessageId: String(gatewayMessageId).slice(0, 12) });
    return {
      found   : true,
      state,
      terminal: state === 'delivered' || state === 'failed',
      raw     : undefined, // jamais la réponse brute en log/mémoire longue
    };
  }
}

/* ── Santé ──────────────────────────────────────────────────── */
async function health() {
  const c = cfg();
  if (!c.baseUrl) return { ok: false, error: 'SMSGATE_BASE_URL manquant' };
  try {
    const out = await fetchJson(`${c.baseUrl}${c.prefix}/health`, { method: 'GET' }, 5000);
    return { ok: out.ok, statusCode: out.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ── Réservation de tests (transport HTTP injecté) ──────────── */
let _fetchImpl = null;
function _setFetchImplForTests(fn) {
  if (String(process.env.NODE_ENV).toLowerCase() === 'production') {
    throw new Error('_setFetchImplForTests interdit en production.');
  }
  _fetchImpl = fn || null;
}

module.exports = {
  isConfigured,
  isEnabled,
  sendSMS,
  checkStatus,
  health,
  mapState,
  isValidPhone,
  invalidateToken,
  _setFetchImplForTests,
  _resetTokensForTests: () => { _token = null; _sentMemo.clear(); },
};
