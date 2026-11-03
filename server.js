require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// เรียกใช้ไฟล์ pdfGenerator.js (ตรวจสอบชื่อฟังก์ชันในไฟล์ของคุณด้วยว่าชื่อ generateInspectionPDF หรือไม่)
const { generateInspectionPDF } = require('./pdfGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ma_inspection')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const InspectionSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Inspection = mongoose.model('Inspection', InspectionSchema);

const CalibrationSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Calibration = mongoose.model('Calibration', CalibrationSchema);

app.post('/api/inspection', upload.array('photos', 10), async (req, res) => {
    try {
        const formData = req.body;
        const photos = [];
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                photos.push({ thumbnailUrl: `/uploads/${file.filename}`, webViewLink: `/uploads/${file.filename}` });
            });
        }
        formData.photos = photos;
        const newInspection = new Inspection(formData);
        await newInspection.save();
        res.status(200).json({ success: true, message: 'Saved successfully' });
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
        res.status(200).json({ success: true, message: 'Saved successfully' });
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
// การสร้าง PDF - แก้ไขชื่อฟังก์ชันและส่งตัวแปรสำรอง
// ===============================================
app.get('/api/report/pdf', async (req, res) => {
    try {
        const term = req.query.term || 'all';
        const basin = req.query.basin || 'all';

        let query = {};
        if (term !== 'all') {
            query.saya = new RegExp(term.replace(/\s+/g, '.*'), 'i'); 
        }
        if (basin !== 'all') query.code = basin;

        const inspectionData = await Inspection.find(query).lean();

        // ฝังตัวแปรสำรองไว้ใน Backend เลย ป้องกันไฟล์อื่นสูญหาย
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

        // ถ้าโค้ดเก่าใน pdfGenerator.js ของคุณชื่อว่า generateInspectionPDF
        await generateInspectionPDF(
            inspectionData, 
            [], 
            term, 
            basin, 
            res, 
            fallbackEquipmentMap, 
            [], 
            null, 
            null, 
            fixThaiVowels
        );

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).send('เกิดข้อผิดพลาดในการสร้าง PDF: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});