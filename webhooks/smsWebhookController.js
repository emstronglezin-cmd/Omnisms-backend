// smsWebhookController.js
// Gestion des webhooks pour les SMS

const handleIncomingSMS = (req, res) => {
    const { from, message } = req.body;
    console.log(`SMS reçu de ${from}: ${message}`);
    // Logique pour traiter le SMS reçu
    res.status(200).send('SMS reçu');
};

module.exports = { handleIncomingSMS };