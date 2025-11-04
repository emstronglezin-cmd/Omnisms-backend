const db = require('../config/firebase');

class AdRevenue {
  static async logAdRevenue(data) {
    const adRevenueRef = db.collection('adRevenues').doc();
    await adRevenueRef.set(data);
    return { id: adRevenueRef.id, ...data };
  }

  static async getAdRevenuesByUser(userId) {
    const snapshot = await db.collection('adRevenues').where('userId', '==', userId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = AdRevenue;