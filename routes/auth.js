const express = require('express');
const Parse = require('parse/node');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  const { name, country, phone, password, userType } = req.body;
  try {
    const query = new Parse.Query(Parse.User);
    query.equalTo('username', phone);
    const existingUser = await query.first();

    if (existingUser) {
      return res.status(400).json({ message: 'Phone number already exists' });
    }

    const user = new Parse.User();
    user.set('username', phone);
    user.set('password', password);
    user.set('name', name);
    user.set('country', country);
    user.set('userType', userType);

    await user.signUp();
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    res.status(400).json({ message: 'Error registering user', error: err.message });
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

module.exports = router;