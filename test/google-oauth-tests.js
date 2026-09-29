'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const collections = new Map();
function coll(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}
function snapshot(ref) {
  const store = coll(ref.collection);
  return { exists: store.has(ref.id), data: () => structuredClone(store.get(ref.id)) };
}
function refFor(collection, id) {
  return {
    collection,
    id,
    async get() { return snapshot(this); },
    async create(data) {
      const store = coll(collection);
      if (store.has(id)) throw new Error('already exists');
      store.set(id, structuredClone(data));
    },
    async set(data, options = {}) {
      const store = coll(collection);
      store.set(id, options.merge ? { ...(store.get(id) || {}), ...structuredClone(data) } : structuredClone(data));
    },
    async delete() { coll(collection).delete(id); },
  };
}
const db = {
  collection(name) {
    return {
      doc(id = crypto.randomUUID()) { return refFor(name, id); },
      where(field, operator, value) {
        assert.equal(operator, '==');
        return { limit() { return { async get() {
          const docs = [...coll(name)].filter(([, data]) => data[field] === value).map(([id, data]) => ({ id, data: () => structuredClone(data) }));
          return { empty: docs.length === 0, docs };
        } }; } };
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const tx = {
      async get(ref) { return snapshot(ref); },
      set(ref, data, options) { writes.push(() => ref.set(data, options)); },
      create(ref, data) { writes.push(() => ref.create(data)); },
      update(ref, data) { writes.push(async () => {
        if (!snapshot(ref).exists) throw new Error('missing doc');
        await ref.set(data, { merge: true });
      }); },
    };
    const result = await callback(tx);
    for (const write of writes) await write();
    return result;
  },
};
require.cache[require.resolve('../config/firebase')] = { id: require.resolve('../config/firebase'), filename: require.resolve('../config/firebase'), loaded: true, exports: db };

const google = require('../services/googleOAuth');

(async () => {
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const encrypted = google.encryptRefreshToken('refresh-token-test');
  assert.equal(google.decryptRefreshToken(encrypted), 'refresh-token-test');
  assert.throws(() => google.decryptRefreshToken(`${encrypted.slice(0, -1)}x`), { code: 'GOOGLE_TOKEN_EXPIRED' });

  const existing = {
    name: 'Existing Omni User', email: 'existing@example.com', username: 'keep-name',
    phone: '+22670000000', contacts_manual: [{ phone: '+22671111111' }],
    contacts_synced: [{ phone: '+22672222222', source: 'vcf' }],
    isSubscribed: true, credits: 23, status: 'active', googleUid: 'legacy-firebase-uid', provider: 'password',
  };
  coll('users').set('existing-uid', structuredClone(existing));
  const linked = await google.findOrCreateOmniUser({
    googleUid: 'google-sub-1', email: 'existing@example.com', name: 'Google Name', picture: 'https://example.test/avatar.png',
  });
  assert.equal(linked.id, 'existing-uid', 'Google email must link to the existing OmniSMS uid');
  assert.equal(linked.data.username, 'keep-name');
  assert.equal(linked.data.phone, '+22670000000');
  assert.deepEqual(linked.data.contacts_manual, existing.contacts_manual);
  assert.deepEqual(linked.data.contacts_synced, existing.contacts_synced);
  assert.equal(linked.data.isSubscribed, true);
  assert.equal(linked.data.credits, 23);
  assert.equal(linked.data.status, 'active');
  assert.equal(linked.data.provider, 'password', 'existing auth provider must be preserved');
  assert.equal(linked.data.googleUid, 'legacy-firebase-uid', 'legacy Firebase Google UID must not be overwritten');
  assert.equal(linked.data.googleOAuthSub, 'google-sub-1');

  const created = await google.findOrCreateOmniUser({
    googleUid: 'google-sub-2', email: 'new@example.com', name: 'New Google User', picture: null,
  });
  assert.ok(created.id);
  assert.equal(created.data.email, 'new@example.com');
  assert.equal(coll('users').size, 2, 'new verified identity should create only one user');

  await google.findOrCreateOmniUser({
    googleUid: 'google-sub-2', email: 'new@example.com', name: 'New Google User', picture: null,
  });
  assert.equal(coll('users').size, 2, 'repeated login must not create a duplicate');

  console.log('Google OAuth unit checks: 14 PASS / 0 FAIL');
})().catch(err => { console.error(err); process.exitCode = 1; });
