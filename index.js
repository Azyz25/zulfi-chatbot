/**
 * index.js - الكود النهائي والموحد (يشمل جميع الدوال المساعدة ومنطق الحالات)
 * 🟢 تم تطبيق التعديل على رسالة الخطأ وتوجيه المستخدمين للدعم (رقم 3).
 * 🟢 تم إضافة معالج الرد على رسائل الدعم ونظام التذكير.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); 
const qrcode = require('qrcode-terminal');
const constants = require('./constants');
const db = require('./db');
const express = require('express');
const app = express();

const MAX_IMAGES_COUNT = 4;
// صيغة التحقق من الوقت الجديدة: تقبل H:MM أو HH:MM
const TIME_REGEX = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
// صيغة التحقق من رقم الجوال: 10 أرقام تبدأ بـ 05
const PHONE_REGEX = /^05\d{8}$/; 

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// --- دوال مساعدة (Helpers) ---

function getCurrentRiyadhTime() {
    return new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
}

async function sendMessageTo(client, id, content) {
  try {
    return await client.sendMessage(id, content);
  } catch (error) {
    console.error('Failed to send message:', error);
    if (typeof content !== 'string') {
      const fallbackText = content.body ? content.body.replace(/\*/g, '').replace(/_/g, '') : 'حدث خطأ.';
      await client.sendMessage(id, fallbackText);
    }
  }
}

// دالة القائمة الرئيسية لإظهار الإحصائيات للمدير فقط
async function sendMainMenu(client, to) {
  let menu = constants.MENU_TEXT;
  const senderNumber = to.split('@')[0];
  if (senderNumber === constants.ADMIN_NUMBER) {
    menu += `\n4) الإحصائيات (للمسؤولين فقط)`;
  }
  await client.sendMessage(to, menu);
}

async function askYesNo(client, to, text) {
  await client.sendMessage(to, `${text} (يرجى الرد بـ "نعم" أو "لا")`);
}

function parseMultiInput(text) {
    if (!text) return [];
    // يسمح بـ (مسافة, شرطة, نقطة, فاصلة) كفواصل
    return text.replace(/[-\s.]/g, ',').split(',').map(s => s.trim()).filter(Boolean);
}

// --- دوال منطق التعديل ---

async function handleEditPrompt(client, from, fieldId, temp) {
    const showCurrent = (label, val) => `الحقل: ${label}\nالقيمة الحالية: ${val || 'فارغة'}\nأرسل القيمة الجديدة أو اكتب "تخطي"`;
    
    switch (fieldId) {
        case '1': await sendMessageTo(client, from, showCurrent('اسم النشاط', temp.current_data.business_name)); break;
        case '2': 
            const categories = Object.entries(constants.BUSINESS_CATEGORIES).map(([k,v])=>`${k}. ${v.ar}`).join('\n');
            await sendMessageTo(client, from, `${showCurrent('نوع النشاط', temp.current_data.category_name)}\nاختر النوع الجديد:\n${categories}`); 
            break;
        case '3': await sendMessageTo(client, from, showCurrent('موقع النشاط', temp.current_data.location_link) + '\nالرجاء إرسال **رابط** الموقع (Google Maps Link) كنص:'); break;
        case '4': await sendMessageTo(client, from, showCurrent('الوصف', temp.current_data.description)); break;
        case '5': 
            await sendMessageTo(client, from, showCurrent('الشعار (ارفع صورة)', temp.current_data.logo ? 'موجود' : 'غير موجود') + '\nالرجاء رفع صورة الشعار الجديدة:'); 
            break;
        case '6': 
            const imgCount = (temp.current_data.images||[]).length + (temp.edit_updates.images||[]).length;
            await sendMessageTo(client, from, `${showCurrent('الصور', imgCount + ' صور')}\nلإضافة صور جديدة، أرسل صورة واحدة الآن. للانتهاء/التخطي اكتب "تخطي"`); 
            break;
        case '7': 
            const menuCount = (temp.current_data.menu||[]).length + (temp.edit_updates.menu||[]).length;
            await sendMessageTo(client, from, `${showCurrent('المنيو', menuCount + ' ملفات')}\nلإضافة ملف منيو، أرسل صورة/ملف PDF الآن. للانتهاء/التخطي اكتب "تخطي"`); 
            break;
        case '8': 
            await sendMessageTo(client, from, `الحسابات الحالية: ${JSON.stringify(temp.current_data.social_accounts)}\nأرسل الأرقام الجديدة مفصولة بـ (فواصل أو مسافات) لاختيار المنصات:\n${Object.entries(constants.SOCIAL_PLATFORMS).map(([k,v])=>`${k}. ${v}`).join('\n')}`); 
            break;
        case '9': 
            await sendMessageTo(client, from, showCurrent('رقم التواصل', temp.current_data.contact_number) + '\nأرسل الرقم وطريقة التواصل الجديدة مفصولين بمسافة (مثال: 05xxxxxxx 1)\n1) اتصال فقط 2) واتساب فقط 3) كلاهما:'); 
            break;
        case '10': 
            await sendMessageTo(client, from, `الأيام والساعات الحالية: ${JSON.stringify(temp.current_data.working_days)} - ${JSON.stringify(temp.current_data.working_hours)}\nأرسل الأيام الجديدة (أرقام مفصولة، مع خيار 8 طيلة الأسبوع)، ثم بعد ذلك سيطلب منك إدخال الساعات:`); 
            break;
        default: 
            await sendMessageTo(client, from, 'حقل غير معروف، ننتقل للتالي.');
            await finalizeEditStep(client, from, temp.uploader_whatsapp, temp);
    }
}

