const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(400).json({ message: 'Invalid token.' });
  }
};

const verifyApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (apiKey !== process.env.API_KEY) {
    return res.status(403).json({ message: 'Forbidden. Invalid API key.' });
  }
  next();
};

const encryptToken = (token) => {
  const cipher = crypto.createCipher('aes-256-cbc', process.env.ENCRYPTION_KEY);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
};

module.exports = { authMiddleware, verifyApiKey, encryptToken };