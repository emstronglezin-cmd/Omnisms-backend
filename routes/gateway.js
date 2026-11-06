'use strict';
/**
 * OmniSMS — API Passerelle Android (stratégie SMS retenue).
 *
 * Authentifications :
 *  - administration (register / revoke / list / stats) : en-tête x-admin-key
 *    vérifié contre ADMIN_KEY si cette variable est configurée (sinon accès
 *    historique ouvert, comme /api/diag — poser ADMIN_KEY en production !) ;
 *  - appareil passerelle : en-têtes x-gateway-device + x-gateway-token
 *    (jeton 256 bits, stocké hashé, révocable immédiatement).
 *
 * Aucun secret (jeton, hash) n'est journalisé ni renvoyé après la création.
 */
const express = require('express');
const router = express.Router();
const androidGW = require('../services/androidGateway');
const { logger } = require('../middleware/logger');

function adminAuthorized(req) {
  const key = String(process.env.ADMIN_KEY || '');
  if (!key) return true; // compat : sans ADMIN_KEY, comportement historique
  return String(req.headers['x-admin-key'] || '') === key;
}

function adminGuard(req, res, next) {
  if (!adminAuthorized(req)) {
    return res.status(401).json({ error: 'Admin key requise.', code: 'ADMIN_KEY_REQUIRED' });
  }
  return next();
}

/** Middleware appareil : vérifie (deviceId, token) et attache req.gatewayDevice. */
async function deviceGuard(req, res, next) {
  const deviceId = String(req.headers['x-gateway-device'] || '');
  const token = String(req.headers['x-gateway-token'] || '');
  if (!deviceId || !token) {
    return res.status(401).json({ error: 'En-têtes appareil requis.', code: 'DEVICE_AUTH_REQUIRED' });
  }
  const ok = await androidGW.verifyDevice(deviceId, token);
  if (!ok) {
    logger.warn('[GatewayAPI] appareil refusé', { deviceId: deviceId.slice(0, 10) + '…' });
    return res.status(401).json({ error: 'Appareil inconnu, révoqué ou jeton invalide.', code: 'DEVICE_UNAUTHORIZED' });
  }
  req.gatewayDevice = deviceId;
  return next();
}

/* ── Administration ─────────────────────────────────────────── */

/** POST /api/gateway/register {name?} → {deviceId, token} (jeton affiché UNE fois). */
router.post('/register', adminGuard, async (req, res) => {
  const r = await androidGW.registerDevice(req.body && req.body.name);
  if (!r.ok) return res.status(500).json({ error: 'Enregistrement impossible.', code: 'REGISTER_FAILED' });
  return res.status(201).json({
    deviceId: r.deviceId,
    token   : r.token, // UNE SEULE fois — stocké hashé côté serveur
    hint    : 'Conservez ce jeton : il ne sera plus jamais renvoyé. En-têtes appareil : x-gateway-device + x-gateway-token.',
  });
});

/** POST /api/gateway/devices/:deviceId/revoke → révocation immédiate. */
router.post('/devices/:deviceId/revoke', adminGuard, async (req, res) => {
  const r = await androidGW.revokeDevice(req.params.deviceId);
  if (!r.ok) return res.status(500).json({ error: 'Révocation impossible.', code: 'REVOKE_FAILED' });
  return res.status(200).json({ ok: true, revoked: req.params.deviceId });
});

/** GET /api/gateway/devices → liste SANS hash de jeton. */
router.get('/devices', adminGuard, async (req, res) => {
  const db = (() => { try { return require('../config/firebase'); } catch (_) { return null; } })();
  if (!db) return res.status(500).json({ error: 'DB indisponible.', code: 'NO_DB' });
  try {
    const snap = await db.collection('gateway_devices').limit(50).get();
    const devices = (snap.docs || []).map((d) => {
      const x = d.data() || {};
      return { deviceId: x.deviceId, name: x.name, status: x.status, createdAt: x.createdAt, lastSeenAt: x.lastSeenAt || null };
    });
    return res.status(200).json({ devices });
  } catch (err) {
    return res.status(500).json({ error: 'Lecture impossible.', code: 'SERVER_ERROR' });
  }
});

/** GET /api/gateway/outbox/stats → compteurs par statut. */
router.get('/outbox/stats', adminGuard, async (req, res) => {
  const stats = await androidGW.outboxStats();
  if (!stats) return res.status(500).json({ error: 'DB indisponible.', code: 'NO_DB' });
  return res.status(200).json({ outbox: stats, maxAttempts: process.env.GATEWAY_MAX_ATTEMPTS ? parseInt(process.env.GATEWAY_MAX_ATTEMPTS, 10) : 3 });
});

/* ── Appareil passerelle ────────────────────────────────────── */

/** POST /api/gateway/claim {limit?} → {tasks:[{messageId,to,text,attempts}]} */
router.post('/claim', deviceGuard, async (req, res) => {
  const r = await androidGW.claimTasks(req.gatewayDevice, req.body && req.body.limit);
  if (!r.ok) return res.status(500).json({ error: 'Claim impossible.', code: 'CLAIM_FAILED' });
  return res.status(200).json({ tasks: r.tasks });
});

/** POST /api/gateway/result {messageId, success, error?} → conclusion de tâche. */
router.post('/result', deviceGuard, async (req, res) => {
  const { messageId, success, error } = req.body || {};
  if (!messageId || typeof success !== 'boolean') {
    return res.status(400).json({ error: 'messageId et success (booléen) requis.', code: 'BAD_REQUEST' });
  }
  const r = await androidGW.applyResult({ deviceId: req.gatewayDevice, messageId, success, error });
  if (!r.ok) {
    const map = { NOT_FOUND: 404, FORBIDDEN: 403, BAD_REQUEST: 400 };
    return res.status(map[r.code] || 500).json({ error: r.code, code: r.code });
  }
  return res.status(200).json({ ok: true, status: r.status || 'already', already: !!r.already });
});

module.exports = router;
