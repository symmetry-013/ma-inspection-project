require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const stream = require('stream');
const { google } = require('googleapis');
const axios = require('axios');

const { generateInspectionPDF } = require('./pdfGenerator');
const { equipmentMap: svEquipmentMap, hardcodedBasins: svHardcodedBasins } = require('./name_sv');
const {
    Equipment: MamEquipment,
    TorTask: MamTorTask,
    MamSyncMeta,
    cleanExcelFormulaEscape,
    importFromMam
} = require('./mamImporter');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// ==========================================
// ฟังก์ชันช่วยเหลือทั่วไป (Helpers)
// ==========================================
function getThaiFiscalYear(dateInput, explicitYear) {
    if (explicitYear && String(explicitYear).trim() !== '' && explicitYear !== 'all' && explicitYear !== 'ALL') {
        return String(explicitYear).trim();
    }
    const d = dateInput ? new Date(dateInput) : new Date();
    if (isNaN(d.getTime())) return String(new Date().getFullYear() + 543);
    let thaiYear = d.getFullYear() + 543;
    if (d.getMonth() >= 9) thaiYear += 1;
    return String(thaiYear);
}

function normalizeStationCode(code) {
    if (!code) return '';
    return String(code).trim().split('(')[0].trim().replace(/\s+/g, '').toUpperCase();
}

function parsePeriodNumber(periodInput) {
    if (!periodInput) return '1';
    const match = String(periodInput).match(/\d+/);
    return match ? match[0] : String(periodInput).trim();
}

function formatPeriodLabel(periodInput) {
    const num = parsePeriodNumber(periodInput);
    return `งวดที่${num}`;
}

// แปลงรายการอุปกรณ์จาก mam_equipment.html และผลประเมินจาก tor_inspection.html
// ให้เป็นคีย์มาตรฐานเดิม (clean, sta_cpu, sta_m1, sta_p1, ...) เพื่อใช้เงื่อนไขเดิมในรายงานทั้งหมด
function mapMamDataToLegacyRecord(torDoc, equipDoc) {
    const base = {};
    const refDoc = torDoc || equipDoc || {};
    const pNum = parsePeriodNumber(refDoc.period || '1');

    base._id = refDoc._id;
    base.source_type = 'mam_unified';
    base.contractYear = refDoc.contractYear || getThaiFiscalYear(refDoc.timestamp);
    base.saya = `งวดที่${pNum}`;
    base.period = pNum;
    base.code = refDoc.basin || '-';
    base.basin = refDoc.basin || '-';
    base.id_name = (torDoc && torDoc.station_id) ? torDoc.station_id : (equipDoc ? equipDoc.station_code : '-');
    base.name_id = (torDoc && torDoc.station_name) ? torDoc.station_name : (equipDoc ? equipDoc.station_name : base.id_name);
    base.timestamp = (torDoc && torDoc.timestamp) ? torDoc.timestamp : (equipDoc ? equipDoc.timestamp : new Date());
    base.createdAt = base.timestamp;

    base.lat = (torDoc && torDoc.lat) ? torDoc.lat : '';
    base.lon = (torDoc && torDoc.lon) ? torDoc.lon : '';
    base.geoAddress = (torDoc && torDoc.geoAddress) ? torDoc.geoAddress : 'ไม่ระบุพิกัด';
    base.photos = (torDoc && Array.isArray(torDoc.photos)) ? torDoc.photos : [];

    // หมายเหตุผู้ตรวจสอบ (จาก mam_equipment) และความเห็นกรรมการ (จาก tor_inspection)
    base.note = (equipDoc && equipDoc.inspector_note) ? equipDoc.inspector_note : ((torDoc && torDoc.inspector_note) ? torDoc.inspector_note : '-');
    base.note2 = (torDoc && torDoc.committee_note) ? torDoc.committee_note : '-';

    // ค่าเริ่มต้นให้ทุกคีย์เป็น 'ปกติ' ('p')
    const allKeys = [
        'clean', 'pai', 'power', 'power1', 'online', 'wl', 'wl1', 'r',
        'sta_cpu', 'sta_ai', 'sta_di', 'sta_do', 'sta_io', 'plc',
        'sta_m1', 'sta_m2', 'sta_p1', 'sta_p2', 'sta_cctv1', 'sta_cctv2',
        'sta_r', 'sta_s', 'sta_wl', 'sta_tro', 'sta_gass', 'sta_wl1',
        'sta_wl2', 'sta_saling', 'b2', 'sta1', 'sta2', 'pole2'
    ];
    allKeys.forEach(k => { base[k] = 'ปกติ'; });

    // 1. ตรวจสอบจากผลประเมิน TOR (tor_inspection.html)
    if (torDoc && Array.isArray(torDoc.evaluations)) {
        base.tor_evaluations = torDoc.evaluations;
        torDoc.evaluations.forEach(ev => {
            const isFail = (ev.result === 'ไม่ผ่าน' || ev.result === 'ชำรุด');
            const nameAndKey = `${ev.task_key || ''} ${ev.task_name || ''}`.toLowerCase();
            if (nameAndKey.includes('step_2') || nameAndKey.includes('ความสะอาด') || nameAndKey.includes('ทำความสะอาด')) {
                base.clean = isFail ? 'ไม่ผ่าน' : 'ผ่าน';
            }
            if (isFail) {
                if (nameAndKey.includes('ป้าย')) base.pai = 'ชำรุด';
                if (nameAndKey.includes('ไฟฟ้า')) base.power = 'ชำรุด';
                if (nameAndKey.includes('หลอดไฟ')) base.power1 = 'ชำรุด';
                if (nameAndKey.includes('ออนไลน์') || nameAndKey.includes('เว็บ')) base.online = 'ชำรุด';
                if (nameAndKey.includes('เสาวัดน้ำ') || nameAndKey.includes('staff')) base.pole2 = 'ชำรุด';
            }
        });
    } else {
        base.clean = 'ผ่าน';
    }

    // 2. ตรวจสอบจากรายการอุปกรณ์ MAM (mam_equipment.html)
    if (equipDoc && Array.isArray(equipDoc.items)) {
        base.mam_items = equipDoc.items;
        let modemCount = 0;
        let powerCount = 0;
        let cctvCount = 0;

        equipDoc.items.forEach(it => {
            const st = String(it.inspected_status || it.mam_status || '').trim();
            const isBroken = (st === 'ชำรุด' || st === 'ใช้งานไม่ได้' || st === 'ไม่ผ่าน' || st === '0' || st.toLowerCase() === 'o');
            const text = `${it.category || ''} ${it.location_point || ''} ${it.model || ''} ${it.brand || ''}`.toLowerCase();

            if (text.includes('cpu') || text.includes('rtu')) {
                if (isBroken) base.sta_cpu = 'ชำรุด';
            } else if (text.includes('ai') || text.includes('analog')) {
                if (isBroken) base.sta_ai = 'ชำรุด';
            } else if (text.includes('di')) {
                if (isBroken) base.sta_di = 'ชำรุด';
            } else if (text.includes('do')) {
                if (isBroken) base.sta_do = 'ชำรุด';
            } else if (text.includes('io') || text.includes('i/o') || text.includes('mux')) {
                if (isBroken) base.sta_io = 'ชำรุด';
            } else if (text.includes('plc') || text.includes('logger')) {
                if (isBroken) base.plc = 'ชำรุด';
            } else if (text.includes('modem') || text.includes('router') || text.includes('gprs') || text.includes('โมเด็ม')) {
                modemCount++;
                const targetKey = modemCount === 1 ? 'sta_m1' : 'sta_m2';
                if (isBroken) base[targetKey] = 'ชำรุด';
            } else if (text.includes('power') || text.includes('solar') || text.includes('charger') || text.includes('แหล่งจ่ายไฟ') || text.includes('โซลาร์')) {
                powerCount++;
                const targetKey = powerCount === 1 ? 'sta_p1' : 'sta_p2';
                if (isBroken) base[targetKey] = 'ชำรุด';
            } else if (text.includes('cctv') || text.includes('กล้อง') || text.includes('camera')) {
                cctvCount++;
                const targetKey = cctvCount === 1 ? 'sta_cctv1' : 'sta_cctv2';
                if (isBroken) base[targetKey] = 'ชำรุด';
            } else if (text.includes('rain') || text.includes('น้ำฝน') || text.includes('ปริมาณฝน')) {
                if (isBroken) base.sta_r = 'ชำรุด';
            } else if (text.includes('surge') || text.includes('กันฟ้าผ่า') || text.includes('arrester')) {
                if (isBroken) base.sta_s = 'ชำรุด';
            } else if (text.includes('radar') || text.includes('เรดาร์') || text.includes('ultrasonic')) {
                if (isBroken) base.sta_wl1 = 'ชำรุด';
            } else if (text.includes('float') || text.includes('ลูกลอย') || text.includes('shaft')) {
                if (isBroken) base.sta_wl2 = 'ชำรุด';
            } else if (text.includes('bubble') || text.includes('ความดัน') || text.includes('pressure') || text.includes('ระดับน้ำ')) {
                if (isBroken) base.sta_wl = 'ชำรุด';
            } else if (text.includes('battery') || text.includes('แบต')) {
                if (isBroken) base.b2 = 'ชำรุด';
            } else if (text.includes('ท่อลม')) {
                if (isBroken) base.sta_tro = 'ชำรุด';
            } else if (text.includes('ถังแก๊ส') || text.includes('ไนโตรเจน')) {
                if (isBroken) base.sta_gass = 'ชำรุด';
            } else if (text.includes('สลิง')) {
                if (isBroken) base.sta_saling = 'ชำรุด';
            } else if (text.includes('เสาวัดน้ำ') || text.includes('staff')) {
                if (isBroken) base.pole2 = 'ชำรุด';
            }
        });
    }

    return base;
}

