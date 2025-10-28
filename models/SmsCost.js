const mongoose = require('mongoose');

const smsCostSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  unitCost: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('SmsCost', smsCostSchema);