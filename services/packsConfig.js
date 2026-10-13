'use strict';
/**
 * OmniSMS — Configuration des packs de crédits SMS et des garde-fous.
 *
 * TOUT est configurable (jamais en dur) :
 *   - variables d'environnement (valeurs de départ) ;
 *   - override possible par document Firestore `app_config/credits`
 *     (champ `packs` : [{ id, sms, priceFcfa }], champ `limits` : {...}),
 *     lu avec un cache de 5 minutes.
 *
 * Valeurs de départ (à ajuster librement) :
 *   PACK_10 = 10 SMS à 250 FCFA ; PACK_30 = 30 SMS à 600 FCFA.
 */

const DEFAULT_PACKS = [
  { id: 'PACK_10', sms: 10, priceFcfa: 250 },
  { id: 'PACK_30', sms: 30, priceFcfa: 600 },
];

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** Packs depuis l'environnement (synchrone, valeurs par défaut sûres). */
function getPacksFromEnv() {
  const csv = (process.env.PACKS_CSV || '').trim();
  if (csv) {
    const parsed = csv.split(',').map((chunk) => {
      const [id, sms, priceFcfa] = chunk.trim().split(':');
      const s = parseInt(sms, 10);
      const p = parseInt(priceFcfa, 10);
      if (!id || !Number.isFinite(s) || !Number.isFinite(p) || s <= 0 || p <= 0) return null;
      return { id: id.trim().toUpperCase(), sms: s, priceFcfa: p };
    }).filter(Boolean);
    if (parsed.length) return parsed;
  }
  return [
    { id: 'PACK_10', sms: envInt('PACK_10_SMS', DEFAULT_PACKS[0].sms), priceFcfa: envInt('PACK_10_PRICE_FCFA', DEFAULT_PACKS[0].priceFcfa) },
    { id: 'PACK_30', sms: envInt('PACK_30_SMS', DEFAULT_PACKS[1].sms), priceFcfa: envInt('PACK_30_PRICE_FCFA', DEFAULT_PACKS[1].priceFcfa) },
  ];
}

let _fsCache = { at: 0, packs: null };

/**
 * Packs effectifs : doc Firestore `app_config/credits`.packs si présent
 * (tableau [{id,sms,priceFcfa}]), sinon l'environnement. Cache 5 min.
 */
async function getEffectivePacks(db) {
  if (db && !db._stub) {
    try {
      const snap = await db.collection('app_config').doc('credits').get();
      if (snap.exists && Array.isArray(snap.data().packs) && snap.data().packs.length) {
        const packs = snap.data().packs
          .map((p) => ({ id: String(p.id || '').toUpperCase(), sms: parseInt(p.sms, 10), priceFcfa: parseInt(p.priceFcfa, 10) }))
          .filter((p) => p.id && p.sms > 0 && p.priceFcfa > 0);
        if (packs.length) { _fsCache = { at: Date.now(), packs }; return packs; }
      }
    } catch (_) { /* Firestore indisponible → env */ }
  }
  return getPacksFromEnv();
}

/** Trouver un pack par id (insensible à la casse) sur la liste effective. */
async function findPack(db, packId) {
  const wanted = String(packId || '').trim().toUpperCase();
  const packs = await getEffectivePacks(db);
  return packs.find((p) => p.id === wanted) || null;
}

/** Garde-fous anti-fraude (tous configurables). */
function getLimits() {
  return {
    freeSmsQuota: envInt('FREE_SMS_QUOTA', 5),
    paymentIntentTtlMin: envInt('PAYMENT_INTENT_TTL_MIN', 30),
    omDailyMaxRecharges: envInt('OM_DAILY_MAX_RECHARGES', 3),
    omDailyMaxFcfa: envInt('OM_DAILY_MAX_FCFA', 5000),
    smsCommandsPerHour: envInt('SMS_COMMANDS_PER_HOUR', 10),
    insufficientReplyCooldownMin: envInt('INSUFFICIENT_REPLY_COOLDOWN_MIN', 360),
    claimWindowHours: envInt('OM_CLAIM_WINDOW_HOURS', 48),
    pushWaitMs: envInt('OFFLINE_PUSH_WAIT_MS', 15000),
  };
}

/** Numéro Orange Money de la passerelle (numéro SIM du Z Fold2). */
function getGatewayOmNumber() {
  return (process.env.OM_GATEWAY_NUMBER
    || require('./creditSystem').PAYMENT_NUMBER
    || '').trim();
}

/** Liste blanche des expéditeurs Orange Money (IDs courts, pas des numéros). */
function getOmSenderIds() {
  return (process.env.OM_SENDER_IDS || 'ORANGE MONEY,ORANGEMONEY,OM,4001')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

module.exports = {
  DEFAULT_PACKS,
  getPacksFromEnv,
  getEffectivePacks,
  findPack,
  getLimits,
  getGatewayOmNumber,
  getOmSenderIds,
};