async function handleEditInput(client, from, whatsappId, message, text, fieldId, temp) {
    if (text && text.toLowerCase() === 'تخطي' && fieldId !== '6' && fieldId !== '7') {
        await finalizeEditStep(client, from, whatsappId, temp);
        return;
    }

    temp.edit_updates = temp.edit_updates || {};

    switch (fieldId) {
        case '1': temp.edit_updates.business_name = text; break;
        case '2': 
            if (constants.BUSINESS_CATEGORIES[text]) {
                temp.edit_updates.category_key = constants.BUSINESS_CATEGORIES[text].key;
                temp.edit_updates.category_name = constants.BUSINESS_CATEGORIES[text].ar;
            } else { await sendMessageTo(client, from, 'خطأ في الفئة. تخطي..'); }
            break;
        case '3': 
            if (!text.toLowerCase().includes('http')) { await sendMessageTo(client, from, 'رابط غير صالح. تخطي..'); }
            else { temp.edit_updates.location_link = text; }
            break;
        case '4': temp.edit_updates.description = text; break;
        case '5': 
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                const url = await db.uploadMediaBase64('logo_edit.png', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
                temp.edit_updates.logo = url;
            } else { await sendMessageTo(client, from, 'لم يتم رفع صورة. تخطي..'); }
            break;
        case '6': 
            if (text && text.toLowerCase() === 'تخطي') { await finalizeEditStep(client, from, whatsappId, temp); return; }
            if (message.hasMedia) {
                temp.edit_updates.images = temp.edit_updates.images || [];
                if (temp.edit_updates.images.length + (temp.current_data.images||[]).length >= MAX_IMAGES_COUNT) {
                    await sendMessageTo(client, from, 'وصلت الحد الأقصى للصور. تخطي...');
                    break;
                }
                const mImg = await message.downloadMedia();
                const uImg = await db.uploadMediaBase64('img_edit.png', `data:${mImg.mimetype};base64,${mImg.data}`, mImg.mimetype);
                temp.edit_updates.images.push(uImg);
                await db.updateUserState(whatsappId, '101_edit_step', temp);
                await sendMessageTo(client, from, `تم إضافة صورة (${temp.edit_updates.images.length + (temp.current_data.images||[]).length}/${MAX_IMAGES_COUNT}). أرسل الصورة التالية أو "تخطي"`);
                return;
            }
            // إذا لم يرسل تخطي ولم يرسل ميديا، نبقى في نفس الخطوة
            await sendMessageTo(client, from, 'الرجاء إرسال صورة أو "تخطي".');
            return; 
        case '7': 
            if (text && text.toLowerCase() === 'تخطي') { await finalizeEditStep(client, from, whatsappId, temp); return; }
            if (message.hasMedia) {
                const mMenu = await message.downloadMedia();
                const uMenu = await db.uploadMediaBase64('menu_edit', `data:${mMenu.mimetype};base64,${mMenu.data}`, mMenu.mimetype);
                temp.edit_updates.menu = [uMenu]; // نفترض استبدال المنيو
            } else { await sendMessageTo(client, from, 'الرجاء إرسال ملف أو "تخطي".'); return; }
            break;
        case '8': 
             const parts = parseMultiInput(text);
             const chosen = [];
             for (const p of parts) if (constants.SOCIAL_PLATFORMS[p]) chosen.push(constants.SOCIAL_PLATFORMS[p]);
             
             if (!chosen.length) { await sendMessageTo(client, from, 'اختيارات غير صالحة. تخطي..'); break; }
             temp.pending_social_edit = chosen;
             temp.edit_updates.social_accounts = {};
             await db.updateUserState(whatsappId, '101_edit_step_social_users', temp);
             await sendMessageTo(client, from, `أرسل يوزر ${chosen[0]} الآن:`);
             return;
        case '9': 
             const contactParts = text.split(/\s+/);
             if (!PHONE_REGEX.test(contactParts[0])) { await sendMessageTo(client, from, 'رقم غير صحيح. تخطي..'); break; }
             temp.edit_updates.contact_number = contactParts[0];
             let pref = contactParts[1];
             if (pref==='1') pref='call'; else if (pref==='2') pref='whatsapp'; else if (pref==='3') pref='both'; 
             else { await sendMessageTo(client, from, 'تفضيل التواصل غير صحيح. تم حفظ الرقم فقط.'); break; }
             temp.edit_updates.contact_pref = pref;
             break;
        case '10': 
             const dayP = parseMultiInput(text);
             const mapD = {'1':'السبت','2':'الأحد','3':'الإثنين','4':'الثلاثاء','5':'الأربعاء','6':'الخميس','7':'الجمعة', '8': 'طيلة أيام الأسبوع'};
             const finalDays = [];
             for(const p of dayP) if(mapD[p]) finalDays.push(mapD[p]);
             
             if (!finalDays.length) { await sendMessageTo(client, from, 'اختيارات أيام غير صحيحة. تخطي..'); break; }
             temp.edit_updates.working_days = finalDays;
             await db.updateUserState(whatsappId, '101_edit_step_hours_q', temp);
             await sendMessageTo(client, from, 'تم اختيار الأيام. نظام العمل: 1) فترة واحدة  2) فترتين  3) 24 ساعة؟');
             return;
    }
    // إذا لم يكن هناك عودة (return) يعني انتهت خطوة الحقل، ننتقل للخطوة التالية
    await finalizeEditStep(client, from, whatsappId, temp);
}

