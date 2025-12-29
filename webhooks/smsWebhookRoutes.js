// smsWebhookRoutes.js
// Routes pour les webhooks SMS

const express = require('express');
const { handleIncomingSMS } = require('./smsWebhookController');

const router = express.Router();

router.post('/sms', handleIncomingSMS);

module.exports = router;