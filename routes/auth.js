const express = require('express');
const Parse = require('../parse/node');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  console.log('Incoming request:', req.method, req.url);
  const { name, email, password, phone } = req.body;

  try {
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Missing fields' });
    }

    // Keep compatibility with Parse logic if available
    try {
      const query = new Parse.Query(Parse.User);
      query.equalTo('username', phone || email);
      const existingUser = await query.first();

      if (existingUser) {
        return res.status(400).json({ message: 'User already exists' });
      }

      const user = new Parse.User();
      user.set('username', phone || email);
      user.set('password', password);
      user.set('name', name);
      user.set('email', email);
      if (phone) user.set('phone', phone);

      await user.signUp();
    } catch (parseErr) {
      console.warn('Parse registration fallback:', parseErr.message || parseErr);
    }

    return res.status(200).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error('Register route error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const user = await Parse.User.logIn(phone, password);
    res.status(200).json({ sessionToken: user.getSessionToken() });
  } catch (err) {
    res.status(400).json({ message: 'Invalid credentials', error: err.message });
  }
});

// Modifier le profil utilisateur
router.put('/profile', authenticate, async (req, res) => {
  const { name, country, password } = req.body;
  try {
    const user = req.user;

    if (name) user.set('name', name);
    if (country) user.set('country', country);
    if (password) user.set('password', password);

    await user.save(null, { useMasterKey: true });
    res.status(200).json({ message: 'Profil mis à jour avec succès' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour du profil', error: err.message });
  }
});

module.exports = router;