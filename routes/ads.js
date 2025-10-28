const express = require('express');
const router = express.Router();
const AdRevenue = require('../models/AdRevenue');
const { logInMobiEvent } = require('../services/inmobi');

// Updated route to save AdMob revenue in MongoDB
router.post('/revenue', async (req, res) => {
  const { userId, amount } = req.body;

  try {
    const revenue = new AdRevenue({ userId, amount });
    await revenue.save();
    res.status(200).json({ message: 'AdMob revenue recorded successfully.', revenue });
  } catch (error) {
    console.error('Error recording AdMob revenue:', error.message);
    res.status(500).json({ error: 'Failed to record AdMob revenue.' });
  }
});

router.post('/api/pub/event', async (req, res) => {
  try {
    await logInMobiEvent(req.body);
    res.status(200).json({ message: 'InMobi event logged successfully' });
  } catch (error) {
    console.error('Error logging InMobi event:', error.message);
    res.status(500).json({ error: 'Failed to log event' });
  }
});

module.exports = router;