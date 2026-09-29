'use strict';

const axios = require('axios');
const { logger } = require('../middleware/logger');
const { normalizePhone, isValidPhone } = require('../services/phoneNormalizer');
const { resolveUserByPhone } = require('../services/userResolver');
const google = require('../services/googleOAuth');

const PEOPLE_URL = 'https://people.googleapis.com/v1/people/me/connections';
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const MAX_PHONE_ENTRIES = 5000;

function formatPersonName(person) {
  const name = (person.names || [])[0] || {};
  const display = (name.displayName || '').trim();
  const given = (name.givenName || '').trim();
  const family = (name.familyName || '').trim();
  return {
    name: display || [given, family].filter(Boolean).join(' ') || '',
    givenName: given,
    familyName: family,
  };
}

async function loadGoogleContacts(userId) {
  const db = google.getDb();
  const credentialRef = db.collection('google_contacts_credentials').doc(userId);
  const credentialSnap = await credentialRef.get();
  if (!credentialSnap.exists || !credentialSnap.data().refreshTokenEncrypted) {
    throw Object.assign(new Error('Google Contacts authorization is required.'), { code: 'GOOGLE_CONTACTS_AUTH_REQUIRED' });
  }
  const credential = credentialSnap.data();
  const refreshToken = google.decryptRefreshToken(credential.refreshTokenEncrypted);
  const oauthClient = google.createOAuthClient();
  oauthClient.setCredentials({ refresh_token: refreshToken });

  let accessToken;
  try {
    const access = await oauthClient.getAccessToken();
    accessToken = typeof access === 'string' ? access : access && access.token;
  } catch (err) {
    if (err.response?.status === 400 || err.code === 'invalid_grant') {
      await credentialRef.delete().catch(() => {});
      throw Object.assign(new Error('Google authorization expired.'), { code: 'GOOGLE_TOKEN_EXPIRED' });
    }
    throw Object.assign(new Error('Google People API authorization failed.'), { code: 'GOOGLE_PEOPLE_API_UNAVAILABLE' });
  }
  if (!accessToken) throw Object.assign(new Error('Google access token unavailable.'), { code: 'GOOGLE_TOKEN_EXPIRED' });

  const people = [];
  let pageToken;
  let pageCount = 0;
  try {
    do {
      const response = await axios.get(PEOPLE_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          personFields: 'names,phoneNumbers,photos',
          pageSize: PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
        },
        timeout: 20000,
      });
      people.push(...(response.data.connections || []));
      pageToken = response.data.nextPageToken || null;
      pageCount++;
    } while (pageToken && pageCount < MAX_PAGES);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      if (status === 401 || err.response?.data?.error?.status === 'UNAUTHENTICATED') {
        await credentialRef.delete().catch(() => {});
        throw Object.assign(new Error('Google Contacts authorization expired.'), { code: 'GOOGLE_TOKEN_EXPIRED' });
      }
      throw Object.assign(new Error('Google Contacts permission is missing.'), { code: 'GOOGLE_CONTACTS_PERMISSION_REQUIRED' });
    }
    throw Object.assign(new Error('Google People API is temporarily unavailable.'), { code: 'GOOGLE_PEOPLE_API_UNAVAILABLE' });
  }

  return { people, truncated: !!pageToken, googleEmail: credential.googleEmail || null };
}

function normalizedKey(contact) {
  const phone = normalizePhone(contact && contact.phone, process.env.DEFAULT_PHONE_COUNTRY || 'BF');
  return phone || String(contact && contact.phone || '');
}

