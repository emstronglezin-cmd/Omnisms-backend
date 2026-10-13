'use strict';
/**
 * OmniSMS — Conformité Google Play : suppression de compte.
 *
 * Play exige un chemin de suppression DEPUIS L'APP **ET** DEPUIS LE WEB
 * (politique "Account deletion", 2024+, obligatoire pour les comptes créés in-app).
 *
 *   GET  /api/account/web           → page publique (HTML autonome, zéro dépendance)
 *   POST /api/account/web-request   → demande de suppression sans compte (téléphone + confirmation)
 *   POST /api/account/delete        → suppression in-app (JWT) — scrub PII + audit + révocation tokens
 *   POST /api/account/admin/purge-expired → purge définitive (x-admin-key) des comptes
 *                                            soft-deleted au-delà de la rétention
 *
 * Rétention : ACCOUNT_DELETION_RETENTION_DAYS (défaut 30) entre soft-delete et purge.
 * Le téléphone n'est JAMAIS stocké en clair dans deletion_requests (SHA-256 + sel).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const auth = require('../middleware/firebaseAuth');
const { logger } = require('../middleware/logger');
const { normalizePhone } = require('../services/phoneNormalizer');
const { runBatched } = require('../services/firestoreUtils');
const db = require('../config/firebase');

const RETENTION_DAYS = Math.max(0, Number(process.env.ACCOUNT_DELETION_RETENTION_DAYS || 30));

/* ── Utilitaires ── */
function hashPhone(phone) {
  const salt = String(process.env.JWT_SECRET || 'omnisms');
  return crypto.createHash('sha256').update(`${salt}:${phone}`).digest('hex').slice(0, 40);
}

function maskPhone(phone) {
  return String(phone || '').replace(/\d{4}$/, '****');
}

