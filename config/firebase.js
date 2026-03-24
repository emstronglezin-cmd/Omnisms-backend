const admin = require('../firebase-admin/index');
// const serviceAccount = require('./omnisms-b98c5-firebase-adminsdk-fbsvc-c49b735d46.json');

admin.initializeApp({
  credential: admin.credential.cert({}),
  databaseURL: `https://mock.firebaseio.com`
});

module.exports = admin;