async function importGoogleContacts(req, res) {
  const uid = req.user && (req.user.uid || req.user.userId || req.user.sub);
  if (!uid) return res.status(401).json({ success: false, error: 'Session OmniSMS invalide.', code: 'INVALID_SESSION' });
  if (!google.isConfigured()) {
    return res.status(503).json({ success: false, error: 'Google OAuth non configuré.', code: 'GOOGLE_NOT_CONFIGURED' });
  }

  try {
    const db = google.getDb();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, error: 'Compte OmniSMS introuvable.', code: 'USER_NOT_FOUND' });

    const { people, truncated } = await loadGoogleContacts(uid);
    if (!people.length) {
      return res.status(200).json({
        success: true, authorizationRequired: false, empty: true,
        totalGoogleContacts: 0, totalPhoneNumbers: 0, imported: 0, updated: 0,
        omnismsMatches: 0, external: 0, skippedExisting: 0,
        invalidNumbers: 0, duplicateNumbers: 0, truncated,
      });
    }

    const country = process.env.DEFAULT_PHONE_COUNTRY || 'BF';
    const contactsByPhone = new Map();
    let invalidNumbers = 0;
    let duplicateNumbers = 0;

    for (const person of people) {
      const identity = formatPersonName(person);
      const photo = person.photos && person.photos[0] && person.photos[0].url || null;
      for (const phoneEntry of person.phoneNumbers || []) {
        const original = String(phoneEntry.value || '').trim();
        const phone = normalizePhone(original, country);
        if (!phone || !isValidPhone(phone, country)) {
          invalidNumbers++;
          continue;
        }
        if (contactsByPhone.has(phone)) {
          duplicateNumbers++;
          const existing = contactsByPhone.get(phone);
          if (!existing.name && identity.name) existing.name = identity.name;
          continue;
        }
        contactsByPhone.set(phone, {
          name: identity.name,
          givenName: identity.givenName || null,
          familyName: identity.familyName || null,
          phone,
          avatar: photo,
          isOnOmniSms: false,
          userId: null,
          registeredUserId: null,
          source: 'google',
          googleResourceName: person.resourceName || null,
          addedAt: new Date().toISOString(),
        });
      }
    }

    const googleEntries = [...contactsByPhone.values()].slice(0, MAX_PHONE_ENTRIES);
    let omnismsMatches = 0;
    for (const contact of googleEntries) {
      const match = await resolveUserByPhone(contact.phone, { includeDeleted: false, requireVerified: true });
      if (match.found) {
        contact.isOnOmniSms = true;
        contact.userId = match.uid;
        contact.registeredUserId = match.uid;
        contact.phone = match.phone || contact.phone;
        contact.avatar = contact.avatar || match.avatar || null;
        omnismsMatches++;
      }
    }

    const counts = { imported: 0, updated: 0, skippedExisting: 0 };
    await db.runTransaction(async tx => {
      const latestSnap = await tx.get(userRef);
      if (!latestSnap.exists) throw Object.assign(new Error('OmniSMS user not found.'), { code: 'USER_NOT_FOUND' });
      const latest = latestSnap.data();
      const manual = Array.isArray(latest.contacts_manual) ? [...latest.contacts_manual] : [];
      const synced = Array.isArray(latest.contacts_synced) ? [...latest.contacts_synced] : [];
      const manualIndex = new Map();
      const syncedIndex = new Map();
      manual.forEach((c, i) => { const key = normalizedKey(c); if (key && !manualIndex.has(key)) manualIndex.set(key, i); });
      synced.forEach((c, i) => { const key = normalizedKey(c); if (key && !syncedIndex.has(key)) syncedIndex.set(key, i); });

      for (const incoming of googleEntries) {
        const key = incoming.phone;
        if (manualIndex.has(key)) {
          const idx = manualIndex.get(key);
          const current = manual[idx];
          let changed = false;
          if (incoming.isOnOmniSms && !current.isOnOmniSms) {
            manual[idx] = { ...current, isOnOmniSms: true, userId: incoming.userId, registeredUserId: incoming.registeredUserId, avatar: current.avatar || incoming.avatar };
            changed = true;
          }
          if (changed) counts.updated++;
          else counts.skippedExisting++;
          continue;
        }
        if (syncedIndex.has(key)) {
          const idx = syncedIndex.get(key);
          const current = synced[idx];
          if (current.source === 'google') {
            const updated = {
              ...current,
              name: incoming.name || current.name || '',
              givenName: incoming.givenName || current.givenName || null,
              familyName: incoming.familyName || current.familyName || null,
              isOnOmniSms: incoming.isOnOmniSms || current.isOnOmniSms || false,
              userId: incoming.userId || current.userId || null,
              registeredUserId: incoming.registeredUserId || current.registeredUserId || null,
              avatar: incoming.avatar || current.avatar || null,
              googleResourceName: incoming.googleResourceName || current.googleResourceName || null,
            };
            const fields = ['name', 'givenName', 'familyName', 'isOnOmniSms', 'userId', 'registeredUserId', 'avatar', 'googleResourceName'];
            const changed = fields.some(field => (current[field] ?? null) !== (updated[field] ?? null));
            if (changed) { synced[idx] = { ...updated, updatedAt: new Date().toISOString() }; counts.updated++; }
            else counts.skippedExisting++;
          } else {
            // Existing VCF/legacy synced record wins; do not duplicate or overwrite its label/source.
            if (incoming.isOnOmniSms && !current.isOnOmniSms) {
              synced[idx] = { ...current, isOnOmniSms: true, userId: incoming.userId, registeredUserId: incoming.registeredUserId };
              counts.updated++;
            } else counts.skippedExisting++;
          }
          continue;
        }
        syncedIndex.set(key, synced.length);
        synced.push(incoming);
        counts.imported++;
      }

      await tx.set(userRef, {
        contacts_manual: manual,
        contacts_synced: synced,
        contacts_updated_at: new Date().toISOString(),
      }, { merge: true });
    });

    const response = {
      success: true,
      authorizationRequired: false,
      empty: false,
      totalGoogleContacts: people.length,
      totalPhoneNumbers: googleEntries.length,
      imported: counts.imported,
      updated: counts.updated,
      omnismsMatches,
      external: googleEntries.length - omnismsMatches,
      skippedExisting: counts.skippedExisting,
      invalidNumbers,
      duplicateNumbers,
      truncated,
    };
    logger.info('[Google Contacts] Import completed', {
      uid,
      imported: response.imported,
      updated: response.updated,
      omnismsMatches: response.omnismsMatches,
      external: response.external,
      invalidNumbers,
    });
    return res.status(200).json(response);
  } catch (err) {
    const code = err.code || 'GOOGLE_CONTACTS_IMPORT_FAILED';
    const publicErrors = {
      GOOGLE_CONTACTS_AUTH_REQUIRED: [409, 'Google Contacts doit être autorisé avant l’import.'],
      GOOGLE_TOKEN_EXPIRED: [401, 'Autorisation Google expirée; autorisez de nouveau Google Contacts.'],
      GOOGLE_CONTACTS_PERMISSION_REQUIRED: [403, 'L’accès Google Contacts a été refusé.'],
      GOOGLE_PEOPLE_API_UNAVAILABLE: [502, 'Google Contacts est temporairement indisponible.'],
      GOOGLE_ENCRYPTION_NOT_CONFIGURED: [503, 'Le stockage sécurisé de Google Contacts n’est pas configuré.'],
      GOOGLE_ENCRYPTION_MISCONFIGURED: [503, 'Le stockage sécurisé de Google Contacts n’est pas configuré.'],
      USER_NOT_FOUND: [404, 'Compte OmniSMS introuvable.'],
    };
    const [status, message] = publicErrors[code] || [500, 'Échec de l’import Google Contacts.'];
    logger.warn('[Google Contacts] Import failed', { uid, code });
    return res.status(status).json({ success: false, error: message, code });
  }
}

module.exports = { importGoogleContacts, formatPersonName, PEOPLE_URL };
