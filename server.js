require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { generateSummaryPDF } = require('./pdfGenerator');
const name_sv = require('./name_sv'); 

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. ตั้งค่า Middleware และเชื่อมต่อหน้าเว็บ (Frontend)
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// สั่งให้ระบบเปิดโฟลเดอร์ frontend ให้คนภายนอกเข้าถึงไฟล์ HTML/JS ได้
app.use(express.static(path.join(__dirname, 'frontend')));

// เมื่อผู้ใช้เข้า URL หน้าแรก (/) ให้แสดงไฟล์ index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// สร้างโฟลเดอร์ uploads หากยังไม่มี เพื่อเก็บรูปภาพ
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// ==========================================
// 2. ตั้งค่า Multer สำหรับอัปโหลดไฟล์รูปภาพ
// ==========================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ==========================================
// 3. เชื่อมต่อ MongoDB และสร้าง Schema
// ==========================================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ma_inspection')
  .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ'))
  .catch(err => console.error('❌ ข้อผิดพลาดในการเชื่อมต่อ MongoDB:', err));

const InspectionSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Inspection = mongoose.model('Inspection', InspectionSchema);

const CalibrationSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Calibration = mongoose.model('Calibration', CalibrationSchema);

// ==========================================
// 4. API Endpoints - สำหรับ Inspection (ตรวจงาน MA)
// ==========================================
app.post('/api/inspection', upload.array('photos', 10), async (req, res) => {
    try {
        const formData = req.body;
        const photos = [];
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                photos.push({
                    thumbnailUrl: `/uploads/${file.filename}`,
                    webViewLink: `/uploads/${file.filename}`
                });
            });
        }
        formData.photos = photos;

        const newInspection = new Inspection(formData);
        await newInspection.save();
        
        res.status(200).json({ success: true, message: 'บันทึกข้อมูลการตรวจสอบสำเร็จ' });
    } catch (error) {
        console.error('Error saving inspection:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/inspections', async (req, res) => {
    try {
        const data = await Inspection.find().sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: data });
    } catch (error) {
        console.error('Error fetching inspections:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 5. API Endpoints - สำหรับ Calibration (สอบเทียบ)
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
        const fileFields = ['myFile', 'myFile2', 'myFile3', 'myFile4', 'myFile5', 'myFile6', 'myFile7', 'myFile8'];
        fileFields.forEach((field, index) => {
            const urlField = index === 0 ? 'myFileUrl' : `myFileUrl${index + 1}`;
            if (req.files[field] && req.files[field].length > 0) {
                formData[urlField] = `uploads/${req.files[field][0].filename}`;
            } else {
                formData[urlField] = ''; 
            }
        });

        const newCalibration = new Calibration(formData);
        await newCalibration.save();
        
        res.status(200).json({ success: true, message: 'บันทึกข้อมูลสอบเทียบสำเร็จ' });
    } catch (error) {
        console.error('Error saving calibration:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/calibrations', async (req, res) => {
    try {
        const data = await Calibration.find().sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: data });
    } catch (error) {
        console.error('Error fetching calibrations:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 6. API Endpoint - สำหรับสร้าง PDF
// ==========================================
app.get('/api/report/pdf', async (req, res) => {
    try {
        const term = req.query.term || 'all';
        const basin = req.query.basin || 'all';

        let query = {};
        if (term !== 'all') query.saya = term.replace(/\s+/g, ''); 
        if (basin !== 'all') query.code = basin;

        const inspectionData = await Inspection.find(query).lean();
        await generateSummaryPDF(inspectionData, term, basin, res);

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).send('เกิดข้อผิดพลาดในการสร้าง PDF: ' + error.message);
    }
});

// ==========================================
// 7. Webhook Endpoint - รับข้อมูลจาก server_mam.js 
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
        console.error('Webhook processing error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// เริ่มต้นการทำงาน Server
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📁 Upload directory is ready at: ${uploadDir}`);
});