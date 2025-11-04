const db = require('../config/firebase');

class Group {
  static async createGroup(data) {
    const groupRef = db.collection('groups').doc();
    await groupRef.set(data);
    return { id: groupRef.id, ...data };
  }

  static async getGroupsByUser(userId) {
    const snapshot = await db.collection('groups').where('members', 'array-contains', userId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = Group;