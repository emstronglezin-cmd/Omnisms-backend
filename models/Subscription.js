const db = require('../config/firebase');

class Subscription {
  static async createSubscription(data) {
    const subscriptionRef = db.collection('subscriptions').doc();
    await subscriptionRef.set(data);
    return { id: subscriptionRef.id, ...data };
  }

  static async getSubscriptionsByUser(userId) {
    const snapshot = await db.collection('subscriptions').where('user_id', '==', userId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = Subscription;