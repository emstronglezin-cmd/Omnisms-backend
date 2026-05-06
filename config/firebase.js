'use strict';
/**
 * OmniSMS — Firestore instance
 * Returns real Firestore or async-safe stub (never crashes on load).
 */

const admin = require('../firebase-admin/index');

let db;

if (admin._stub) {
  // Firebase not configured — stub Firestore
  db = admin.firestore();
} else {
  try {
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
  } catch (err) {
    console.error('[Firestore] init failed:', err.message);
    // Build a local async-safe stub
    const rej = () => Promise.reject(new Error('[Firestore] unavailable: ' + err.message));
    db = {
      _stub: true,
      collection: function s() { return s; },
      doc: function s() { return s; },
      where: function s() { return s; },
      orderBy: function s() { return s; },
      limit: function s() { return s; },
      startAfter: function s() { return s; },
      select: function s() { return s; },
      settings: () => {},
      get: rej, add: rej, set: rej, update: rej, delete: rej,
    };
  }
}

module.exports = db;
