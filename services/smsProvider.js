// smsProvider.js
// Service pour gérer l'envoi et la réception des SMS

const sendSMS = (to, message) => {
    console.log(`Envoi de SMS à ${to}: ${message}`);
    // Logique pour envoyer un SMS via le fournisseur
};

module.exports = { sendSMS };