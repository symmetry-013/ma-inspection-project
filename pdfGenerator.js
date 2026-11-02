const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

async function generateInspectionPDF(inspections, calibrations, term, basin, res, equipmentMap, hardcodedBasins, fetchImageBufferDirectly, extractDriveId, fixThaiVowels) {
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

    const getThaiDate = (date) => {
      if (!date) return '-';
      const d = new Date(date);
      if (isNaN(d)) return '-';
      return new Intl.DateTimeFormat('th-TH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Bangkok' }).format(d);
    };

    doc.font('ThaiBold').fontSize(16).fillColor('black');
    doc.text(fixThaiVowels(`รายงานสรุปสถานีโทรมาตร ลุ่มน้ำ${basin === 'all' ? 'ทั้งหมด' : basin}`), { align: 'center' });
    doc.fontSize(12).fillColor('red');
    doc.text(fixThaiVowels(`งวดการตรวจสอบ : ${term}`), { align: 'center' });
    
    let inspectDate = inspections.length > 0 ? inspections[0].mam_updated_at || inspections[0].last_sync_at : new Date();
    doc.text(fixThaiVowels(`วันที่ตรวจสอบ : ${getThaiDate(inspectDate)}`), { align: 'center' });
    
    doc.moveDown(1);

    const startX = 30;
    let currentY = doc.y;
    const colX = [30, 60, 110, 195, 245, 295, 395, 465]; 
    const colW = [30, 50,  85,  50,  50, 100,  70,  100]; 
    const headers = ['ลำดับ', 'รหัสสถานี', 'ชื่อสถานี', 'พร้อมใช้งาน', 'ความสะอาด', 'อุปกรณ์ที่ชำรุด', 'หมายเหตุ', 'ข้อคิดเห็น'];

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
        return v === 'o' || v === 'ชำรุด' || v === '0' || v === 'ไม่ผ่าน';
      };

      // หาอุปกรณ์ที่ชำรุดจาก equipmentMap ที่ดึงมาจาก name_sv.js
      Object.keys(equipmentMap).forEach(key => {
        if (isBrokenValue(item[key])) brokenList.push(equipmentMap[key]);
      });

      // ลอจิกระบบใช้ไม่ได้ (กลุ่ม A และ กลุ่ม B)
      let isSystemBroken = false;
      const groupA = ['power', 'sta_cpu', 'plc', 'sta_cctv1', 'sta_r', 'sta_s', 'sta_wl', 'sta_tro', 'sta_gass', 'sta_wl2', 'sta_saling', 'sta_wl1'];
      if (groupA.some(key => isBrokenValue(item[key]))) isSystemBroken = true;
      if (isBrokenValue(item.sta_m1) && isBrokenValue(item.sta_m2)) isSystemBroken = true;
      if (isBrokenValue(item.sta_p1) && isBrokenValue(item.sta_p2)) isSystemBroken = true;

      const statusText = isSystemBroken ? 'ใช้ไม่ได้' : 'ใช้ได้';
      const cleanStatus = (item.clean === 'P' || item.clean === 'ผ่าน') ? 'ผ่าน' : (item.clean === 'O' ? 'ไม่ผ่าน' : '-');
      const brokenDesc = brokenList.join(', ') || '-';
      const note2 = item.note2 || '-';

      const h1 = doc.heightOfString(fixThaiVowels(item.name_id || '-'), { width: colW[2] - 4 });
      const h2 = doc.heightOfString(fixThaiVowels(brokenDesc), { width: colW[5] - 4 });
      const h3 = doc.heightOfString(fixThaiVowels(note2), { width: colW[7] - 4 });
      const rowHeight = Math.max(h1, h2, h3, 15) + 10;

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
      doc.text(fixThaiVowels('-'), colX[6] + 2, textY, { width: colW[6] - 4, align: 'left' });
      doc.text(fixThaiVowels(note2), colX[7] + 2, textY, { width: colW[7] - 4, align: 'left' });

      currentY += rowHeight;
    });

    doc.end();
  } catch (error) {
    console.error('PDF Generation Error:', error);
    if (!res.headersSent) res.status(500).send('Error');
  }
}

module.exports = { generateInspectionPDF };