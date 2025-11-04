const db = require('../config/firebase');

class User {
  static async createUser(data) {
    const userRef = db.collection('users').doc();
    await userRef.set(data);
    return { id: userRef.id, ...data };
  }

  static async getUserById(userId) {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      throw new Error('User not found');
    }
    return { id: userDoc.id, ...userDoc.data() };
  }
}

module.exports = User;