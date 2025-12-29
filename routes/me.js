const express = require('express');
const authenticate = require('../middleware/authenticate');
const User = require('../models/User');

const router = express.Router();

// Route to get user premium status
router.get('/', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ premium: user.isPremium || false });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch user status', error: error.message });
  }
});

module.exports = router;