/** Page web publique (inline : styles + SVG, aucun CDN — se dégrade jamais). */
const WEB_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OmniSMS — Supprimer mon compte</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fa;color:#1c2733;margin:0;padding:24px;line-height:1.55}
 .card{max-width:640px;margin:32px auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
 h1{font-size:1.35rem;margin:0 0 8px} .warn{background:#fff4e5;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:6px;font-size:.92rem;margin:14px 0}
 label{display:block;font-weight:600;margin:14px 0 6px} input[type=tel]{width:100%;box-sizing:border-box;padding:11px;border:1px solid #cfd8e0;border-radius:8px;font-size:1rem}
 .chk{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-size:.93rem} .chk input{margin-top:3px}
 button{width:100%;padding:13px;border:0;border-radius:9px;background:#d93025;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;margin-top:8px}
 button:disabled{background:#9aa7b3;cursor:not-allowed} .msg{margin-top:14px;padding:11px;border-radius:8px;display:none;font-size:.94rem}
 .ok{background:#e6f4ea;color:#137333;display:block} .err{background:#fce8e6;color:#c5221f;display:block}
 small{color:#5b6b7b} ul{padding-left:20px;margin:8px 0}
</style></head><body><div class="card">
<h1>Supprimer mon compte OmniSMS</h1>
<p>Vous pouvez aussi supprimer votre compte depuis l'application : <b>Profil → Paramètres → Supprimer mon compte</b>.</p>
<div class="warn"><b>Attention — action définitive.</b> Sont supprimés ou anonymisés sous 30 jours :</div>
<ul><li>Votre profil (nom, e-mail, avatar, numéro de téléphone)</li><li>Vos contacts et conversations</li><li>Vos crédits restants (non remboursables)</li></ul>
<form id="f">
 <label for="tel">Votre numéro de téléphone (format international)</label>
 <input id="tel" type="tel" placeholder="+226 70 00 00 00" required autocomplete="tel">
 <div class="chk"><input id="c" type="checkbox" required><label for="c" style="margin:0;font-weight:400">Je confirme vouloir supprimer définitivement mon compte et comprendre que cette action est irréversible.</label></div>
 <button id="b" type="submit">Demander la suppression</button>
 <div id="ok" class="msg ok">✅ Demande enregistrée. Un opérateur va vérifier votre identité ; la suppression sera effective sous 30 jours maximum.</div>
 <div id="err" class="msg err">❌ Échec — vérifiez le numéro ou réessayez plus tard.</div>
 <p><small>Détail de la conservation des données : voir notre politique de confidentialité. Contact : support OmniSMS.</small></p>
</form></div>
<script>
document.getElementById('f').addEventListener('submit', async function(e){
  e.preventDefault();
  var b=document.getElementById('b'); b.disabled=true;
  var tel=document.getElementById('tel').value.trim();
  try{
    var r=await fetch('/api/account/web-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:tel,confirm:true})});
    if(r.status===202||r.status===200){document.getElementById('ok').style.display='block';document.getElementById('err').style.display='none';document.getElementById('f').reset();}
    else throw 0;
  }catch(_){document.getElementById('err').style.display='block';document.getElementById('ok').style.display='none';}
  b.disabled=false;
});
</script></body></html>`;

/* ── Page publique ── */
router.get('/web', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex');
  res.send(WEB_PAGE);
});

/* ── Demande web sans authentification ── */
router.post('/web-request', async (req, res) => {
  try {
    const { phone, confirm } = req.body || {};
    if (!phone || confirm !== true) {
      return res.status(400).json({ error: 'Numéro et confirmation requis.', code: 'MISSING_FIELDS' });
    }
    const norm = normalizePhone(phone) || String(phone).trim();
    if (!/^\+\d{8,15}$/.test(norm)) {
      return res.status(400).json({ error: 'Numéro invalide.', code: 'INVALID_PHONE' });
    }
    // Anti-abus : 3 demandes / heure / numéro (rateStore mémoire/Redis)
    const rateStore = require('../services/rateStore');
    const ok = await rateStore.hit(`rate:delreq:${hashPhone(norm)}`, 3600 * 1000, 3).catch(() => true);
    if (!ok) {
      return res.status(429).json({ error: 'Trop de demandes. Réessayez plus tard.', code: 'RATE_LIMIT' });
    }
    const id = 'req-' + crypto.randomUUID();
    const ref = db.collection('deletion_requests').doc(id);
    await ref.set({
      phoneHash: hashPhone(norm),
      status: 'pending',
      source: 'web',
      requestedAt: new Date().toISOString(),
    });
    logger.info('[Account] Demande de suppression web', { phone: maskPhone(norm) });
    return res.status(202).json({ success: true, message: 'Demande enregistrée.' });
  } catch (err) {
    logger.error('[Account] web-request échec', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

/* ── Suppression in-app (authentifiée) ── */
router.post('/delete', auth, async (req, res) => {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: 'Authentification requise.', code: 'UNAUTHENTICATED' });
  try {
    const now = new Date().toISOString();
    // Scrub PII (même modèle que DELETE /me, étendu : bio + fcmTokens)
    await db.collection('users').doc(uid).set({
      deleted: true,
      deletedAt: now,
      updatedAt: now,
      email: `deleted_${uid}@omnisms.deleted`,
      phone: null,
      name: 'Compte supprimé',
      username: `deleted_${String(uid).slice(-8)}`,
      avatar: null,
      bio: null,
      fcmTokens: [],
      purgeDueAt: new Date(Date.now() + RETENTION_DAYS * 86400 * 1000).toISOString(),
    }, { merge: true });

    // Audit horodaté (conservé après purge : prouve la suppression)
    await db.collection('account_deletions').doc(uid).set({
      uid, deletedAt: now, source: 'in_app', retentionDays: RETENTION_DAYS, purged: false,
    }, { merge: true });

    // Révocation des sessions Firebase (best-effort)
    try {
      const admin = require('../firebase-admin/index');
      if (!admin._stub && admin.auth) await admin.auth().revokeRefreshTokens(uid);
    } catch (_) { /* JWT-only : pas de refresh tokens Firebase */ }

    logger.info('[Account] Compte supprimé (in-app)', { uid });
    return res.status(200).json({
      success: true,
      message: `Compte supprimé. Les données résiduelles seront purgées définitivement sous ${RETENTION_DAYS} jours.`,
    });
  } catch (err) {
    logger.error('[Account] delete échec', { uid, error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

/* ── Purge définitive (admin) ── */
router.post('/admin/purge-expired', async (req, res) => {
  const expected = String(process.env.ADMIN_KEY || '').trim();
  if (!expected || String(req.get('x-admin-key') || '') !== expected) {
    return res.status(401).json({ success: false, error: 'Clé admin requise.', code: 'ADMIN_KEY_REQUIRED' });
  }
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString();
    let snap;
    try {
      snap = await db.collection('users').where('deleted', '==', true).limit(500).get();
    } catch (e) {
      return res.status(503).json({ success: false, error: 'Firestore indisponible.', code: 'FIRESTORE_UNAVAILABLE' });
    }
    const expired = (snap.docs || []).filter((d) => {
      const u = d.data() || {};
      return u.deleted && u.deletedAt && String(u.deletedAt) < cutoff;
    });
    let purged = 0;
    if (expired.length) {
      try {
        purged = await runBatched(db, expired, (batch, chunk) => {
          chunk.forEach((d) => batch.delete(d.ref || db.collection('users').doc(d.id)));
        });
      } catch (_) {
        // fallback : suppressions unitaires
        for (const d of expired) { await (d.ref || db.collection('users').doc(d.id)).delete(); purged++; }
      }
      const now = new Date().toISOString();
      for (const d of expired) {
        await db.collection('account_deletions').doc(d.id).set({ purged: true, purgedAt: now }, { merge: true }).catch(() => {});
      }
    }
    logger.info('[Account] Purge des comptes expirés', { purged, cutoff: cutoff.slice(0, 10) });
    return res.status(200).json({ success: true, purged, retentionDays: RETENTION_DAYS });
  } catch (err) {
    logger.error('[Account] purge échec', { error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
module.exports.WEB_PAGE = WEB_PAGE;
