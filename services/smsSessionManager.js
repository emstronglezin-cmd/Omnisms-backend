'use strict';
/**
 * OmniSMS — SMS Session Manager (stub de compatibilité)
 *
 * Le système de commandes SMS est stateless (pas de sessions nécessaires).
 * Ce fichier est conservé pour la compatibilité avec du code legacy.
 * Les nouvelles fonctionnalités sont dans services/smsHandler.js
 */

// Stub silencieux — pas de console.warn en production
const startSession = (_userId) => {};
const endSession   = (_userId) => {};

module.exports = { startSession, endSession };
