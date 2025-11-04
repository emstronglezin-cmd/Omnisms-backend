const functions = require("firebase-functions");
const app = require("./app"); // Assurez-vous que le fichier app.js contient la configuration Express

exports.api = functions.https.onRequest(app);