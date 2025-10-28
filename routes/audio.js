const express = require('express');
const multer = require('multer');
const path = require('path');
const { exec } = require('child_process');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Configure multer for audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads/audio'));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// Upload audio file
router.post('/upload/audio', authenticate, upload.single('audio'), (req, res) => {
  try {
    const filePath = `/uploads/audio/${req.file.filename}`;
    res.status(201).json({ filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transcribe audio file
router.post('/transcribe', authenticate, (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  const fullPath = path.join(__dirname, `..${filePath}`);
  exec(`whisper ${fullPath} --language en`, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });

    res.status(200).json({ transcription: stdout.trim() });
  });
});

module.exports = router;