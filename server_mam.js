// นำเข้าโมดูลที่จำเป็น
const axios = require('axios');
require('dotenv').config(); // เพื่อให้ฝั่ง MAM เรียกใช้ .env ได้ด้วย (ถ้ามี)

// ==========================================
// 1. ตั้งค่าการเชื่อมต่อไปยังเซิร์ฟเวอร์หลัก (ฝั่งกรรมการ)
// ==========================================
// หากทดสอบในเครื่องตัวเอง (Local) ให้ใช้ localhost
const TARGET_URL = 'http://localhost:3000/webhook/update-station';

// ⚠️ เมื่อนำเซิร์ฟเวอร์หลักขึ้น Render แล้ว ให้เปลี่ยนเป็น URL ของ Render แทน เช่น:
// const TARGET_URL = 'https://ma-inspection-api.onrender.com/webhook/update-station';

// รหัสลับที่ต้องตรงกับ WEBHOOK_SECRET ในไฟล์ .env ของเซิร์ฟเวอร์หลัก
const API_KEY = process.env.WEBHOOK_SECRET || 'MAM_Secret_2026';

// ==========================================
// 2. ฟังก์ชันจำลองการส่งข้อมูลเมื่อช่างทำงานเสร็จ (หรือเมื่อมีการอนุมัติ)
// ==========================================
async function triggerWebhook() {
  // โครงสร้าง Payload ที่ปรับให้ตรงกับแอปฝั่งกรรมการ (Inspection Schema)
  const payload = {
    // ข้อมูลทั่วไปของสถานี
    saya: "งวดที่2",
    code: "เพชรบุรี-ประจวบคีรีขันธ์",
    id_name: "TPR.2",
    name_id: "อบต.ห้วยสัตว์ใหญ่",
    install_status: "ปกติ",
    lat: 12.534210,
    lon: 99.645320,

    // สถานะตรวจสอบทั่วไปและผลสอบเทียบ (P = ผ่าน/ปกติ, O = ไม่ผ่าน/ชำรุด)
    clean: "P",
    pai: "P",
    power: "P",
    power1: "P",
    online: "P",

    // สถานะอุปกรณ์ RTU และภาคสนาม
    sta_cpu: "P",
    sta_ai: "P",
    plc: "P",
    sta_m1: "O", // ตัวอย่าง: Modem 1 ชำรุด
    sta_m2: "O", // ตัวอย่าง: Modem 2 ชำรุด
    sta_p1: "P",
    sta_p2: "P",
    
    // หมายเหตุ
    note: "[MAM Webhook] สถานะอนุมัติข้อมูลจากผู้รับจ้างเรียบร้อยแล้ว",
    note2: "พบ Modem ชำรุดทั้ง 2 ตัว โปรดดำเนินการแจ้งซ่อม"
  };

  try {
    console.log(`⏳ [MAM] กำลังส่งข้อมูล Webhook สำหรับสถานี ${payload.id_name}...`);
    
    const response = await axios.post(TARGET_URL, payload, {
      headers: { 
        'Content-Type': 'application/json', 
        'x-api-key': API_KEY // แนบรหัสลับเพื่อยืนยันตัวตน
      }
    });

    console.log('✅ [MAM] ส่งข้อมูลสำเร็จ! การตอบกลับจากเซิร์ฟเวอร์หลัก:');
    console.log(response.data);

  } catch (error) {
    console.error('❌ [MAM] เกิดข้อผิดพลาดในการส่ง Webhook:');
    if (error.response) {
      // กรณีเซิร์ฟเวอร์หลักตอบกลับด้วย Error (เช่น รหัส API_KEY ผิด)
      console.error(`Status Code: ${error.response.status}`);
      console.error(`Message: ${JSON.stringify(error.response.data)}`);
    } else {
      // กรณีเชื่อมต่อเซิร์ฟเวอร์หลักไม่ได้เลย (เช่น ลืมรัน server.js)
      console.error(error.message);
    }
  }
}

// ==========================================
// 3. สั่งให้ทำงานทันทีเมื่อรันไฟล์นี้ (เพื่อทดสอบ)
// ==========================================
triggerWebhook();