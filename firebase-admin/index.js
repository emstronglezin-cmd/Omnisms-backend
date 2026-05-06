'use strict';
/**
 * OmniSMS — Firebase Admin SDK
 *
 * Graceful initialization — never calls process.exit().
 * If FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid, exports a stub
 * that rejects Promises at call time so routes can respond 503 instead of crashing.
 *
 * Production (Render): set FIREBASE_SERVICE_ACCOUNT_JSON in Environment Variables.
 */

const admin = require('firebase-admin');

/* ── Async-safe stub (all terminal ops return rejected Promises) ── */
function makeStub(reason) {
  const reject = () =>
    Promise.reject(
      new Error('[Firebase] Not available: ' + reason +
        '. Set FIREBASE_SERVICE_ACCOUNT_JSON in Render env vars.')
    );

  function firestoreStub() {
    const fs = {
      collection : () => fs,
      doc        : () => fs,
      where      : () => fs,
      orderBy    : () => fs,
      limit      : () => fs,
      startAfter : () => fs,
      select     : () => fs,
      settings   : () => {},
      // terminal ops — async rejected, never blocking
      get    : reject,
      add    : reject,
      set    : reject,
      update : reject,
      delete : reject,
    };
    return fs;
  }

  return {
    _stub    : true,
    _reason  : reason,
    firestore: firestoreStub,
    auth     : () => ({
      verifyIdToken : reject,
      getUser       : reject,
      createUser    : reject,
    }),
    apps: [],
  };
}

let adminInstance;

if (admin.apps.length) {
  // Already initialized (e.g. hot-reload or double require)
  adminInstance = admin;
} else {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON absent — degraded stub mode.');
    console.warn('[Firebase] Firebase-dependent routes will return HTTP 503.');
    console.warn('[Firebase] Add the variable in Render: Settings → Environment.');
    adminInstance = makeStub('FIREBASE_SERVICE_ACCOUNT_JSON absent');
  } else {
    let sa;
    try { sa = JSON.parse(raw); } catch (e) {
      console.error('[Firebase] Invalid JSON in FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
      adminInstance = makeStub('malformed JSON: ' + e.message);
      sa = null;
    }

    if (sa) {
      try {
        admin.initializeApp({ credential: admin.credential.cert(sa) });
        console.log('[Firebase] Admin SDK initialized — project:', sa.project_id || '(unknown)');
        adminInstance = admin;
      } catch (e) {
        console.error('[Firebase] initializeApp failed:', e.message);
        adminInstance = makeStub('initializeApp failed: ' + e.message);
      }
    }
  }
}

module.exports = adminInstance;
