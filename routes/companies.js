const express = require('express');
const authenticate = require('../middleware/authenticate');
const Company = require('../models/Company');
const router = express.Router();

// Create a company
router.post('/create', authenticate, async (req, res) => {
  const { name, logo } = req.body;

  try {
    const company = new Company({
      name,
      logo,
      owner: req.user.id,
      verified: false,
    });

    await company.save();
    res.status(201).json({ message: 'Company created successfully', company });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create company', error: error.message });
  }
});

// Verify a company (Admin only)
router.post('/verify/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const company = await Company.findById(id);
    if (!company) return res.status(404).json({ message: 'Company not found' });

    company.verified = true;
    await company.save();

    res.status(200).json({ message: 'Company verified successfully', company });
  } catch (error) {
    res.status(500).json({ message: 'Failed to verify company', error: error.message });
  }
});

module.exports = router;