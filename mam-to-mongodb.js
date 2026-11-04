const axios = require('axios');
const { parse } = require('csv-parse/sync');
const { MongoClient } = require('mongodb');

// ตั้งค่าระบบ MAM API & Authentication
const MAM_API_URL = 'https://mam-app.com';
const API_KEY = 'YOUR_MAM_API_KEY'; // หรือ Bearer Token ตามข้อตกลง

// ตั้งค่า MongoDB ของคุณ
const MONGO_URI = 'mongodb://localhost:27017';
const MONGO_DB_NAME = 'royal_irrigation_db'; // ตัวอย่างชื่อฐานข้อมูลชลประทาน
const COLLECTION_NAME = 'station_tasks';

async function syncMamDataToMongo() {
  let mongoClient;

  try {
    console.log('--- เริ่มต้นกระบวนการซิงค์ข้อมูลจาก MAM ---');
    
    // 1. กำหนด Query Parameters เพื่อกรองข้อมูลไม่ให้ดาวน์โหลดไฟล์ใหญ่เกินไป
    // สามารถปรับเปลี่ยนตัวแปรเหล่านี้แบบ Dynamic ได้ตามการใช้งาน
    const queryParams = {
      year: '2569',
      period: '2',
      // basin: 'เจ้าพระยา',  // เปิดใช้งานหากต้องการกรองรายลุ่มน้ำ
      // station_id: 'TC.55' // เปิดใช้งานหากต้องการกรองรายสถานี
    };

    console.log('กำลังเรียกข้อมูลจากระบบ MAM API...');
    
    // 2. เรียกดึงข้อมูลในรูปแบบ CSV
    const response = await axios.get(MAM_API_URL, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`, // หรือ 'X-API-Key': API_KEY ตามที่ตกลงไว้
        'Accept': 'text/csv'
      },
      params: queryParams,
      responseType: 'text' // รับค่ากลับมาเป็นข้อความ CSV
    });

    console.log('ดาวน์โหลดข้อมูล CSV สำเร็จ กำลังแปลงข้อมูล...');

    // 3. แปลงข้อมูลจาก CSV String ให้กลายเป็น Array of Objects (JSON)
    const records = parse(response.data, {
      columns: true,          // ใช้แถวแรกของ CSV เป็นชื่อ Key/คอลัมน์
      skip_empty_lines: true,
      trim: true              // ตัดช่องว่างหน้า-หลังข้อความ
    });

    console.log(`แปลงข้อมูลสำเร็จ พบทั้งหมด ${records.length} แถว`);

    // 4. เชื่อมต่อ MongoDB
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    // 5. นำข้อมูลเข้า MongoDB ด้วยวิธี Upsert รายสถานี + งวดงาน
    // อ้างอิง รหัสสถานี (Station ID) และปีสัญญา/งวดงาน เป็นหลักในการเช็คตัวซ้ำ
    for (const record of records) {
      
      // ดึงค่าตามชื่อคอลัมน์ที่ตกลงกันไว้ (แก้ไขชื่อคอลัมน์ให้ตรงตามไฟล์จริงภายหลัง)
      const stationId = record['รหัสสถานี'] || record['station_id']; 
      const period = record['งวดงาน'] || record['period'];
      const year = record['ปีสัญญางานma'] || record['contract_year'];

      if (!stationId) continue; // ข้ามหากไม่มีรหัสสถานี

      // โครงสร้างเอกสาร JSON ที่จะเก็บใน MongoDB
      const mongoDocument = {
        station_id: stationId,
        station_name: record['ชื่อสถานี'],
        basin: record['ลุ่มน้ำ'],
        contract_year: year,
        period: period,
        inspection_date: record['วันที่ผู้รับจ้างเข้าปฏิบัติงาน'],
        
        // รวบรวมงานประจำ (ข้อ 1-3)
        regular_tasks: {
          cleaning: record['การทำความสะอาด'],
          calibration: record['การสอบเทียบ'],
          maintenance: record['การบำรุงรักษา']
        },
        
        // รวบรวมงานพิเศษตามลุ่มน้ำ (TOR ข้อ 4 งวดที่ 2)
        // สามารถเก็บเป็น Object ยืดหยุ่นได้เลยตามสไตล์ NoSQL
        special_tasks: {
          task_4_1_amount: record['task_4_1_amount'] || 0,
          task_4_2_amount: record['task_4_2_amount'] || 0,
          unit: record['หน่วย'] || null
        },
        
        updated_at: new Date()
      };

      // ทำการ Upsert: ค้นหาด้วย station_id + contract_year + period
      // ถ้ามีอยู่แล้วจะอัปเดตข้อมูลล่าสุดซ้ำลงไป ถ้ายังไม่มีจะเพิ่มเอกสารใหม่
      await collection.updateOne(
        { 
          station_id: stationId, 
          contract_year: year, 
          period: period 
        },
        { $set: mongoDocument },
        { upsert: true }
      );
    }

    console.log('--- ซิงค์ข้อมูลลง MongoDB สำเร็จเรียบร้อย! ---');

  } catch (error) {
    console.error('เกิดข้อผิดพลาดในการซิงค์ข้อมูล:', error.message);
  } finally {
    if (mongoClient) await mongoClient.close();
  }
}

// ตัวอย่างการสั่งรันสคริปต์นี้อัตโนมัติด้วย node-cron
// แนะนำให้ตั้งเวลาการรันไม่ถี่เกินไป เช่น รันทุก 1 ชั่วโมง หรือวันละครั้งตามความจำเป็น เพื่อไม่ให้ชน Rate Limit ของระบบ MAM
const cron = require('node-cron');
cron.schedule('0 * * * *', () => { // รันทุกๆ ต้นชั่วโมง
  syncMamDataToMongo();
});
