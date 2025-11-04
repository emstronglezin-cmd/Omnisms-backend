const db = require('../config/firebase');

class SmsCost {
  static async setSmsCost(data) {
    const smsCostRef = db.collection('smsCosts').doc();
    await smsCostRef.set(data);
    return { id: smsCostRef.id, ...data };
  }

  static async getSmsCost() {
    const snapshot = await db.collection('smsCosts').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = SmsCost;