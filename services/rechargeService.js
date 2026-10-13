'use strict';
/**
 * OmniSMS — Recharges par SMS Orange Money (utilisateurs hors ligne).
 *
 * Parcours :
 *   1. RECHARGE 10|30 (SMS à la passerelle) → intention `payment_intents`
 *      (pending, montant attendu, payeur = expéditeur, expiration 30 min
 *      configurable) + instructions SMS (montant, numéro OM, heure limite).
 *   2. Le payeur envoie le montant via Orange Money au numéro passerelle.
 *   3. La confirmation OM arrive sur le téléphone passerelle → webhook →
 *      orangeMoneyParser (liste blanche) → `incoming_payments`
 *      (id transaction UNIQUE, idempotent) → rapprochement :
 *        - intention pending même payeur + montant exact + fenêtre → MATCHED
 *          (crédit du pack + ledger + SMS confirmation avec solde) ;
 *        - payeur différent ou pas d'intention → UNMATCHED (créditable via
 *          « PAYE <idTransaction> » par le bénéficiaire) ;
 *        - ambigu / montant non reconnu → REVIEW (aucun crédit automatique,
 *          SMS « paiement reçu, en vérification »).
 *
 * Garde-fous : plafonds journaliers par numéro (recharges et FCFA), limite
 * de commandes/heure, réponses limitées à 1 par commande, aucun crédit
 * sans paiement prouvé, jamais 2 crédits pour la même transaction OM.
 */

const ledger = require('./creditLedger');
const { findPack, getEffectivePacks, getLimits, getGatewayOmNumber } = require('./packsConfig');

function getDb(dbParam) {
  if (dbParam) return dbParam;
  const db = require('../config/firebase');
  return db && !db._stub ? db : null;
}
function nowIso() { return new Date().toISOString(); }

/* ── Limite de commandes par numéro (anti-spam : chaque réponse coûte un SMS) ── */
const _cmdWindow = new Map(); // phone → [timestamps]
function commandRateOk(phoneE164) {
  const max = getLimits().smsCommandsPerHour;
  const now = Date.now();
  const arr = (_cmdWindow.get(phoneE164) || []).filter((ts) => now - ts < 3600 * 1000);
  if (arr.length >= max) { _cmdWindow.set(phoneE164, arr); return false; }
  arr.push(now);
  _cmdWindow.set(phoneE164, arr);
  return true;
}

/* ── Plafonds journaliers par numéro ──────────────────────────────── */
function _dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

async function getDailyUsage(db, phoneE164) {
  const d = getDb(db);
  if (!d) return { recharges: 0, fcfa: 0 };
  const snap = await d.collection('om_daily_usage').doc(`${phoneE164}_${_dayKey()}`).get();
  if (!snap.exists) return { recharges: 0, fcfa: 0 };
  return { recharges: Number(snap.data().recharges) || 0, fcfa: Number(snap.data().fcfa) || 0 };
}

/** Incrémente les compteurs journaliers (transactionnel). */
async function bumpDailyUsage(db, phoneE164, fcfa) {
  const d = getDb(db);
  if (!d) return { recharges: 0, fcfa: 0 };
  const ref = d.collection('om_daily_usage').doc(`${phoneE164}_${_dayKey()}`);
  let out = { recharges: 0, fcfa: 0 };
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : { recharges: 0, fcfa: 0 };
    out = { recharges: (Number(cur.recharges) || 0) + 1, fcfa: (Number(cur.fcfa) || 0) + fcfa };
    const base = { phone: phoneE164, date: _dayKey(), updatedAt: nowIso() };
    if (snap.exists) tx.update(ref, { ...out, ...base });
    else tx.set(ref, { ...out, ...base, createdAt: nowIso() });
  });
  return out;
}

/** Vérifie les plafonds AVANT de créer une intention. */
async function dailyCapsOk(db, phoneE164, amountFcfa) {
  const lim = getLimits();
  const usage = await getDailyUsage(db, phoneE164);
  if (usage.recharges >= lim.omDailyMaxRecharges) {
    return { ok: false, reason: `Limite journaliere atteinte (${lim.omDailyMaxRecharges} recharges/jour). Reessayez demain.` };
  }
  if (usage.fcfa + amountFcfa > lim.omDailyMaxFcfa) {
    return { ok: false, reason: `Plafond journalier de ${lim.omDailyMaxFcfa}F atteint. Reessayez demain.` };
  }
  return { ok: true };
}

