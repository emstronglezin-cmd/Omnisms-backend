const db = require('../config/firebase');

class Message {
  static async createMessage(data) {
    const messageRef = db.collection('messages').doc();
    await messageRef.set(data);
    return { id: messageRef.id, ...data };
  }

  static async getMessagesByUser(userId) {
    const snapshot = await db.collection('messages').where('userId', '==', userId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = Message;