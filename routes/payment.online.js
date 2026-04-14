'use strict';
/**
 * OmniSMS — Routes Paiement ONLINE (Fusion Link / MoneyFusion)
 *
 * Flux :
 *  1. Utilisateur clique "Payer" → MoneyFusion traite
 *  2. MoneyFusion redirige → GET /payment-success
 *  3. L'utilisateur saisit son téléphone → POST /confirm-payment
 *  4. Backend active le premium (Firestore)
 *
 * Toutes les opérations sur les utilisateurs utilisent Firestore.
 */

const express = require('express');
const router  = express.Router();

const { findUserByPhone, upsertUser, updateUser, normalizePhone } = require('../config/db');
const {
  checkIpRateLimit,
  checkPhoneCooldown,
  markPhoneConfirmed,
  logPaymentAttempt,
} = require('../services/antifraud');

const MONEYFUSION_LINK = process.env.MONEYFUSION_PAYMENT_LINK || 'https://pay.moneyfusion.net/OmniSMS_premium';
const BACKEND_URL      = process.env.BACKEND_URL || 'https://votre-backend.com';

/* ============================================================
   GET /payment-success
   → Redirigé depuis MoneyFusion après paiement
============================================================ */
router.get('/payment-success', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Paiement terminé - OmniSMS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #ffffff;
      border-radius: 20px;
      padding: 40px 36px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 60px rgba(0,0,0,0.4);
      text-align: center;
    }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 26px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }
    .subtitle { color: #6b7280; font-size: 15px; margin-bottom: 32px; line-height: 1.5; }
    .form-group { text-align: left; margin-bottom: 24px; }
    label { display: block; font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 8px; }
    input[type="tel"] {
      width: 100%; padding: 14px 16px; border: 2px solid #e5e7eb;
      border-radius: 12px; font-size: 16px; color: #1f2937; outline: none;
      background: #f9fafb; transition: border-color .2s, box-shadow .2s;
    }
    input[type="tel"]:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.15); background: #fff; }
    .hint { font-size: 12px; color: #9ca3af; margin-top: 6px; }
    button[type="submit"] {
      width: 100%; padding: 16px;
      background: linear-gradient(135deg,#4f46e5,#7c3aed);
      color: white; border: none; border-radius: 12px;
      font-size: 16px; font-weight: 700; cursor: pointer;
    }
    button:disabled { opacity: .7; cursor: not-allowed; }
    #message {
      margin-top: 20px; padding: 14px 18px; border-radius: 12px;
      font-size: 15px; font-weight: 500; display: none; line-height: 1.5;
    }
    #message.success { background:#ecfdf5; color:#065f46; border:1px solid #6ee7b7; }
    #message.error   { background:#fef2f2; color:#991b1b; border:1px solid #fca5a5; }
    .security-note {
      margin-top: 24px; padding: 12px; background: #f8fafc;
      border-radius: 10px; font-size: 12px; color: #94a3b8; border: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Paiement terminé !</h1>
    <p class="subtitle">Votre paiement MoneyFusion a bien été reçu.<br>Entrez votre numéro pour activer le Premium.</p>
    <form id="confirmForm">
      <div class="form-group">
        <label for="phone">📱 Numéro de téléphone</label>
        <input type="tel" id="phone" name="phone" placeholder="+226XXXXXXXX" required autocomplete="tel" inputmode="tel"/>
        <p class="hint">Le même numéro utilisé pour le paiement MoneyFusion</p>
      </div>
      <button type="submit" id="submitBtn">Valider mon accès Premium</button>
    </form>
    <div id="message"></div>
    <div class="security-note">🔒 Votre numéro est utilisé uniquement pour l'activation. Il ne sera jamais partagé.</div>
  </div>
  <script>
    const form = document.getElementById('confirmForm');
    const btn  = document.getElementById('submitBtn');
    const msg  = document.getElementById('message');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = document.getElementById('phone').value.trim();
      if (!phone) { showMessage('❌ Veuillez entrer votre numéro.', 'error'); return; }
      btn.disabled = true;
      btn.textContent = 'Validation en cours...';
      msg.style.display = 'none';
      try {
        const res = await fetch('/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showMessage('⭐ ' + (data.message || 'Premium activé !'), 'success');
          form.style.display = 'none';
        } else {
          showMessage('❌ ' + (data.error || 'Erreur activation.'), 'error');
          btn.disabled = false;
          btn.textContent = 'Valider mon accès Premium';
        }
      } catch {
        showMessage('❌ Erreur réseau. Réessayez.', 'error');
        btn.disabled = false;
        btn.textContent = 'Valider mon accès Premium';
      }
    });
    function showMessage(text, type) {
      msg.textContent = text; msg.className = type; msg.style.display = 'block';
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/* ============================================================
   POST /confirm-payment
   → Reçoit { phone } depuis la page HTML — active le premium
============================================================ */
router.post('/confirm-payment', async (req, res) => {
  const ip          = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '0.0.0.0';
  const { phone }   = req.body;

  if (!phone || typeof phone !== 'string' || phone.trim().length < 8) {
    logPaymentAttempt({ phone: phone || 'unknown', ip, action: 'CONFIRM_PAYMENT', status: 'error', details: 'missing_phone' });
    return res.status(400).json({ success: false, error: 'Numéro de téléphone requis.' });
  }

  const normalizedPhone = normalizePhone(phone.trim());

  // Rate limit par IP
  if (!checkIpRateLimit(ip)) {
    logPaymentAttempt({ phone: normalizedPhone, ip, action: 'CONFIRM_PAYMENT', status: 'blocked', details: 'ip_rate_limit' });
    return res.status(429).json({ success: false, error: 'Trop de tentatives. Attendez 30 secondes.' });
  }

  // Cooldown par téléphone
  if (!checkPhoneCooldown(normalizedPhone)) {
    logPaymentAttempt({ phone: normalizedPhone, ip, action: 'CONFIRM_PAYMENT', status: 'blocked', details: 'phone_cooldown' });
    return res.status(429).json({ success: false, error: 'Requête trop rapide. Attendez 30 secondes.' });
  }

  try {
    // Récupérer ou créer l'utilisateur (Firestore)
    let user = await findUserByPhone(normalizedPhone);
    if (!user) {
      user = await upsertUser(normalizedPhone, { phone: normalizedPhone, credits: 0, premium: false });
    }

    if (user.premium) {
      logPaymentAttempt({ phone: normalizedPhone, ip, action: 'CONFIRM_PAYMENT', status: 'blocked', details: 'already_premium' });
      return res.status(400).json({ success: false, error: 'Ce numéro est déjà Premium.' });
    }

    // Activer le premium
    const updatedUser = await updateUser(normalizedPhone, {
      premium            : true,
      premiumActivatedAt : new Date().toISOString(),
      lastPaymentAt      : new Date().toISOString(),
      activationIp       : ip,
      activationChannel  : 'online_moneyfusion',
    });

    markPhoneConfirmed(normalizedPhone);

    logPaymentAttempt({
      phone: normalizedPhone, ip,
      action : 'CONFIRM_PAYMENT',
      status : 'success',
      details: 'premium_activated via moneyfusion online',
    });

    return res.status(200).json({
      success    : true,
      message    : 'Premium activé ✅ Bienvenue dans OmniSMS Premium !',
      phone      : normalizedPhone,
      premium    : true,
      activatedAt: updatedUser?.premiumActivatedAt || new Date().toISOString(),
    });
  } catch (err) {
    logPaymentAttempt({ phone: normalizedPhone, ip, action: 'CONFIRM_PAYMENT', status: 'error', details: err.message });
    console.error('❌ [confirm-payment]', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur. Réessayez.' });
  }
});

/* ============================================================
   GET /moneyfusion-link
   → Retourner le lien MoneyFusion (pour l'app mobile)
============================================================ */
router.get('/moneyfusion-link', (req, res) => {
  return res.json({
    success    : true,
    link       : MONEYFUSION_LINK,
    amount     : 2000,
    currency   : 'XOF',
    description: 'Abonnement OmniSMS Premium',
    return_url : `${BACKEND_URL}/payment-success`,
  });
});

module.exports = router;