/* ── Intentions de paiement ────────────────────────────────────────── */

function newIntentId() {
  return `PI-${Date.now().toString(36).toUpperCase().slice(-5)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

/**
 * RECHARGE <pack> : crée l'intention + retourne les instructions (1 segment).
 * @returns {{ ok:true, intentId, reply } | { ok:false, reply }}
 */
async function createIntent({ db, uid, phoneE164, packId }) {
  const d = getDb(db);
  const pack = await findPack(d, packId);
  if (!pack) {
    const packs = await getEffectivePacks(d);
    const list = packs.map((p) => `${p.id.replace('PACK_', '')}=${p.sms}SMS ${p.priceFcfa}F`).join(' ');
    return { ok: false, reply: `OmniSMS: pack inconnu. Packs: ${list}. Envoyer RECHARGE 10 ou RECHARGE 30.` };
  }
  const caps = await dailyCapsOk(d, phoneE164, pack.priceFcfa);
  if (!caps.ok) return { ok: false, reply: `OmniSMS: ${caps.reason}` };

  const lim = getLimits();
  const intentId = newIntentId();
  const expiresAt = new Date(Date.now() + lim.paymentIntentTtlMin * 60 * 1000);
  await d.collection('payment_intents').doc(intentId).set({
    intentId, uid: String(uid), phone: phoneE164, packId: pack.id,
    sms: pack.sms, amountFcfa: pack.priceFcfa, status: 'pending',
    createdAt: nowIso(), expiresAt: expiresAt.toISOString(),
  });
  await bumpDailyUsage(d, phoneE164, pack.priceFcfa);

  const hhmm = expiresAt.toISOString().slice(11, 16);
  const reply =
    `OmniSMS: envoyez ${pack.priceFcfa}F au ${getGatewayOmNumber()} (Orange Money) avant ${hhmm} UTC. ` +
    `Credit auto apres paiement. Ref ${intentId}.`;
  return { ok: true, intentId, reply };
}

/* ── Rapprochement des paiements entrants ──────────────────────────── */

async function _findPendingIntents(db, payerPhone, amountFcfa) {
  const snap = await db.collection('payment_intents')
    .where('phone', '==', payerPhone)
    .where('status', '==', 'pending')
    .limit(10)
    .get()
    .catch(() => ({ docs: [] }));
  const now = Date.now();
  return (snap.docs || [])
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((it) => Number(it.amountFcfa) === Number(amountFcfa)
      && (!it.expiresAt || new Date(it.expiresAt).getTime() > now));
}

async function _packCreditsForAmount(db, amountFcfa) {
  const packs = await getEffectivePacks(db);
  return packs.find((p) => p.priceFcfa === Number(amountFcfa)) || null;
}

async function _resolveUidByPhone(db, phoneE164) {
  try {
    const { resolveUserByPhone } = require('./userResolver');
    const res = await resolveUserByPhone(phoneE164);
    return res && res.found ? res.uid : null;
  } catch (_) { return null; }
}

/**
 * Traite une confirmation OM déjà parsée (parseur liste blanche).
 * @returns {Promise<{status:'matched'|'unmatched'|'review'|'duplicate'|'ignored'|'unparseable', reply?:string}>}
 */
async function handleOmPayment({ db, parsed, notifyReply }) {
  const d = getDb(db);
  if (!parsed || !parsed.ok) {
    if (parsed && parsed.reason === 'PARSE_FAILED') return { status: 'unparseable' };
    return { status: 'ignored' }; // expéditeur non whitelisté / numéro ordinaire
  }
  const payRef = d.collection('incoming_payments').doc(parsed.txnId);
  const existing = await payRef.get().catch(() => ({ exists: false }));
  if (existing.exists) return { status: 'duplicate' }; // idempotence : jamais 2 crédits

  await payRef.set({
    omTransactionId: parsed.txnId, omSenderId: parsed.senderId,
    payerPhone: parsed.payerPhone || null, amountFcfa: parsed.amountFcfa,
    omDate: parsed.omDate || null, status: 'processing',
    receivedAt: nowIso(),
  });

  const candidates = parsed.payerPhone ? await _findPendingIntents(d, parsed.payerPhone, parsed.amountFcfa) : [];

  // ── MATCHED : une seule intention pending correspondante ──
  if (candidates.length === 1) {
    const intent = candidates[0];
    const grant = await ledger.grantPurchase(d, {
      uid: intent.uid, credits: intent.sms, reference: parsed.txnId, reason: `pack ${intent.packId}`,
    });
    if (grant.alreadyDone) { // sûreté : txn déjà créditée sous une autre forme
      await payRef.set({ status: 'duplicate', intentId: intent.intentId }, { merge: true });
      return { status: 'duplicate' };
    }
    await d.collection('payment_intents').doc(intent.intentId).set({
      status: 'matched', paymentId: parsed.txnId, matchedAt: nowIso(),
    }, { merge: true });
    await payRef.set({
      status: 'matched', intentId: intent.intentId, creditedUid: intent.uid,
      creditsGranted: intent.sms, processedAt: nowIso(),
    }, { merge: true });
    const balance = await ledger.getBalance(d, intent.uid);
    const reply = `OmniSMS: paiement recu. +${intent.sms} credits. Nouveau solde: ${balance}.`;
    if (notifyReply && parsed.payerPhone) await notifyReply(parsed.payerPhone, reply);
    return { status: 'matched', reply };
  }

  // ── REVIEW : plusieurs intentions (ambigu) ou montant sans pack ──
  const packForAmount = await _packCreditsForAmount(d, parsed.amountFcfa);
  if (candidates.length > 1 || !packForAmount) {
    await payRef.set({ status: 'review', reviewReason: candidates.length > 1 ? 'ambiguous_intents' : 'unknown_amount' }, { merge: true });
    const uid = parsed.payerPhone ? await _resolveUidByPhone(d, parsed.payerPhone) : null;
    if (notifyReply && parsed.payerPhone && uid) {
      await notifyReply(parsed.payerPhone, 'OmniSMS: paiement recu, en verification. Un agent va valider votre credit.');
    }
    return { status: 'review' };
  }

  // ── UNMATCHED : montant valide mais aucune intention (dépôt par un tiers…) ──
  await payRef.set({ status: 'unmatched', packIdCandidate: packForAmount.id, smsCandidate: packForAmount.sms }, { merge: true });
  return { status: 'unmatched' };
}

/**
 * PAYE <idTransaction> : l'utilisateur rapproche lui-même un paiement
 * unmatched (dépôt fait par un proche). Idempotent + fenêtre limitée.
 */
async function claimUnmatched({ db, uid, phoneE164, txnId }) {
  const d = getDb(db);
  const id = String(txnId || '').trim();
  if (!id) return { ok: false, reply: 'OmniSMS: format PAYE <id>. Exemple: PAYE MP261011.1432.A12345' };
  const payRef = d.collection('incoming_payments').doc(id);
  const snap = await payRef.get().catch(() => ({ exists: false }));
  if (!snap.exists) return { ok: false, reply: 'OmniSMS: paiement inconnu. Verifiez l ID du SMS Orange Money.' };
  const pay = snap.data();

  if (pay.status === 'matched' || pay.status === 'duplicate') {
    return { ok: false, reply: 'OmniSMS: ce paiement a deja ete credite.' };
  }
  if (pay.status !== 'unmatched' && pay.status !== 'review') {
    return { ok: false, reply: 'OmniSMS: paiement en cours de verification. Reessayez plus tard.' };
  }
  const winH = getLimits().claimWindowHours * 3600 * 1000;
  if (pay.receivedAt && Date.now() - new Date(pay.receivedAt).getTime() > winH) {
    return { ok: false, reply: 'OmniSMS: delai de rapprochement depasse. Contactez le support.' };
  }
  const pack = await _packCreditsForAmount(d, pay.amountFcfa);
  if (!pack) return { ok: false, reply: 'OmniSMS: montant non reconnu. Un agent va verifier votre paiement.' };

  const caps = await dailyCapsOk(d, phoneE164, pay.amountFcfa);
  if (!caps.ok) return { ok: false, reply: `OmniSMS: ${caps.reason}` };

  const grant = await ledger.grantPurchase(d, {
    uid: String(uid), credits: pack.sms, reference: `claim-${id}`, reason: `pack ${pack.id} (claim)`,
  });
  if (grant.alreadyDone) return { ok: false, reply: 'OmniSMS: ce paiement a deja ete credite.' };

  await payRef.set({
    status: 'matched', claimedByUid: String(uid), intentId: null,
    creditsGranted: pack.sms, processedAt: nowIso(),
  }, { merge: true });
  await bumpDailyUsage(d, phoneE164, pay.amountFcfa);
  const balance = await ledger.getBalance(d, uid);
  return { ok: true, reply: `OmniSMS: paiement rapproche. +${pack.sms} credits. Nouveau solde: ${balance}.` };
}

/* ── Commandes SMS (SOLDE / PACKS / RECHARGE / PAYE / AIDE) ────────── */

/** Solde + gratuits restants d'un utilisateur. */
async function balanceReply({ db, uid, phoneE164 }) {
  const d = getDb(db);
  const billing = require('./creditBilling');
  const balance = await ledger.getBalance(d, uid);
  const remaining = await billing.getFreeRemaining(d, phoneE164);
  return `OmniSMS: solde ${balance} credits. Gratuits restants: ${remaining}/${getLimits().freeSmsQuota}.`;
}

/**
 * Point d'entrée des commandes crédit envoyées par SMS à la passerelle.
 * @param {object} p { db, phoneE164, text, sendSms }
 * @returns {Promise<{handled:boolean, reply?:string}>}
 */
async function handleSmsCommand({ db, phoneE164, text }) {
  const d = getDb(db);
  const raw = String(text || '').trim();
  const cmd = raw.toUpperCase().replace(/\s+/g, ' ');
  if (!/^(SOLDE|PACKS|RECHARGE( \d+)?|PAYE [A-Za-z0-9._-]+|AIDE)$/.test(cmd)) {
    return { handled: false }; // pas une commande crédit → traitement normal du message
  }
  if (!commandRateOk(phoneE164)) {
    return { handled: true, reply: 'OmniSMS: trop de commandes. Reessayez dans une heure.' };
  }

  const { resolveUserByPhone } = require('./userResolver');
  const resolution = await resolveUserByPhone(phoneE164).catch(() => ({ found: false }));
  const uid = resolution && resolution.found ? resolution.uid : null;

  if (cmd === 'AIDE') {
    return { handled: true, reply: 'OmniSMS: SOLDE solde | PACKS packs | RECHARGE 10 ou 30 acheter | PAYE <id> apres depot par tiers.' };
  }
  if (!uid) {
    return { handled: true, reply: 'OmniSMS: aucun compte pour ce numero. Creez un compte dans l app OmniSMS.' };
  }

  if (cmd === 'SOLDE') {
    return { handled: true, reply: await balanceReply({ db: d, uid, phoneE164 }) };
  }

  if (cmd === 'PACKS') {
    const packs = await getEffectivePacks(d);
    const list = packs.map((p) => `${p.id.replace('PACK_', '')}=${p.sms}SMS ${p.priceFcfa}F`).join(' ');
    return { handled: true, reply: `OmniSMS: ${list}. Envoyer RECHARGE 10 ou RECHARGE 30.` };
  }

  if (cmd.startsWith('RECHARGE ')) {
    const arg = cmd.slice(9).trim();
    const res = await createIntent({ db: d, uid, phoneE164, packId: `PACK_${arg}` });
    return { handled: true, reply: res.reply };
  }

  if (cmd.startsWith('PAYE ')) {
    const res = await claimUnmatched({ db: d, uid, phoneE164, txnId: cmd.slice(5).trim() });
    return { handled: true, reply: res.reply };
  }

  return { handled: false };
}

module.exports = {
  createIntent, handleOmPayment, claimUnmatched, handleSmsCommand,
  getDailyUsage, bumpDailyUsage, dailyCapsOk, commandRateOk, balanceReply,
};
