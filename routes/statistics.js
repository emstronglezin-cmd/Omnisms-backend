const express = require('express');
const Message = require('../models/Message');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Récupérer les statistiques utilisateur
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const messagesSent = await Message.countDocuments({ senderId: userId });
    const messagesReceived = await Message.countDocuments({ receiverId: userId });

    res.status(200).json({
      messagesSent,
      messagesReceived,
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la récupération des statistiques', error: err.message });
  }
});

module.exports = router;