// รวมข้อมูลจาก Inspection เดิม + TorCheck + EquipmentCheck โดยไม่ซ้ำสถานีในงวดเดียวกัน
async function buildUnifiedInspections(filterOptions = {}) {
    const { year = 'all', term = 'all', basin = 'all', station = 'all' } = filterOptions;

    let legacyQuery = {};
    let torQuery = {};
    let equipQuery = {};

    if (term !== 'all' && term !== 'ALL') {
        const pNum = parsePeriodNumber(term);
        const pLabel = formatPeriodLabel(pNum);
        legacyQuery.saya = new RegExp(term.replace(/\s+/g, '.*'), 'i');
        torQuery.period = { $in: [pNum, pLabel] };
        equipQuery.period = { $in: [pNum, pLabel, String(term).trim()] };
    }
    if (basin !== 'all' && basin !== 'ALL') {
        legacyQuery.code = basin;
        torQuery.basin = basin;
        equipQuery.basin = basin;
    }
    if (station !== 'all' && station !== 'ALL' && String(station).trim() !== '') {
        const stReg = new RegExp(String(station).trim(), 'i');
        legacyQuery.id_name = stReg;
        torQuery.station_id = stReg;
        equipQuery.station_code = stReg;
    }
    if (year !== 'all' && year !== 'ALL') {
        torQuery.contractYear = String(year).trim();
        equipQuery.contractYear = String(year).trim();
    }

    let [legacyList, torList, equipList] = await Promise.all([
        Inspection.find(legacyQuery).sort({ timestamp: -1 }).lean(),
        TorCheck.find(torQuery).sort({ timestamp: -1 }).lean(),
        EquipmentCheck.find(equipQuery).sort({ timestamp: -1 }).lean()
    ]);

    if (year !== 'all' && year !== 'ALL') {
        legacyList = legacyList.filter(item => getThaiFiscalYear(item.timestamp || item.createdAt, item.contractYear) === String(year));
    }

    const unifiedMap = new Map();

    // 1. จับคู่ TorCheck กับ EquipmentCheck ตาม ปี_งวด_รหัสสถานี
    const mamGroupMap = new Map();

    torList.forEach(t => {
        const y = t.contractYear || getThaiFiscalYear(t.timestamp);
        const p = parsePeriodNumber(t.period);
        const code = normalizeStationCode(t.station_id);
        const key = `${y}_${p}_${code}`;
        if (!mamGroupMap.has(key)) mamGroupMap.set(key, { tor: t, equip: null });
        else if (!mamGroupMap.get(key).tor) mamGroupMap.get(key).tor = t;
    });

    equipList.forEach(e => {
        const y = e.contractYear || getThaiFiscalYear(e.timestamp);
        const p = parsePeriodNumber(e.period);
        const code = normalizeStationCode(e.station_code);
        const key = `${y}_${p}_${code}`;
        if (!mamGroupMap.has(key)) mamGroupMap.set(key, { tor: null, equip: e });
        else if (!mamGroupMap.get(key).equip) mamGroupMap.get(key).equip = e;
    });

    for (const [key, pair] of mamGroupMap.entries()) {
        unifiedMap.set(key, mapMamDataToLegacyRecord(pair.tor, pair.equip));
    }

    // 2. เติมข้อมูลจาก Inspection เดิม (กรณีสถานีเก่าที่ยังไม่ได้ตรวจผ่านระบบใหม่)
    legacyList.forEach(leg => {
        const y = getThaiFiscalYear(leg.timestamp || leg.createdAt, leg.contractYear);
        const p = parsePeriodNumber(leg.saya || '1');
        const code = normalizeStationCode(leg.id_name);
        const key = `${y}_${p}_${code}`;
        if (!unifiedMap.has(key)) {
            unifiedMap.set(key, {
                ...leg,
                contractYear: y,
                saya: formatPeriodLabel(p)
            });
        } else {
            // หากใน TorCheck ยังไม่มีรูปภาพหรือพิกัด แต่ใน Inspection เดิมมี ให้ดึงมาเสริม
            const existing = unifiedMap.get(key);
            if ((!existing.photos || existing.photos.length === 0) && Array.isArray(leg.photos) && leg.photos.length > 0) {
                existing.photos = leg.photos;
            }
            if (!existing.lat && leg.lat) {
                existing.lat = leg.lat;
                existing.lon = leg.lon;
                existing.geoAddress = leg.geoAddress || existing.geoAddress;
            }
        }
    });

    const resultList = Array.from(unifiedMap.values());
    resultList.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return {
        unifiedList: resultList,
        torList,
        equipList
    };
}

