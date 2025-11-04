const db = require('../config/firebase');

class SmsLog {
  static async logSms(data) {
    const smsLogRef = db.collection('smsLogs').doc();
    await smsLogRef.set(data);
    return { id: smsLogRef.id, ...data };
  }

  static async getSmsLogsByUser(userId) {
    const snapshot = await db.collection('smsLogs').where('user_id', '==', userId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = SmsLog;