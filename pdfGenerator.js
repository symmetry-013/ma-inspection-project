const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

async function generateInspectionPDF(inspections, calibrations, term, basin, res, equipmentMap, hardcodedBasins, fetchImageBufferDirectly, extractDriveId, fixThaiVowels) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const fontRegular = path.join(__dirname, 'fonts', 'Prompt-Regular.ttf');
    const fontBold = path.join(__dirname, 'fonts', 'Prompt-Bold.ttf');
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Report_${encodeURIComponent(basin)}_${encodeURIComponent(term)}.pdf`);
    doc.pipe(res);

    if (fs.existsSync(fontRegular) && fs.existsSync(fontBold)) {
      doc.registerFont('ThaiRegular', fontRegular);
      doc.registerFont('ThaiBold', fontBold);
    } else {
      console.warn('⚠️ ไม่พบไฟล์ฟอนต์ภาษาไทยในโฟลเดอร์ fonts/ ระบบจะใช้ฟอนต์มาตรฐานแทน');
      doc.registerFont('ThaiRegular', 'Helvetica');
      doc.registerFont('ThaiBold', 'Helvetica-Bold');
    }

    // ---------------------------------------------------------
    // กรณีที่ 1: สรุปทุกลุ่มน้ำทั้งหมด (ภาพรวมประเทศ)
    // ---------------------------------------------------------
    if (basin === 'all') {
      doc.font('ThaiBold').fontSize(20).text('รายงานสรุปผลการตรวจสอบสถานีโทรมาตร (ภาพรวมประเทศ)', { align: 'center' });
      doc.font('ThaiRegular').fontSize(12).text(`งวดการตรวจสอบ: ${term === 'all' ? 'ทุกงวด' : term}`, { align: 'center' });
      doc.moveDown(2);

      let totalStations = inspections.length;
      let totalP = 0;
      let totalO = 0;
      
      const equipmentIssues = {};
      equipmentMap.forEach(e => equipmentIssues[e.field] = 0);

      const basinStats = {};
      hardcodedBasins.forEach(b => basinStats[b] = { total: 0, p: 0, o: 0 });

      inspections.forEach(item => {
        const hasIssue = equipmentMap.some(eq => {
          const val = (item[eq.field] || '').toString().trim().toLowerCase();
          return val === 'o' || val === 'ชำรุด' || val === '0';
        });

        if (hasIssue) totalO++; else totalP++;

        if (basinStats[item.code]) {
          basinStats[item.code].total++;
          if (hasIssue) basinStats[item.code].o++; else basinStats[item.code].p++;
        }

        equipmentMap.forEach(eq => {
          const val = (item[eq.field] || '').toString().trim().toLowerCase();
          if (val === 'o' || val === 'ชำรุด' || val === '0') equipmentIssues[eq.field]++;
        });
      });

      doc.font('ThaiBold').fontSize(14).text(`สถิติรวมทั้งหมด: ${totalStations} สถานี`);
      doc.font('ThaiRegular').fontSize(12)
         .text(`• พร้อมใช้งานปกติ (P): ${totalP} สถานี`)
         .text(`• พบอุปกรณ์ชำรุด (O): ${totalO} สถานี`);
      doc.moveDown(2);

      doc.font('ThaiBold').fontSize(14).text('สรุปผลการตรวจสอบแยกตามลุ่มน้ำ', { underline: true });
      doc.moveDown(0.5);
      let y = doc.y;
      doc.fontSize(10);
      doc.text('ลุ่มน้ำ', 50, y, { width: 200 }).text('ทั้งหมด', 250, y).text('ปกติ (P)', 350, y).text('ชำรุด (O)', 450, y);
      doc.moveTo(50, y + 15).lineTo(500, y + 15).stroke();
      y += 20;

      hardcodedBasins.forEach(b => {
        const stat = basinStats[b];
        if (stat.total > 0) {
          if (y > 750) { doc.addPage(); y = 50; } 
          doc.font('ThaiRegular').text(b, 50, y, { width: 200 })
             .text(stat.total.toString(), 250, y)
             .text(stat.p.toString(), 350, y)
             .text(stat.o.toString(), 450, y);
          y += 15;
        }
      });
      doc.moveDown(2);

      y = doc.y + 20;
      if (y > 750) { doc.addPage(); y = 50; }
      doc.font('ThaiBold').fontSize(14).text('สรุปปัญหาอุปกรณ์ที่ชำรุดบ่อยที่สุด', 50, y);
      y += 20;
      equipmentMap.sort((a, b) => equipmentIssues[b.field] - equipmentIssues[a.field]).forEach(eq => {
        if (equipmentIssues[eq.field] > 0) {
          if (y > 750) { doc.addPage(); y = 50; }
          doc.font('ThaiRegular').fontSize(12).text(`• ${eq.label}: ${equipmentIssues[eq.field]} รายการ`, 50, y);
          y += 15;
        }
      });
    } 
    // ---------------------------------------------------------
    // กรณีที่ 2: ระบุรายลุ่มน้ำเดี่ยว
    // ---------------------------------------------------------
    else {
      doc.font('ThaiBold').fontSize(20).text(`รายงานสรุปสถานีโทรมาตร ลุ่มน้ำ${basin}`, { align: 'center' });
      doc.font('ThaiRegular').fontSize(12).text(`งวดการตรวจสอบ: ${term === 'all' ? 'ทุกงวด' : term}`, { align: 'center' });
      doc.moveDown(2);

      doc.font('ThaiBold').fontSize(14).text('สถานะการตรวจสอบรายสถานี');
      let y = doc.y + 10;
      doc.fontSize(10);
      doc.text('รหัสสถานี', 50, y).text('ชื่อสถานี', 120, y).text('สถานะรวม', 300, y).text('หมายเหตุ', 380, y);
      doc.moveTo(50, y + 15).lineTo(500, y + 15).stroke();
      y += 20;

      inspections.forEach(item => {
        if (y > 750) { doc.addPage(); y = 50; }
        
        const hasIssue = equipmentMap.some(eq => {
          const val = (item[eq.field] || '').toString().trim().toLowerCase();
          return val === 'o' || val === 'ชำรุด' || val === '0';
        });

        const statusText = hasIssue ? 'O (พบชำรุด)' : 'P (ปกติ)';
        const note = item.note || item.note2 || '-';
        
        doc.font('ThaiRegular')
           .text(item.id_name || '-', 50, y)
           .text(item.name_id || '-', 120, y, { width: 170 })
           .text(statusText, 300, y)
           .text(note, 380, y, { width: 120, height: 15, lineBreak: false });
        y += 20;
      });

      for (const calib of calibrations) {
        doc.addPage();
        doc.font('ThaiBold').fontSize(16).text(`รายงานการสอบเทียบ: สถานี ${calib.myData1 || 'ไม่ระบุ'}`, { underline: true });
        doc.moveDown(1);

        const calibPoints = [
          { title: 'เสาวัดระดับน้ำ', text: calib.myData2, imgUrl: calib.myFileUrl },
          { title: 'ระดับน้ำ RTU', text: calib.myData3, imgUrl: calib.myFileUrl2 },
          { title: 'ระดับน้ำ Website', text: calib.myData4, imgUrl: calib.myFileUrl3 },
          { title: 'ค่าน้ำฝน RTU', text: calib.myData5, imgUrl: calib.myFileUrl4 },
          { title: 'ค่าน้ำฝน Website', text: calib.myData6, imgUrl: calib.myFileUrl5 }
        ];

        const activePoints = calibPoints.filter(p => p.text || p.imgUrl);

        let currentY = doc.y;
        let col = 0; 
        const startX = [50, 300];

        for (const point of activePoints) {
          if (currentY > 600) { doc.addPage(); currentY = 50; col = 0; }
          
          let x = startX[col];
          let blockHeight = 200; 

          if (point.imgUrl) {
            const fileId = extractDriveId(point.imgUrl);
            if (fileId) {
               const imgBuffer = await fetchImageBufferDirectly(fileId);
               if (imgBuffer) {
                 try {
                   doc.image(imgBuffer, x, currentY, { fit: [200, 150], align: 'center' });
                 } catch (e) {
                   doc.font('ThaiRegular').fontSize(10).text('[รูปแบบภาพไม่รองรับ]', x, currentY);
                 }
               } else {
                   doc.font('ThaiRegular').fontSize(10).text('[ไม่สามารถโหลดรูปภาพได้]', x, currentY);
               }
            }
          }

          doc.font('ThaiBold').fontSize(12).text(point.title, x, currentY + 160);
          doc.font('ThaiRegular').fontSize(10).text(`ค่าที่อ่านได้: ${fixThaiVowels(point.text) || '-'}`, x, currentY + 175);

          col++;
          if (col > 1) { col = 0; currentY += blockHeight; }
        }
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