async function finalizeEditStep(client, from, whatsappId, temp) {
  temp.edit_index = (temp.edit_index || 0) + 1;
  const idxArr = temp.edit_fields || [];
  
  if (temp.edit_index >= idxArr.length) {
    let summary = 'ملخص التعديلات المقترحة:\n';
    const fieldsMap = {
        'business_name': 'اسم النشاط', 'category_name': 'نوع النشاط', 'location_link': 'الموقع', 
        'description': 'الوصف', 'logo': 'الشعار', 'images': 'الصور المضافة', 'menu': 'المنيو المضاف/المستبدل',
        'contact_number': 'رقم التواصل', 'working_days': 'أيام العمل', 'working_hours': 'ساعات العمل', 
        'contact_pref': 'تفضيل التواصل', 'social_accounts': 'الحسابات الاجتماعية'
    };
    
    // إزالة الحقول التي لم تتغير (لا توجد في edit_updates)
    for (const [key, value] of Object.entries(temp.edit_updates)) {
        if (key === 'category_key') continue; 
        const label = fieldsMap[key] || key;
        
        let displayValue;
        if (['logo', 'images', 'menu'].includes(key)) {
            displayValue = (Array.isArray(value) ? value.length : 1) + ' تم إضافة/تعديل عنصر';
        } else if (typeof value === 'object' && value !== null) {
            displayValue = JSON.stringify(value).replace(/[\"\\[\]\{\}]/g, '').replace(/,/g, ', ').trim();
        } else {
            displayValue = value;
        }

        summary += `- ${label}: ${displayValue}\n`;
    }

    if (summary === 'ملخص التعديلات المقترحة:\n') {
        await sendMessageTo(client, from, 'لم يتم إدخال أي تعديلات. تم إلغاء عملية التعديل. اكتب 0 للعودة للقائمة الرئيسية.');
        await db.resetUserState(whatsappId);
        return;
    }

    await db.updateUserState(whatsappId, '102_edit_confirm', temp);
    summary += '\nهل تعتمد الحفظ؟ (نعم/لا)';
    await sendMessageTo(client, from, summary);

  } else {
    await db.updateUserState(whatsappId, '101_edit_step', temp);
    await handleEditPrompt(client, from, temp.edit_fields[temp.edit_index], temp);
  }
}

// --- أحداث WhatsApp (Events) ---

client.on('qr', qr => {
  console.log('Scan this QR to link session:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp client ready');
  
  // تشغيل نظام التذكير (يعمل كل دقيقة)
  setInterval(async () => {
    try {
      const staleSessions = await db.getStaleSessions();
      for (const session of staleSessions) {
        const userPhone = session.id + '@c.us';
        await sendMessageTo(client, userPhone, 'مرحباً، لاحظنا أنك بدأت في تسجيل نشاطك وتوقفت. هل تود استكمال البيانات لرفع النشاط؟\nاستكمل الخطوات الآن أو اكتب 0 للإلغاء.');
        await db.markSessionReminded(session.id);
        console.log(`[Reminder] Sent to ${session.id}`);
      }
    } catch (e) {
      console.error('Error in reminder job:', e);
    }
  }, 60 * 1000); 
});

client.on('message', async message => {
  let from, whatsappId, state, temp;
  
  try {
    if (message.isGroupMsg) return;
    
    from = message.from;
    whatsappId = from.split('@')[0]; 
    let text = (message.body || '').trim();
    
    // منطق معالجة ردود المدير (Admin Reply Handler)
    const adminFullId = `${constants.ADMIN_NUMBER}@c.us`; 
    if (from === adminFullId) {
        if (message.hasQuotedMsg) {
            const quotedMsg = await message.getQuotedMessage();
            const quotedText = quotedMsg.body || '';
            const supportRegex = /من: (\d+)/;
            const match = quotedText.match(supportRegex);
            if (match && match[1]) {
                const userIdToReply = `${match[1]}@c.us`;
                await sendMessageTo(client, userIdToReply, `*رد الإدارة على طلب الدعم:*\n---\n${message.body.trim()}`);
                await sendMessageTo(client, from, `✅ تم إرسال الرد إلى الرقم: ${match[1]}`);
                return; 
            }
        }
    }

    const session = await db.getUserState(whatsappId);
    state = (session.state || '0').trim(); 
    temp = session.data || {};
    
    console.log(`[INCOMING] ID: ${whatsappId}, State: ${state}, Text: "${text}"`);
    const setState = async (s, data = {}) => { await db.updateUserState(whatsappId, s, data); };

    if (text === '0' || text === 'الرئيسية' || text === 'الغاء' || text.toLowerCase() === 'اختر الخدمة') {
      await db.resetUserState(whatsappId);
      await sendMainMenu(client, from);
      return;
    }

    switch (state) {
      case '0': {
        if (text === '1' || text === 'تسجيل نشاط جديد') {
          await setState('10', {});
          await sendMessageTo(client, from, 'أولاً، وش اسم نشاطك التجاري؟');
          return;
        } else if (text === '2' || text === 'تعديل نشاط (الكود)') {
          await setState('99', {});
          await sendMessageTo(client, from, 'لتعديل النشاط، ارسل كود النشاط الآن:');
          return;
        } else if (text === '3' || text === 'دعم') {
          await setState('30', {});
          await sendMessageTo(client, from, 'أرسل رسالتك للدعم الآن:');
          return;
        } else if (text === '4' && whatsappId === constants.ADMIN_NUMBER) { 
           await sendMessageTo(client, from, 'يتم استخراج الإحصائيات، لحظة من فضلك...');
           const stats = await db.getBotStats();
           let lastContactMsg = 'لم يتم تحديد آخر اتصال.';
           if (stats.lastContact) lastContactMsg = `آخر شخص تواصل: ${stats.lastContact.whatsappId}\nالتاريخ: ${stats.lastContact.timestamp}`;
           const statsMessage = `📊 *إحصائيات البوت الحالية*:\n--------------------------\n*عدد النشاطات المسجلة*: ${stats.totalBusinesses}\n*عدد الأرقام (الجلسات النشطة)*: ${stats.totalActiveUsers}\n--------------------------\n${lastContactMsg}\n\nاكتب 0 للعودة.`;
           await sendMessageTo(client, from, statsMessage);
           return;
        } else {
          // 💡 رسالة الخطأ المحدثة (التي طلبت تعديلها)
          await sendMessageTo(client, from, 'عذراً، الخيار غير صحيح.\n\n💡 *تلميح:* إذا كان لديك اقتراح أو مشكلة أو معلومة، الرجاء اختيار الرقم *3* للتواصل مع الدعم الفني.\n\nأو يمكنك إعادة المحاولة واختيار رقم خدمة من القائمة أدناه:');
          await sendMainMenu(client, from);
          return;
        }
      }

      // --- تدفق التسجيل (REGISTRATION FLOW) ---
      case '10': // Name
        if (!text || text.length < 2) { await sendMessageTo(client, from, 'الاسم قصير.'); return; }
        temp.business_name = text;
        temp.custom_type = null; 
        await setState('11', temp);
        const categories = Object.entries(constants.BUSINESS_CATEGORIES).map(([k,v])=>`${k}. ${v.ar}`).join('\n');
        await sendMessageTo(client, from, `طيب، وش نوع النشاط؟ (ارسل الرقم)\n${categories}`);
        return;

      case '11': // Category
        let selection = text.trim(); 
        if (!constants.BUSINESS_CATEGORIES[selection]) { await sendMessageTo(client, from, 'اختيار غير صحيح.'); return; }
        const sel = constants.BUSINESS_CATEGORIES[selection];
        temp.category_key = sel.key;
        temp.category_name = sel.ar;
        if (sel.key === 'other_businesses') {
          await setState('12', temp);
          await sendMessageTo(client, from, 'اكتب نوع النشاط بالتفصيل:');
          return;
        } else {
          await setState('13', temp);
          await askYesNo(client, from, 'هل النشاط له موقع ثابت؟');
          return;
        }

      case '12': // Custom Type
        temp.custom_type = text || 'أخرى';
        await setState('13', temp);
        await askYesNo(client, from, 'هل النشاط له موقع ثابت؟');
        return;

      case '13': // Has Location
        const t = text.toLowerCase().trim();
        if (t === 'نعم' || t === 'y') {
          temp.has_location = true;
          await setState('14_loc', temp);
          await sendMessageTo(client, from, 'أرسل رابط الخرائط للمكان:');
          return;
        } else if (t === 'لا' || t === 'n') {
          temp.has_location = false;
          temp.location_link = null; 
          await setState('15_desc', temp);
          await sendMessageTo(client, from, 'أرسل وصف مختصر للنشاط أو اكتب "تخطي"');
          return;
        } else { await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا".'); return; }

      case '14_loc': // Link
        if (message.hasMedia || text.startsWith('/9j/')) { await sendMessageTo(client, from, 'الرجاء إرسال رابط نصي.'); return; }
        if (!text.toLowerCase().includes('http')) { await sendMessageTo(client, from, 'رابط غير صالح.'); return; }
        temp.location_link = text;
        await setState('15_desc', temp);
        await sendMessageTo(client, from, 'أرسل وصف مختصر للنشاط أو اكتب "تخطي"');
        return;

      case '15_desc': // Desc
        temp.description = (text !== 'تخطي') ? text : null;
        await setState('16_logo', temp);
        await askYesNo(client, from, 'هل عندك شعار (logo) للنشاط؟');
        return;

      case '16_logo': 
        if (text === 'نعم') { await setState('16_logo_upload', temp); await sendMessageTo(client, from, 'ارفع صورة الشعار:'); return; }
        else { temp.logo = null; await setState('17_images', temp); await askYesNo(client, from, 'هل عندك صور للنشاط؟'); return; }

      case '16_logo_upload':
        if (!message.hasMedia) {
           if (text === 'تخطي') { temp.logo = null; await setState('17_images', temp); await askYesNo(client, from, 'هل عندك صور؟'); return; }
           await sendMessageTo(client, from, 'ارفع صورة الشعار.'); return;
        }
        const mLogo = await message.downloadMedia();
        const urlLogo = await db.uploadMediaBase64('logo.png', `data:${mLogo.mimetype};base64,${mLogo.data}`, mLogo.mimetype);
        temp.logo = urlLogo;
        await setState('17_images', temp);
        await askYesNo(client, from, 'تم الرفع. هل عندك صور للنشاط؟');
        return;

      case '17_images':
        if (text === 'نعم') {
          await setState('17_images_upload', { ...temp, files: [] });
          await sendMessageTo(client, from, `ارفع الصور وحدة وحدة (max ${MAX_IMAGES_COUNT}). اذا خلصت اكتب "انتهيت"`);
          return;
        } else {
          temp.files = []; await setState('18_menu', temp); await askYesNo(client, from, 'هل عندك منيو؟'); return;
        }

      case '17_images_upload':
        temp.files = temp.files || [];
        if (text === 'انتهيت') {
           if (temp.files.length === 0) { await sendMessageTo(client, from, 'ارفع صورة وحدة على الاقل او اكتب 0 للالغاء'); return; }
           await setState('18_menu', temp); await askYesNo(client, from, 'انتهيت. هل عندك منيو؟'); return;
        }
        if (message.hasMedia) {
           if (temp.files.length >= MAX_IMAGES_COUNT) { await sendMessageTo(client, from, 'وصلت الحد الأقصى. اكتب "انتهيت".'); return; }
           const mImg = await message.downloadMedia();
           const uImg = await db.uploadMediaBase64('img.png', `data:${mImg.mimetype};base64,${mImg.data}`, mImg.mimetype);
           temp.files.push(uImg);
           await setState('17_images_upload', temp);
           await sendMessageTo(client, from, `تم (${temp.files.length}/${MAX_IMAGES_COUNT}). ارفع التالية او اكتب "انتهيت"`);
           return;
        }
        await sendMessageTo(client, from, 'ارفع صورة او اكتب "انتهيت"');
        return;

      case '18_menu':
        if (text === 'نعم') { await setState('18_menu_upload', temp); await sendMessageTo(client, from, 'ارفع المنيو (صورة/PDF) او "تخطي"'); return; }
        else { temp.menu = []; await setState('19_social_q', temp); await askYesNo(client, from, 'هل عندك حسابات تواصل؟'); return; }

      case '18_menu_upload':
         if (text === 'تخطي') { temp.menu = []; await setState('19_social_q', temp); await askYesNo(client, from, 'هل عندك حسابات تواصل؟'); return; }
         if (message.hasMedia) {
            const mMenu = await message.downloadMedia();
            const uMenu = await db.uploadMediaBase64('menu', `data:${mMenu.mimetype};base64,${mMenu.data}`, mMenu.mimetype);
            temp.menu = [uMenu];
            await setState('19_social_q', temp); await askYesNo(client, from, 'تم. هل عندك حسابات تواصل؟'); return;
         }
         await sendMessageTo(client, from, 'ارفع ملف.'); return;

      case '19_social_q':
         if (text === 'نعم') {
            const list = Object.entries(constants.SOCIAL_PLATFORMS).map(([k,v])=>`${k}. ${v}`).join('\n');
            temp.social_accounts = {}; temp.pending_social = [];
            await setState('19_social_select', temp);
            await sendMessageTo(client, from, `اختر المنصات (ارقام مفصولة):\n${list}\nاو 'تخطي'`);
            return;
         } else { temp.social_accounts = {}; await setState('20_contact', temp); await sendMessageTo(client, from, 'ارسل رقم التواصل (مثال: 059xxxxxxx)'); return; }

      case '19_social_select':
         if (text === 'تخطي') { temp.social_accounts = {}; await setState('20_contact', temp); await sendMessageTo(client, from, 'ارسل رقم التواصل'); return; }
         const parts = parseMultiInput(text);
         const chosen = [];
         for(const p of parts) if(constants.SOCIAL_PLATFORMS[p]) chosen.push(constants.SOCIAL_PLATFORMS[p]);
         if (!chosen.length) { await sendMessageTo(client, from, 'اختيار غير صالح.'); return; }
         temp.pending_social = chosen;
         await setState('19_social_user', temp);
         await sendMessageTo(client, from, `اكتب يوزر ${chosen[0]}`);
         return;

      case '19_social_user':
         const plat = temp.pending_social.shift();
         temp.social_accounts[plat] = text;
         if (temp.pending_social.length) { await setState('19_social_user', temp); await sendMessageTo(client, from, `اكتب يوزر ${temp.pending_social[0]}`); return; }
         await setState('20_contact', temp); await sendMessageTo(client, from, 'تم. ارسل رقم التواصل (05xxxxxxx)'); return;

      case '20_contact':
         if (!PHONE_REGEX.test(text)) { await sendMessageTo(client, from, 'رقم غير صحيح (يجب 10 ارقام يبدأ ب 05).'); return; }
         temp.contact_number = text;
         await setState('20_contact_pref', temp);
         await sendMessageTo(client, from, 'طريقة التواصل؟\n1) اتصال فقط\n2) واتساب فقط\n3) كلاهما');
         return;

      case '20_contact_pref':
         let pref = text;
         if (pref==='1') pref='call'; else if (pref==='2') pref='whatsapp'; else if (pref==='3') pref='both'; else { await sendMessageTo(client, from, '1 او 2 او 3'); return; }
         temp.contact_pref = pref;
         await setState('21_workdays', temp);
         await sendMessageTo(client, from, 'اختار أيام العمل (ارقام مفصولة):\n1 السبت\n2 الاحد\n3 الاثنين\n4 الثلاثاء\n5 الأربعاء\n6 الخميس\n7 الجمعة\n8 طيلة أيام الأسبوع');
         return;

      case '21_workdays':
         const dayP = parseMultiInput(text);
         const mapD = {'1':'السبت','2':'الأحد','3':'الإثنين','4':'الثلاثاء','5':'الأربعاء','6':'الخميس','7':'الجمعة', '8': 'طيلة أيام الأسبوع'};
         const finalDays = [];
         for(const p of dayP) if(mapD[p]) finalDays.push(mapD[p]);
         
         if (!finalDays.length) { await sendMessageTo(client, from, 'اختيار غير صحيح.'); return; }
         temp.working_days = finalDays;
         await setState('22_shift_count', temp);
         await sendMessageTo(client, from, 'نظام العمل:\n1) فترة واحدة\n2) فترتين\n3) 24 ساعة');
         return;

      case '22_shift_count':
         if (text === '3' || text === '24 ساعة') {
            temp.working_hours = [{ shift: 1, times: '24 ساعة' }];
            await setState('90_confirm', temp);
            await askYesNo(client, from, 'تمام. هل تبغى تأكيد الحفظ؟');
            return;
         }
         if (text === '1') {
            await setState('23_single_shift', temp);
            await sendMessageTo(client, from, 'ادخل وقت الفترة (مثال: 9:00-17:00)\n⚠️ تنبيه: الساعات بنظام 24 ساعة (00:00 تعني 12 ليلاً).');
            return;
         } else if (text === '2') {
            await setState('23_double_shift_1', temp);
            await sendMessageTo(client, from, 'ادخل الفترة الأولى (مثال: 9:00-13:00)\n⚠️ نظام 24 ساعة.');
            return;
         } else { await sendMessageTo(client, from, '1 او 2 او 3'); return; }

      case '23_single_shift':
         const m1 = text.match(TIME_REGEX);
         if (!m1) { await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة. مثال: 9:00-17:00'); return; }
         if (parseInt(m1[1]) > 23 || parseInt(m1[3]) > 23) { await sendMessageTo(client, from, 'الساعة يجب أن تكون بين 0 و 23.'); return; }
         
         temp.working_hours = [{ shift:1, times: text }];
         await setState('90_confirm', temp);
         await askYesNo(client, from, 'حلو. هل تبغى تأكيد الحفظ؟');
         return;

      case '23_double_shift_1':
         const m2 = text.match(TIME_REGEX);
         if (!m2) { await sendMessageTo(client, from, 'صيغة الوقت خطأ. مثال: 9:00-12:00'); return; }
         if (parseInt(m2[1]) > 23 || parseInt(m2[3]) > 23) { await sendMessageTo(client, from, 'الساعة يجب أن تكون بين 0 و 23.'); return; }
         
         temp.shift1 = text;
         await setState('23_double_shift_2', temp);
         await sendMessageTo(client, from, 'ادخل الفترة الثانية (مثال: 16:00-23:00)');
         return;

      case '23_double_shift_2':
         const m3 = text.match(TIME_REGEX);
         if (!m3) { await sendMessageTo(client, from, 'صيغة الوقت خطأ.'); return; }
         if (parseInt(m3[1]) > 23 || parseInt(m3[3]) > 23) { await sendMessageTo(client, from, 'الساعة يجب أن تكون بين 0 و 23.'); return; }
         
         temp.working_hours = [{ shift:1, times: temp.shift1 }, { shift:2, times: text }];
         delete temp.shift1;
         await setState('90_confirm', temp);
         await askYesNo(client, from, 'تمام. هل تبغى تأكيد الحفظ؟');
         return;

      case '90_confirm':
        if (text === 'نعم') {
          const activity = {
            business_name: temp.business_name,
            category_key: temp.category_key,
            category_name: temp.category_name,
            custom_type: temp.custom_type || null,
            location_link: temp.location_link || null,
            description: temp.description || null,
            logo: temp.logo || null,
            images: temp.files || [],
            menu: temp.menu || [],
            social_accounts: temp.social_accounts || {},
            contact_number: temp.contact_number || null,
            contact_pref: temp.contact_pref || null,
            working_days: temp.working_days || [],
            working_hours: temp.working_hours || [],
            uploader_whatsapp: whatsappId,
            status: 'pending'
          };
          const code = await db.saveNewActivity(activity);
          
          const now = getCurrentRiyadhTime();
          const adminMsg = `🚨 نشاط جديد:\nالتوقيت: ${now}\nكود: ${code}\nالاسم: ${activity.business_name}\nنوع: ${activity.category_name}\nرقم: ${activity.contact_number}\nرفع: ${whatsappId}`;
          await sendMessageTo(client, `${constants.ADMIN_NUMBER}@c.us`, adminMsg);
          
          await sendMessageTo(client, from, `تم التسجيل بنجاح! كود النشاط: ${code}\nانشر الرسالة التالية لتعم الفائدة 👇`);
          await sendMessageTo(client, from, constants.MARKETING_MESSAGE); // رسالة التسويق

          await db.resetUserState(whatsappId);
          return;
        } else {
            await sendMessageTo(client, from, 'تم الإلغاء. اكتب 0 للعودة.');
            await db.resetUserState(whatsappId);
            return;
        }

      case '30': // Support
         const now = getCurrentRiyadhTime();
         const adminSupportMsg = `📩 رسالة دعم جديدة:\nالتوقيت: ${now}\nمن: ${whatsappId}\nالرسالة: ${text}`;
         await sendMessageTo(client, `${constants.ADMIN_NUMBER}@c.us`, adminSupportMsg);
         await sendMessageTo(client, from, 'شكراً لك. تم الإرسال.');
         await db.resetUserState(whatsappId);
         return;
         
       // --- تدفق التعديل (EDIT FLOW) ---
       case '99': // Request Code
        const code = text.trim();
        const found = await db.findActivityByCode(code);
        if (!found) { await sendMessageTo(client, from, 'كود خطأ. 0 للخروج'); return; }
        temp.edit_target = { code, ref: found.ref.path };
        temp.current_data = found.data;
        temp.edit_fields = []; // قائمة الحقول المراد تعديلها
        temp.edit_updates = {}; // التعديلات
        await setState('100_edit_menu', temp);
        await sendMessageTo(client, from, `لقينا النشاط: ${found.data.business_name}\nاختر الحقول للتعديل (ارقام مفصولة):\n1. اسم\n2. نوع\n3. موقع\n4. وصف\n5. شعار\n6. صور\n7. منيو\n8. سوشال\n9. رقم\n10. ايام/ساعات`);
        return;

       case '100_edit_menu': // Select Fields
        const pEdit = parseMultiInput(text);
        if (!pEdit.length) { await sendMessageTo(client, from, 'الرجاء إرسال أرقام الحقول التي تود تعديلها مفصولة بمسافة أو فاصلة.'); return; }
        temp.edit_fields = pEdit.map(p=>p.toString());
        temp.edit_updates = {}; 
        temp.edit_index = -1; // نبدأ من -1 ليتم زيادة العداد إلى 0 في الخطوة التالية
        await setState('101_edit_step', temp);
        await finalizeEditStep(client, from, whatsappId, temp); // تبدأ عملية التعديل
        return;
       
       case '101_edit_step': // Handle Input for Current Field
          const idxArr = temp.edit_fields;
          const idx = temp.edit_index || 0;
          const currentField = idxArr[idx];
          await handleEditInput(client, from, whatsappId, message, text, currentField, temp);
          return;
        
       case '101_edit_step_social_users': // Social Accounts step by step
          const plat_social = temp.pending_social_edit.shift();
          temp.edit_updates.social_accounts[plat_social] = text;

          if (temp.pending_social_edit.length) { 
            await db.updateUserState(whatsappId, '101_edit_step_social_users', temp);
            await sendMessageTo(client, from, `أرسل يوزر ${temp.pending_social_edit[0]} الآن:`); 
            return; 
          }
          await finalizeEditStep(client, from, whatsappId, temp); // انتهينا من الحسابات ننتقل للحقل التالي
          return;

       case '101_edit_step_hours_q': // Hours: Shift Count (1, 2, 3)
           if (text === '3' || text === '24 ساعة') {
                temp.edit_updates.working_hours = [{ shift: 1, times: '24 ساعة' }];
                await finalizeEditStep(client, from, whatsappId, temp);
                return;
            }
            if (text === '1') {
                await db.updateUserState(whatsappId, '101_edit_step_hours_single', temp);
                await sendMessageTo(client, from, 'ادخل وقت الفترة (مثال: 9:00-17:00)\n⚠️ نظام 24 ساعة.');
                return;
            } else if (text === '2') {
                await db.updateUserState(whatsappId, '101_edit_step_hours_double_1', temp);
                await sendMessageTo(client, from, 'ادخل الفترة الأولى (مثال: 9:00-13:00)\n⚠️ نظام 24 ساعة.');
                return;
            } else { await sendMessageTo(client, from, '1 او 2 او 3'); return; }

        case '101_edit_step_hours_single':
            const m_single = text.match(TIME_REGEX);
            if (!m_single) { await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة. مثال: 9:00-17:00'); return; }
            temp.edit_updates.working_hours = [{ shift:1, times: text }];
            await finalizeEditStep(client, from, whatsappId, temp);
            return;

        case '101_edit_step_hours_double_1':
            const m_d1 = text.match(TIME_REGEX);
            if (!m_d1) { await sendMessageTo(client, from, 'صيغة الوقت خطأ. مثال: 9:00-12:00'); return; }
            temp.shift1 = text;
            await db.updateUserState(whatsappId, '101_edit_step_hours_double_2', temp);
            await sendMessageTo(client, from, 'ادخل الفترة الثانية (مثال: 16:00-23:00)');
            return;

        case '101_edit_step_hours_double_2':
            const m_d2 = text.match(TIME_REGEX);
            if (!m_d2) { await sendMessageTo(client, from, 'صيغة الوقت خطأ.'); return; }
            temp.edit_updates.working_hours = [{ shift:1, times: temp.shift1 }, { shift:2, times: text }];
            delete temp.shift1;
            await finalizeEditStep(client, from, whatsappId, temp);
            return;

       case '102_edit_confirm': // Final Confirmation
        const target = temp.edit_target;
        if (text === 'نعم') {
          if (!target || !target.code) {
             await sendMessageTo(client, from, 'حدث خطأ غير متوقع. اكتب 0 للعودة.');
             await db.resetUserState(whatsappId);
             return;
          }
          
          const found = await db.findActivityByCode(target.code);
          if (!found) {
            await sendMessageTo(client, from, 'للأسف الكود ما لقيته الآن.');
            await db.resetUserState(whatsappId);
            return;
          }
          
          const updates = temp.edit_updates || {};
          
          // دمج الصور الجديدة مع القديمة
          if (updates.images && Array.isArray(updates.images)) {
            const existing = found.data.images || [];
            updates.images = existing.concat(updates.images);
          }
          
          // يتم تحديث البيانات في قاعدة البيانات
          await found.ref.update(updates);
          
          const now = getCurrentRiyadhTime();
          await sendMessageTo(client, `${constants.ADMIN_NUMBER}@c.us`, `✅ تم تعديل نشاط ${target.code} بواسطة ${whatsappId}\nالتوقيت: ${now}`);
          await sendMessageTo(client, from, 'تم حفظ التعديلات بنجاح. اكتب 0 للعودة.');
          await db.resetUserState(whatsappId);
          return;
          
        } else if (text === 'لا') {
          await sendMessageTo(client, from, 'تم إلغاء الحفظ. اكتب 0 للعودة.');
          await db.resetUserState(whatsappId);
          return;
        } else {
             await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا".');
             return;
        }

      default:
        await sendMessageTo(client, from, 'ما فهمت. 0 للعودة.');
    }
  } catch (err) {
    console.error('ERROR:', err); 
    if (from) await sendMessageTo(client, from, 'خطأ غير متوقع. 0 للعودة.');
    await sendMainMenu(client, from); 
  }
});

// تشغيل خادم Express للبقاء "Awake"
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => { res.send('Bot is running.'); });
app.listen(PORT, () => { console.log(`Server listening on port ${PORT}`); });

client.initialize();