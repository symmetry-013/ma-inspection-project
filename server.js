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

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend')));

// ==========================================
// 1. ตั้งค่า File Upload (ใช้ Memory Storage เพื่อส่งต่อเข้า Drive)
// ==========================================
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => /^image\//i.test(file.mimetype) ? cb(null, true) : cb(new Error('รองรับเฉพาะรูปภาพ')),
    limits: { fileSize: 15 * 1024 * 1024, files: 10 }
});

// ==========================================
// 2. Database Setup (MongoDB)
// ==========================================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ma_inspection')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const InspectionSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Inspection = mongoose.model('Inspection', InspectionSchema);

const CalibrationSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Calibration = mongoose.model('Calibration', CalibrationSchema);

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
const ADMIN_KEY = process.env.ADMIN_KEY || 'MAM_Secret_2026'; 
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1YYa-Cu1vu-Ei9a0qpJMFOTJxmQPN2srv'; // 📌 โฟลเดอร์หลักที่คุณระบุ

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
    if(oauth2Client) {
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

// โหลด Token เมื่อต่อ DB สำเร็จ
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
                console.warn('⚠️ Google Drive ยังไม่ได้เชื่อมต่อ → กรุณาเปิด /auth/google?key=<ADMIN_KEY> เพื่อล็อกอินครั้งแรก');
            }
        } catch (e) {
            console.error('❌ โหลด Google token ไม่สำเร็จ:', e.message);
        }
    }
});

// เส้นทางสำหรับล็อกอิน Google Drive (ต้องเข้าผ่าน URL)
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
            res.send(`✅ เชื่อมต่อ Google Drive สำเร็จด้วยบัญชี ${about.data.user.emailAddress} — ปิดหน้านี้ได้เลยและระบบพร้อมใช้งาน`);
        } else {
            res.status(400).send('ไม่ได้รับ refresh_token — กรุณาไปที่ Google Account เพื่อลบสิทธิ์ของแอพนี้ แล้วล็อกอินใหม่');
        }
    } catch (e) {
        res.status(500).send('เชื่อมต่อไม่สำเร็จ: ' + e.message);
    }
});

// ==========================================
// 4. ฟังก์ชันจัดการโฟลเดอร์และอัปโหลดรูปภาพ
// ==========================================
const folderCache = new Map();

