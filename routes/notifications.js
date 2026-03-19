const express = require('express');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Activer/désactiver les notifications
router.put('/toggle', authenticate, async (req, res) => {
  const { notificationsEnabled } = req.body;
  try {
    const user = req.user;
    user.set('notificationsEnabled', notificationsEnabled);
    await user.save(null, { useMasterKey: true });
    res.status(200).json({ message: 'Préférences de notifications mises à jour' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour des notifications', error: err.message });
  }
});

// Gérer les sons et alertes
router.put('/preferences', authenticate, async (req, res) => {
  const { alertSettings, soundSettings } = req.body;
  try {
    const user = req.user;
    if (alertSettings) user.set('alertSettings', alertSettings);
    if (soundSettings) user.set('soundSettings', soundSettings);
    await user.save(null, { useMasterKey: true });
    res.status(200).json({ message: 'Préférences de sons et alertes mises à jour' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour des préférences', error: err.message });
  }
});

module.exports = router;