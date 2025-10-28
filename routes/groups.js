const express = require('express');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Create a group
router.post('/', authenticate, async (req, res) => {
  const { name, members } = req.body;
  try {
    const group = new Group({ name, members });
    await group.save();
    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add members to a group
router.post('/:id/members', authenticate, async (req, res) => {
  const { id } = req.params;
  const { members } = req.body;
  try {
    const group = await Group.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    group.members.push(...members);
    await group.save();
    res.status(200).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a member from a group
router.delete('/:id/members/:memberId', authenticate, async (req, res) => {
  const { id, memberId } = req.params;
  try {
    const group = await Group.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    group.members = group.members.filter((member) => member.toString() !== memberId);
    await group.save();
    res.status(200).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message to a group
router.post('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  try {
    const group = await Group.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const message = new GroupMessage({
      groupId: id,
      senderId: req.user.id,
      content,
    });
    await message.save();
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages from a group
router.get('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const messages = await GroupMessage.find({ groupId: id }).sort({ timestamp: -1 });
    res.status(200).json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;