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
    baseUrl   : String(process.env.SMSGATE_BASE_URL || '').trim().replace(/\/+$/, ''),
    username  : String(process.env.SMSGATE_USERNAME || '').trim(),
    password  : String(process.env.SMSGATE_PASSWORD || '').trim(),
    deviceId  : String(process.env.SMSGATE_DEVICE_ID || '').trim(),
    timeoutMs : Math.min(Math.max(Number(process.env.SMSGATE_REQUEST_TIMEOUT_MS) || 10000, 1000), 60000),
    authMode  : (String(process.env.SMSGATE_AUTH_MODE || 'jwt').trim().toLowerCase() === 'basic') ? 'basic' : 'jwt',
    prefix    : process.env.SMSGATE_API_PREFIX !== undefined ? String(process.env.SMSGATE_API_PREFIX) : '/3rdparty/v1',
    ttlSec    : Math.min(Math.max(Number(process.env.SMSGATE_TOKEN_TTL_SECONDS) || 3600, 60), 86400),
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.baseUrl && c.username && c.password);
}

/** true si SMSGate est le fournisseur SÉLECTIONNÉ et configuré. */
function isEnabled() {
  const selected = String(process.env.OFFLINE_SMS_PROVIDER || 'sms_gateway').toLowerCase().trim();
  return selected === 'smsgate' && isConfigured();
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
  if (cfg().authMode === 'basic') return null; // Basic : pas de jeton
  if (_token && _token.expiresAtMs - 60000 > Date.now()) return _token.accessToken;
  _token = _token ? await refreshTokenPair() : await obtainTokenPair();
  return _token.accessToken;
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

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = await getAccessToken();
      const out = await fetchJson(`${c.baseUrl}${c.prefix}/messages`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(token) },
        body   : JSON.stringify(payload),
      });

      if (out.status === 401 && attempt === 1 && cfg().authMode === 'jwt') {
        invalidateToken();
        continue; // une seule re-auth puis retry
      }
      if (out.status === 429) {
        logger.warn('[SMSGate] Limite de requêtes atteinte (429)', { to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: 429, error: 'RATE_LIMITED' };
      }
      if (out.status >= 500) {
        // Ambigu : l'API a pu accepter le message malgré l'erreur
        logger.warn('[SMSGate] Erreur serveur (ambigu)', { status: out.status, to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: out.status, error: 'PROVIDER_ERROR', ambiguous: true };
      }
      if (!out.ok) {
        logger.warn('[SMSGate] Requête rejetée', { status: out.status, to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: out.status, error: (out.body && (out.body.message || out.body.error)) || `HTTP_${out.status}` };
      }

      // id retourné : string | array | {id}
      let gwId = out.body && out.body.id;
      if (Array.isArray(gwId)) gwId = gwId[0];
      if (gwId && typeof gwId === 'object') gwId = gwId.id;
      if (!gwId) {
        logger.warn('[SMSGate] Réponse sans identifiant de message', { to: maskPhone(to) });
        return { success: false, provider: 'smsgate', statusCode: out.status, error: 'NO_MESSAGE_ID', ambiguous: true };
      }

      memoSet(messageId, String(gwId));
      logger.info('[SMSGate] SMS accepté', { to: maskPhone(to), gatewayMessageId: String(gwId).slice(0, 12), ttl: payload.ttl || null });
      return { success: true, gatewayMessageId: String(gwId), state: 'pending', provider: 'smsgate', statusCode: out.status };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (attempt === 1 && !aborted) {
        // erreur réseau ponctuelle → un seul retry immédiat
        continue;
      }
      logger.error('[SMSGate] Erreur réseau/timeout', { to: maskPhone(to), error: aborted ? `timeout après ${c.timeoutMs} ms` : err.message });
      return { success: false, provider: 'smsgate', statusCode: 0, error: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', ambiguous: true };
    }
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
    if (out.status === 401 && cfg().authMode === 'jwt') {
      invalidateToken();
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
