// paymentService.js
// Service pour gérer les paiements offline via SMS

const processPayment = (userId, amount) => {
    console.log(`Traitement du paiement de ${amount} pour l'utilisateur ${userId}`);
    // Logique pour traiter les paiements via MoneyFusion
};

module.exports = { processPayment };