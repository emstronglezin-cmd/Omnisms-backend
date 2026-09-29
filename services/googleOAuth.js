'use strict';

/**
 * Google OAuth support for OmniSMS.
 * Google OAuth credentials are kept separate from the OmniSMS JWT session.
 */
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { signToken } = require('../middleware/authenticate');
const { normalizeEmail } = require('./userResolver');

const LOGIN_SCOPES = ['openid', 'email', 'profile'];
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
const DEFAULT_FLUTTER_REDIRECT = 'omnisms://auth/google/callback';
const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 2 * 60 * 1000;

function getConfig() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: (process.env.GOOGLE_REDIRECT_URI || '').trim(),
    flutterRedirectUri: (process.env.GOOGLE_FLUTTER_REDIRECT_URI || DEFAULT_FLUTTER_REDIRECT).trim(),
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.clientId && c.clientSecret && c.redirectUri && c.flutterRedirectUri);
}

function createOAuthClient() {
  const c = getConfig();
  if (!c.clientId || !c.clientSecret || !c.redirectUri) {
    throw Object.assign(new Error('Google OAuth is not configured.'), { code: 'GOOGLE_NOT_CONFIGURED' });
  }
  return new OAuth2Client(c.clientId, c.clientSecret, c.redirectUri);
}

function safeAppRedirect(purpose = 'login') {
  const target = purpose === 'contacts'
    ? (process.env.GOOGLE_CONTACTS_FLUTTER_REDIRECT_URI || 'omnisms://auth/google/contacts/callback').trim()
    : getConfig().flutterRedirectUri;
  try {
    const parsed = new URL(target);
    if (!['omnisms:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported redirect scheme');
    return target;
  } catch (_) {
    throw Object.assign(new Error('Flutter redirect URI is invalid.'), { code: 'GOOGLE_REDIRECT_MISCONFIGURED' });
  }
}

function appendAppParams(values, purpose = 'login') {
  const target = new URL(safeAppRedirect(purpose));
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function getDb() {
  const db = require('../config/firebase');
  if (!db || db._stub) throw Object.assign(new Error('Firestore unavailable.'), { code: 'DB_UNAVAILABLE' });
  return db;
}

async function createState(purpose, userId = null) {
  const db = getDb();
  const state = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.collection('google_oauth_states').doc(state).create({
    purpose,
    userId,
    createdAtMs: now,
    expiresAtMs: now + STATE_TTL_MS,
    consumed: false,
  });
  return state;
}

async function consumeState(state, expectedPurpose) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(state)) return null;
  const db = getDb();
  const ref = db.collection('google_oauth_states').doc(state);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.consumed || data.purpose !== expectedPurpose || Number(data.expiresAtMs) < Date.now()) return null;
    tx.update(ref, { consumed: true, consumedAtMs: Date.now() });
    return data;
  });
}

function authorizationUrl(state, { contacts = false } = {}) {
  const client = createOAuthClient();
  const params = {
    access_type: contacts ? 'offline' : 'online',
    include_granted_scopes: contacts ? 'true' : 'false',
    prompt: contacts ? 'consent' : 'select_account',
    state,
    scope: contacts ? [...LOGIN_SCOPES, CONTACTS_SCOPE] : LOGIN_SCOPES,
    response_type: 'code',
  };
  return client.generateAuthUrl(params);
}

async function exchangeAndVerify(code) {
  if (!code || typeof code !== 'string' || code.length > 4096) {
    throw Object.assign(new Error('Google authorization code is missing or invalid.'), { code: 'GOOGLE_CODE_INVALID' });
  }
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw Object.assign(new Error('Google did not return an identity token.'), { code: 'GOOGLE_IDENTITY_MISSING' });
  }
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: getConfig().clientId });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    throw Object.assign(new Error('Google identity is not verified.'), { code: 'GOOGLE_IDENTITY_INVALID' });
  }
  return {
    tokens,
    profile: {
      googleUid: String(payload.sub),
      email: normalizeEmail(payload.email),
      name: payload.name || payload.given_name || payload.email.split('@')[0],
      givenName: payload.given_name || null,
      familyName: payload.family_name || null,
      picture: payload.picture || null,
    },
  };
}

