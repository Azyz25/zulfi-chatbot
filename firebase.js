// firebase.js
const admin = require('firebase-admin');

// 💡 تم التعديل لقراءة مفتاح الخدمة من متغير البيئة GOOGLE_SERVICE_KEY
const FIREBASE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_KEY;

// تأكد من أن متغير البيئة مضبوط
if (!FIREBASE_SERVICE_ACCOUNT_KEY) {
    throw new Error("GOOGLE_SERVICE_KEY environment variable is not set. Please ensure the full JSON content of your service account key is stored in this variable on Render.");
}

// قم بتحويل محتوى المتغير (النص JSON) إلى كائن JavaScript
const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY);

// تهيئة Firebase
if (admin.apps.length === 0) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // يتم تحديد مسار storageBucket بشكل ديناميكي
        storageBucket: serviceAccount.project_id + '.appspot.com' 
    });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { db, bucket };