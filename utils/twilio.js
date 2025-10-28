const SmsLog = require('../models/SmsLog');

// Validate Twilio environment variables
const requiredEnvVars = ['TWILIO_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    throw new Error(`La variable d'environnement ${envVar} est manquante. Veuillez la définir dans le fichier .env.`);
  }
});

const sendSms = async (to, body, userId) => {
  try {
    // Log SMS details
    const smsLog = new SmsLog({
      user_id: userId,
      message_id: 'simulated-message-sid', // Simulated message ID
      cost: 12, // Example cost
      operator: 'Twilio',
      status: 'sent',
    });
    await smsLog.save();
  } catch (err) {
    console.error('SMS Log Error:', err.message);
    throw new Error('Failed to log SMS');
  }
};

const handleIncomingSms = async (req, res) => {
  const { From, Body } = req.body;

  try {
    console.log(`Incoming SMS from ${From}: ${Body}`);

    // Deduct cost and distribute via PayDunya
    const smsCost = 12; // FCFA
    const twilioShare = 7; // FCFA
    const ownerShare = smsCost - twilioShare;

    // Simulate PayDunya transfer for owner's share
    const paydunya = require('../services/paydunya');
    await paydunya.withdrawFunds(ownerShare, 'owner_account');

    res.status(200).send('<Response><Message>Thank you for your message!</Message></Response>');
  } catch (error) {
    console.error('Error handling incoming SMS:', error.message);
    res.status(500).send('Failed to process SMS');
  }
};

module.exports = { sendSms, handleIncomingSms };