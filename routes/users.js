const express = require('express');
const User = require('../models/User');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Link user with phone or publicId
router.post('/link', authenticate, async (req, res) => {
  const { phone, userId, publicId } = req.body;
  try {
    let user = await User.findOne({ phone });

    if (!user) {
      user = new User({ phone, publicId });
      await user.save();
    } else {
      if (userId) user._id = userId;
      if (publicId) user.publicId = publicId;
      await user.save();
    }

    res.status(200).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;