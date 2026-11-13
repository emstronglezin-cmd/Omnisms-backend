'use strict';
/**
 * OmniSMS — Outbox de secours (Firestore) pour les tâches critiques.
 *
 * RÔLE : Redis/BullMQ reste le chemin principal. Quand il est indisponible
 * (quota Upstash, panne DNS) les jobs critiques (« transcription », « sms »)
 * exécutés INLINE sont enregistrés ICI AVANT exécution :
 *   - succès        → status 'done' (jamais ré-exécuté) ;
 *   - échec         → nouvelle tentative BORNÉE à délais progressifs
 *                     (30 s, 1 min, 2 min, 4 min… plafonnées à 1 h) ;
 *   - crash/restart → les tâches non terminées sont reprises au boot
 *                     (queueService.startFallbackRecovery) ;
 *   - retour Redis  → réintégrées dans les files BullMQ normales
 *                     (recoverFallbackTasks preferQueue:true) ou inline.
 * Anti-simultané : bail (claimUntil) — un seul exécuteur par tâche ;
 * instance unique Render (documenté). Anti-doublon SMS : les traitements
 * restent protégés en aval (marqueurs succès-seul, claim audioSms) ;
 * l'outbox ne ré-exécute JAMAIS une tâche 'done'.
 * L'outbox ne doit JAMAIS casser le chemin normal : toutes ses erreurs
 * sont absorbées (dégradation douce).
 */
const nowIso = () => new Date().toISOString();
const COL = 'queue_fallback';

let _handlers = {}; // { kind: async(task) => result } — injecté par queueService

function getDb() {
  try { const db = require('../config/firebase'); return (db && !db._stub) ? db : null; } catch (_) { return null; }
}

function init(handlers) { _handlers = handlers || {}; }

const docId = (kind, id) => `${String(kind)}:${String(id)}`;

/**
 * Enregistre la tâche AVANT exécution. Si elle est déjà 'done' →
 * { alreadyDone:true } (l'appelant n'exécute pas — anti-doublon).
 */
async function recordTask({ kind, id, data, maxAttempts = 4 }) {
  const db = getDb();
  if (!db || !kind || !id) return null;
  try {
    const ref = db.collection(COL).doc(docId(kind, id));
    const snap = await ref.get();
    const prev = snap && snap.exists ? (snap.data() || {}) : null;
    if (prev && prev.status === 'done') return { id: ref.id, alreadyDone: true };
    await ref.set({
      kind, taskId: String(id), data: data || {},
      attempts     : Number.isFinite(prev && prev.attempts) ? prev.attempts : 0,
      maxAttempts  : (prev && prev.maxAttempts) || maxAttempts,
      status       : (prev && prev.status) || 'pending',
      claimUntil   : (prev && prev.claimUntil) || null,
      nextAttemptAt: (prev && prev.nextAttemptAt) || Date.now(),
      lastError    : (prev && prev.lastError) || null,
      createdAt    : (prev && prev.createdAt) || nowIso(),
      updatedAt    : nowIso(),
    }, { merge: true });
    return { id: ref.id, alreadyDone: false };
  } catch (_) { return null; } // jamais bloquant
}

async function markDone(id) {
  const db = getDb();
  if (!db || !id) return;
  try { await db.collection(COL).doc(String(id)).set({ status: 'done', doneAt: nowIso(), claimUntil: null, updatedAt: nowIso() }, { merge: true }); } catch (_) {}
}

/** Échec d'une tentative → délai progressif ou échec définitif (traçabilité). */
async function markAttemptFailed(id, error, baseMs = 30000) {
  const db = getDb();
  if (!db || !id) return;
  try {
    const ref = db.collection(COL).doc(String(id));
    const snap = await ref.get();
    const d = snap && snap.exists ? (snap.data() || {}) : {};
    const attempts = (Number(d.attempts) || 0) + 1;
    const maxAttempts = Number(d.maxAttempts) || 4;
    const patch = { attempts, lastError: String(error || 'unknown').slice(0, 300), claimUntil: null, updatedAt: nowIso() };
    if (attempts >= maxAttempts) {
      patch.status = 'failed';
      patch.failedAt = nowIso();
    } else {
      patch.status = 'pending';
      patch.nextAttemptAt = Date.now() + Math.min(baseMs * Math.pow(2, attempts - 1), 3600000);
    }
    await ref.set(patch, { merge: true });
  } catch (_) {}
}

/** Pas de handler disponible pour l'instant → reprogrammée sans compter un échec. */
async function release(id, retryInMs = 60000) {
  const db = getDb();
  if (!db || !id) return;
  try { await db.collection(COL).doc(String(id)).set({ status: 'pending', claimUntil: null, nextAttemptAt: Date.now() + retryInMs, updatedAt: nowIso() }, { merge: true }); } catch (_) {}
}

function _isDue(d) {
  const now = Date.now();
  if (d.status === 'pending') return (Number(d.nextAttemptAt) || 0) <= now;
  if (d.status === 'processing') return (Number(d.claimUntil) || 0) <= now; // bail expiré
  return false;
}

/** Récupère et RÉSERVE (bail) les tâches dues — un seul exécuteur par tâche. */
async function recoverDueTasks({ limit = 10 } = {}) {
  const db = getDb();
  if (!db) return [];
  const claimed = [];
  try {
    for (const st of ['pending', 'processing']) {
      if (claimed.length >= (limit || 10)) break;
      const snap = await db.collection(COL).where('status', '==', st).limit(40).get();
      for (const doc of (snap.docs || [])) {
        if (claimed.length >= (limit || 10)) break;
        const d = doc.data() || {};
        if (!_isDue(d)) continue;
        const leaseMs = d.kind === 'transcription' ? 360000 : 120000; // Groq peut prendre 120 s
        try {
          await db.collection(COL).doc(doc.id).set({
            status: 'processing', claimUntil: Date.now() + leaseMs, claimedAt: nowIso(), updatedAt: nowIso(),
          }, { merge: true });
          claimed.push({ id: doc.id, kind: d.kind, taskId: d.taskId, data: d.data || {}, attempts: Number(d.attempts) || 0, maxAttempts: Number(d.maxAttempts) || 4 });
        } catch (_) { /* claim perdu → prochain tour */ }
      }
    }
  } catch (_) {}
  return claimed;
}

module.exports = { init, recordTask, markDone, markAttemptFailed, release, recoverDueTasks };
