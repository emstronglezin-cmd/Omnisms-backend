'use strict';
/**
 * OmniSMS — Routes Contacts v2 (Workflow WhatsApp)
 *
 * Endpoints :
 *   POST /api/contacts/sync           → Synchroniser carnet d'adresses (bulk upload)
 *   POST /api/contacts/add            → Ajouter un contact unique
 *   GET  /api/contacts                → Lister mes contacts
 *   DELETE /api/contacts/:phone       → Supprimer un contact
 *   GET  /api/contacts/check/:phone   → Vérifier si un numéro est sur OmniSMS
 *   POST /api/contacts/block          → Bloquer un contact
 *   GET  /api/contacts/blocked        → Lister les contacts bloqués
 *
 * Workflow sync (style WhatsApp) :
 *   1. Client envoie [{name, phone}, ...]
 *   2. Backend normalise tous les numéros
 *   3. Compare avec la collection Firestore users_sms
 *   4. Retourne les contacts qui ont un compte OmniSMS
 */

const express   = require('express');
const router    = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const authenticate  = require('../middleware/authenticate');
const firebaseAuth  = require('../middleware/firebaseAuth');
const { normalizePhone, normalizePhoneBatch, isValidPhone } = require('../services/phoneNormalizer');
const { logger }    = require('../middleware/logger');

/* ── Auth middleware — accepte Firebase ou JWT ────────────── */
// Utilise firebaseAuth si Firebase configuré, sinon JWT
const auth = firebaseAuth;

/* ── Validation helper ────────────────────────────────────── */
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

