'use strict';

/**
 * Flutter-compatible Google OAuth routes.
 * Login uses a short-lived one-time exchange code; the OmniSMS JWT never appears
 * in a browser redirect or deep-link query string.
 */
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { logger } = require('../middleware/logger');
const google = require('../services/googleOAuth');

function unavailable(res) {
  return res.status(503).json({
    success: false,
    error: 'Connexion Google non configurée.',
    code: 'GOOGLE_NOT_CONFIGURED',
  });
}

function publicOAuthError(code) {
  const safeCodes = new Set([
    'GOOGLE_OAUTH_DENIED', 'GOOGLE_CODE_INVALID', 'GOOGLE_IDENTITY_INVALID',
    'GOOGLE_IDENTITY_MISSING', 'GOOGLE_IDENTITY_CONFLICT', 'GOOGLE_AUTH_FAILED',
    'GOOGLE_CONTACTS_AUTH_FAILED', 'GOOGLE_CONTACTS_ACCOUNT_MISMATCH',
    'GOOGLE_REFRESH_TOKEN_MISSING', 'GOOGLE_ENCRYPTION_NOT_CONFIGURED',
  ]);
  return safeCodes.has(code) ? code : 'GOOGLE_AUTH_FAILED';
}

async function startLogin(_req, res) {
  if (!google.isConfigured()) return unavailable(res);
  try {
    const state = await google.createState('login');
    return res.redirect(302, google.authorizationUrl(state));
  } catch (err) {
    logger.error('[Google OAuth] Failed to start login', { code: err.code || 'INTERNAL' });
    return res.status(err.code === 'GOOGLE_NOT_CONFIGURED' ? 503 : 500).json({
      success: false,
      error: 'Impossible de démarrer la connexion Google.',
      code: err.code || 'GOOGLE_AUTH_FAILED',
    });
  }
}

async function finishLogin(req, res) {
  let stateData;
  try {
    stateData = await google.consumeState(req.query.state, 'login');
    if (!stateData) return res.status(400).json({ success: false, error: 'État OAuth invalide ou expiré.', code: 'GOOGLE_STATE_INVALID' });
    if (req.query.error) {
      return res.redirect(302, google.appendAppParams({ error: 'GOOGLE_OAUTH_DENIED' }));
    }

    const { profile } = await google.exchangeAndVerify(req.query.code);
    const account = await google.findOrCreateOmniUser(profile);
    const code = await google.createLoginExchange(account.id);
    logger.info('[Google OAuth] Login completed; app exchange code issued', { uid: account.id });
    return res.redirect(302, google.appendAppParams({ code }));
  } catch (err) {
    const errorCode = publicOAuthError(err.code);
    logger.warn('[Google OAuth] Login callback failed', { code: err.code || 'INTERNAL' });
    if (stateData) return res.redirect(302, google.appendAppParams({ error: errorCode }));
    return res.status(400).json({ success: false, error: 'Réponse Google invalide.', code: errorCode });
  }
}

async function exchangeLogin(req, res) {
  const code = req.body && req.body.code;
  try {
    const session = await google.redeemLoginExchange(code);
    if (!session) {
      return res.status(401).json({ success: false, error: 'Code de connexion expiré ou déjà utilisé.', code: 'GOOGLE_EXCHANGE_CODE_INVALID' });
    }
    return res.status(200).json({ success: true, ...session });
  } catch (err) {
    logger.error('[Google OAuth] Login exchange failed', { code: err.code || 'INTERNAL' });
    return res.status(500).json({ success: false, error: 'Impossible de finaliser la session OmniSMS.', code: 'GOOGLE_EXCHANGE_FAILED' });
  }
}

async function authorizeContacts(req, res) {
  if (!google.isConfigured()) return unavailable(res);
  const uid = req.user && (req.user.uid || req.user.userId || req.user.sub);
  if (!uid) return res.status(401).json({ success: false, error: 'Session OmniSMS invalide.', code: 'INVALID_SESSION' });
  try {
    const state = await google.createState('contacts', uid);
    const url = google.authorizationUrl(state, { contacts: true });
    return res.status(200).json({
      success: true,
      authorizationRequired: true,
      authorizationUrl: url,
      redirectUri: google.safeAppRedirect('contacts'),
      scope: google.CONTACTS_SCOPE,
    });
  } catch (err) {
    logger.error('[Google Contacts] Failed to create authorization URL', { code: err.code || 'INTERNAL', uid });
    return res.status(err.code === 'GOOGLE_NOT_CONFIGURED' ? 503 : 500).json({
      success: false,
      error: 'Impossible de démarrer l’autorisation Google Contacts.',
      code: err.code || 'GOOGLE_CONTACTS_AUTH_FAILED',
    });
  }
}

async function finishContacts(req, res) {
  let stateData;
  try {
    stateData = await google.consumeState(req.query.state, 'contacts');
    if (!stateData) return res.status(400).json({ success: false, error: 'État OAuth invalide ou expiré.', code: 'GOOGLE_STATE_INVALID' });
    if (req.query.error) {
      return res.redirect(302, google.appendAppParams({ error: 'GOOGLE_OAUTH_DENIED' }, 'contacts'));
    }

    const { profile, tokens } = await google.exchangeAndVerify(req.query.code, { contacts: true });
    const db = google.getDb();
    const userRef = db.collection('users').doc(stateData.userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.redirect(302, google.appendAppParams({ error: 'GOOGLE_CONTACTS_AUTH_FAILED' }, 'contacts'));
    }
    const user = userSnap.data();
    if (user.googleOAuthSub && user.googleOAuthSub !== profile.googleUid) {
      return res.redirect(302, google.appendAppParams({ error: 'GOOGLE_CONTACTS_ACCOUNT_MISMATCH' }, 'contacts'));
    }
    await google.saveContactsCredential(stateData.userId, profile, tokens.refresh_token);
    logger.info('[Google Contacts] Authorization stored', { uid: stateData.userId });
    return res.redirect(302, google.appendAppParams({ authorized: '1' }, 'contacts'));
  } catch (err) {
    const errorCode = publicOAuthError(err.code === 'GOOGLE_ENCRYPTION_NOT_CONFIGURED' ? err.code : 'GOOGLE_CONTACTS_AUTH_FAILED');
    logger.warn('[Google Contacts] OAuth callback failed', { code: err.code || 'INTERNAL', uid: stateData && stateData.userId });
    if (stateData) return res.redirect(302, google.appendAppParams({ error: errorCode }, 'contacts'));
    return res.status(400).json({ success: false, error: 'Réponse Google Contacts invalide.', code: 'GOOGLE_STATE_INVALID' });
  }
}

router.get('/google', startLogin);
router.get('/google/callback', finishLogin);
router.post('/google/exchange', exchangeLogin);
router.post('/google/contacts/authorize', authenticate, authorizeContacts);
router.get('/google/contacts/callback', finishContacts);

module.exports = router;