function hashed(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Resolve by stable Google subject/email, then atomically claim both identity indexes. */
async function findOrCreateOmniUser(profile) {
  const db = getDb();
  const identityRef = db.collection('google_oauth_identities').doc(hashed(profile.googleUid));
  const emailRef = db.collection('google_oauth_emails').doc(hashed(profile.email));

  const [identitySnap, emailSnap] = await Promise.all([identityRef.get(), emailRef.get()]);
  let matchedId = identitySnap.exists ? identitySnap.data().userId : (emailSnap.exists ? emailSnap.data().userId : null);
  let matchedUser;

  if (!matchedId) {
    const byGoogle = await db.collection('users').where('googleOAuthSub', '==', profile.googleUid).limit(1).get();
    if (!byGoogle.empty) matchedId = byGoogle.docs[0].id;
  }
  if (!matchedId) {
    const byEmail = await db.collection('users').where('email', '==', profile.email).limit(1).get();
    if (!byEmail.empty) matchedId = byEmail.docs[0].id;
  }

  const userRef = matchedId ? db.collection('users').doc(matchedId) : db.collection('users').doc();
  let finalId = userRef.id;
  const now = new Date().toISOString();

  await db.runTransaction(async tx => {
    const [identity, emailClaim, userSnap] = await Promise.all([
      tx.get(identityRef), tx.get(emailRef), tx.get(userRef),
    ]);
    if (identity.exists && emailClaim.exists && identity.data().userId !== emailClaim.data().userId) {
      throw Object.assign(new Error('Google identity and email belong to different OmniSMS accounts.'), { code: 'GOOGLE_IDENTITY_CONFLICT' });
    }
    const claimedId = identity.exists ? identity.data().userId : (emailClaim.exists ? emailClaim.data().userId : null);
    if (claimedId && claimedId !== userRef.id) {
      const claimedUserRef = db.collection('users').doc(claimedId);
      const claimedUserSnap = await tx.get(claimedUserRef);
      if (!claimedUserSnap.exists) throw Object.assign(new Error('Google identity claim is inconsistent.'), { code: 'GOOGLE_IDENTITY_CONFLICT' });
      matchedUser = claimedUserSnap.data();
      if (matchedUser.googleOAuthSub && matchedUser.googleOAuthSub !== profile.googleUid) {
        throw Object.assign(new Error('This account is linked to another Google identity.'), { code: 'GOOGLE_IDENTITY_CONFLICT' });
      }
      tx.set(claimedUserRef, {
        googleOAuthSub: profile.googleUid,
        googleEmail: profile.email,
        avatar: matchedUser.avatar || profile.picture || null,
        lastLoginAt: now,
        updatedAt: now,
      }, { merge: true });
      tx.set(identityRef, { userId: claimedId, createdAt: now }, { merge: true });
      tx.set(emailRef, { userId: claimedId, updatedAt: now }, { merge: true });
      finalId = claimedId;
      return;
    }

    if (userSnap.exists) {
      matchedUser = userSnap.data();
      if (matchedUser.googleOAuthSub && matchedUser.googleOAuthSub !== profile.googleUid) {
        throw Object.assign(new Error('This account is linked to another Google identity.'), { code: 'GOOGLE_IDENTITY_CONFLICT' });
      }
      tx.set(userRef, {
        googleOAuthSub: profile.googleUid,
        googleEmail: profile.email,
        avatar: matchedUser.avatar || profile.picture || null,
        lastLoginAt: now,
        updatedAt: now,
      }, { merge: true });
    } else {
      matchedUser = {
        name: profile.name,
        email: profile.email,
        googleOAuthSub: profile.googleUid,
        googleEmail: profile.email,
        avatar: profile.picture,
        phone: null,
        password: null,
        provider: 'google',
        isSubscribed: false,
        credits: 0,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      };
      tx.create(userRef, matchedUser);
    }
    tx.set(identityRef, { userId: userRef.id, createdAt: now }, { merge: true });
    tx.set(emailRef, { userId: userRef.id, updatedAt: now }, { merge: true });
  });

  const finalSnap = await db.collection('users').doc(finalId).get();
  if (!finalSnap.exists) throw Object.assign(new Error('OmniSMS user not found after Google linking.'), { code: 'GOOGLE_USER_NOT_FOUND' });
  return { id: finalId, data: finalSnap.data() };
}

function publicUser(id, data) {
  return {
    id,
    name: data.name || null,
    username: data.username || null,
    email: data.email || null,
    phone: data.phone || null,
    avatar: data.avatar || null,
    phoneVerified: data.phoneVerified !== false,
    isSubscribed: data.isSubscribed === true,
    credits: Number(data.credits) || 0,
    needsPhone: !data.phone,
  };
}

async function createLoginExchange(userId) {
  const db = getDb();
  const code = crypto.randomBytes(32).toString('base64url');
  const codeId = hashed(code);
  await db.collection('google_login_exchanges').doc(codeId).create({
    userId,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + EXCHANGE_TTL_MS,
    consumed: false,
  });
  return code;
}

async function redeemLoginExchange(code) {
  if (typeof code !== 'string' || code.length < 40 || code.length > 100) return null;
  const db = getDb();
  const ref = db.collection('google_login_exchanges').doc(hashed(code));
  let userId = null;
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    if (data.consumed || Number(data.expiresAtMs) < Date.now()) return;
    userId = data.userId;
    tx.update(ref, { consumed: true, consumedAtMs: Date.now() });
  });
  if (!userId) return null;
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  const token = signToken({ uid: userId, email: data.email || data.phone, name: data.name });
  return { token, user: publicUser(userId, data) };
}

