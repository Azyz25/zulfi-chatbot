/**
 * index.js - الكود النهائي والمستقر (مع جميع الإصلاحات)
 * 🟢 تم إضافة معالج الرد على رسائل الدعم.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); 
const qrcode = require('qrcode-terminal');
const constants = require('./constants');
const db = require('./db');

const MAX_IMAGES_COUNT = 4;
// 💡 صيغة التحقق من الوقت: HH:MM-HH:MM
const TIME_REGEX = /^\d{2}:\d{2}-\d{2}:\d{2}$/; 
// 💡 صيغة التحقق من رقم الجوال: 10 أرقام تبدأ بـ 05
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
      const fallbackText = content.body ? content.body.replace(/\*/g, '').replace(/_/g, '') : 'حدث خطأ، الرجاء المحاولة مجدداً.';
      await client.sendMessage(id, fallbackText);
    }
  }
}

async function sendMainMenu(client, to) {
  await client.sendMessage(to, constants.MENU_TEXT);
}

async function askYesNo(client, to, text) {
  await client.sendMessage(to, `${text} (يرجى الرد بـ "نعم" أو "لا")`);
}

function parseMultiInput(text) {
    if (!text) return [];
    // استبدال الشرطات والفراغات والنقاط بفواصل، ثم تقسيم حسب الفاصلة
    return text.replace(/[-\s.]/g, ',').split(',').map(s => s.trim()).filter(Boolean);
}

