const db = require('../config/firebase');

class GroupMessage {
  static async createGroupMessage(data) {
    const groupMessageRef = db.collection('groupMessages').doc();
    await groupMessageRef.set(data);
    return { id: groupMessageRef.id, ...data };
  }

  static async getMessagesByGroup(groupId) {
    const snapshot = await db.collection('groupMessages').where('groupId', '==', groupId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = GroupMessage;