// ==========================================
// การตรวจสอบสิทธิ์ (Auth) 
// ==========================================
const ADMIN_KEY = 'MAM_Secret_2026';
const CRON_SECRET = 'MAM_Secret_2026';

function checkApiAuth(req, res, next) {
    if (process.env.REQUIRE_API_AUTH !== 'true') {
        return next();
    }
    const token = req.headers['x-api-key'] ||
                  (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '') ||
                  req.query.key;
    if (token && (token === ADMIN_KEY || token === process.env.APP_ACCESS_KEY)) {
        return next();
    }
    return res.status(401).json({
        success: false,
        error: 'Unauthorized: กรุณาระบุ API Key หรือเข้าสู่ระบบ',
        code: 'UNAUTHORIZED'
    });
}

// ==========================================
// 1. ตั้งค่า File Upload (Memory Storage)
// ==========================================
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => /^image\//i.test(file.mimetype) ? cb(null, true) : cb(new Error('รองรับเฉพาะรูปภาพ')),
    limits: { fileSize: 15 * 1024 * 1024, files: 10 }
});

// ==========================================
// 2. Database Setup (MongoDB)
// ==========================================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ma_inspection')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const InspectionSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now }
}, { strict: false, timestamps: true });
const Inspection = mongoose.model('Inspection', InspectionSchema);

const CalibrationSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now }
}, { strict: false, timestamps: true });
const Calibration = mongoose.model('Calibration', CalibrationSchema);

const EquipmentCheckSchema = new mongoose.Schema({
    contractYear: String,
    period: String,
    basin: String,
    station_code: String,
    station_name: String,
    items: Array,
    inspector_note: String,
    timestamp: { type: Date, default: Date.now }
}, { strict: false, timestamps: true });
const EquipmentCheck = mongoose.model('EquipmentCheck', EquipmentCheckSchema);

const TorCheckSchema = new mongoose.Schema({
    contractYear: String,
    period: String,
    period_label: String,
    basin: String,
    station_id: String,
    station_name: String,
    mam_record_id: String,
    evaluations: Array,
    committee_note: String,
    inspector_note: String,
    lat: String,
    lon: String,
    geoAddress: String,
    photos: Array,
    timestamp: { type: Date, default: Date.now }
}, { strict: false, timestamps: true });
const TorCheck = mongoose.model('TorCheck', TorCheckSchema);

const OAuthToken = mongoose.model('OAuthToken', new mongoose.Schema({
    key: { type: String, unique: true, default: 'google_drive' },
    refresh_token: String,
    updatedAt: { type: Date, default: Date.now }
}));

// ==========================================
// 3. Google Drive API & OAuth2
// ==========================================
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `https://ma-inspection-project.onrender.com/auth/google/callback`;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1YYa-Cu1vu-Ei9a0qpJMFOTJxmQPN2srv';

let driveAuthorized = false;
let oauth2Client;
let drive;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    drive = google.drive({ version: 'v3', auth: oauth2Client });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) {
            saveRefreshToken(tokens.refresh_token).catch(e => console.error('❌ Save token error:', e.message));
        }
    });
} else {
    console.warn('⚠️ Google Drive: ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID หรือ GOOGLE_CLIENT_SECRET ใน .env');
}

function applyRefreshToken(refreshToken) {
    if (oauth2Client) {
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        driveAuthorized = true;
    }
}

async function saveRefreshToken(refreshToken) {
    await OAuthToken.findOneAndUpdate(
        { key: 'google_drive' },
        { refresh_token: refreshToken, updatedAt: new Date() },
        { upsert: true }
    );
}

mongoose.connection.once('open', async () => {
    if (process.env.GOOGLE_REFRESH_TOKEN) {
        applyRefreshToken(process.env.GOOGLE_REFRESH_TOKEN);
        console.log('✅ Google Drive: ใช้ Refresh Token จาก Environment');
    } else {
        try {
            const saved = await OAuthToken.findOne({ key: 'google_drive' });
            if (saved && saved.refresh_token) {
                applyRefreshToken(saved.refresh_token);
                console.log('✅ Google Drive: โหลด Refresh Token จาก MongoDB เรียบร้อยแล้ว');
            } else {
                console.warn('⚠️ Google Drive ยังไม่ได้เชื่อมต่อ → กรุณาเปิด /auth/google?key=<ADMIN_KEY> เพื่อล็อกอิน');
            }
        } catch (e) {
            console.error('❌ โหลด Google token ไม่สำเร็จ:', e.message);
        }
    }
});

