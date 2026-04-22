'use strict';
/**
 * OmniSMS — Firebase Services (Production)
 *
 * Expose :
 *  - admin      : instance Firebase Admin SDK
 *  - db         : instance Firestore
 *  - messaging  : Firebase Cloud Messaging
 *  - sendNotification(token, title, body) : envoyer une notification push
 */

const admin = require('../firebase-admin/index');

const db        = admin.firestore();
const messaging = admin.messaging();

/**
 * Envoyer une notification push FCM.
 * @param {string} fcmToken  - Token FCM de l'appareil
 * @param {string} title     - Titre de la notification
 * @param {string} body      - Corps de la notification
 * @param {object} [data]    - Données supplémentaires (optionnel)
 */
async function sendNotification(fcmToken, title, body, data = {}) {
  if (!fcmToken) {
    console.warn('⚠️  [FCM] sendNotification : token FCM manquant, ignoré');
    return null;
  }

  const message = {
    notification: { title, body },
    data        : Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    token: fcmToken,
  };

  try {
    const response = await messaging.send(message);
    console.log('✅ [FCM] Notification envoyée :', response);
    return response;
  } catch (error) {
    console.error('❌ [FCM] Erreur envoi notification :', error.message);
    throw error;
  }
}

module.exports = { admin, db, messaging, sendNotification };
