const africastalking = require('africastalking')({
  apiKey: process.env.AFRICASTALKING_API_KEY,
  username: process.env.AFRICASTALKING_USERNAME,
});

const sms = africastalking.SMS;

const sendSms = async (to, message) => {
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