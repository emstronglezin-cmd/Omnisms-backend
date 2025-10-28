const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  country: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  userType: {
    type: String,
    enum: ['free', 'premium', 'enterprise', 'native_sms'],
    default: 'free',
  },
  credits: { type: Number, default: 0 },
  publicId: { type: String, unique: true },
  hasApp: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.addCredits = function (amount) {
  this.credits += amount;
  return this.save();
};

userSchema.methods.decrementCredits = function (amount) {
  if (this.credits < amount) {
    throw new Error('Insufficient credits');
  }
  this.credits -= amount;
  return this.save();
};

module.exports = mongoose.model('User', userSchema);