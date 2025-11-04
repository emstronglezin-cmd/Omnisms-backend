const admin = require('firebase-admin');
const serviceAccount = require('./omnisms-b98c5-firebase-adminsdk-fbsvc-c49b735d46.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

module.exports = admin;