/* ── Firestore helper ─────────────────────────────────────── */
function getDb() {
  try {
    const db = require('../config/firebase');
    if (db._stub) return null;
    return db;
  } catch (_) { return null; }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/contacts/sync
   Synchronisation carnet d'adresses (style WhatsApp)
   Body : { contacts: [{name, phone}], country?: "FR" }
   ─────────────────────────────────────────────────────────── */
router.post(
  '/sync',
  auth,
  [
    body('contacts')
      .isArray({ min: 1, max: 5000 })
      .withMessage('contacts doit être un tableau de 1 à 5000 entrées.'),
    body('contacts.*.phone')
      .notEmpty()
      .withMessage('Chaque contact doit avoir un champ phone.'),
    body('country')
      .optional()
      .isLength({ min: 2, max: 2 })
      .withMessage('country doit être un code ISO 2 lettres.'),
  ],
  async (req, res) => {
    const err = validate(req, res);
    if (err) return;

    const { contacts, country } = req.body;
    const uid = req.user.uid;

    try {
      // 1. Normaliser tous les numéros
      const normalized = normalizePhoneBatch(contacts, country || 'BF');

      // Filtrer les invalides
      const validContacts = normalized.filter(c => c.valid);
      const invalid       = normalized.filter(c => !c.valid);

      if (validContacts.length === 0) {
        return res.status(400).json({
          error  : 'Aucun numéro valide dans la liste fournie.',
          code   : 'NO_VALID_NUMBERS',
          sample : normalized.slice(0, 3),
        });
      }

      // 2. Rechercher dans Firestore par lots de 30 (limite Firestore `in`)
      const db = getDb();
      let registeredContacts = [];

      if (db) {
        const phones = validContacts.map(c => c.normalized);
        const BATCH_SIZE = 10;  // Firestore `in` operator limite

        // Rechercher dans la collection `users` par numéro de téléphone vérifié
        for (let i = 0; i < phones.length; i += BATCH_SIZE) {
          const batch = phones.slice(i, i + BATCH_SIZE);
          try {
            // Chercher les utilisateurs OmniSMS dont le téléphone est vérifié
            const snap = await db
              .collection('users')
              .where('phone', 'in', batch)
              .get();

            snap.forEach(doc => {
              const data = doc.data();
              // Ignorer les comptes dont phoneVerified est explicitement false (non activés)
              if (data.phoneVerified === false) return;
              // Trouver le nom donné par cet utilisateur dans ses contacts
              const contact = validContacts.find(c => c.normalized === data.phone);
              // Éviter les doublons
              if (registeredContacts.some(r => r.userId === doc.id)) return;
              registeredContacts.push({
                phone           : data.phone,
                name            : contact?.name || data.name || '',
                avatar          : data.avatar   || null,
                isOnOmniSms     : true,
                userId          : doc.id,        // UID Firestore réel
                registeredUserId: doc.id,        // Alias frontend
              });
            });
          } catch (batchErr) {
            logger.warn('[Contacts] Batch query users failed', { error: batchErr.message, batchIndex: i });
          }
        }
      }

      // 3. Construire la liste complète : OmniSMS + SMS uniquement
      // AUCUN contact ne disparaît — tous restent visibles
      const registeredPhones = new Set(registeredContacts.map(r => r.phone));
      const smsOnlyContacts = validContacts
        .filter(c => !registeredPhones.has(c.normalized))
        .map(c => ({
          phone           : c.normalized,
          name            : c.name || '',
          avatar          : null,
          isOnOmniSms     : false,
          userId          : null,
          registeredUserId: null,
        }));

      const allContacts = [...registeredContacts, ...smsOnlyContacts];

      // 4. Sauvegarder les contacts synchronisés en Firestore
      if (db && uid) {
        try {
          await db.collection('users').doc(uid).set({
            contacts_synced    : allContacts.map(c => ({
              name             : c.name || '',
              phone            : c.phone,
              isOnOmniSms      : c.isOnOmniSms,
              userId           : c.userId           || null,
              registeredUserId : c.registeredUserId || null,
              avatar           : c.avatar           || null,
            })),
            contacts_synced_at: new Date().toISOString(),
          }, { merge: true });
        } catch (saveErr) {
          logger.warn('[Contacts] sync save error (non bloquant)', { error: saveErr.message });
        }
      }

      logger.info('[Contacts] Sync done', {
        uid,
        total      : contacts.length,
        valid      : validContacts.length,
        omnisms    : registeredContacts.length,
        smsOnly    : smsOnlyContacts.length,
        invalid    : invalid.length,
      });

      return res.status(200).json({
        success              : true,
        total                : contacts.length,
        valid                : validContacts.length,
        invalid              : invalid.length,
        registeredOnOmniSms  : registeredContacts.length,
        smsOnly              : smsOnlyContacts.length,
        // contacts inclut TOUS : OmniSMS + SMS (avec isOnOmniSms pour distinguer)
        contacts             : allContacts,
        invalidSamples       : invalid.slice(0, 5).map(c => ({
          original: c.original,
          reason  : 'Numéro invalide ou non reconnu',
        })),
      });

    } catch (err) {
      logger.error('[Contacts] sync error', { error: err.message, uid });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   POST /api/contacts/add
   Ajouter un contact unique
   ─────────────────────────────────────────────────────────── */
router.post(
  '/add',
  auth,
  [
    body('name').trim().isLength({ min: 1, max: 60 }).withMessage('name requis (1-60 chars).'),
    body('phone').trim().notEmpty().withMessage('phone requis.'),
    body('country').optional().isLength({ min: 2, max: 2 }),
  ],
  async (req, res) => {
    const err = validate(req, res);
    if (err) return;

    const { name, phone, country } = req.body;
    const uid     = req.user.uid;
    const ownerNorm = normalizePhone(uid);
    const contactNorm = normalizePhone(phone, country);

    if (!isValidPhone(contactNorm)) {
      return res.status(400).json({
        error: `Numéro invalide: ${phone}`,
        code : 'INVALID_PHONE',
      });
    }

    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json({ error: 'Firestore non disponible.', code: 'DB_UNAVAILABLE' });
      }

      // Stocker dans la collection `users` directement (pas users_sms)
      const userSnap  = await db.collection('users').doc(uid).get();
      const userData  = userSnap.exists ? userSnap.data() : {};
      const contacts  = userData.contacts_manual || [];

      // Vérifier si déjà présent
      const exists = contacts.some(c => c.phone === contactNorm);

      const contact = { name, phone: contactNorm, isOnOmniSms: false, addedAt: new Date().toISOString() };

      if (!exists) {
        // Vérifier si ce numéro est sur OmniSMS
        try {
          const omniSnap = await db.collection('users').where('phone', '==', contactNorm).limit(1).get();
          if (!omniSnap.empty) {
            const omniUser = omniSnap.docs[0];
            contact.isOnOmniSms      = true;
            contact.userId           = omniUser.id;
            contact.registeredUserId = omniUser.id;
          }
        } catch (_) {}

        contacts.push(contact);
        await db.collection('users').doc(uid).set(
          { contacts_manual: contacts, contacts_updated_at: new Date().toISOString() },
          { merge: true }
        );
      }

      return res.status(exists ? 200 : 201).json({
        success: true,
        added  : !exists,
        contact,
        message: exists ? 'Contact déjà présent.' : 'Contact ajouté.',
      });

    } catch (err) {
      logger.error('[Contacts] add error', { error: err.message });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/contacts
   Lister mes contacts (depuis la collection users)
   ─────────────────────────────────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const uid = req.user.uid;

  try {
    const db = getDb();
    if (!db) {
      return res.status(200).json({ contacts: [], count: 0 });
    }

    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) {
      return res.status(200).json({ contacts: [], count: 0 });
    }

    const data = snap.data();
    // Fusionner les contacts manuels et ceux issus de la sync VCF
    const manual  = data.contacts_manual  || [];
    const synced  = data.contacts_synced  || [];

    // Dédupliquer par numéro de téléphone (manual prime sur synced)
    const phoneSet = new Set(manual.map(c => c.phone));
    const combined = [
      ...manual,
      ...synced.filter(c => !phoneSet.has(c.phone)),
    ];

    return res.status(200).json({
      count   : combined.length,
      contacts: combined,
    });

  } catch (err) {
    logger.error('[Contacts] list error', { error: err.message });
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/contacts/:phone
   ─────────────────────────────────────────────────────────── */
router.delete(
  '/:phone',
  auth,
  async (req, res) => {
    const uid          = req.user.uid;
    const ownerNorm    = normalizePhone(uid);
    const contactPhone = normalizePhone(req.params.phone);

    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json({ error: 'Firestore non disponible.', code: 'DB_UNAVAILABLE' });
      }

      const snap = await db.collection('users').doc(uid).get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'Utilisateur non trouvé.', code: 'NOT_FOUND' });
      }

      const data = snap.data();
      const contacts_manual = (data.contacts_manual || []).filter(c => c.phone !== contactPhone);
      const contacts_synced = (data.contacts_synced  || []).filter(c => c.phone !== contactPhone);

      await db.collection('users').doc(uid).update({
        contacts_manual,
        contacts_synced,
        contacts_updated_at: new Date().toISOString(),
      });

      return res.status(200).json({ success: true, message: 'Contact supprimé.' });

    } catch (err) {
      logger.error('[Contacts] delete error', { error: err.message });
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/contacts/check/:phone
   Vérifie si un numéro est sur OmniSMS
   ─────────────────────────────────────────────────────────── */
router.get(
  '/check/:phone',
  auth,
  async (req, res) => {
    const phone = normalizePhone(req.params.phone);

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Numéro invalide.', code: 'INVALID_PHONE' });
    }

    try {
      const db = getDb();
      if (!db) return res.status(200).json({ phone, registered: false, reason: 'db_unavailable' });

      // Chercher dans la collection `users` par numéro de téléphone
      const snap = await db.collection('users').where('phone', '==', phone).limit(1).get();
      const found = !snap.empty && snap.docs[0].data().phoneVerified !== false;

      return res.status(200).json({
        phone,
        registered: found,
        user      : found ? {
          userId: snap.docs[0].id,
          name  : snap.docs[0].data().name   || null,
          avatar: snap.docs[0].data().avatar || null,
        } : null,
      });

    } catch (err) {
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   POST /api/contacts/block
   ─────────────────────────────────────────────────────────── */
router.post(
  '/block',
  auth,
  [body('phone').trim().notEmpty().withMessage('phone requis.')],
  async (req, res) => {
    const err = validate(req, res);
    if (err) return;

    const uid       = req.user.uid;
    const ownerNorm = normalizePhone(uid);
    const blockPhone = normalizePhone(req.body.phone);

    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable.', code: 'DB_UNAVAILABLE' });

      const bSnap = await db.collection('users').doc(uid).get();
      const blocked = bSnap.exists ? (bSnap.data().blocked || []) : [];
      if (!blocked.includes(blockPhone)) blocked.push(blockPhone);
      await db.collection('users').doc(uid).set(
        { blocked, updatedAt: new Date().toISOString() },
        { merge: true }
      );

      return res.status(200).json({ success: true, blocked: blockPhone });

    } catch (err) {
      return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/contacts/blocked
   ─────────────────────────────────────────────────────────── */
router.get('/blocked', auth, async (req, res) => {
  const uid      = req.user.uid;
  const ownerNorm = normalizePhone(uid);

  try {
    const db = getDb();
    if (!db) return res.status(200).json({ blocked: [] });

    const snap = await db.collection('users').doc(uid).get();
    const blocked = snap.exists ? (snap.data().blocked || []) : [];

    return res.status(200).json({ count: blocked.length, blocked });

  } catch (err) {
    return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
  }
});

module.exports = router;