// --- دوال مساعدة لمنطق التعديل ---

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
        case '5': await sendMessageTo(client, from, showCurrent('الشعار (ارفع صورة)', temp.current_data.logo ? 'موجود' : 'غير موجود') + '\nالرجاء رفع صورة الشعار الجديدة:'); break;
        case '6': await sendMessageTo(client, from, `${showCurrent('الصور', (temp.current_data.images||[]).length + ' صور')}\nلإضافة صور جديدة، أرسل صورة واحدة الآن. للانتهاء/التخطي اكتب "تخطي"`); break;
        case '7': await sendMessageTo(client, from, `${showCurrent('المنيو', (temp.current_data.menu||[]).length + ' ملفات')}\nلإضافة ملف منيو، أرسل صورة/ملف PDF الآن. للانتهاء/التخطي اكتب "تخطي"`); break;
        case '8': await sendMessageTo(client, from, `الحسابات الحالية: ${JSON.stringify(temp.current_data.social_accounts)}\nأرسل الأرقام الجديدة مفصولة بـ (فواصل أو مسافات) لاختيار المنصات:\n${Object.entries(constants.SOCIAL_PLATFORMS).map(([k,v])=>`${k}. ${v}`).join('\n')}`); break;
        case '9': await sendMessageTo(client, from, showCurrent('رقم التواصل', temp.current_data.contact_number) + '\nأرسل الرقم وطريقة التواصل الجديدة مفصولين بمسافة (مثال: 05xxxxxxx 1)\n1) اتصال فقط 2) واتساب فقط 3) كلاهما:'); break;
        case '10': await sendMessageTo(client, from, `الأيام والساعات الحالية: ${JSON.stringify(temp.current_data.working_days)} - ${JSON.stringify(temp.current_data.working_hours)}\nأرسل الأيام الجديدة (أرقام مفصولة)، ثم بعد ذلك سيطلب منك إدخال الساعات:`); break;
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

    switch (fieldId) {
        case '1': temp.edit_updates.business_name = text; break;
        case '2': 
            if (constants.BUSINESS_CATEGORIES[text]) {
                temp.edit_updates.category_key = constants.BUSINESS_CATEGORIES[text].key;
                temp.edit_updates.category_name = constants.BUSINESS_CATEGORIES[text].ar;
            } else {
                await sendMessageTo(client, from, 'اختيار الفئة غير صحيح. أعد إدخال الرقم الصحيح أو اكتب "تخطي"');
                return;
            }
            break;
        case '3': 
            if (message.hasMedia || text.startsWith('/9j/4AAQSkZJRg')) {
                await sendMessageTo(client, from, 'الرجاء إرسال **رابط الموقع** (Google Maps Link) كنص، وليس صورة أو مشاركة موقع.');
                return;
            }
            if (!text.toLowerCase().includes('http')) {
                 await sendMessageTo(client, from, 'الرجاء إرسال رابط خرائط صالح (يحتوي على http/https).');
                 return;
            }
            temp.edit_updates.location_link = text; 
            break;
        case '4': temp.edit_updates.description = text; break;
        case '5': 
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                const url = await db.uploadMediaBase64('logo_edit.png', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
                temp.edit_updates.logo = url;
            } else {
                await sendMessageTo(client, from, 'ارفع صورة الشعار او اكتب تخطي');
                return; 
            }
            break;
        case '6': 
            if (text && text.toLowerCase() === 'تخطي') {
                await finalizeEditStep(client, from, whatsappId, temp);
                return;
            } else if (message.hasMedia) {
                if ((temp.edit_updates.images || []).length + (temp.current_data.images || []).length >= MAX_IMAGES_COUNT) {
                     await sendMessageTo(client, from, `وصلت للحد الأقصى للصور (${MAX_IMAGES_COUNT}). اكتب "تخطي" للمتابعة.`);
                     return;
                }
                const media = await message.downloadMedia();
                const url = await db.uploadMediaBase64('img_edit.png', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
                temp.edit_updates.images = (temp.edit_updates.images || []).concat([url]);
                await sendMessageTo(client, from, 'تمت الاضافة. ارسل صورة اخرى او اكتب "تخطي"');
                return; 
            } else {
                await sendMessageTo(client, from, 'ارفع صورة او اكتب تخطي');
                return;
            }
            break;
        case '7': 
            if (text && text.toLowerCase() === 'تخطي') {
                await finalizeEditStep(client, from, whatsappId, temp);
                return;
            } else if (message.hasMedia) {
                const media = await message.downloadMedia();
                const url = await db.uploadMediaBase64('menu_edit', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
                temp.edit_updates.menu = (temp.edit_updates.menu || []).concat([url]);
                await sendMessageTo(client, from, 'تمت الاضافة. ارسل ملف اخر او اكتب "تخطي"');
                return; 
            } else {
                await sendMessageTo(client, from, 'ارفع ملف المنيو او اكتب تخطي');
                return;
            }
            break;
        case '8': 
            const parts = parseMultiInput(text);
            const chosen = [];
            for (const p of parts) {
              if (constants.SOCIAL_PLATFORMS[p]) chosen.push(constants.SOCIAL_PLATFORMS[p]);
            }
            if (!chosen.length) {
                await sendMessageTo(client, from, 'اختيار المنصات غير صحيح. الرجاء إرسال أرقام المنصات مفصولة (فواصل أو مسافات).');
                return;
            }
            temp.pending_social_edit = chosen;
            temp.edit_updates.social_accounts = {};
            await db.updateUserState(whatsappId, '101_edit_step_social_users', temp);
            await sendMessageTo(client, from, `أرسل يوزر ${chosen[0]} الآن:`);
            return;
        case '9': 
            const contactParts = text.split(/\s+/).filter(Boolean);
            if (contactParts.length !== 2) {
                await sendMessageTo(client, from, 'الرجاء إدخال الرقم وطريقة التواصل مفصولين بمسافة (مثال: 05xxxxxxx 1).');
                return;
            }
            const newNumber = contactParts[0];
            const pref = contactParts[1];
            if (!PHONE_REGEX.test(newNumber)) {
                 await sendMessageTo(client, from, 'رقم التواصل غير صحيح. يجب أن يتكون من 10 أرقام ويبدأ بـ 05.');
                 return;
            }
            if (!['1','2','3'].includes(pref)) {
                 await sendMessageTo(client, from, 'طريقة التواصل غير صحيحة. يجب أن تكون 1 أو 2 أو 3.');
                 return;
            }
            temp.edit_updates.contact_number = newNumber;
            temp.edit_updates.contact_pref = (pref === '1')? 'call' : (pref === '2')? 'whatsapp' : 'both';
            break;
        case '10': 
            const dayParts = parseMultiInput(text);
            const map = {'1':'السبت','2':'الأحد','3':'الإثنين','4':'الثلاثاء','5':'الأربعاء','6':'الخميس','7':'الجمعة'};
            const days = [];
            for (const p of dayParts) {
                if (map[p]) days.push(map[p]);
            }
            if (!days.length) {
                await sendMessageTo(client, from, 'اختيار أيام غير صحيح. أرسل أرقام الأيام مفصولة (فواصل أو مسافات).');
                return;
            }
            temp.edit_updates.working_days = days;
            await db.updateUserState(whatsappId, '101_edit_step_hours_q', temp);
            await sendMessageTo(client, from, 'تم اختيار الأيام. نظام العمل: 1) فترة واحدة  2) فترتين؟ ارسل 1 او 2');
            return;
    }
    
    await finalizeEditStep(client, from, whatsappId, temp);
}

async function finalizeEditStep(client, from, whatsappId, temp) {
  temp.edit_index = (temp.edit_index || 0) + 1;
  const idxArr = temp.edit_fields || [];
  
  if (temp.edit_index >= idxArr.length) {
    let summary = 'ملخص التعديلات المقترحة:\n';
    const fieldsMap = {
        'business_name': 'اسم النشاط', 'category_name': 'نوع النشاط', 'location_link': 'الموقع', 
        'description': 'الوصف', 'logo': 'الشعار', 'contact_number': 'رقم التواصل',
        'working_days': 'أيام العمل', 'working_hours': 'ساعات العمل', 'contact_pref': 'تفضيل التواصل'
    };
    for (const [key, value] of Object.entries(temp.edit_updates)) {
        // 🚨 تصحيح: تجاهل category_key واعتمد على category_name لضمان العرض العربي
        if (key === 'category_key') continue; 
        
        if (key === 'logo') {
            summary += `- الشعار: [تم رفع شعار جديد]\n`;
        } else if (key === 'images' && Array.isArray(value)) {
            summary += `- الصور: إضافة ${value.length} صور جديدة\n`;
        } else if (key === 'menu' && Array.isArray(value)) {
            summary += `- المنيو: إضافة ${value.length} ملفات جديدة\n`;
        } else if (key === 'social_accounts') {
             summary += `- حسابات التواصل: ${Object.keys(value).join(', ')}\n`;
        } else {
            const label = fieldsMap[key] || key;
            summary += `- ${label}: ${JSON.stringify(value, null, 2).replace(/[\"\\[\]\{\}]/g, '').trim()}\n`;
        }
    }
    
    await db.updateUserState(whatsappId, '102_edit_confirm', temp);
    summary += '\nهل تعتمد الحفظ؟ (نعم/لا)';
    await sendMessageTo(client, from, summary);
  } else {
    await db.updateUserState(whatsappId, '101_edit_step', temp);
    await handleEditPrompt(client, from, temp.edit_fields[temp.edit_index], temp);
  }
}

// --- بداية الأحداث (Events) ---

client.on('qr', qr => {
  console.log('Scan this QR to link session:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp client ready');
});

client.on('message', async message => {
  let from, whatsappId, state, temp;
  
  try {
    if (message.isGroupMsg) return;
    
    from = message.from;
    whatsappId = from.split('@')[0]; 
    
    let text = (message.body || '').trim();
    
    // 💡 منطق معالجة ردود المدير على رسائل الدعم (يجب أن يكون قبل آلة الحالات)
    const adminFullId = `${constants.ADMIN_NUMBER}@c.us`; 
    if (from === adminFullId) {
        if (message.hasQuotedMsg) {
            const quotedMsg = await message.getQuotedMessage();
            const quotedText = quotedMsg.body || '';

            // التعبير النمطي للبحث عن رقم المستخدم الأصلي في الإشعار: "\nمن: [رقم_المستخدم]\n"
            const supportRegex = /من: (\d+)/;
            const match = quotedText.match(supportRegex);

            if (match && match[1]) {
                const userIdToReply = `${match[1]}@c.us`;
                const adminReplyText = message.body.trim();
                
                // إرسال الرد إلى المستخدم الأصلي
                await sendMessageTo(client, userIdToReply, `*رد الإدارة على طلب الدعم:*\n---\n${adminReplyText}`);
                
                // تأكيد للمدير
                await sendMessageTo(client, from, `✅ تم إرسال الرد إلى الرقم: ${match[1]}`);
                
                // إيقاف المعالجة لتجنب دخول آلة الحالات
                return; 
            }
        }
    }
    // ----------------------------------------------------------------------
    
    const session = await db.getUserState(whatsappId);
    state = (session.state || '0').trim(); 
    temp = session.data || {};
    
    console.log(`[INCOMING] ID: ${whatsappId}, State: ${state}, Text: "${text}"`);
    
    const hasMedia = message.hasMedia;

    const setState = async (s, data = {}) => {
      await db.updateUserState(whatsappId, s, data);
    };

    // --- أوامر عامة ---
    
    if (text === '0' || text === 'الرئيسية' || text === 'الغاء' || text.toLowerCase() === 'اختر الخدمة') {
      console.log('[RESET] Resetting state and sending main menu.');
      await db.resetUserState(whatsappId);
      await sendMainMenu(client, from);
      return;
    }

    // --- آلة الحالات (State Machine) ---
    
    switch (state) {
      case '0': {
        if (text === '1' || text === 'تسجيل نشاط جديد') {
          await setState('10', {});
          await sendMessageTo(client, from, 'أولاً، وش اسم نشاطك التجاري؟');
          return;
        } else if (text === '2' || text === 'تعديل نشاط (الكود)') {
          console.log('[STATE 0] Matched 2, moving to 99.');
          await setState('99', {});
          await sendMessageTo(client, from, 'لتعديل النشاط، ارسل كود النشاط الآن:');
          return;
        } else if (text === '3' || text === 'دعم') {
          await setState('30', {});
          await sendMessageTo(client, from, 'أرسل رسالتك للدعم الآن أو أرسل *5* للإحصائيات (للمدراء فقط):');
          return;
        } else {
          await sendMainMenu(client, from);
          return;
        }
      }

      // --- تدفق التسجيل (REGISTRATION FLOW) ---
      
      case '10': {
        if (!text || text.length < 2) {
          await sendMessageTo(client, from, 'الاسم قصير، عطنا اسم صحيح أو اكتب 0 للعوده');
          return;
        }
        temp.business_name = text;
        temp.custom_type = null; 
        await setState('11', temp);
        
        const categories = Object.entries(constants.BUSINESS_CATEGORIES).map(([k,v])=>`${k}. ${v.ar}`).join('\n');
        await sendMessageTo(client, from, `طيب، وش نوع النشاط؟ (ارسل الرقم)\n${categories}`);
        return;
      }

      case '11': {
        let selection = text.trim(); 
        if (!constants.BUSINESS_CATEGORIES[selection]) {
           await sendMessageTo(client, from, 'اختيار غير صحيح، ارسل رقم الفئة الصحيح من القائمة.');
           return;
        }
        
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
      }

      case '12': {
        temp.custom_type = text || 'أخرى - تفاصيل غير محددة';
        await setState('13', temp);
        await askYesNo(client, from, 'هل النشاط له موقع ثابت؟');
        return;
      }

      case '13': {
        const t = text.toLowerCase().trim();
        if (t === 'نعم' || t === 'y' || t === 'yes') {
          temp.has_location = true;
          await setState('14_loc', temp);
          await sendMessageTo(client, from, 'أرسل رابط الخرائط للمكان:');
          return;
        } else if (t === 'لا' || t === 'n' || t === 'no') {
          temp.has_location = false;
          temp.location_link = null; 
          await setState('15_desc', temp);
          await sendMessageTo(client, from, 'أرسل وصف مختصر للنشاط أو اكتب "تخطي"');
          return;
        } else {
          await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا". هل للنشاط موقع ثابت؟');
          return;
        }
      }

      case '14_loc': {
        if (message.hasMedia || text.startsWith('/9j/4AAQSkZJRg')) {
            await sendMessageTo(client, from, 'الرجاء إرسال **رابط الموقع** (Google Maps Link) كنص، وليس مشاركة موقع واتساب (Live Location) أو صورة.');
            return;
        }
        if (!text || !text.toLowerCase().includes('http')) {
             await sendMessageTo(client, from, 'الرجاء إرسال رابط خرائط صالح (Google Maps Link).');
             return;
        }
        temp.location_link = text;
        await setState('15_desc', temp);
        await sendMessageTo(client, from, 'أرسل وصف مختصر للنشاط أو اكتب "تخطي"');
        return;
      }

      case '15_desc': {
        if (text && text.toLowerCase() !== 'تخطي') temp.description = text;
        else temp.description = null;
        
        await setState('16_logo', temp);
        await askYesNo(client, from, 'هل عندك شعار (logo) للنشاط؟');
        return;
      }

      case '16_logo': {
        const t = text.toLowerCase();
        if (t === 'نعم') {
          await setState('16_logo_upload', temp);
          await sendMessageTo(client, from, 'ارفع صورة الشعار (PNG/JPG) الآن:');
          return;
        } else if (t === 'لا') {
          temp.logo = null;
          await setState('17_images', temp);
          await askYesNo(client, from, 'هل عندك صور للنشاط؟');
          return;
        } else {
            await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا". هل عندك شعار للنشاط؟');
            return;
        }
      }

      case '16_logo_upload': {
        if (!message.hasMedia) {
          if (text && text.toLowerCase() === 'تخطي') {
            temp.logo = null;
            await setState('17_images', temp);
            await askYesNo(client, from, 'هل عندك صور للنشاط؟');
            return;
          }
          await sendMessageTo(client, from, 'الرجاء رفع صورة الشعار أو إرسال "تخطي" للمرور.');
          return;
        }
        const media = await message.downloadMedia();
        const url = await db.uploadMediaBase64('logo.png', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
        temp.logo = url;
        await setState('17_images', temp);
        await askYesNo(client, from, 'تم رفع الشعار. هل عندك صور للنشاط؟');
        return;
      }

      case '17_images': {
        const t = text.toLowerCase();
        if (t === 'نعم') {
          await setState('17_images_upload', { ...temp, files: [] });
          await sendMessageTo(client, from, `ارفع الصور وحدة وحدة، (الحد الأقصى ${MAX_IMAGES_COUNT} صور). وبعد ما تخلص اكتب "انتهيت"`);
          return;
        } else if (t === 'لا') {
          temp.files = [];
          await setState('18_menu', temp);
          await askYesNo(client, from, 'هل عندك منيو؟');
          return;
        } else {
            await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا". هل عندك صور للنشاط؟');
            return;
        }
      }

      case '17_images_upload': {
        temp.files = temp.files || [];
        if (text && text.toLowerCase() === 'انتهيت') {
          if (temp.files.length === 0) {
              await sendMessageTo(client, from, 'لم يتم رفع أي صور. يجب رفع صورة واحدة على الأقل أو إرسال 0 للعودة.');
              return;
          }
          await setState('18_menu', temp);
          await askYesNo(client, from, 'انتهيت من الصور. هل عندك منيو؟');
          return;
        }
        
        if (temp.files.length >= MAX_IMAGES_COUNT) {
            await sendMessageTo(client, from, `وصلت للحد الأقصى للصور (${MAX_IMAGES_COUNT}). اكتب "انتهيت" للمتابعة.`);
            return;
        }

        if (!message.hasMedia) {
          await sendMessageTo(client, from, 'ارفع صورة او اكتب "انتهيت" للمتابعة.');
          return;
        }
        
        const media = await message.downloadMedia();
        const url = await db.uploadMediaBase64('image.png', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
        temp.files.push(url);
        await setState('17_images_upload', temp);
        await sendMessageTo(client, from, `تم استلام الصورة (${temp.files.length}/${MAX_IMAGES_COUNT}). تقدر ترسل صورة ثانية او اكتب "انتهيت"`);
        return;
      }

      case '18_menu': {
        const t = text.toLowerCase();
        if (t === 'نعم') {
          await setState('18_menu_upload', temp);
          await sendMessageTo(client, from, 'ارفع المنيو (صورة او PDF) أو اكتب "تخطي" للانتقال');
          return;
        } else if (t === 'لا') {
          temp.menu = [];
          await setState('19_social_q', temp);
          await askYesNo(client, from, 'هل عندك حسابات تواصل للنشاط؟');
          return;
        } else {
            await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا". هل عندك منيو؟');
            return;
        }
      }

      case '18_menu_upload': {
        if (text && text.toLowerCase() === 'تخطي') {
          temp.menu = temp.menu || [];
          await setState('19_social_q', temp);
          await askYesNo(client, from, 'حلو. هل عندك حسابات تواصل للنشاط؟');
          return;
        }
        if (!message.hasMedia) {
          await sendMessageTo(client, from, 'ارفع ملف المنيو أو اكتب "تخطي"');
          return;
        }
        const media = await message.downloadMedia();
        const url = await db.uploadMediaBase64('menu', `data:${media.mimetype};base64,${media.data}`, media.mimetype);
        temp.menu = temp.menu || [];
        temp.menu.push(url);
        await setState('19_social_q', temp);
        await askYesNo(client, from, 'تم حفظ المنيو. هل عندك حسابات تواصل للنشاط؟');
        return;
      }

      case '19_social_q': {
        const t = text.toLowerCase();
        if (t === 'نعم') {
          const list = Object.entries(constants.SOCIAL_PLATFORMS).map(([k,v])=>`${k}. ${v}`).join('\n');
          temp.pending_social = []; 
          temp.social_accounts = {};
          await setState('19_social_select', temp);
          await sendMessageTo(client, from, `اختر المنصات اللي عندك بالأرقام مفصولة بـ (فواصل أو مسافات):\n${list}\nاو اكتب 'تخطي'`);
          return;
        } else if (t === 'لا') {
          temp.social_accounts = {};
          await setState('20_contact', temp);
          await sendMessageTo(client, from, 'حلو. ارسل رقم التواصل الآن (مثال: 059xxxxxxx)');
          return;
        } else {
             await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا". هل عندك حسابات تواصل للنشاط؟');
             return;
        }
      }

      case '19_social_select': {
        if (!text || text.toLowerCase() === 'تخطي') {
          temp.social_accounts = {};
          await setState('20_contact', temp);
          await sendMessageTo(client, from, 'طيب، ارسل رقم التواصل الآن (مثال: 059xxxxxxx)');
          return;
        }
        
        const parts = parseMultiInput(text);
        const chosen = [];
        for (const p of parts) {
          if (constants.SOCIAL_PLATFORMS[p]) chosen.push(constants.SOCIAL_PLATFORMS[p]);
        }
        
        if (!chosen.length) {
          await sendMessageTo(client, from, 'اختيار غير صالح، ارسل ارقام المنصات مفصولة (فواصل أو مسافات) او اكتب تخطي');
          return;
        }
        
        temp.pending_social = chosen;
        temp.social_accounts = {};
        await setState('19_social_user', temp);
        await sendMessageTo(client, from, `اكتب يوزر ${chosen[0]} (بدون رابط، مثال @username)`);
        return;
      }

      case '19_social_user': {
        if (!text || text.length < 1) { await sendMessageTo(client, from, 'ادخل يوزر صحيح'); return; }
        const platform = temp.pending_social.shift();
        temp.social_accounts = temp.social_accounts || {};
        temp.social_accounts[platform] = text;
        
        if (temp.pending_social.length) {
          await setState('19_social_user', temp);
          await sendMessageTo(client, from, `الآن اكتب يوزر ${temp.pending_social[0]}`);
          return;
        } else {
          delete temp.pending_social;
          await setState('20_contact', temp);
          await sendMessageTo(client, from, 'تم حفظ حسابات السوشال. ارسل رقم التواصل الآن (مثال: 059xxxxxxx)');
          return;
        }
      }

      case '20_contact': {
        if (!PHONE_REGEX.test(text)) { 
            await sendMessageTo(client, from, 'رقم التواصل غير صحيح. يجب أن يتكون من 10 أرقام ويبدأ بـ 05 (مثال: 05xxxxxxx).');
            return; 
        }
        temp.contact_number = text;
        await setState('20_contact_pref', temp);
        
        await sendMessageTo(client, from, 'كيف تبي طريقة التواصل؟ ارسل:\n1) اتصال فقط\n2) واتساب فقط\n3) كلاهما');
        return;
      }

      case '20_contact_pref': {
          let choice = text.trim();
          if (choice === 'اتصال فقط') choice = '1';
          if (choice === 'واتساب فقط') choice = '2';
          if (choice === 'كلاهما') choice = '3';
          
        if (!['1','2','3'].includes(choice)) { await sendMessageTo(client, from, 'اكتب 1 او 2 او 3 فقط.'); return; }
        temp.contact_pref = (choice === '1')? 'call' : (choice === '2')? 'whatsapp' : 'both';
        await setState('21_workdays', temp);
        await sendMessageTo(client, from, 'اختار أيام العمل من القائمة (ارسل أرقام مفصولة بفواصل أو مسافات):\n1 السبت\n2 الاحد\n3 الاثنين\n4 الثلاثاء\n5 الأربعاء\n6 الخميس\n7 الجمعة');
        return;
      }

      case '21_workdays': {
        const parts = parseMultiInput(text);
        const map = {'1':'السبت','2':'الأحد','3':'الإثنين','4':'الثلاثاء','5':'الأربعاء','6':'الخميس','7':'الجمعة'};
        const days = [];
        for (const p of parts) {
          if (map[p]) days.push(map[p]);
        }
        
        if (!days.length) { 
            await sendMessageTo(client, from, 'اختيار أيام غير صحيح، يرجى إرسال الأرقام مفصولة (مثل: 1, 2, 3) أو (1 2 3).'); 
            return; 
        }
        
        temp.working_days = days;
        await setState('22_shift_count', temp);
        
        await sendMessageTo(client, from, 'نظام العمل: 1) فترة واحدة  2) فترتين؟ ارسل 1 او 2');
        return;
      }

      case '22_shift_count': {
        let choice = text.trim();
        if(choice === 'فترة واحدة') choice = '1';
        if(choice === 'فترتين') choice = '2';

        if (!['1','2'].includes(choice)) { await sendMessageTo(client, from, 'اكتب 1 او 2 فقط.'); return; }
        if (choice === '1') {
          await setState('23_single_shift', temp);
          await sendMessageTo(client, from, 'ادخل وقت الفترة (مثال: 09:00-17:00)');
          return;
        } else {
          await setState('23_double_shift_1', temp);
          await sendMessageTo(client, from, 'ادخل الفترة الأولى (مثال: 09:00-13:00)');
          return;
        }
      }

      case '23_single_shift': {
        if (!TIME_REGEX.test(text.trim())) {
            await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة. الرجاء استخدام الصيغة: HH:MM-HH:MM (مثال: 09:00-17:00).');
            return;
        }
        temp.working_hours = [{ shift:1, times: text }];
        await setState('90_confirm', temp);
        await askYesNo(client, from, 'حلو. هل تبغى تأكيد الحفظ؟');
        return;
      }

      case '23_double_shift_1': {
        if (!TIME_REGEX.test(text.trim())) {
            await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة للفترة الأولى. الرجاء استخدام الصيغة: HH:MM-HH:MM (مثال: 09:00-13:00).');
            return;
        }
        temp.shift1 = text;
        await setState('23_double_shift_2', temp);
        await sendMessageTo(client, from, 'ادخل الفترة الثانية (مثال: 16:00-22:00)');
        return;
      }

      case '23_double_shift_2': {
        if (!TIME_REGEX.test(text.trim())) {
            await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة للفترة الثانية. الرجاء استخدام الصيغة: HH:MM-HH:MM (مثال: 16:00-22:00).');
            return;
        }
        temp.working_hours = [{ shift:1, times: temp.shift1 }, { shift:2, times: text }];
        delete temp.shift1;
        await setState('90_confirm', temp);
        await askYesNo(client, from, 'تمام. هل تبغى تأكيد الحفظ؟');
        return;
      }

      case '90_confirm': {
        if (text.toLowerCase() === 'نعم') {
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
          
          await sendMessageTo(client, from, `تم التسجيل بنجاح! كود النشاط: ${code}`);
          await db.resetUserState(whatsappId);
          return;
        } else if (text.toLowerCase() === 'لا') {
            await sendMessageTo(client, from, 'تم إلغاء التسجيل. اكتب 0 للعودة للقائمة الرئيسية.');
            await db.resetUserState(whatsappId);
            return;
        } else {
             await askYesNo(client, from, 'الرجاء اختيار "نعم" أو "لا". هل تبغى تأكيد الحفظ؟');
             return;
        }
      }
      
      case '30': {
        if (text === '5') {
            // إرسال الإحصائيات
            await sendMessageTo(client, from, 'يتم استخراج الإحصائيات، لحظة من فضلك...');
            const stats = await db.getBotStats();

            let lastContactMsg = 'لم يتم تحديد آخر اتصال.';
            if (stats.lastContact) {
                lastContactMsg = `آخر شخص تواصل: ${stats.lastContact.whatsappId}\nالتاريخ: ${stats.lastContact.timestamp}`;
            }

            const statsMessage = `📊 *إحصائيات البوت الحالية*:\n` +
                                 `--------------------------\n` +
                                 `*عدد النشاطات المسجلة*: ${stats.totalBusinesses}\n` +
                                 `*عدد الأرقام (الجلسات النشطة)*: ${stats.totalActiveUsers}\n` +
                                 `--------------------------\n` +
                                 `${lastContactMsg}\n\n` +
                                 `اكتب 0 للعودة للقائمة الرئيسية.`;
            
            await sendMessageTo(client, from, statsMessage);
            await db.resetUserState(whatsappId);
            return;
        }
        
        // مسار رسالة الدعم العادية
        const now = getCurrentRiyadhTime();
        // 💡 تحديث: التأكد من أن الإشعار يحتوي على ID المرسل بشكل واضح
        const adminSupportMsg = `📩 رسالة دعم جديدة:\nالتوقيت: ${now}\nمن: ${whatsappId}\nالرسالة: ${text}`;
        await sendMessageTo(client, `${constants.ADMIN_NUMBER}@c.us`, adminSupportMsg);
        
        await sendMessageTo(client, from, 'شكراً لك. تم إرسال رسالتك إلى فريق الدعم بنجاح، وسيتم الرد عليك قريباً. اكتب 0 للعودة للقائمة الرئيسية.');
        await db.resetUserState(whatsappId);
        return;
      }

      // --- EDIT FLOW (جزء التعديل) ---
      case '99': {
        console.log(`[STATE 99] Received code input: ${text}`); 
        const code = text.trim();
        const found = await db.findActivityByCode(code);
        if (!found) {
          await sendMessageTo(client, from, 'الكود غير موجود، اعد الادخال او اكتب 0 للعودة');
          return;
        }
        temp.edit_target = { code, ref: found.ref.path };
        temp.current_data = found.data;
        await setState('100_edit_menu', temp);
        const opts = `اختر الحقول اللي تبي تعدلها (ارسل ارقام مفصولة):\n1. اسم النشاط\n2. نوع النشاط\n3. موقع\n4. الوصف\n5. الشعار\n6. الصور\n7. المنيو\n8. حسابات التواصل\n9. رقم التواصل و طريقة\n10. ايام العمل و الساعات`;
        await sendMessageTo(client, from, `لقينا النشاط:\n${found.data.business_name}\n${opts}`);
        return;
      }

      case '100_edit_menu': {
        const parts = parseMultiInput(text);
        if (!parts.length || parts.some(p => isNaN(parseInt(p)) || parseInt(p) < 1 || parseInt(p) > 10)) { 
            await sendMessageTo(client, from, 'الرجاء إرسال أرقام الحقول الصحيحة مفصولة بفواصل أو مسافات.');
            return; 
        }
        
        temp.edit_fields = parts.map(p => p.toString());
        temp.edit_updates = {};
        temp.edit_index = 0;
        await setState('101_edit_step', temp);
        await sendMessageTo(client, from, `نبدأ بالحقل رقم ${parts[0]}.`);
        await handleEditPrompt(client, from, parts[0], temp);
        return;
      }

      case '101_edit_step': {
          const idxArr = temp.edit_fields;
          const idx = temp.edit_index || 0;
          const currentField = idxArr[idx];
          await handleEditInput(client, from, whatsappId, message, text, currentField, temp);
          return;
      }

      case '101_edit_step_social_users': {
        if (!text || text.length < 1) { await sendMessageTo(client, from, 'ادخل يوزر صحيح'); return; }
        const platform = temp.pending_social_edit.shift();
        temp.edit_updates.social_accounts = temp.edit_updates.social_accounts || {};
        temp.edit_updates.social_accounts[platform] = text;
        
        if (temp.pending_social_edit.length) {
            await db.updateUserState(whatsappId, '101_edit_step_social_users', temp);
            await sendMessageTo(client, from, `الآن اكتب يوزر ${temp.pending_social_edit[0]}`);
            return;
        } else {
            delete temp.pending_social_edit;
            await finalizeEditStep(client, from, whatsappId, temp);
            return;
        }
      }

      case '101_edit_step_hours_q': {
        let choice = text.trim();
        if(choice === 'فترة واحدة') choice = '1';
        if(choice === 'فترتين') choice = '2';

        if (!['1','2'].includes(choice)) { await sendMessageTo(client, from, 'اكتب 1 او 2 فقط.'); return; }
        if (choice === '1') {
          await db.updateUserState(whatsappId, '101_edit_step_single_hour', temp);
          await sendMessageTo(client, from, 'ادخل وقت الفترة (مثال: 09:00-17:00)');
          return;
        } else {
          await db.updateUserState(whatsappId, '101_edit_step_double_hour_1', temp);
          await sendMessageTo(client, from, 'ادخل الفترة الأولى (مثال: 09:00-13:00)');
          return;
        }
      }
      
      case '101_edit_step_single_hour': {
        if (!TIME_REGEX.test(text.trim())) {
            await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة. الرجاء استخدام الصيغة: HH:MM-HH:MM (مثال: 09:00-17:00).');
            return;
        }
        temp.edit_updates.working_hours = [{ shift:1, times: text }];
        await finalizeEditStep(client, from, whatsappId, temp);
        return;
      }
      
      case '101_edit_step_double_hour_1': {
        if (!TIME_REGEX.test(text.trim())) {
            await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة للفترة الأولى. الرجاء استخدام الصيغة: HH:MM-HH:MM (مثال: 09:00-13:00).');
            return;
        }
        temp.shift1_edit = text;
        await db.updateUserState(whatsappId, '101_edit_step_double_hour_2', temp);
        await sendMessageTo(client, from, 'ادخل الفترة الثانية (مثال: 16:00-22:00)');
        return;
      }
      
      case '101_edit_step_double_hour_2': {
        if (!TIME_REGEX.test(text.trim())) {
            await sendMessageTo(client, from, 'صيغة الوقت غير صحيحة للفترة الثانية. الرجاء استخدام الصيغة: HH:MM-HH:MM (مثال: 16:00-22:00).');
            return;
        }
        temp.edit_updates.working_hours = [{ shift:1, times: temp.shift1_edit }, { shift:2, times: text }];
        delete temp.shift1_edit;
        await finalizeEditStep(client, from, whatsappId, temp);
        return;
      }

      default: {
        console.log(`[DEFAULT] Unhandled state: ${state}. Sending main menu fallback.`);
        await sendMessageTo(client, from, 'ما فهمت. ربما حدث خطأ. اكتب 0 للرجوع للقائمة الرئيسية.');
      }
    }
  } catch (err) {
    console.error('❌ CRITICAL ERROR IN MESSAGE HANDLER', err); 
    if (from) {
        await sendMessageTo(client, from, 'عفواً، حدث خطأ فادح في معالجة طلبك. الرجاء المحاولة مجدداً أو إرسال 0 للعودة للقائمة الرئيسية.');
    }
    await sendMainMenu(client, from); 
  }
});

client.initialize();

client.on('message_create', async msg => {
  try {
    if (msg.isGroupMsg) return;
    const from = msg.from;
    if(msg.fromMe) return; 

    const whatsappId = from.split('@')[0];
    const session = await db.getUserState(whatsappId);
    if (!session) return;
    const state = (session.state || '0').trim(); 
    const temp = session.data || {};
    const text = (msg.body || '').trim().toLowerCase();

    if (state === '102_edit_confirm') {
      if (text === 'نعم') {
        const target = temp.edit_target;
        const found = await db.findActivityByCode(target.code);
        if (!found) {
          await client.sendMessage(from, 'للأسف الكود ما لقيته الآن.');
          await db.resetUserState(whatsappId);
          return;
        }
        
        const updates = temp.edit_updates || {};
        if (updates.images && Array.isArray(updates.images)) {
          const existing = found.data.images || [];
          updates.images = existing.concat(updates.images);
        }
        await found.ref.update(updates);
        
        const now = getCurrentRiyadhTime();
        await client.sendMessage(`${constants.ADMIN_NUMBER}@c.us`, `✅ تم تعديل نشاط ${target.code} بواسطة ${whatsappId}\nالتوقيت: ${now}`);
        await client.sendMessage(from, 'تم حفظ التعديلات بنجاح.');
        await db.resetUserState(whatsappId);
      } else if (text === 'لا') {
        await client.sendMessage(from, 'تم إلغاء الحفظ. اكتب 0 للعودة.');
        await db.resetUserState(whatsappId);
      }
    }
  } catch (e) {
    // ignore
  }
});