// ฟังก์ชันสร้าง/ค้นหาโฟลเดอร์แบบซ้อนกัน
async function getTargetFolderId(folderPathArray) {
    if (!driveAuthorized) return null;
    let currentParentId = GOOGLE_DRIVE_FOLDER_ID;

    for (const folderName of folderPathArray) {
        if (!folderName || folderName.trim() === '' || folderName === 'ไม่ระบุ' || folderName === 'null') continue;

        const safeFolderName = folderName.trim();
        const cacheKey = `${currentParentId}_${safeFolderName}`;
        
        if (folderCache.has(cacheKey)) {
            currentParentId = folderCache.get(cacheKey);
            continue;
        }

        try {
            const query = `mimeType='application/vnd.google-apps.folder' and name='${safeFolderName}' and '${currentParentId}' in parents and trashed=false`;
            const res = await drive.files.list({ q: query, fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true });

            if (res.data.files && res.data.files.length > 0) {
                currentParentId = res.data.files[0].id;
                folderCache.set(cacheKey, currentParentId);
            } else {
                // สร้างโฟลเดอร์ใหม่
                const folder = await drive.files.create({
                    requestBody: { name: safeFolderName, mimeType: 'application/vnd.google-apps.folder', parents: [currentParentId] },
                    fields: 'id', supportsAllDrives: true
                });
                
                // แชร์ให้คนที่มีลิงก์ดูได้
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

// ฟังก์ชันอัปโหลดไฟล์ขึ้น Google Drive
async function uploadFileToFolder(file, targetFolderId) {
    if (!driveAuthorized) return null;
    try {
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        // ตั้งชื่อไฟล์ใหม่ให้ไม่ซ้ำ
        const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        
        const response = await drive.files.create({
            requestBody: { name: safeName, parents: targetFolderId ? [targetFolderId] : [GOOGLE_DRIVE_FOLDER_ID] },
            media: { mimeType: file.mimetype, body: bufferStream },
            fields: 'id, name, webViewLink',
            supportsAllDrives: true,
        });

        // เปิดสิทธิ์ให้คนนอกดูรูปได้
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
            supportsAllDrives: true,
        });

        const fileId = response.data.id;
        return {
            fileId: fileId,
            name: response.data.name,
            webViewLink: response.data.webViewLink,
            thumbnailUrl: `https://drive.google.com/uc?export=view&id=${fileId}` // ลิงก์ตรงสำหรับดูภาพ
        };
    } catch (error) {
        console.error('❌ Google Drive Upload API Error:', error.message);
        return null;
    }
}

// ฟังก์ชันดึงภาพตรงๆ มาให้ PDF วาด
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
// 5. API: รับข้อมูลตรวจสอบสถานี (Inspection)
// ==========================================
app.post('/api/inspection', upload.array('photos', 10), async (req, res) => {
    try {
        const formData = req.body;
        const photos = [];
        
        const term = formData.saya || 'ไม่ระบุงวด';
        const basin = formData.code || 'ไม่ระบุลุ่มน้ำ';
        const station = formData.id_name || 'ไม่ระบุสถานี';
        
        // 🌟 1. สร้างโฟลเดอร์แบบ งวดที่ > ลุ่มน้ำ > รหัสสถานี
        const targetFolderId = await getTargetFolderId([term, basin, station]);

        if (req.files && req.files.length > 0) {
            // 🌟 2. อัปโหลดภาพเข้า Google Drive
            for (const file of req.files) {
                const uploaded = await uploadFileToFolder(file, targetFolderId);
                if (uploaded) photos.push(uploaded);
            }
        }
        
        formData.photos = photos;
        const newInspection = new Inspection(formData);
        await newInspection.save();
        
        res.status(200).json({ success: true, message: 'บันทึกข้อมูลสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/inspections', async (req, res) => {
    try {
        const data = await Inspection.find().sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 6. API: รับข้อมูลสอบเทียบ (Calibration)
// ==========================================
const calibrationUploadFields = [
    { name: 'myFile', maxCount: 1 }, { name: 'myFile2', maxCount: 1 },
    { name: 'myFile3', maxCount: 1 }, { name: 'myFile4', maxCount: 1 },
    { name: 'myFile5', maxCount: 1 }, { name: 'myFile6', maxCount: 1 },
    { name: 'myFile7', maxCount: 1 }, { name: 'myFile8', maxCount: 1 }
];

app.post('/api/calibration', upload.fields(calibrationUploadFields), async (req, res) => {
    try {
        const formData = req.body;
        
        const term = formData.myDataPeriod || 'ไม่ระบุงวด';
        const basin = formData.myData0 || 'ไม่ระบุลุ่มน้ำ';
        const station = formData.myData1 || 'ไม่ระบุสถานี';
        
        // 🌟 1. สร้างโฟลเดอร์แบบ งวดที่ > ลุ่มน้ำ > รหัสสถานี
        const targetFolderId = await getTargetFolderId([term, basin, station]);

        const fileFields = ['myFile', 'myFile2', 'myFile3', 'myFile4', 'myFile5', 'myFile6', 'myFile7', 'myFile8'];
        
        // 🌟 2. อัปโหลดภาพเข้า Google Drive (ใช้ Promise.all ให้ไวขึ้น)
        await Promise.all(fileFields.map(async (field, index) => {
            const urlField = index === 0 ? 'myFileUrl' : `myFileUrl${index + 1}`;
            
            if (req.files[field] && req.files[field].length > 0) {
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

app.get('/api/calibrations', async (req, res) => {
    try {
        const data = await Calibration.find().sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ===============================================
// 7. การสร้าง PDF 
// ===============================================
app.get('/api/report/pdf', async (req, res) => {
    try {
        const term = req.query.term || 'all';
        const basin = req.query.basin || 'all';

        let query = {};
        let calibQuery = {};
        
        if (term !== 'all') {
            query.saya = new RegExp(term.replace(/\s+/g, '.*'), 'i'); 
            calibQuery.myDataPeriod = new RegExp(term.replace(/\s+/g, '.*'), 'i'); 
        }
        if (basin !== 'all') {
            query.code = basin;
            calibQuery.myData0 = basin;
        }

        const inspectionData = await Inspection.find(query).lean();
        const calibrationData = await Calibration.find(calibQuery).lean();

        const fallbackEquipmentMap = {
            clean: "ความสะอาด", pai: "ป้ายสถานี", power: "ระบบไฟฟ้า", power1: "หลอดไฟ",
            online: "เว็บไซต์ไม่ออนไลน์", wl: "ระดับน้ำ(1)", wl1: "ระดับน้ำ(แก้)", r: "ค่าน้ำฝน",
            sta_cpu: "CPU", sta_ai: "AI", sta_di: "DI", sta_do: "DO", sta_io: "IO", plc: "PLC",
            sta_m1: "Modem 1", sta_m2: "Modem 2", sta_p1: "Power 1", sta_p2: "Power 2",
            sta_cctv1: "CCTV1", sta_cctv2: "CCTV2", sta_r: "Rain Gauge", sta_s: "Surge",
            sta_wl: "WL(bubble)", sta_tro: "ท่อลม", sta_gass: "ถังแก๊ส", sta_wl1: "WL(Radar)",
            sta_wl2: "WL(float)", sta_saling: "สายสลิง", b2: "แบตเตอรี่", sta2: "แผ่นวัดน้ำ", pole2: "เสาวัดน้ำ"
        };
        const fixThaiVowels = (text) => text || '';

        // ส่ง fetchImageBufferDirectly ให้ PDF ใช้งานดึงรูปวาดลงกระดาษ
        await generateInspectionPDF(
            inspectionData, 
            calibrationData, 
            term, 
            basin, 
            res, 
            fallbackEquipmentMap, 
            [], 
            fetchImageBufferDirectly, 
            null, 
            fixThaiVowels
        );

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).send('เกิดข้อผิดพลาดในการสร้าง PDF: ' + error.message);
    }
});

// ==========================================
// 8. Webhook (สำหรับทีมรับจ้าง)
// ==========================================
app.post('/webhook/update-station', async (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== process.env.WEBHOOK_SECRET) {
            return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API Key' });
        }
        const payload = req.body;
        const newRecord = new Inspection(payload);
        await newRecord.save();
        res.status(200).json({ success: true, message: 'Webhook received and processed' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});