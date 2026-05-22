'use strict';
/**
 * OmniSMS — Routes Contacts & Envoi SMS
 *
 * POST /add-contact                  → Ajouter un contact (API)
 * GET  /contacts/:userId             → Lister les contacts d'un utilisateur
 * DELETE /contacts/:userId/:phone    → Supprimer un contact
 * POST /send-sms                     → Envoyer un SMS (API REST)
 */

const express      = require('express');
const router       = express.Router();
const { body, param, validationResult } = require('express-validator');
const authenticate = require('../middleware/authenticate');
const UserSms      = require('../models/UserSms');
const { sendSMS }  = require('../services/smsProvider');
const { logger }   = require('../middleware/logger');
const { normalizePhone } = require('../config/db');

// Helper validation
function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error : 'Données invalides.',
      code  : 'VALIDATION_ERROR',
      fields: errors.array().map(e => ({ field: e.path, msg: e.msg })),
    });
  }
  return null;
}

// Lien d'abonnement LeekPay
const SUBSCRIPTION_LINK = process.env.FRONTEND_URL
  || `${process.env.BACKEND_URL || 'https://omnisms-backend.onrender.com'}/api/payment/link`;

// ─────────────────────────────────────────────────────────────
// POST /add-contact
// ─────────────────────────────────────────────────────────────
/**
 * @body { userId: string, name: string, phone: string }
 * Ajouter un contact dans le carnet d'adresses d'un utilisateur.
 * userId = numéro de téléphone normalisé du propriétaire.
 */
router.post(
  '/add-contact',
  authenticate,
  [
    body('userId').trim().notEmpty().withMessage('userId est requis.'),
    body('name').trim().isLength({ min: 1, max: 60 }).withMessage('name doit contenir entre 1 et 60 caractères.'),
    body('phone').trim().matches(/^\+?[0-9\s\-().]{7,20}$/).withMessage('Numéro de téléphone invalide.'),
  ],
  async (req, res) => {
  const validationError = validate(req, res);
  if (validationError) return;

  const { userId, name, phone } = req.body;

  // Sécurité : un utilisateur ne peut modifier que son propre carnet
  const ownerPhone = normalizePhone(userId);
  if (req.user.uid !== ownerPhone && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    const contactPhone = normalizePhone(phone);
    const { added, contact } = await UserSms.addContact(ownerPhone, name, contactPhone);

    logger.info('Contact ajouté via API', { owner: ownerPhone, contact: contactPhone });

    return res.status(added ? 201 : 200).json({
      success: true,
      added,
      contact,
      message: added ? `Contact ${name} ajouté avec succès.` : `Contact ${name} existait déjà.`,
    });
  } catch (err) {
    logger.error('Erreur POST /add-contact', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /contacts/:userId
// ─────────────────────────────────────────────────────────────
/**
 * Récupérer tous les contacts d'un utilisateur.
 * userId = numéro de téléphone normalisé.
 */
router.get('/contacts/:userId', authenticate, async (req, res) => {
  const ownerPhone = normalizePhone(req.params.userId);

  // Sécurité : un utilisateur ne peut voir que son propre carnet
  if (req.user.uid !== ownerPhone && req.user.uid !== req.params.userId) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    const user = await UserSms.getByPhone(ownerPhone);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
    }

    return res.status(200).json({
      userId  : ownerPhone,
      count   : (user.contacts || []).length,
      contacts: user.contacts || [],
    });
  } catch (err) {
    logger.error('Erreur GET /contacts', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /send-sms
// ─────────────────────────────────────────────────────────────
/**
 * @body { userId: string, target: string, message: string }
 * Envoyer un SMS via l'API REST.
 * target peut être :
 *   - "@Jean"         → cherche dans les contacts
 *   - "+22670000000"  → numéro direct
 *   - "70000000"      → numéro sans indicatif (Burkina Faso par défaut)
 */
router.post('/send-sms', authenticate, async (req, res) => {
  const { userId, target, message } = req.body;

  if (!userId || !target || !message) {
    return res.status(400).json({
      error: 'userId, target et message sont requis.',
      code : 'MISSING_FIELDS',
      example: {
        userId : '+22670000000',
        target : '@Jean',   // ou "+22671000000"
        message: 'Bonjour !',
      },
    });
  }

  if (message.trim().length === 0) {
    return res.status(400).json({ error: 'Le message ne peut pas être vide.', code: 'EMPTY_MESSAGE' });
  }

  if (message.length > 1600) {
    return res.status(400).json({ error: 'Message trop long (max 1600 caractères).', code: 'MESSAGE_TOO_LONG' });
  }

  const ownerPhone = normalizePhone(userId);

  // Sécurité : contrôle d'accès
  if (req.user.uid !== ownerPhone && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    const user = await UserSms.getByPhone(ownerPhone);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
    }

    // Vérifier abonnement ou quota
    if (!user.isSubscribed) {
      const { allowed, remaining } = await UserSms.decrementQuota(ownerPhone);
      if (!allowed) {
        return res.status(403).json({
          error       : 'Quota SMS épuisé. Passez Premium pour un envoi illimité.',
          code        : 'QUOTA_EXCEEDED',
          remaining   : 0,
          upgradeUrl  : SUBSCRIPTION_LINK,
        });
      }
      logger.info('Quota SMS décrémenté', { phone: ownerPhone, remaining });
    }

    // Résoudre le destinataire
    const resolved = await UserSms.resolveTarget(ownerPhone, target);

    if (!resolved) {
      // Suggérer d'enregistrer le contact
      const suggestion = target.startsWith('@')
        ? `Ajoutez ce contact : POST /add-contact { name: "${target.slice(1)}", phone: "NUMERO" }`
        : null;

      return res.status(404).json({
        error     : `Destinataire "${target}" non trouvé.`,
        code      : 'TARGET_NOT_FOUND',
        suggestion,
      });
    }

    // Envoyer le SMS
    const result = await sendSMS(resolved.phone, message.trim());

    if (result.success) {
      logger.info('SMS envoyé via API', {
        from    : ownerPhone,
        to      : resolved.phone,
        provider: result.provider,
      });

      return res.status(200).json({
        success     : true,
        to          : resolved.phone,
        name        : resolved.name,
        provider    : result.provider,
        attempts    : result.attempts,
        message     : `SMS envoyé à ${resolved.name || resolved.phone}.`,
      });
    }

    // Provider non configuré
    if (result.provider === 'none') {
      return res.status(503).json({
        success: false,
        error  : 'Service SMS non configuré sur ce serveur.',
        code   : 'SMS_PROVIDER_NOT_CONFIGURED',
      });
    }

    return res.status(502).json({
      success : false,
      error   : `Échec envoi SMS après ${result.attempts} tentative(s) : ${result.error}`,
      code    : 'SMS_SEND_FAILED',
      attempts: result.attempts,
    });

  } catch (err) {
    logger.error('Erreur POST /send-sms', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /contacts/:userId/:contactPhone
// ─────────────────────────────────────────────────────────────
router.delete('/contacts/:userId/:contactPhone', authenticate, async (req, res) => {
  const ownerPhone   = normalizePhone(req.params.userId);
  const contactPhone = normalizePhone(req.params.contactPhone);

  if (req.user.uid !== ownerPhone && req.user.uid !== req.params.userId) {
    return res.status(403).json({ error: 'Accès refusé.', code: 'FORBIDDEN' });
  }

  try {
    await UserSms.removeContact(ownerPhone, contactPhone);
    return res.status(200).json({ success: true, message: 'Contact supprimé.' });
  } catch (err) {
    logger.error('Erreur DELETE /contacts', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

module.exports = router;
