// ต้องติดตั้งแพ็กเกจเหล่านี้ก่อน: npm install express mongoose cors axios dotenv multer
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.static(path.join(__dirname, 'frontend')));

app.use(cors()); 
app.use(express.json());
app.use('/uploads', express.static('uploads')); 

// ==========================================
// 1. Database Setup
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ma_inspection';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.log('❌ MongoDB Connection Error:', err));

const InspectionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  saya: String, code: String, id_name: String, name_id: String, install_status: String,
  clean: String, pai: String, power: String, power1: String, online: String,
  wl: String, wl1: String, r: String,
  sta_cpu: String, sta_ai: String, sta_di: String, sta_do: String, sta_io: String, plc: String,
  sta_m1: String, sta_m2: String, 
  sta_p1: String, sta_p2: String, sta_cctv1: String, sta_cctv2: String, sta_r: String, sta_s: String,
  sta_wl: String, sta_tro: String, sta_gass: String, sta_wl1: String, sta_wl2: String, sta_saling: String,
  b1: { type: Number, default: 0 }, b2: { type: Number, default: 0 },
  sta1: { type: Number, default: 0 }, sta2: { type: Number, default: 0 },
  pole1: { type: Number, default: 0 }, pole2: { type: Number, default: 0 },
  note: String, note2: String, lat: Number, lon: Number, geoAddress: String
});

const Inspection = mongoose.model('Inspection', InspectionSchema);

const CalibrationSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  myDataPeriod: String, myData0: String, myData1: String, myData2: String, myData3: String,
  myData4: String, myFileUrl: String, myData5: String, myFileUrl2: String, myData6: String, myFileUrl3: String, myData7: String,
  myData8: String, myFileUrl4: String, myData9: String, myFileUrl5: String, myData10: String, myFileUrl6: String,
  myData11: String, myData12: String, myFileUrl7: String, myData13: String, myFileUrl8: String, myData14: String
});

const Calibration = mongoose.model('Calibration', CalibrationSchema);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const period = req.body.myDataPeriod || 'Unknown_Period';
    const basin = req.body.myData0 || 'Unknown_Basin';
    const station = req.body.myData1 || 'Unknown_Station';
    const dir = `./uploads/${period}/${basin}/${station}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// ==========================================
// 2. ข้อมูลกลุ่มลุ่มน้ำและสถานี
// ==========================================
// (ดึงมาจากโค้ดเก่าได้เลยเพื่อความกระชับ)
const stationsData = { /* ข้อมูลลุ่มน้ำ */ };

// ==========================================
// 3. Backend API Endpoints
// ==========================================

// [GET] ดึงข้อมูลรายชื่อสถานี (สำหรับ Autocomplete)
app.get('/api/stations', (req, res) => {
  res.status(200).json(stationsData);
});

// [POST] บันทึกข้อมูลตรวจสอบสถานี
app.post('/api/inspection', async (req, res) => {
  try {
    const formData = req.body;
    let geoAddress = "ไม่ระบุพิกัด";
    if (formData.lat && formData.lon) {
      try {
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;
        if (apiKey) {
          const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${formData.lat},${formData.lon}&language=th&key=${apiKey}`);
          if (response.data.status === 'OK' && response.data.results.length > 0) geoAddress = response.data.results[0].formatted_address;
        } else {
          const response = await axios.get(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${formData.lat}&lon=${formData.lon}&zoom=18&addressdetails=1`, { headers: { 'User-Agent': 'MA_Inspection_App' } });
          if (response.data && response.data.display_name) geoAddress = response.data.display_name;
        }
      } catch (e) { geoAddress = "หาที่อยู่ไม่เจอ (" + e.message + ")"; }
    }
    formData.geoAddress = geoAddress;

    const newInspection = new Inspection(formData);
    await newInspection.save();
    res.status(201).json({ success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// [POST] บันทึกผลการสอบเทียบสถานี
app.post('/api/calibration', upload.any(), async (req, res) => {
  try {
    const formData = req.body;
    const files = req.files; 
    if (files && files.length > 0) {
      files.forEach(file => {
        const filePath = file.path.replace(/\\/g, '/'); 
        if (file.fieldname === 'myFile') formData.myFileUrl = filePath;
        if (file.fieldname === 'myFile2') formData.myFileUrl2 = filePath;
        if (file.fieldname === 'myFile3') formData.myFileUrl3 = filePath;
        if (file.fieldname === 'myFile4') formData.myFileUrl4 = filePath;
        if (file.fieldname === 'myFile5') formData.myFileUrl5 = filePath;
        if (file.fieldname === 'myFile6') formData.myFileUrl6 = filePath;
        if (file.fieldname === 'myFile7') formData.myFileUrl7 = filePath;
        if (file.fieldname === 'myFile8') formData.myFileUrl8 = filePath;
      });
    }
    const newCalibration = new Calibration(formData);
    await newCalibration.save();
    res.status(201).json({ success: true, message: `รายงานผลสอบเทียบสถานี ${formData.myData2} บันทึกเรียบร้อยแล้ว` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// [GET] 👉 ดึงข้อมูลการตรวจสอบทั้งหมด (สำหรับให้หน้าแผนที่และหน้ารายงานดึงไปแสดงผล)
app.get('/api/inspections', async (req, res) => {
    try {
      const inspections = await Inspection.find().sort({ timestamp: -1 });
      res.status(200).json({ success: true, data: inspections });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
});

// [GET] 👉 ดึงข้อมูลการสอบเทียบทั้งหมด (สำหรับหน้ารายงานผลสอบเทียบ)
app.get('/api/calibrations', async (req, res) => {
    try {
      const calibrations = await Calibration.find().sort({ timestamp: -1 });
      res.status(200).json({ success: true, data: calibrations });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Server running on port ${PORT}`);
});