function getEncryptionKey() {
  const raw = (process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) throw Object.assign(new Error('Google token encryption is not configured.'), { code: 'GOOGLE_ENCRYPTION_NOT_CONFIGURED' });
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('Google token encryption key must be 32 bytes.'), { code: 'GOOGLE_ENCRYPTION_MISCONFIGURED' });
  return key;
}

function encryptRefreshToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64url')).join('.');
}

function decryptRefreshToken(encrypted) {
  try {
    const [iv, tag, ciphertext] = String(encrypted).split('.').map(v => Buffer.from(v, 'base64url'));
    if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted token');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err.code === 'GOOGLE_ENCRYPTION_NOT_CONFIGURED' || err.code === 'GOOGLE_ENCRYPTION_MISCONFIGURED') throw err;
    throw Object.assign(new Error('Stored Google authorization must be renewed.'), { code: 'GOOGLE_TOKEN_EXPIRED' });
  }
}

async function saveContactsCredential(userId, profile, refreshToken) {
  const db = getDb();
  const ref = db.collection('google_contacts_credentials').doc(userId);
  const existing = await ref.get();
  const previous = existing.exists ? existing.data() : {};
  const tokenToKeep = refreshToken || (previous.refreshTokenEncrypted ? decryptRefreshToken(previous.refreshTokenEncrypted) : null);
  if (!tokenToKeep) throw Object.assign(new Error('Google did not grant offline contacts access.'), { code: 'GOOGLE_REFRESH_TOKEN_MISSING' });
  await ref.set({
    googleOAuthSub: profile.googleUid,
    googleEmail: profile.email,
    refreshTokenEncrypted: encryptRefreshToken(tokenToKeep),
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

module.exports = {
  LOGIN_SCOPES, CONTACTS_SCOPE, DEFAULT_FLUTTER_REDIRECT,
  getConfig, isConfigured, createOAuthClient, safeAppRedirect, appendAppParams,
  createState, consumeState, authorizationUrl, exchangeAndVerify,
  findOrCreateOmniUser, publicUser, createLoginExchange, redeemLoginExchange,
  encryptRefreshToken, decryptRefreshToken, saveContactsCredential, getDb,
  STATE_TTL_MS, EXCHANGE_TTL_MS,
};
