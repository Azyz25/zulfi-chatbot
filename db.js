const { db, bucket } = require('./firebase');
const { v4: uuidv4 } = require('uuid');

const USER_SESSIONS = 'user_sessions';
const BUSINESSES = 'businesses';

async function getUserState(whatsappId) {
  const doc = await db.collection(USER_SESSIONS).doc(whatsappId).get();
  if (!doc.exists) return { state: '0', data: {} };
  return doc.data();
}

async function updateUserState(whatsappId, state, data = {}) {
  // last_updated ضروري لنظام التذكير
  await db.collection(USER_SESSIONS).doc(whatsappId).set({ 
    state, 
    data, 
    last_updated: new Date().toISOString() 
  }, { merge: true });
}

async function resetUserState(whatsappId) {
  await db.collection(USER_SESSIONS).doc(whatsappId).delete();
}

// 💡 دالة جديدة لجلب الجلسات المعلقة للتذكير
async function getStaleSessions() {
  const now = new Date();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000); // قبل 30 دقيقة

  // نجلب كل الجلسات ونفلترها (لأن فايربيس أحياناً يكون الفلترة بالتواريخ معقدة قليلاً)
  const snapshot = await db.collection(USER_SESSIONS).get();
  const staleUsers = [];

  snapshot.forEach(doc => {
    const d = doc.data();
    // نتأكد أنه ليس في القائمة الرئيسية (0) ولم يتم تذكيره سابقاً
    if (d.state !== '0' && d.last_updated) {
      const lastUpdate = new Date(d.last_updated);
      // إذا مر 30 دقيقة ولم نرسل تذكير بعد
      if (lastUpdate < thirtyMinutesAgo && !d.reminder_sent) {
        staleUsers.push({ id: doc.id, data: d });
      }
    }
  });
  return staleUsers;
}

// تحديث الجلسة بأننا أرسلنا التذكير عشان ما نرسل له كل دقيقة
async function markSessionReminded(whatsappId) {
  await db.collection(USER_SESSIONS).doc(whatsappId).update({ reminder_sent: true });
}

function generateActivityCode(categoryKey = 'OTH') {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${(categoryKey || 'OTH').toUpperCase().slice(0,3)}-${suffix}`;
}

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

async function countTotalBusinesses() {
  let totalCount = 0;
  const categoriesSnap = await db.collection(BUSINESSES).listDocuments();
  for (const c of categoriesSnap) {
    const itemsSnap = await db.collection(BUSINESSES).doc(c.id).collection('items').get();
    totalCount += itemsSnap.size;
  }
  return totalCount;
}

async function getBotStats() {
  const totalBusinesses = await countTotalBusinesses();
  const usersSnap = await db.collection(USER_SESSIONS).get();
  const totalActiveUsers = usersSnap.size;
  
  const lastContactSnap = await db.collection(USER_SESSIONS)
    .orderBy('last_updated', 'desc')
    .limit(1)
    .get();
  
  let lastContactInfo = null;
  if (!lastContactSnap.empty) {
    const doc = lastContactSnap.docs[0];
    // تأكد من وجود حقل last_updated
    const dateObj = doc.data().last_updated ? new Date(doc.data().last_updated) : new Date();
    lastContactInfo = {
      whatsappId: doc.id,
      timestamp: dateObj.toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' }),
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
  getBotStats,
  getStaleSessions, // دالة جديدة
  markSessionReminded // دالة جديدة
};