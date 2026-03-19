/**
 * 🧠 OmniSMS Message Router
 * Décide automatiquement : Internet ou SMS
 */
async function routeMessage({
  sender,
  receiver,
  content,
  sendInternet,
  sendSMS
}) {
  // Si le destinataire est en ligne
  if (receiver.channel === 'online') {
    await sendInternet(receiver, content);
    return { deliveredVia: 'internet' };
  }

  // Sinon SMS
  await sendSMS(receiver.phone, content);
  return { deliveredVia: 'sms' };
}

module.exports = { routeMessage };
