const express = require('express');
const User = require('../models/User');
const router = express.Router();
const authenticate = require('../middleware/authenticate');

// Add credits (for watching ads or daily bonus)
router.post('/add', authenticate, async (req, res) => {
  const { amount } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    await user.addCredits(amount);
    res.status(200).json({ message: 'Credits added successfully', credits: user.credits });
  } catch (err) {
    res.status(500).json({ message: 'Error adding credits', error: err.message });
  }
});

// Decrement credits (for sending messages)
router.post('/decrement', authenticate, async (req, res) => {
  const { amount } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    await user.decrementCredits(amount);
    res.status(200).json({ message: 'Credits decremented successfully', credits: user.credits });
  } catch (err) {
    res.status(400).json({ message: 'Error decrementing credits', error: err.message });
  }
});

module.exports = router;