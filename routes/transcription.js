const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { sendSms } = require('../services/africasTalking');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB limit
});

// Transcription route
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const filePath = req.file.path;
  const model = 'small'; // Whisper model to use

  exec(`whisper ${filePath} --model ${model} --language en --output_format txt`, async (err, stdout, stderr) => {
    if (err) {
      console.error('Whisper error:', stderr);
      fs.unlinkSync(filePath); // Clean up the temporary file
      return res.status(500).json({ error: 'Failed to transcribe audio' });
    }

    const transcriptionPath = `${filePath}.txt`;
    if (fs.existsSync(transcriptionPath)) {
      const transcription = fs.readFileSync(transcriptionPath, 'utf8');
      fs.unlinkSync(filePath); // Clean up the temporary file
      fs.unlinkSync(transcriptionPath); // Clean up the transcription file

      // If the user is offline, send the transcription via SMS
      const { recipient } = req.body;
      if (recipient) {
        await sendSms(recipient, transcription.trim());
      }

      return res.status(200).json({ text: transcription.trim() });
    } else {
      fs.unlinkSync(filePath); // Clean up the temporary file
      return res.status(500).json({ error: 'Transcription file not found' });
    }
  });
});

module.exports = router;