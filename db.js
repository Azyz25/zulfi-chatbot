// db.js - الكود المحدّث
// وظائف بسيطة للتعامل مع Firestore & Storage
const { db, bucket } = require('./firebase');
const { v4: uuidv4 } = require('uuid');

const USER_SESSIONS = 'user_sessions'; // collection لحالات المستخدم المؤقتة
const BUSINESSES = 'businesses'; // top-level collection

async function getUserState(whatsappId) {
  const doc = await db.collection(USER_SESSIONS).doc(whatsappId).get();
  if (!doc.exists) return { state: '0', data: {} };
  return doc.data();
}

async function updateUserState(whatsappId, state, data = {}) {
  // 💡 إضافة حقل last_updated لتتبع آخر تفاعل
  await db.collection(USER_SESSIONS).doc(whatsappId).set({ state, data, last_updated: new Date() }, { merge: true });
}

async function resetUserState(whatsappId) {
  await db.collection(USER_SESSIONS).doc(whatsappId).delete();
}

function generateActivityCode(categoryKey = 'OTH') {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${(categoryKey || 'OTH').toUpperCase().slice(0,3)}-${suffix}`;
}

// save new activity under collection businesses/{category}/items/{code}
async function saveNewActivity(activity) {
  const code = activity.activity_code || generateActivityCode(activity.category_key || 'OTH');
  const categoryKey = activity.category_key || 'other_businesses';
  const docRef = db.collection(BUSINESSES).doc(categoryKey).collection('items').doc(code);
  activity.activity_code = code;
  activity.created_at = new Date();
  await docRef.set(activity, { merge: true });
  return code;
}

async function findActivityByCode(code) {
  const categories = await db.collection(BUSINESSES).listDocuments();
  for (const c of categories) {
    const snapshot = await db.collection(BUSINESSES).doc(c.id).collection('items').doc(code).get();
    if (snapshot.exists) return { ref: db.collection(BUSINESSES).doc(c.id).collection('items').doc(code), data: snapshot.data(), category: c.id };
  }
  return null;
}

async function updateActivity(docRef, updates) {
  await docRef.update(updates);
}

async function uploadMediaBase64(filename, base64Data, contentType = 'image/png') {
  // base64Data: data:image/png;base64,AAAA...
  // remove prefix
  const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
  let bufferData = null;
  let mime = contentType;
  if (matches) {
    mime = matches[1];
    bufferData = Buffer.from(matches[2], 'base64');
  } else {
    bufferData = Buffer.from(base64Data, 'base64');
  }

  const fileName = `${Date.now()}_${uuidv4()}_${filename}`;
  const file = bucket.file(fileName);

  await file.save(bufferData, {
    metadata: {
      contentType: mime,
      metadata: {
        firebaseStorageDownloadTokens: uuidv4()
      }
    }
  });

  const token = file.metadata.metadata.firebaseStorageDownloadTokens;
  const bucketName = bucket.name;
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;
  return url;
}

// 💡 وظائف الإحصائيات الجديدة
async function countTotalBusinesses() {
  let totalCount = 0;
  const categoriesSnap = await db.collection(BUSINESSES).listDocuments();
  for (const c of categoriesSnap) {
    // يتوقع أن يكون المسار: businesses/{category}/items
    const itemsSnap = await db.collection(BUSINESSES).doc(c.id).collection('items').get();
    totalCount += itemsSnap.size;
  }
  return totalCount;
}

async function getBotStats() {
  const totalBusinesses = await countTotalBusinesses();
  
  // 1. عدد المستخدمين الحاليين (لهم جلسات نشطة)
  const usersSnap = await db.collection(USER_SESSIONS).get();
  const totalActiveUsers = usersSnap.size;
  
  // 2. آخر اتصال (أحدث حقل last_updated)
  const lastContactSnap = await db.collection(USER_SESSIONS)
    .orderBy('last_updated', 'desc')
    .limit(1)
    .get();
  
  let lastContactInfo = null;
  if (!lastContactSnap.empty) {
    const doc = lastContactSnap.docs[0];
    lastContactInfo = {
      whatsappId: doc.id,
      timestamp: doc.data().last_updated.toDate().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' }),
    };
  }

  return {
    totalActiveUsers: totalActiveUsers,
    totalBusinesses: totalBusinesses,
    lastContact: lastContactInfo,
  };
}


module.exports = {
  getUserState,
  updateUserState, 
  resetUserState,
  saveNewActivity,
  findActivityByCode,
  updateActivity,
  uploadMediaBase64,
  generateActivityCode,
  getBotStats, // تصدير الدالة الجديدة
};