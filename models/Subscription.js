const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan_name: { type: String, required: true },
  price: { type: Number, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'inactive' },
  payment_reference: { type: String, required: true },
});

module.exports = mongoose.model('Subscription', subscriptionSchema);