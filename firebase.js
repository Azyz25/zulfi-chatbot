// init firebase admin
const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(require(serviceAccountPath)),
  storageBucket: 'appd-75fbf.appspot.com' // <-- عوّض هذا بمعرف مشروعك
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { admin, db, bucket };
