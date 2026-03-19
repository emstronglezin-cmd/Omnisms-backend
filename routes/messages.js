const express = require('express');
const Message = require('../models/Message');
const authenticate = require('../middleware/authenticate');
const { sendSms } = require('../services/africasTalking');

const router = express.Router();

// Send message
router.post('/send', authenticate, async (req, res) => {
  const { receiverId, content, type } = req.body; // type: 'text' or 'voice'
  try {
    const message = new Message({
      senderId: req.user.id,
      receiverId,
      content,
      type,
    });
    await message.save();

    // If the recipient is a native SMS user, send via Africa's Talking
    if (type === 'text') {
      await sendSms(receiverId, content);
    }

    res.status(201).json({ message: 'Message sent successfully', data: message });
  } catch (err) {
    res.status(500).json({ message: 'Error sending message', error: err.message });
  }
});

// Get messages
router.get('/:userId', authenticate, async (req, res) => {
  const { userId } = req.params;
  try {
    const messages = await Message.find({
      $or: [
        { senderId: userId },
        { receiverId: userId },
      ],
    }).sort({ timestamp: -1 });
    res.status(200).json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Error retrieving messages', error: err.message });
  }
});

// Réagir avec un emoji
router.post('/:id/react', authenticate, async (req, res) => {
  const { id } = req.params;
  const { emoji } = req.body;
  try {
    const message = await Message.findById(id);
    if (!message) return res.status(404).json({ message: 'Message non trouvé' });

    message.reactions = message.reactions || [];
    message.reactions.push({ userId: req.user.id, emoji });
    await message.save();

    res.status(200).json({ message: 'Réaction ajoutée avec succès' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout de la réaction', error: err.message });
  }
});

// Supprimer un message
router.delete('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const message = await Message.findById(id);
    if (!message) return res.status(404).json({ message: 'Message non trouvé' });

    if (message.senderId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Vous ne pouvez supprimer que vos propres messages' });
    }

    await message.remove();
    res.status(200).json({ message: 'Message supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la suppression du message', error: err.message });
  }
});

module.exports = router;