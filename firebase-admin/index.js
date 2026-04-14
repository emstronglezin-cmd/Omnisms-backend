'use strict';
/**
 * OmniSMS — Firebase Admin SDK (Production)
 *
 * Initialisation unique du SDK Firebase Admin.
 * Credentials chargées UNIQUEMENT depuis la variable d'environnement
 * FIREBASE_SERVICE_ACCOUNT_JSON (JSON stringifié du service account).
 *
 * En production (Render) : définir cette variable dans le dashboard.
 * En développement local : créer un fichier .env avec la variable.
 *
 * Si la variable est absente → le serveur refuse de démarrer.
 * Zéro fallback, zéro mock, zéro données en mémoire.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    console.error('❌ [Firebase] FIREBASE_SERVICE_ACCOUNT_JSON est absent.');
    console.error('   Ajoutez cette variable dans votre fichier .env ou dans les');
    console.error('   variables d\'environnement Render (Settings → Environment).');
    console.error('   Valeur attendue : le contenu JSON du service account Firebase.');
    process.exit(1); // Arrêt immédiat — impossible de démarrer sans Firebase
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (parseErr) {
    console.error('❌ [Firebase] FIREBASE_SERVICE_ACCOUNT_JSON est invalide (JSON malformé).');
    console.error('   Assurez-vous que la valeur est un JSON valide (sans retour à la ligne).');
    console.error('   Détail :', parseErr.message);
    process.exit(1);
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ [Firebase] SDK Admin initialisé — projet :', serviceAccount.project_id);
  } catch (initErr) {
    console.error('❌ [Firebase] Échec initializeApp :', initErr.message);
    process.exit(1);
  }
}

module.exports = admin;
