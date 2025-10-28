const express = require('express');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const authenticate = require('../middleware/authenticate');
const router = express.Router();

// Webhook to validate subscription payment
router.post('/webhook/moneyfusion', async (req, res) => {
  try {
    // Replace MoneyFusion logic with direct API calls
    const isValid = true; // Placeholder for signature validation logic
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Placeholder for processing webhook data
    console.log('Processing MoneyFusion webhook:', req.body);
    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Error processing MoneyFusion webhook:', error.message);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Subscription plans
const plans = {
  premium: { amount: 2000, description: 'Premium Plan - 1 Month' },
  native_sms_weekly: { amount: 50, description: 'Native SMS Plan - 1 Week' },
  native_sms_monthly: { amount: 150, description: 'Native SMS Plan - 1 Month' },
  enterprise: { amount: 10000, description: 'Enterprise Plan - 1 Month' },
};

// Subscribe to a plan
router.post('/subscribe', authenticate, async (req, res) => {
  const { plan } = req.body;
  const user = await User.findById(req.user.id);

  if (!user) return res.status(404).json({ message: 'User not found' });
  if (!plans[plan]) return res.status(400).json({ message: 'Invalid plan selected' });

  try {
    const invoiceData = {
      items: [{ name: plans[plan].description, quantity: 1, unit_price: plans[plan].amount }],
      totalAmount: plans[plan].amount,
      description: plans[plan].description,
    };

    const invoice = await createInvoice(invoiceData);
    res.status(200).json({ message: 'Invoice created successfully', invoice });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create invoice', error: error.message });
  }
});

module.exports = router;