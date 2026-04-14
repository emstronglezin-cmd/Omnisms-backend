'use strict';
/**
 * OmniSMS — Firestore (Production)
 *
 * Exporte une instance Firestore connectée au vrai projet Firebase.
 * Utilisé par tous les modèles (User, Message, Group, etc.).
 *
 * La connexion passe par firebase-admin/index.js qui s'initialise
 * via FIREBASE_SERVICE_ACCOUNT_JSON.
 */

const admin = require('../firebase-admin/index');

const db = admin.firestore();

// Paramètres Firestore recommandés pour la production
db.settings({ ignoreUndefinedProperties: true });

module.exports = db;