const pendingStates = new Map();
app.get('/auth/google', (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(403).send('Forbidden: ต้องใช้ Admin Key');
    if (!oauth2Client) return res.status(503).send('ยังไม่ได้ตั้งค่า Google Client ID ใน .env');
    
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: DRIVE_SCOPES, state });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`เกิดข้อผิดพลาด: ${error}`);

    const expires = pendingStates.get(state);
    pendingStates.delete(state);
    if (!expires || expires < Date.now()) return res.status(400).send('Session ล็อกอินหมดอายุ');

    try {
        const { tokens } = await oauth2Client.getToken(code);
        if (tokens.refresh_token) {
            applyRefreshToken(tokens.refresh_token);
            await saveRefreshToken(tokens.refresh_token);
            const about = await drive.about.get({ fields: 'user(emailAddress)' });
            res.send(`✅ เชื่อมต่อ Google Drive สำเร็จด้วยบัญชี ${about.data.user.emailAddress} — ปิดหน้านี้ได้เลย`);
        } else {
            res.status(400).send('ไม่ได้รับ refresh_token — กรุณาลบสิทธิ์แอพเก่าในบัญชี Google แล้วลองใหม่');
        }
    } catch (e) {
        res.status(500).send('เชื่อมต่อไม่สำเร็จ: ' + e.message);
    }
});

// ==========================================
// 4. API: ล็อกอินใช้งานระบบ (สำหรับกรรมการ)
// ==========================================
const APP_LOGIN_USER = process.env.APP_LOGIN_USER || 'tele_app';
const APP_LOGIN_PASS = process.env.APP_LOGIN_PASS || 'Rid_tele';

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (String(username).trim() === APP_LOGIN_USER && String(password) === APP_LOGIN_PASS) {
        return res.status(200).json({
            success: true,
            message: 'เข้าสู่ระบบสำเร็จ',
            user: APP_LOGIN_USER
        });
    }
    return res.status(401).json({
        success: false,
        message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง'
    });
});

// ==========================================
// 5. ฟังก์ชันจัดการโฟลเดอร์และรูปภาพ Google Drive
// ==========================================
const folderCache = new Map();

function extractDriveId(url) {
    if (!url) return null;
    const str = String(url);
    const ucMatch = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (ucMatch) return ucMatch[1];
    const dMatch = str.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (dMatch) return dMatch[1];
    const apiMatch = str.match(/\/api\/images\/([a-zA-Z0-9_-]+)/);
    if (apiMatch) return apiMatch[1];
    return null;
}

app.get('/api/images/:fileId', async (req, res) => {
    try {
        const fileId = req.params.fileId;
        if (!driveAuthorized) {
            return res.redirect(`https://drive.google.com/thumbnail?id=${fileId}&sz=w800`);
        }
        const response = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'stream' }
        );
        res.setHeader('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    } catch (error) {
        console.error('❌ Fetch image API error:', error.message);
        res.redirect(`https://drive.google.com/thumbnail?id=${req.params.fileId}&sz=w800`);
    }
});

async function getTargetFolderId(folderPathArray) {
    if (!driveAuthorized) return null;
    let currentParentId = GOOGLE_DRIVE_FOLDER_ID;

    for (const folderName of folderPathArray) {
        if (!folderName || String(folderName).trim() === '' || folderName === 'ไม่ระบุ' || folderName === 'null') continue;

        const safeFolderName = String(folderName).trim();
        const cacheKey = `${currentParentId}_${safeFolderName}`;
        
        if (folderCache.has(cacheKey)) {
            currentParentId = folderCache.get(cacheKey);
            continue;
        }

        try {
            const escapedName = safeFolderName.replace(/'/g, "\\'");
            const query = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and '${currentParentId}' in parents and trashed=false`;
            const res = await drive.files.list({ q: query, fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true });

            if (res.data.files && res.data.files.length > 0) {
                currentParentId = res.data.files[0].id;
                folderCache.set(cacheKey, currentParentId);
            } else {
                const folder = await drive.files.create({
                    requestBody: { name: safeFolderName, mimeType: 'application/vnd.google-apps.folder', parents: [currentParentId] },
                    fields: 'id', supportsAllDrives: true
                });
                
                await drive.permissions.create({ fileId: folder.data.id, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true });
                currentParentId = folder.data.id;
                folderCache.set(cacheKey, currentParentId);
            }
        } catch (err) {
            console.error(`❌ Google Drive API Error (สร้างโฟลเดอร์ ${safeFolderName}):`, err.message);
        }
    }
    return currentParentId;
}

async function uploadFileToFolder(file, targetFolderId) {
    if (!driveAuthorized) return null;
    try {
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        
        const response = await drive.files.create({
            requestBody: { name: safeName, parents: targetFolderId ? [targetFolderId] : [GOOGLE_DRIVE_FOLDER_ID] },
            media: { mimeType: file.mimetype, body: bufferStream },
            fields: 'id, name, webViewLink',
            supportsAllDrives: true,
        });

        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
            supportsAllDrives: true,
        });

        const fileId = response.data.id;
        return {
            fileId: fileId,
            name: response.data.name,
            webViewLink: response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
            thumbnailUrl: `/api/images/${fileId}`
        };
    } catch (error) {
        console.error('❌ Google Drive Upload API Error:', error.message);
        return null;
    }
}

async function fetchImageBufferDirectly(fileId) {
    if (!driveAuthorized || !fileId) return null;
    try {
        const response = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'arraybuffer' }
        );
        return Buffer.from(response.data, 'binary');
    } catch (error) {
        console.error(`❌ PDF Image Fetch Error (${fileId}):`, error.message);
        return null;
    }
}

// ==========================================
// 6. API: ดึงข้อมูลตรวจสอบสถานีแบบรวมศูนย์ (TorCheck + EquipmentCheck + Inspection เดิม)
// ==========================================
app.get('/api/inspections', checkApiAuth, async (req, res) => {
    try {
        const { year, term, basin, station } = req.query;
        const { unifiedList } = await buildUnifiedInspections({ year, term, basin, station });
        res.status(200).json({ success: true, count: unifiedList.length, data: unifiedList });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// คง Endpoint POST /api/inspection ไว้เผื่อกรณีมีข้อมูลค้างส่ง
app.post('/api/inspection', upload.array('photos', 10), async (req, res) => {
    try {
        const formData = { ...req.body };
        formData.timestamp = new Date();
        formData.contractYear = getThaiFiscalYear(formData.timestamp, formData.contractYear);

        let geoAddress = "ไม่ระบุพิกัด";
        if (formData.lat && formData.lon) {
            try {
                const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${formData.lat}&lon=${formData.lon}&zoom=18&addressdetails=1`;
                const response = await axios.get(osmUrl, { headers: { 'User-Agent': 'MA_Inspection_App' }, timeout: 5000 });
                if (response.data && response.data.display_name) geoAddress = response.data.display_name;
            } catch (e) { geoAddress = "หาที่อยู่ไม่เจอ"; }
        }
        formData.geoAddress = geoAddress;

        const yearFolder = `ปีงบ_${formData.contractYear}`;
        const term = formData.saya || 'ไม่ระบุงวด';
        const basin = formData.code || 'ไม่ระบุลุ่มน้ำ';
        const station = formData.id_name || 'ไม่ระบุสถานี';
        
        const targetFolderId = await getTargetFolderId([yearFolder, term, basin, station]);

        const photos = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const uploaded = await uploadFileToFolder(file, targetFolderId);
                if (uploaded) photos.push(uploaded);
            }
        }
        
        formData.photos = photos;
        const newInspection = new Inspection(formData);
        await newInspection.save();
        
        res.status(200).json({ success: true, message: 'บันทึกข้อมูลสำเร็จ', photos });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 7. API: รับ-ส่งข้อมูลสอบเทียบ (Calibration)
