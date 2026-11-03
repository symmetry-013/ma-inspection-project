const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// =======================================================
// ฟังก์ชันช่วยโหลดรูปภาพผ่าน URL ด้วย Native Node.js
// =======================================================
const fetchImageFromUrl = (url) => {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            // ถ้าติด Redirect (Google Drive ชอบเด้งไปลิงก์อื่น) ให้ตามลิงก์ไป
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirUrl = res.headers.location;
                if (!redirUrl.startsWith('http')) redirUrl = new URL(redirUrl, url).href;
                resolve(fetchImageFromUrl(redirUrl));
            } 
            // ถ้าโหลดสำเร็จ คืนค่าข้อมูลรูปภาพ (Buffer) กลับไปให้ PDF วาด
            else if (res.statusCode === 200) {
                const data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => resolve(Buffer.concat(data)));
            } else {
                resolve(null);
            }
        }).on('error', () => resolve(null));
    });
};

async function generateInspectionPDF(inspections, calibrations, term, basin, res, equipmentMap, hardcodedBasins, _fetchImageBufferDirectly, _extractDriveId, fixThaiVowels) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const fontRegular = path.join(__dirname, 'fonts', 'Prompt-Regular.ttf');
    const fontBold = path.join(__dirname, 'fonts', 'Prompt-Bold.ttf');
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Report_${encodeURIComponent(basin)}_${encodeURIComponent(term)}.pdf`);
    doc.pipe(res);

    if (fs.existsSync(fontRegular) && fs.existsSync(fontBold)) {
      doc.registerFont('ThaiRegular', fontRegular);
      doc.registerFont('ThaiBold', fontBold);
    } else {
      doc.registerFont('ThaiRegular', 'Helvetica');
      doc.registerFont('ThaiBold', 'Helvetica-Bold');
    }

    const getThaiDate = (dateString) => {
      if (!dateString) return '-';
      const d = new Date(dateString);
      if (isNaN(d)) return '-';
      
      const parts = new Intl.DateTimeFormat('en-US', { 
        timeZone: 'Asia/Bangkok', year: 'numeric', month: 'numeric', day: 'numeric' 
      }).formatToParts(d);
      
      let day, month, year;
      parts.forEach(p => {
        if (p.type === 'day') day = parseInt(p.value, 10);
        if (p.type === 'month') month = parseInt(p.value, 10);
        if (p.type === 'year') year = parseInt(p.value, 10);
      });
      
      const months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
      return `${day} ${months[month - 1]} ${year + 543}`;
    };

    const getThaiTime = (dateString, addMinutes = 0) => {
      if (!dateString) return '-';
      const d = new Date(dateString);
      if (isNaN(d)) return '-';
      
      d.setMinutes(d.getMinutes() + addMinutes); 
      const timeString = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
      
      return timeString.replace(':', '.');
    };

    // =======================================================
    // ระบบโหลดรูปภาพอัจฉริยะ (ดึงรูปลง PDF ได้ 100%)
    // =======================================================
    const renderCalibImage = async (fileUrl, x, y, w, h) => {
      if (!fileUrl || fileUrl.trim() === '') return;
      let buf = null;
      try {
        let pathStr = fileUrl.trim();
        let fileId = null;

        // 1. ดักจับ Google Drive ID
        if (pathStr.includes('/api/images/')) {
            const parts = pathStr.split('/api/images/');
            fileId = parts[parts.length - 1].replace(/\//g, '');
        } else if (pathStr.includes('drive.google.com') || pathStr.includes('drive.usercontent.google.com')) {
            const matchFileD = pathStr.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
            if (matchFileD) {
                fileId = matchFileD[1];
            } else {
                const matchId = pathStr.match(/[?&]id=([a-zA-Z0-9_-]+)/);
                if (matchId) fileId = matchId[1];
            }
        }

        // 2. โหลดรูปมาเป็น Buffer เพื่อให้ PDF วาดได้
        if (fileId) {
            // โหลดรูปจาก Google Drive
            const driveThumbnailUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;
            buf = await fetchImageFromUrl(driveThumbnailUrl);
        } else if (/^https?:\/\//i.test(pathStr)) {
            // โหลดรูปจากลิงก์เว็บไซต์ทั่วไป
            buf = await fetchImageFromUrl(pathStr);
        } else {
            // โหลดรูปจากในเครื่อง Server (Uploads)
            let cleanPath = pathStr.replace(/\\/g, '/');
            if (cleanPath.startsWith('/')) cleanPath = cleanPath.substring(1);
            
            const localPath = path.join(__dirname, cleanPath);
            const decodedPath = path.join(__dirname, decodeURIComponent(cleanPath));

            if (fs.existsSync(localPath)) {
                buf = fs.readFileSync(localPath);
            } else if (fs.existsSync(decodedPath)) {
                buf = fs.readFileSync(decodedPath);
            }
        }

        // 3. วาดรูปลงกระดาษ PDF
        if (buf) {
            doc.image(buf, x + 2, y + 2, { fit: [w - 4, h - 4], align: 'center', valign: 'center' }); 
        } else {
            doc.font('ThaiRegular').fontSize(8).fillColor('black').text('[ไม่พบรูปภาพ]', x + 5, y + Math.floor(h/2));
        }
      } catch (e) {
        doc.font('ThaiRegular').fontSize(8).fillColor('black').text('[ภาพขัดข้อง]', x + 5, y + Math.floor(h/2));
      }
    };

    // ============================================================================
    // หน้ารายงานแอป 1 (ตารางภาพรวม)
    // ============================================================================
    doc.font('ThaiBold').fontSize(16).fillColor('black');
    doc.text(fixThaiVowels(`รายงานสรุปสถานีโทรมาตร ลุ่มน้ำ${basin === 'all' ? 'ทั้งหมด' : basin}`), { align: 'center' });
    
    doc.fontSize(12).fillColor('red');
    doc.text(fixThaiVowels(`งวดการตรวจสอบ : ${term === 'all' ? 'ทั้งหมด' : term}`), { align: 'center' });
    
    let inspectDate = inspections.length > 0 ? (inspections[0].timestamp || inspections[0].createdAt || new Date()) : new Date();
    doc.text(fixThaiVowels(`วันที่ตรวจสอบ : ${getThaiDate(inspectDate)}`), { align: 'center' });
    
    doc.moveDown(1);

    const startX = 30;
    let currentY = doc.y;
    const colX = [30, 60, 110, 195, 245, 295, 395, 465]; 
    const colW = [30, 50,  85,  50,  50, 100,  70,  100]; 
    const headers = ['ลำดับ', 'รหัสสถานี', 'ชื่อสถานี', 'พร้อมใช้งาน', 'ความสะอาด', 'อุปกรณ์ที่ชำรุด', 'หมายเหตุ', 'ข้อคิดเห็นกรรมการ'];

    const drawTableHeader = (yPos) => {
      doc.fillColor('black').font('ThaiBold').fontSize(9);
      doc.rect(startX, yPos, 535, 25).fillAndStroke('#f0f0f0', 'black');
      doc.fillColor('black');
      
      headers.forEach((h, i) => {
        doc.text(fixThaiVowels(h), colX[i], yPos + 6, { width: colW[i], align: 'center' });
        if (i > 0) doc.moveTo(colX[i], yPos).lineTo(colX[i], yPos + 25).stroke(); 
      });
      return yPos + 25;
    };

    currentY = drawTableHeader(currentY);
    doc.font('ThaiRegular').fontSize(8);

    inspections.forEach((item, index) => {
      let brokenList = [];
      const isBrokenValue = (val) => {
        const v = (val || '').toString().trim().toLowerCase();
        return v === 'o' || v === 'ชำรุด' || v === '0' || v === 'ไม่ผ่าน' || v === 'ไม่ถูกต้อง';
      };

      if (equipmentMap) {
          Object.keys(equipmentMap).forEach(key => {
            if (isBrokenValue(item[key])) {
              brokenList.push(equipmentMap[key]);
            }
          });
      }

      let isSystemBroken = false;
      const groupA = ['power', 'sta_cpu', 'sta_ai', 'sta_di', 'sta_do', 'sta_io', 'plc', 'sta_cctv1', 'sta_cctv2', 'sta_r', 'sta_s', 'sta_wl', 'sta_tro', 'sta_gass', 'sta_wl2', 'sta_saling', 'sta_wl1'];
      if (groupA.some(key => isBrokenValue(item[key]))) {
        isSystemBroken = true;
      }

      if (isBrokenValue(item.sta_m1) && isBrokenValue(item.sta_m2)) isSystemBroken = true;
      if (isBrokenValue(item.sta_p1) && isBrokenValue(item.sta_p2)) isSystemBroken = true;

      const statusText = isSystemBroken ? 'ใช้ไม่ได้' : 'ใช้ได้';
      
      let cleanStatus = item.clean || '-';
      const cleanLower = cleanStatus.toLowerCase();
      if (cleanLower === 'o' || cleanLower === 'ไม่ผ่าน') cleanStatus = 'ไม่ผ่าน';
      else if (cleanLower === 'p' || cleanLower === 'ผ่าน') cleanStatus = 'ผ่าน';
      
      const brokenDesc = brokenList.join(', ') || '-';
      const note1 = item.note || '-';
      const note2 = item.note2 || '-';

      const h1 = doc.heightOfString(fixThaiVowels(item.name_id || '-'), { width: colW[2] - 4 });
      const h2 = doc.heightOfString(fixThaiVowels(brokenDesc), { width: colW[5] - 4 });
      const h3 = doc.heightOfString(fixThaiVowels(note1), { width: colW[6] - 4 });
      const h4 = doc.heightOfString(fixThaiVowels(note2), { width: colW[7] - 4 });
      const rowHeight = Math.max(h1, h2, h3, h4, 15) + 10;

      if (currentY + rowHeight > 780) {
        doc.addPage();
        currentY = drawTableHeader(30);
        doc.font('ThaiRegular').fontSize(8);
      }

      doc.rect(startX, currentY, 535, rowHeight).stroke();
      colX.forEach((x, i) => { if (i > 0) doc.moveTo(x, currentY).lineTo(x, currentY + rowHeight).stroke(); });

      const textY = currentY + 4;
      doc.text(fixThaiVowels(`${index + 1}`), colX[0], textY, { width: colW[0], align: 'center' });
      doc.text(fixThaiVowels(item.id_name || '-'), colX[1], textY, { width: colW[1], align: 'center' });
      doc.text(fixThaiVowels(item.name_id || '-'), colX[2] + 2, textY, { width: colW[2] - 4, align: 'left' });
      doc.text(fixThaiVowels(statusText), colX[3], textY, { width: colW[3], align: 'center' });
      doc.text(fixThaiVowels(cleanStatus), colX[4], textY, { width: colW[4], align: 'center' });
      doc.text(fixThaiVowels(brokenDesc), colX[5] + 2, textY, { width: colW[5] - 4, align: 'left' });
      doc.text(fixThaiVowels(note1), colX[6] + 2, textY, { width: colW[6] - 4, align: 'left' });
      doc.text(fixThaiVowels(note2), colX[7] + 2, textY, { width: colW[7] - 4, align: 'left' });

      currentY += rowHeight;
    });

    // ============================================================================
    // หน้ารายงานแอป 2 และ 3 (Calibrations) พร้อมรูปภาพ!
    // ============================================================================
    if (calibrations && calibrations.length > 0) {
        for (const calib of calibrations) {
          
          doc.addPage();
          doc.font('ThaiBold').fontSize(14).fillColor('black');
          doc.text(fixThaiVowels(`1. สอบเทียบเซ็นเซอร์อุปกรณ์ตรวจวัดระดับน้ำ สถานี “${calib.myData1 || '-'}”`), 40, 40);
          
          doc.font('ThaiRegular').fontSize(12);
          const calibDate = calib.timestamp || calib.createdAt || new Date();
          doc.text(fixThaiVowels(`วันที่บันทึกค่า ${getThaiDate(calibDate)}`), 40, 60);

          doc.font('ThaiBold').fontSize(12);
          doc.text(fixThaiVowels(`ครั้งที่ 1 เวลา ${getThaiTime(calibDate)} น.`), 40, 85);

          let tY = 105;
          doc.rect(40, tY, 171, 20).stroke(); doc.rect(211, tY, 171, 20).stroke(); doc.rect(382, tY, 171, 20).stroke();
          doc.text(fixThaiVowels('รูปที่ 1 ค่า ค่าแผ่นวัดระดับน้ำ'), 40, tY + 5, { width: 171, align: 'center' });
          doc.text(fixThaiVowels('รูปที่ 2 ค่า RTU'), 211, tY + 5, { width: 171, align: 'center' });
          doc.text(fixThaiVowels('รูปที่ 3 Website'), 382, tY + 5, { width: 171, align: 'center' });

          tY += 20;
          doc.rect(40, tY, 171, 140).stroke(); doc.rect(211, tY, 171, 140).stroke(); doc.rect(382, tY, 171, 140).stroke();
          // วาดรูปด้วยฟังก์ชันใหม่
          await renderCalibImage(calib.myFileUrl, 40, tY, 171, 140);
          await renderCalibImage(calib.myFileUrl2, 211, tY, 171, 140);
          await renderCalibImage(calib.myFileUrl3, 382, tY, 171, 140);

          tY += 140;
          doc.rect(40, tY, 171, 25).stroke(); doc.rect(211, tY, 171, 25).stroke(); doc.rect(382, tY, 171, 25).stroke();
          doc.font('ThaiRegular').fillColor('red');
          doc.text(fixThaiVowels(`${calib.myData4 || '-'} ม.รสม.`), 40, tY + 7, { width: 171, align: 'center' });
          doc.text(fixThaiVowels(`${calib.myData5 || '-'} ม.รสม.`), 211, tY + 7, { width: 171, align: 'center' });
          doc.text(fixThaiVowels(`${calib.myData6 || '-'} ม.รสม.`), 382, tY + 7, { width: 171, align: 'center' });

          tY += 40;
          doc.font('ThaiBold').fillColor('black').fontSize(12);
          doc.text(fixThaiVowels(`ครั้งที่ 2 เวลา ${getThaiTime(calibDate, 10)} น.`), 40, tY);

          tY += 20;
          doc.rect(40, tY, 171, 20).stroke(); doc.rect(211, tY, 171, 20).stroke(); doc.rect(382, tY, 171, 20).stroke();
          doc.text(fixThaiVowels('รูปที่ 1 ค่า ค่าแผ่นวัดระดับน้ำ'), 40, tY + 5, { width: 171, align: 'center' });
          doc.text(fixThaiVowels('รูปที่ 2 ค่า RTU'), 211, tY + 5, { width: 171, align: 'center' });
          doc.text(fixThaiVowels('รูปที่ 3 Website'), 382, tY + 5, { width: 171, align: 'center' });

          tY += 20;
          doc.rect(40, tY, 171, 140).stroke(); doc.rect(211, tY, 171, 140).stroke(); doc.rect(382, tY, 171, 140).stroke();
          await renderCalibImage(calib.myFileUrl4, 40, tY, 171, 140);
          await renderCalibImage(calib.myFileUrl5, 211, tY, 171, 140);
          await renderCalibImage(calib.myFileUrl6, 382, tY, 171, 140);

          tY += 140;
          doc.rect(40, tY, 171, 25).stroke(); doc.rect(211, tY, 171, 25).stroke(); doc.rect(382, tY, 171, 25).stroke();
          doc.font('ThaiRegular').fillColor('red');
          doc.text(fixThaiVowels(`${calib.myData8 || '-'} ม.รสม.`), 40, tY + 7, { width: 171, align: 'center' });
          doc.text(fixThaiVowels(`${calib.myData9 || '-'} ม.รสม.`), 211, tY + 7, { width: 171, align: 'center' });
          doc.text(fixThaiVowels(`${calib.myData10 || '-'} ม.รสม.`), 382, tY + 7, { width: 171, align: 'center' });

          tY += 40;
          doc.font('ThaiRegular').fillColor('black');
          doc.text(fixThaiVowels(`หมายเหตุ : ${calib.myData7 || '-'}`), 40, tY);

          doc.addPage();
          doc.font('ThaiBold').fontSize(14).fillColor('black');
          doc.text(fixThaiVowels(`2. สอบเทียบเซ็นเซอร์อุปกรณ์ตรวจวัดค่าน้ำฝน สถานี “${calib.myData1 || '-'}”`), 40, 40);
          
          doc.font('ThaiRegular').fontSize(12);
          doc.text(fixThaiVowels(`วันที่บันทึกค่า ${getThaiDate(calibDate)}`), 40, 60);
          doc.text(fixThaiVowels(`ครั้งที่ 1 เวลา ${getThaiTime(calibDate)} น.`), 40, 80);
          doc.text(fixThaiVowels(`จำนวนเคาะจากกระบอกน้ำฝน ${calib.myData11 || '-'} ครั้ง`), 40, 100);

          let rY = 125;
          doc.font('ThaiBold').fontSize(12);
          
          doc.rect(40, rY, 256, 20).stroke(); doc.rect(296, rY, 256, 20).stroke();
          doc.text(fixThaiVowels('รูปที่ 1 ค่า RTU'), 40, rY + 5, { width: 256, align: 'center' });
          doc.text(fixThaiVowels('รูปที่ 2 ค่า Website'), 296, rY + 5, { width: 256, align: 'center' });

          rY += 20;
          doc.rect(40, rY, 256, 220).stroke(); doc.rect(296, rY, 256, 220).stroke();
          await renderCalibImage(calib.myFileUrl7, 40, rY, 256, 220);
          await renderCalibImage(calib.myFileUrl8, 296, rY, 256, 220);

          rY += 220;
          doc.rect(40, rY, 256, 25).stroke(); doc.rect(296, rY, 256, 25).stroke();
          doc.font('ThaiRegular').fillColor('red');
          
          doc.text(fixThaiVowels(`${calib.myData12 || '-'} มม.`), 40, rY + 7, { width: 256, align: 'center' });
          doc.text(fixThaiVowels(`${calib.myData13 || '-'} มม.`), 296, rY + 7, { width: 256, align: 'center' });

          rY += 40;
          doc.font('ThaiRegular').fillColor('black');
          doc.text(fixThaiVowels(`หมายเหตุ : (${calib.myData14 || '-'})`), 40, rY);
        }
    }

    doc.end();
  } catch (error) {
    console.error('PDF Generation Error:', error);
    if (!res.headersSent) res.status(500).send('เกิดข้อผิดพลาดในการสร้าง PDF');
  }
}

module.exports = {
  generateInspectionPDF
};