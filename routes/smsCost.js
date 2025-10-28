const express = require('express');
const SmsCost = require('../models/SmsCost');

const router = express.Router();

// Get all SMS costs
router.get('/', async (req, res) => {
  try {
    const smsCosts = await SmsCost.find();
    res.status(200).json(smsCosts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch SMS costs' });
  }
});

// Add a new SMS cost
router.post('/', async (req, res) => {
  const { provider, unitCost } = req.body;

  try {
    const newSmsCost = new SmsCost({ provider, unitCost });
    await newSmsCost.save();
    res.status(201).json(newSmsCost);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add SMS cost' });
  }
});

// Update an SMS cost
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { provider, unitCost } = req.body;

  try {
    const updatedSmsCost = await SmsCost.findByIdAndUpdate(
      id,
      { provider, unitCost, updatedAt: Date.now() },
      { new: true }
    );

    if (!updatedSmsCost) {
      return res.status(404).json({ error: 'SMS cost not found' });
    }

    res.status(200).json(updatedSmsCost);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update SMS cost' });
  }
});

// Delete an SMS cost
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const deletedSmsCost = await SmsCost.findByIdAndDelete(id);

    if (!deletedSmsCost) {
      return res.status(404).json({ error: 'SMS cost not found' });
    }

    res.status(200).json({ message: 'SMS cost deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete SMS cost' });
  }
});

module.exports = router;