// ==========================================
const calibrationUploadFields = [
    { name: 'myFile', maxCount: 1 }, { name: 'myFile2', maxCount: 1 },
    { name: 'myFile3', maxCount: 1 }, { name: 'myFile4', maxCount: 1 },
    { name: 'myFile5', maxCount: 1 }, { name: 'myFile6', maxCount: 1 },
    { name: 'myFile7', maxCount: 1 }, { name: 'myFile8', maxCount: 1 }
];

app.post('/api/calibration', upload.fields(calibrationUploadFields), async (req, res) => {
    try {
        const formData = { ...req.body };
        formData.timestamp = new Date();
        formData.contractYear = getThaiFiscalYear(formData.timestamp, formData.contractYear);
        
        const yearFolder = `ปีงบ_${formData.contractYear}`;
        const term = formData.myDataPeriod || 'ไม่ระบุงวด';
        const basin = formData.myData0 || 'ไม่ระบุลุ่มน้ำ';
        const station = formData.myData1 || 'ไม่ระบุสถานี';
        
        const targetFolderId = await getTargetFolderId([yearFolder, term, basin, station]);

        const fileFields = ['myFile', 'myFile2', 'myFile3', 'myFile4', 'myFile5', 'myFile6', 'myFile7', 'myFile8'];
        
        await Promise.all(fileFields.map(async (field, index) => {
            const urlField = index === 0 ? 'myFileUrl' : `myFileUrl${index + 1}`;
            
            if (req.files && req.files[field] && req.files[field].length > 0) {
                const file = req.files[field][0];
                const uploaded = await uploadFileToFolder(file, targetFolderId);
                formData[urlField] = uploaded ? uploaded.thumbnailUrl : '';
            } else {
                formData[urlField] = ''; 
            }
        }));

        const newCalibration = new Calibration(formData);
        await newCalibration.save();
        
        res.status(200).json({ success: true, message: 'บันทึกข้อมูลสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/calibrations', checkApiAuth, async (req, res) => {
    try {
        const data = await Calibration.find().sort({ timestamp: -1, createdAt: -1 }).lean();
        res.status(200).json({ success: true, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 8. API: ระบบเชื่อมต่อข้อมูล MAM (mam_equipment & mam_tor_tasks)
// ==========================================

app.all('/api/mam/sync', async (req, res) => {
    try {
        const key = req.headers['x-api-key'] ||
                    (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '') ||
                    req.query.key;

        if (key !== CRON_SECRET && key !== ADMIN_KEY) {
            return res.status(401).json({ success: false, message: 'Forbidden: Invalid Sync Key' });
        }

        const year = req.query.year || req.body?.year || getThaiFiscalYear(new Date());
        const force = req.query.force === 'true' || req.body?.force === true;

        console.log(`[SYNC] เริ่มต้นซิงก์ข้อมูลจาก MAM สำหรับปีงบประมาณ ${year}...`);
        const result = await importFromMam(year, { force });
        res.status(200).json({
            success: true,
            message: `ซิงก์ข้อมูลจากระบบ MAM ปีสัญญา ${year} สำเร็จ`,
            result
        });
    } catch (error) {
        console.error('❌ MAM Sync Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/mam/sync-status', checkApiAuth, async (req, res) => {
    try {
        const meta = await MamSyncMeta.find().lean();
        const equipCount = await MamEquipment.countDocuments();
        const taskCount = await MamTorTask.countDocuments();
        res.status(200).json({
            success: true,
            collections: { mam_equipment: equipCount, mam_tor_tasks: taskCount },
            meta
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/mam/stations', checkApiAuth, async (req, res) => {
    try {
        const { basin } = req.query;
        const stationMap = {};

        const dbCount = await MamEquipment.estimatedDocumentCount();
        if (dbCount > 0) {
            const query = (basin && basin !== 'ALL') ? { basin: String(basin).trim() } : {};
            const docs = await MamEquipment.find(query, { station_id: 1, station_name: 1 }).lean();
            docs.forEach(item => {
                const stId = cleanExcelFormulaEscape(item.station_id);
                const stName = cleanExcelFormulaEscape(item.station_name);
                if (stId && !stationMap[stId]) {
                    stationMap[stId] = stName || stId;
                }
            });
        }

        res.status(200).json({ success: true, stations: stationMap });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/mam/equipment', checkApiAuth, async (req, res) => {
    try {
        const { basin, station, year, period } = req.query;
        if (!station) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสสถานี (station)' });
        }

        const rawStation = String(station).trim();
        const normStation = normalizeStationCode(rawStation);
        let mappedItems = [];
        let dataSource = 'mam_equipment';

        let dbDocs = await MamEquipment.find({
            $or: [
                { station_id: rawStation },
                { station_id: new RegExp(`^${ normStation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }`, 'i') }
            ]
        }).lean();

        if (basin && basin !== 'ALL' && dbDocs.length > 0) {
            const byBasin = dbDocs.filter(d => d.basin === basin);
            if (byBasin.length > 0) dbDocs = byBasin;
        }

        mappedItems = dbDocs.map(doc => ({
            id: cleanExcelFormulaEscape(doc.equipment_id || doc.id || ''),
            equipment_id: cleanExcelFormulaEscape(doc.equipment_id || doc.id || ''),
            station_id: cleanExcelFormulaEscape(doc.station_id || doc.station_code || ''),
            station_code: cleanExcelFormulaEscape(doc.station_id || doc.station_code || ''),
            station_name: cleanExcelFormulaEscape(doc.station_name || doc.station_id || ''),
            basin: cleanExcelFormulaEscape(doc.basin || ''),
            sub_basin: cleanExcelFormulaEscape(doc.sub_basin || '-'),
            location_point: cleanExcelFormulaEscape(doc.location_point || '-') || '-',
            category: cleanExcelFormulaEscape(doc.category || '-') || '-',
            brand: cleanExcelFormulaEscape(doc.brand || '-') || '-',
            model: cleanExcelFormulaEscape(doc.model || '-') || '-',
            serial_number: cleanExcelFormulaEscape(doc.serial_number || '-') || '-',
            mam_status_code: doc.mam_status_code !== undefined ? String(doc.mam_status_code).trim() : '',
            mam_status: cleanExcelFormulaEscape(doc.mam_status || 'ไม่ทราบ') || 'ไม่ทราบ',
            install_date: cleanExcelFormulaEscape(doc.install_date || '-') || '-',
            mam_remark: cleanExcelFormulaEscape(doc.mam_remark || ''),
            generated_at: doc.generated_at || ''
        }));

        let savedRecord = null;
        if (year && period) {
            const formattedPeriod = formatPeriodLabel(period);
            savedRecord = await EquipmentCheck.findOne({
                contractYear: String(year).trim(),
                period: { $in: [String(period).trim(), formattedPeriod, parsePeriodNumber(period)] },
                station_code: { $in: [rawStation, normStation] }
            }).sort({ timestamp: -1 }).lean();
        }

        res.status(200).json({
            success: true,
            source: dataSource,
            count: mappedItems.length,
            data: mappedItems,
            savedRecord: savedRecord
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/mam/equipment-check', checkApiAuth, async (req, res) => {
    try {
        const { contractYear, period, basin, station_code, station_name, items, inspector_note } = req.body;
        if (!station_code || !Array.isArray(items)) {
            return res.status(400).json({ success: false, message: 'ข้อมูลสถานีหรือรายการอุปกรณ์ไม่ครบถ้วน' });
        }

        const now = new Date();
        const yearVal = getThaiFiscalYear(now, contractYear);
        const periodLabel = formatPeriodLabel(period || 'งวดที่1');

        const recordData = {
            contractYear: yearVal,
            period: periodLabel,
            basin: basin || '-',
            station_code: String(station_code).trim(),
            station_name: station_name || station_code,
            items: items,
            inspector_note: inspector_note || '',
            timestamp: now
        };

        const saved = await EquipmentCheck.findOneAndUpdate(
            {
                contractYear: recordData.contractYear,
                period: recordData.period,
                station_code: recordData.station_code
            },
            recordData,
            { upsert: true, new: true }
        );

        res.status(200).json({
            success: true,
            message: 'บันทึกผลการตรวจสอบอุปกรณ์ประจำสถานีเรียบร้อยแล้ว',
            data: saved
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/mam/tor-tasks', checkApiAuth, async (req, res) => {
    try {
        const { year, period, basin, station } = req.query;
        if (!station) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสสถานี (station)' });
        }

        const contractYear = String(year || getThaiFiscalYear(new Date())).trim();
        const periodNum = parsePeriodNumber(period || '1');
        const periodLabel = formatPeriodLabel(periodNum);
        const rawStation = String(station).trim();
        const normStation = normalizeStationCode(rawStation);

        let rows = await MamTorTask.find({
            contract_year: contractYear,
            period: { $in: [periodNum, periodLabel] },
            $or: [
                { station_id: rawStation },
                { station_id: new RegExp(`^${ normStation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }`, 'i') }
            ]
        }).lean();

        let dataSource = 'mam_tor_tasks';

        // กรณีไม่มีใบงานใน mam_tor_tasks ของปีนั้น ให้สร้างโครงสร้างพื้นฐาน 3 ขั้นตอนเพื่อให้กรรมการยังสามารถตรวจสถานีถ่ายรูปและจับ GPS ได้
        if (!rows || rows.length === 0) {
            rows = [
                {
                    contract_year: contractYear,
                    period: periodNum,
                    basin: basin || '-',
                    station_id: rawStation,
                    station_name: rawStation,
                    task_type: 'general',
                    task_key: 'step_2',
                    task_name: 'ทำความสะอาดบริเวณสถานีและอุปกรณ์ (มาตรฐาน TOR)'
                },
                {
                    contract_year: contractYear,
                    period: periodNum,
                    basin: basin || '-',
                    station_id: rawStation,
                    station_name: rawStation,
                    task_type: 'general',
                    task_key: 'step_3',
                    task_name: 'สอบเทียบค่าระดับน้ำและน้ำฝน (มาตรฐาน TOR)'
                },
                {
                    contract_year: contractYear,
                    period: periodNum,
                    basin: basin || '-',
                    station_id: rawStation,
                    station_name: rawStation,
                    task_type: 'general',
                    task_key: 'step_4',
                    task_name: 'ตรวจสอบการทำงานของอุปกรณ์ประจำสถานี (มาตรฐาน TOR)'
                }
            ];
            dataSource = 'default_tor_template';
        }

        const cleanedRows = rows.map(r => {
            const obj = {};
            for (const k of Object.keys(r)) {
                if (k === '_id' || k === '__v') continue;
                obj[k] = cleanExcelFormulaEscape(r[k]);
            }
            return obj;
        });

        const first = cleanedRows[0];
        const generalTasks = cleanedRows
            .filter(r => r.task_type === 'general')
            .sort((a, b) => String(a.task_key).localeCompare(String(b.task_key)));
        const extraTasks = cleanedRows.filter(r => r.task_type === 'extra');

        const savedCheck = await TorCheck.findOne({
            contractYear: contractYear,
            period: { $in: [periodNum, periodLabel] },
            station_id: { $in: [rawStation, normStation] }
        }).sort({ timestamp: -1 }).lean();

        res.status(200).json({
            success: true,
            source: dataSource,
            summary: {
                contract_year: first.contract_year,
                period: first.period,
                period_label: formatPeriodLabel(first.period),
                basin: first.basin,
                sub_basin: first.sub_basin || '-',
                station_id: first.station_id,
                station_name: first.station_name,
                contract_id: first.contract_id || '-',
                contract_name: first.contract_name || '-',
                mam_record_id: first.mam_record_id || '-',
                job_status_code: first.job_status_code ?? '',
                job_status: first.job_status || '-',
                checked_in_at: first.checked_in_at || '',
                contractor_note: first.contractor_note || '',
                extra_works_status: first.extra_works_status || '-',
                generated_at: first.generated_at || ''
            },
            generalTasks,
            extraTasks,
            rows: cleanedRows,
            savedCheck
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// รองรับทั้ง JSON และ Multipart Form-Data (อัปโหลดรูปถ่ายสภาพสถานี 여러รูป + พิกัด GPS)
app.post('/api/mam/tor-check', checkApiAuth, upload.array('photos', 10), async (req, res) => {
    try {
        let {
            contractYear,
            period,
            basin,
            station_id,
            station_name,
            mam_record_id,
            evaluations,
            committee_note,
            inspector_note,
            lat,
            lon,
            existingPhotos
        } = req.body;

        // กรณีส่งมาแบบ FormData ค่า evaluations และ existingPhotos จะเป็น JSON String
        if (typeof evaluations === 'string') {
            try { evaluations = JSON.parse(evaluations); } catch (e) { evaluations = []; }
        }
        let parsedExistingPhotos = [];
        if (typeof existingPhotos === 'string' && existingPhotos.trim() !== '') {
            try { parsedExistingPhotos = JSON.parse(existingPhotos); } catch (e) { parsedExistingPhotos = []; }
        } else if (Array.isArray(existingPhotos)) {
            parsedExistingPhotos = existingPhotos;
        }

        if (!station_id || !Array.isArray(evaluations)) {
            return res.status(400).json({ success: false, message: 'ข้อมูลการตรวจรับงานตาม TOR ไม่ครบถ้วน' });
        }

        const now = new Date();
        const yearVal = getThaiFiscalYear(now, contractYear);
        const periodNum = parsePeriodNumber(period || '1');
        const periodLabel = formatPeriodLabel(periodNum);
        const cleanStationId = String(station_id).trim();

        // ค้นหาที่อยู่จากพิกัด GPS (Reverse Geocoding)
        let geoAddress = "ไม่ระบุพิกัด";
        if (lat && lon) {
            try {
                const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
                const response = await axios.get(osmUrl, { headers: { 'User-Agent': 'MA_Inspection_App' }, timeout: 5000 });
                if (response.data && response.data.display_name) geoAddress = response.data.display_name;
            } catch (e) {
                geoAddress = "หาที่อยู่ไม่เจอ";
            }
        }

        // อัปโหลดรูปภาพใหม่ขึ้น Google Drive (ถ้ามีการแนบรูปมา)
        const uploadedPhotos = [];
        if (req.files && req.files.length > 0) {
            const yearFolder = `ปีงบ_${yearVal}`;
            const targetFolderId = await getTargetFolderId([yearFolder, periodLabel, basin || 'ไม่ระบุลุ่มน้ำ', cleanStationId]);
            for (const file of req.files) {
                const uploaded = await uploadFileToFolder(file, targetFolderId);
                if (uploaded) uploadedPhotos.push(uploaded);
            }
        }

        // รวมรูปเดิมที่เคยอัปโหลดไว้ (ถ้ามี) กับรูปใหม่
        const prevDoc = await TorCheck.findOne({
            contractYear: yearVal,
            period: { $in: [periodNum, periodLabel] },
            station_id: cleanStationId
        }).lean();

        const basePhotos = parsedExistingPhotos.length > 0
            ? parsedExistingPhotos
            : (prevDoc && Array.isArray(prevDoc.photos) ? prevDoc.photos : []);

        const finalPhotos = [...basePhotos, ...uploadedPhotos];

        const recordData = {
            contractYear: yearVal,
            period: periodNum,
            period_label: periodLabel,
            basin: basin || '-',
            station_id: cleanStationId,
            station_name: station_name || cleanStationId,
            mam_record_id: mam_record_id || '',
            evaluations: evaluations,
            committee_note: committee_note || '',
            inspector_note: inspector_note || '',
            lat: lat || (prevDoc ? prevDoc.lat : '') || '',
            lon: lon || (prevDoc ? prevDoc.lon : '') || '',
            geoAddress: (lat && lon) ? geoAddress : ((prevDoc && prevDoc.geoAddress) ? prevDoc.geoAddress : 'ไม่ระบุพิกัด'),
            photos: finalPhotos,
            timestamp: now
        };

        const saved = await TorCheck.findOneAndUpdate(
            {
                contractYear: recordData.contractYear,
                period: { $in: [periodNum, periodLabel] },
                station_id: recordData.station_id
            },
            recordData,
            { upsert: true, new: true }
        );

        res.status(200).json({
            success: true,
            message: 'บันทึกผลการตรวจรับงานตาม TOR พิกัด GPS และภาพถ่ายสถานีเรียบร้อยแล้ว',
            data: saved,
            photos: finalPhotos
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 8.1 API สำหรับหน้ารายงานผลการตรวจสอบอุปกรณ์
// ==========================================
app.get('/api/mam/report/equipment', checkApiAuth, async (req, res) => {
    try {
        const { year, period, basin, station } = req.query;
        let query = {};

        if (year && year !== 'all' && year !== 'ALL') query.contractYear = String(year).trim();
        if (period && period !== 'all' && period !== 'ALL') {
            const pLabel = formatPeriodLabel(period);
            query.period = { $in: [String(period).trim(), pLabel, parsePeriodNumber(period)] };
        }
        if (basin && basin !== 'all' && basin !== 'ALL') query.basin = basin;
        if (station && station.trim() !== '' && station !== 'all' && station !== 'ALL') {
            query.station_code = new RegExp(station.trim(), 'i');
        }

        const data = await EquipmentCheck.find(query).sort({ timestamp: -1 }).lean();
        res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 8.2 API สำหรับหน้ารายงานผลการตรวจรับงาน TOR
// ==========================================
app.get('/api/mam/report/tor', checkApiAuth, async (req, res) => {
    try {
        const { year, period, basin, station } = req.query;
        let query = {};

        if (year && year !== 'all' && year !== 'ALL') query.contractYear = String(year).trim();
        if (period && period !== 'all' && period !== 'ALL') {
            const pNum = parsePeriodNumber(period);
            const pLabel = formatPeriodLabel(period);
            query.period = { $in: [pNum, pLabel] };
        }
        if (basin && basin !== 'all' && basin !== 'ALL') query.basin = basin;
        if (station && station.trim() !== '' && station !== 'all' && station !== 'ALL') {
            query.station_id = new RegExp(station.trim(), 'i');
        }

        const data = await TorCheck.find(query).sort({ timestamp: -1 }).lean();
        res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ===============================================
// 9. การสร้าง PDF (ดึงข้อมูลรวมศูนย์จาก TorCheck + EquipmentCheck + Calibration)
// ===============================================
app.get('/api/report/pdf', async (req, res) => {
    try {
        const year = req.query.year || 'all';
        const term = req.query.term || 'all';
        const basin = req.query.basin || 'all';
        const station = req.query.station || 'all';

        let calibQuery = {};
        let mamEquipQuery = {};
        
        if (term !== 'all') {
            calibQuery.myDataPeriod = new RegExp(term.replace(/\s+/g, '.*'), 'i'); 
        }
        if (basin !== 'all') {
            calibQuery.myData0 = basin;
            mamEquipQuery.basin = basin;
        }
        if (station !== 'all' && String(station).trim() !== '') {
            const stReg = new RegExp(String(station).trim(), 'i');
            calibQuery.myData1 = stReg;
            mamEquipQuery.station_id = stReg;
        }

        const [{ unifiedList, torList, equipList }, rawCalibData, mamEquipments] = await Promise.all([
            buildUnifiedInspections({ year, term, basin, station }),
            Calibration.find(calibQuery).lean(),
            MamEquipment.find(mamEquipQuery).lean()
        ]);

        let calibrationData = rawCalibData;
        if (year !== 'all' && year !== 'ALL') {
            calibrationData = calibrationData.filter(item => getThaiFiscalYear(item.timestamp || item.createdAt, item.contractYear) === String(year));
        }

        const fallbackEquipmentMap = svEquipmentMap || {
            clean: "ความสะอาด", pai: "ป้ายสถานี", power: "ระบบไฟฟ้า", power1: "หลอดไฟ",
            online: "เว็บไซต์ไม่ออนไลน์", wl: "ระดับน้ำ(1)", wl1: "ระดับน้ำ(แก้)", r: "ค่าน้ำฝน",
            sta_cpu: "CPU", sta_ai: "AI", sta_di: "DI", sta_do: "DO", sta_io: "IO", plc: "PLC",
            sta_m1: "Modem 1", sta_m2: "Modem 2", sta_p1: "Power 1", sta_p2: "Power 2",
            sta_cctv1: "CCTV1", sta_cctv2: "CCTV2", sta_r: "Rain Gauge", sta_s: "Surge",
            sta_wl: "WL(bubble)", sta_tro: "ท่อลม", sta_gass: "ถังแก๊ส", sta_wl1: "WL(Radar)",
            sta_wl2: "WL(float)", sta_saling: "สายสลิง", b2: "แบตเตอรี่", 
            sta1: "แผ่นวัดน้ำ(บวก)", sta2: "แผ่นวัดน้ำ(ลบ)", pole2: "เสาวัดน้ำ"
        };
        const fixThaiVowels = (text) => text ? String(text).replace(/ำ/g, 'ํา').replace(/ํ/g, 'ํ') : '';

        const termLabel = (year !== 'all' && year !== 'ALL') ? `${term} (ปีงบประมาณ ${year})` : term;

        await generateInspectionPDF(
            unifiedList, 
            calibrationData, 
            termLabel, 
            basin, 
            res, 
            fallbackEquipmentMap, 
            svHardcodedBasins || [], 
            fetchImageBufferDirectly, 
            extractDriveId, 
            fixThaiVowels,
            {
                equipmentChecks: equipList,
                torChecks: torList,
                mamEquipments,
                contractYear: (year !== 'all' && year !== 'ALL') ? String(year) : getThaiFiscalYear(new Date())
            }
        );

    } catch (error) {
        console.error('Error generating PDF:', error);
        if (!res.headersSent) res.status(500).send('เกิดข้อผิดพลาดในการสร้าง PDF: ' + error.message);
    }
});

// ==========================================
// 10. Webhook (สำหรับทีมรับจ้าง MAM)
// ==========================================
app.post('/webhook/update-station', async (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== process.env.WEBHOOK_SECRET) {
            return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API Key' });
        }
        const now = new Date();
        const payload = { 
            ...req.body, 
            timestamp: now,
            contractYear: getThaiFiscalYear(now, req.body.contractYear)
        };
        const newRecord = new Inspection(payload);
        await newRecord.save();
        res.status(200).json({ success: true, message: 'Webhook received and processed' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.use((err, req, res, next) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์รูปใหญ่เกิน 15 MB' : err.message;
    res.status(400).json({ success: false, message: msg });
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});