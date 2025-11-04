const db = require('../config/firebase');

class Company {
  static async createCompany(data) {
    const companyRef = db.collection('companies').doc();
    await companyRef.set(data);
    return { id: companyRef.id, ...data };
  }

  static async getCompaniesByOwner(ownerId) {
    const snapshot = await db.collection('companies').where('owner', '==', ownerId).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = Company;