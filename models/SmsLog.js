const mongoose = require('mongoose');

const smsLogSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message_id: { type: String, required: true },
  cost: { type: Number, required: true },
  operator: { type: String, required: true },
  date: { type: Date, default: Date.now },
  status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
});

module.exports = mongoose.model('SmsLog', smsLogSchema);