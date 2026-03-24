// Initialize Africa's Talking only if credentials are available
let sms = null;
if (process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME) {
  const africastalking = require('africastalking')({
    apiKey: process.env.AFRICASTALKING_API_KEY,
    username: process.env.AFRICASTALKING_USERNAME,
  });
  sms = africastalking.SMS;
}

const sendSms = async (to, message) => {
  if (!sms) {
    console.log('Africa\'s Talking not configured');
    return { success: false, message: 'SMS service not configured' };
  }
  try {
    const response = await sms.send({
      to,
      message,
    });
    console.log('SMS sent successfully:', response);
  } catch (error) {
    console.error('Error sending SMS:', error.message);
  }
};

module.exports = { sendSms };