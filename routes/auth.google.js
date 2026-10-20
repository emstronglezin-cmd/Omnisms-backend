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
    'GOOGLE_WEB_REDIRECT_NOT_CONFIGURED', 'GOOGLE_REDIRECT_MISCONFIGURED',
  ]);
  return safeCodes.has(code) ? code : 'GOOGLE_AUTH_FAILED';
}

/** Returns 'web' only for ?target=web; every other value keeps the legacy app deep link. */
function requestedVariant(req) {
  return req.query.target === 'web' ? 'web' : 'app';
}

/** Safe trace of a redirect target: scheme, host and path only — never the query string (code/error params). */
function redirectDestination(target) {
  try {
    const u = new URL(target);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch (_) {
    return 'UNPARSABLE';
  }
}

async function startLogin(req, res) {
  if (!google.isConfigured()) return unavailable(res);
  const variant = requestedVariant(req);
  try {
    if (variant === 'web') google.safeAppRedirect('login', 'web'); // fail-fast if the web redirect is not configured
    else google.safeAppRedirect('login', 'app'); // garde-fou APK : 503 immédiat si le retour « app » pointe vers une PWA (config écrasée)
    const state = await google.createState('login', null, variant);
    return res.redirect(302, google.authorizationUrl(state));
  } catch (err) {
    if (err.code === 'GOOGLE_WEB_REDIRECT_NOT_CONFIGURED' || err.code === 'GOOGLE_REDIRECT_MISCONFIGURED') {
      logger.error('[Google OAuth] Web redirect unavailable', { event: 'APP_EXCHANGE_FAILED', code: err.code });
      return res.status(503).json({ success: false, error: 'Retour web Google non configuré côté serveur.', code: err.code });
    }
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
    const variant = stateData.returnTarget === 'web' ? 'web' : 'app';
    if (req.query.error) {
      const target = google.appendAppParams({ error: 'GOOGLE_OAUTH_DENIED' }, 'login', variant);
      logger.info('[Google OAuth] User denied consent; redirecting to app', { event: 'APP_REDIRECT_TARGET', destination: redirectDestination(target) });
      return res.redirect(302, target);
    }

    const { profile } = await google.exchangeAndVerify(req.query.code);
    const account = await google.findOrCreateOmniUser(profile);
    const code = await google.createLoginExchange(account.id);
    const target = google.appendAppParams({ code }, 'login', variant);
    logger.info('[Google OAuth] Login completed; app exchange code issued', {
      event: 'APP_EXCHANGE_CODE_ISSUED',
      uid: account.id,
      destination: redirectDestination(target),
    });
    return res.redirect(302, target);
  } catch (err) {
    const errorCode = publicOAuthError(err.code);
    logger.warn('[Google OAuth] Login callback failed', { code: err.code || 'INTERNAL' });
    if (stateData) {
      // Same variant as the request; fall back to the app deep link if the web target is misconfigured.
      let target;
      try {
        target = google.appendAppParams({ error: errorCode }, 'login', stateData.returnTarget === 'web' ? 'web' : 'app');
      } catch (_) {
        target = google.appendAppParams({ error: errorCode }, 'login', 'app');
      }
      logger.warn('[Google OAuth] Redirecting error to app', { event: 'APP_REDIRECT_TARGET', destination: redirectDestination(target), reason: errorCode });
      return res.redirect(302, target);
    }
    return res.status(400).json({ success: false, error: 'Réponse Google invalide.', code: errorCode });
  }
}

async function exchangeLogin(req, res) {
  const code = req.body && req.body.code;
  // Safe trace: presence/length only — the exchange code value is never logged.
  logger.info('[Google OAuth] App exchange request received', {
    event: 'APP_EXCHANGE_REQUEST_RECEIVED',
    hasCode: typeof code === 'string',
    codeLength: typeof code === 'string' ? code.length : 0,
  });
  try {
    const session = await google.redeemLoginExchange(code);
    if (!session) {
      logger.warn('[Google OAuth] App exchange rejected: code invalid, expired or already used', {
        event: 'APP_EXCHANGE_FAILED',
        reason: 'GOOGLE_EXCHANGE_CODE_INVALID',
      });
      return res.status(401).json({ success: false, error: 'Code de connexion expiré ou déjà utilisé.', code: 'GOOGLE_EXCHANGE_CODE_INVALID' });
    }
    logger.info('[Google OAuth] App session created (exchange validated and consumed)', {
      event: 'APP_SESSION_CREATED',
      uid: session.user && session.user.id,
    });
    return res.status(200).json({ success: true, ...session });
  } catch (err) {
    logger.error('[Google OAuth] Login exchange failed', { event: 'APP_EXCHANGE_FAILED', code: err.code || 'INTERNAL' });
    return res.status(500).json({ success: false, error: 'Impossible de finaliser la session OmniSMS.', code: 'GOOGLE_EXCHANGE_FAILED' });
  }
}

async function authorizeContacts(req, res) {
  if (!google.isConfigured()) return unavailable(res);
  const uid = req.user && (req.user.uid || req.user.userId || req.user.sub);
  if (!uid) return res.status(401).json({ success: false, error: 'Session OmniSMS invalide.', code: 'INVALID_SESSION' });
  const variant = requestedVariant(req);
  try {
    if (variant === 'web') google.safeAppRedirect('contacts', 'web'); // fail-fast if the web redirect is not configured
    const state = await google.createState('contacts', uid, variant);
    const url = google.authorizationUrl(state, { contacts: true });
    return res.status(200).json({
      success: true,
      authorizationRequired: true,
      authorizationUrl: url,
      redirectUri: google.safeAppRedirect('contacts', variant),
      scope: google.CONTACTS_SCOPE,
    });
  } catch (err) {
    if (err.code === 'GOOGLE_WEB_REDIRECT_NOT_CONFIGURED' || err.code === 'GOOGLE_REDIRECT_MISCONFIGURED') {
      logger.error('[Google Contacts] Web redirect unavailable', { code: err.code, uid });
      return res.status(503).json({ success: false, error: 'Retour web Google non configuré côté serveur.', code: err.code });
    }
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
    const variant = stateData.returnTarget === 'web' ? 'web' : 'app';
    if (req.query.error) {
      const target = google.appendAppParams({ error: 'GOOGLE_OAUTH_DENIED' }, 'contacts', variant);
      logger.info('[Google Contacts] User denied consent; redirecting to app', { event: 'APP_REDIRECT_TARGET', destination: redirectDestination(target) });
      return res.redirect(302, target);
    }

    const { profile, tokens } = await google.exchangeAndVerify(req.query.code, { contacts: true });
    const db = google.getDb();
    const userRef = db.collection('users').doc(stateData.userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.redirect(302, google.appendAppParams({ error: 'GOOGLE_CONTACTS_AUTH_FAILED' }, 'contacts', variant));
    }
    const user = userSnap.data();
    if (user.googleOAuthSub && user.googleOAuthSub !== profile.googleUid) {
      return res.redirect(302, google.appendAppParams({ error: 'GOOGLE_CONTACTS_ACCOUNT_MISMATCH' }, 'contacts', variant));
    }
    await google.saveContactsCredential(stateData.userId, profile, tokens.refresh_token);
    const target = google.appendAppParams({ authorized: '1' }, 'contacts', variant);
    logger.info('[Google Contacts] Authorization stored; redirecting to app', {
      event: 'APP_REDIRECT_TARGET',
      uid: stateData.userId,
      destination: redirectDestination(target),
    });
    return res.redirect(302, target);
  } catch (err) {
    const errorCode = publicOAuthError(err.code === 'GOOGLE_ENCRYPTION_NOT_CONFIGURED' ? err.code : 'GOOGLE_CONTACTS_AUTH_FAILED');
    logger.warn('[Google Contacts] OAuth callback failed', { code: err.code || 'INTERNAL', uid: stateData && stateData.userId });
    if (stateData) {
      // Same variant as the request; fall back to the app deep link if the web target is misconfigured.
      let target;
      try {
        target = google.appendAppParams({ error: errorCode }, 'contacts', stateData.returnTarget === 'web' ? 'web' : 'app');
      } catch (_) {
        target = google.appendAppParams({ error: errorCode }, 'contacts', 'app');
      }
      logger.warn('[Google Contacts] Redirecting error to app', { event: 'APP_REDIRECT_TARGET', destination: redirectDestination(target), reason: errorCode });
      return res.redirect(302, target);
    }
    return res.status(400).json({ success: false, error: 'Réponse Google Contacts invalide.', code: 'GOOGLE_STATE_INVALID' });
  }
}

router.get('/google', startLogin);
router.get('/google/callback', finishLogin);
router.post('/google/exchange', exchangeLogin);
router.post('/google/contacts/authorize', authenticate, authorizeContacts);
router.get('/google/contacts/callback', finishContacts);

module.exports = router;
