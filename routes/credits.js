'use strict';
/**
 * OmniSMS — Routes Crédits
 *
 * Gestion des crédits SMS (bonus publicitaires, décrément à l'envoi).
 * Toutes les données sont persistées dans Firestore.
 *
 * Endpoints :
 *  POST /credits/add        → Ajouter des crédits à un utilisateur
 *  POST /credits/decrement  → Décrémenter des crédits
 *  GET  /credits/:userId    → Consulter le solde de crédits
 */

const express      = require('express');
const router       = express.Router();
const authenticate = require('../middleware/authenticate');
const db           = require('../config/firebase');
const { logger }   = require('../middleware/logger');

// ─────────────────────────────────────────────────────────────
// Helpers Firestore
// ─────────────────────────────────────────────────────────────

async function getUserDoc(userId) {
  const doc = await db.collection('users').doc(userId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// ─────────────────────────────────────────────────────────────
// POST /credits/add
// Ajouter des crédits (bonus pub, bonus quotidien, etc.)
// ─────────────────────────────────────────────────────────────
router.post('/add', authenticate, async (req, res) => {
  const { amount } = req.body;
  const uid = req.user.uid;

  if (!amount || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
    return res.status(400).json({
      error: 'amount doit être un entier positif.',
      code : 'INVALID_AMOUNT',
    });
  }

  try {
    const user = await getUserDoc(uid);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
    }

    const current  = user.credits || 0;
    const newTotal = current + amount;

    await db.collection('users').doc(uid).update({
      credits  : newTotal,
      updatedAt: new Date().toISOString(),
    });

    logger.info('Crédits ajoutés', { uid, added: amount, newTotal });

    return res.status(200).json({
      success : true,
      message : `${amount} crédit(s) ajouté(s).`,
      credits : newTotal,
    });
  } catch (err) {
    logger.error('Erreur POST /credits/add', { error: err.message, uid });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /credits/decrement
// Décrémenter des crédits (envoi de message)
// ─────────────────────────────────────────────────────────────
router.post('/decrement', authenticate, async (req, res) => {
  const { amount = 1 } = req.body;
  const uid = req.user.uid;

  if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
    return res.status(400).json({
      error: 'amount doit être un entier positif.',
      code : 'INVALID_AMOUNT',
    });
  }

  try {
    const user = await getUserDoc(uid);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
    }

    // Les abonnés premium ne consomment pas de crédits
    if (user.isSubscribed) {
      return res.status(200).json({
        success: true,
        message: 'Utilisateur Premium — crédits non consommés.',
        credits: user.credits || 0,
      });
    }

    const current = user.credits || 0;

    if (current < amount) {
      return res.status(400).json({
        error  : `Crédits insuffisants (solde : ${current}, requis : ${amount}).`,
        code   : 'INSUFFICIENT_CREDITS',
        credits: current,
      });
    }

    const newTotal = current - amount;

    await db.collection('users').doc(uid).update({
      credits  : newTotal,
      updatedAt: new Date().toISOString(),
    });

    logger.info('Crédits décrémentés', { uid, used: amount, remaining: newTotal });

    return res.status(200).json({
      success : true,
      message : `${amount} crédit(s) consommé(s).`,
      credits : newTotal,
    });
  } catch (err) {
    logger.error('Erreur POST /credits/decrement', { error: err.message, uid });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /credits/:userId
// Consulter le solde de crédits d'un utilisateur
// ─────────────────────────────────────────────────────────────
router.get('/:userId', authenticate, async (req, res) => {
  const { userId } = req.params;

  // Sécurité : un utilisateur ne peut voir que son propre solde (sauf admin)
  if (req.user.uid !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    const user = await getUserDoc(userId);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
    }

    return res.status(200).json({
      userId      : userId,
      credits     : user.credits || 0,
      isSubscribed: user.isSubscribed || false,
      message     : user.isSubscribed
        ? 'Utilisateur Premium — envoi illimité.'
        : `${user.credits || 0} crédit(s) disponible(s).`,
    });
  } catch (err) {
    logger.error('Erreur GET /credits/:userId', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
