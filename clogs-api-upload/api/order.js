const { google } = require('googleapis');

const COLORS = new Set(['black', 'brown', 'havana', 'cumino']);
const SIZES = new Set([41, 42, 43, 44, 45]);
const OFFERS = {
  1: { price: 649, original: 649 },
  2: { price: 1260, original: 1300 },
  3: { price: 1890, original: 1950 },
};
const SHIPPING = {
  'القاهرة': 70, 'الجيزة': 70,
  'الغربية': 80, 'الإسكندرية': 80, 'الإسماعيلية': 80, 'كفر الشيخ': 80,
  'أسوان': 80, 'أسيوط': 80, 'الأقصر': 80, 'البحيرة': 80, 'بني سويف': 80,
  'بورسعيد': 80, 'الدقهلية': 80, 'دمياط': 80, 'سوهاج': 80, 'السويس': 100,
  'الشرقية': 80, 'الفيوم': 80, 'القليوبية': 80, 'قنا': 80, 'المنوفية': 80,
  'المنيا': 80, 'البحر الأحمر': 120, 'جنوب سيناء': 120, 'مطروح': 120,
  'الغردقة': 120, 'شرم الشيخ': 120, 'العريش': 120, 'الوادي الجديد': 140,
};

// Customer-facing columns are Arabic. The final technical ID column is used only
// to prevent the same browser submission from being inserted more than once.
const HEADERS = [
  'رقم الطلب', 'تاريخ الطلب (بتوقيت مصر)', 'اسم العميل', 'رقم الموبايل',
  'رقم موبايل إضافي', 'المحافظة', 'المدينة / المنطقة', 'العنوان بالتفصيل',
  'ملاحظات العميل', 'العرض المختار', 'عدد القطع',
  'لون القطعة الأولى', 'مقاس القطعة الأولى',
  'لون القطعة الثانية', 'مقاس القطعة الثانية',
  'لون القطعة الثالثة', 'مقاس القطعة الثالثة',
  'قيمة المنتجات قبل الخصم', 'قيمة الخصم', 'قيمة المنتجات بعد الخصم',
  'مصاريف الشحن', 'الإجمالي النهائي', 'طريقة الدفع', 'حالة الطلب',
  'UTM source', 'UTM medium', 'UTM campaign', 'UTM term', 'UTM content',
  'معرّف الطلب التقني',
];

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(payload));
}
function clean(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function validEgyptianPhone(value, optional = false) {
  if (optional && !value) return true;
  return /^01[0125]\d{8}$/.test(value);
}
function egyptTime() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}
function columnName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
async function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKey || !process.env.GOOGLE_SHEET_ID) {
    throw new Error('Google Sheets environment variables are not configured');
  }
  const auth = new google.auth.JWT({
    email,
    key: privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'Invalid request' });

    // Honeypot: quietly reject automated form submissions.
    if (clean(body.hp, 200)) return json(res, 400, { ok: false, error: 'Invalid request' });

    const name = clean(body.name, 120);
    const phone = clean(body.phone, 20).replace(/\s+/g, '');
    const phone2 = clean(body.phone2, 20).replace(/\s+/g, '');
    const gov = clean(body.gov, 80);
    const city = clean(body.city, 120);
    const address = clean(body.address, 500);
    const notes = clean(body.notes, 1000);
    const requestId = clean(body.requestId, 100);
    const offer = Number(body.offer);
    const items = Array.isArray(body.items) ? body.items : [];

    if (name.length < 3 || !validEgyptianPhone(phone) || !validEgyptianPhone(phone2, true) ||
        !Object.prototype.hasOwnProperty.call(SHIPPING, gov) || city.length < 2 || address.length < 10 ||
        !OFFERS[offer] || items.length !== offer || !requestId) {
      return json(res, 400, { ok: false, error: 'Please check the order details' });
    }

    const normalizedItems = items.map((item) => ({
      color: clean(item && item.color, 20),
      size: Number(item && item.size),
    }));
    if (normalizedItems.some((item) => !COLORS.has(item.color) || !SIZES.has(item.size))) {
      return json(res, 400, { ok: false, error: 'Invalid item options' });
    }

    const offerInfo = OFFERS[offer];
    const original = offerInfo.original;
    const discount = original - offerInfo.price;
    const productsAfterDiscount = offerInfo.price;
    const shipping = SHIPPING[gov];
    const total = productsAfterDiscount + shipping;
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const sheetName = process.env.GOOGLE_SHEET_TAB || 'Orders';
    const quotedTab = `'${sheetName.replace(/'/g, "''")}'`;
    const lastCol = columnName(HEADERS.length);
    const range = `${quotedTab}!A:${lastCol}`;
    const sheets = await getSheetsClient();

    const headerResult = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${quotedTab}!A1:${lastCol}1`,
    });
    const existingHeaders = headerResult.data.values && headerResult.data.values[0];
    if (!existingHeaders || existingHeaders.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${quotedTab}!A1:${lastCol}1`, valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] },
      });
    } else if (HEADERS.some((header, index) => existingHeaders[index] !== header) || existingHeaders.length !== HEADERS.length) {
      return json(res, 409, {
        ok: false,
        error: 'Sheet headers do not match. Use a blank tab named Orders or make its first row match the supplied Arabic headers.',
      });
    }

    // Technical request ID is column AD (30th column).
    const idColumn = columnName(HEADERS.length);
    const ids = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${quotedTab}!${idColumn}2:${idColumn}`,
    });
    const rows = ids.data.values || [];
    const duplicateIndex = rows.findIndex((row) => row[0] === requestId);
    if (duplicateIndex >= 0) {
      const rowNumber = duplicateIndex + 2;
      const prior = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `${quotedTab}!A${rowNumber}:V${rowNumber}`,
      });
      const values = prior.data.values && prior.data.values[0] ? prior.data.values[0] : [];
      return json(res, 200, { ok: true, orderId: values[0] || 'Already received', total: Number(values[21]) || total, duplicate: true });
    }

    const orderId = `CLG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};
    const row = [
      orderId, egyptTime(), name, phone, phone2, gov, city, address, notes,
      `${offer} قطعة`, offer,
      normalizedItems[0]?.color || '', normalizedItems[0]?.size || '',
      normalizedItems[1]?.color || '', normalizedItems[1]?.size || '',
      normalizedItems[2]?.color || '', normalizedItems[2]?.size || '',
      original, discount, productsAfterDiscount, shipping, total,
      'كاش عند الاستلام', 'جديد',
      clean(utm.utm_source, 200), clean(utm.utm_medium, 200), clean(utm.utm_campaign, 200),
      clean(utm.utm_term, 200), clean(utm.utm_content, 200), requestId,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    return json(res, 200, { ok: true, orderId, total });
  } catch (error) {
    console.error('Order submission failed:', error && error.message ? error.message : error);
    return json(res, 500, { ok: false, error: 'Order could not be saved' });
  }
};
