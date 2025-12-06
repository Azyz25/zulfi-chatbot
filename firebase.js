// init firebase admin
const admin = require('firebase-admin');

// 1. الحصول على المفتاح الجديد كـ "نص" من متغير البيئة
const serviceAccountString = process.env.GOOGLE_SERVICE_KEY;

// 2. تحويل النص إلى كائن JSON يمكن لـ Firebase Admin قراءته
const serviceAccountJson = JSON.parse(serviceAccountString);

admin.initializeApp({
  // استخدام الكائن JSON المحوّل بدلاً من قراءة الملف
  credential: admin.credential.cert(serviceAccountJson), 
  storageBucket: 'appd-75fbf.appspot.com' // <-- عوّض هذا بمعرف مشروعك
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { admin, db, bucket };