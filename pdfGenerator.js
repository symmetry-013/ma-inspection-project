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
        if (!url || typeof url !== 'string') return resolve(null);
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirUrl = res.headers.location;
                if (!redirUrl.startsWith('http')) redirUrl = new URL(redirUrl, url).href;
                resolve(fetchImageFromUrl(redirUrl));
            } else if (res.statusCode === 200) {
                const data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => resolve(Buffer.concat(data)));
            } else {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
};

// =======================================================
// โครงสร้างตารางประวัติครุภัณฑ์ 12 หมวดมาตรฐาน (ตามไฟล์ตัวอย่างรายงาน.pdf)
// =======================================================
const STANDARD_12_EQUIPMENT_ROWS = [
    { no: '1', name: 'RTU', isHeader: true },
    { no: '', name: '1.1 CPU', keywords: ['cpu', 'rtu'] },
    { no: '', name: '1.2 AI/Mux/IO', keywords: ['ai', 'mux', 'analog', 'io', 'i/o'] },
    { no: '', name: '1.3 DI/DO', keywords: ['di', 'do', 'digital'] },
    { no: '', name: '1.4 (1) GPRS Module', keywords: ['gprs module 1', 'gprs 1', 'module 1', '4g module 1'] },
    { no: '', name: '1.4 (2) GPRS Module', keywords: ['gprs module 2', 'gprs 2', 'module 2', '4g module 2'] },
    { no: '', name: '1.5 Power Module', keywords: ['power module', 'psu'] },
    { no: '', name: '1.6 Display', keywords: ['display', 'lcd', 'จอแสดงผล'] },
    { no: '2', name: 'Edge / GPRS Modem', isHeader: true },
    { no: '', name: '2.1 เครื่องที่ 1', keywords: ['modem 1', 'router 1', 'modem', 'router', 'โมเด็ม'], slotIndex: 0 },
    { no: '', name: '2.2 เครื่องที่ 2', keywords: ['modem 2', 'router 2', 'modem', 'router', 'โมเด็ม'], slotIndex: 1 },
    { no: '3', name: 'Data Logger', isHeader: true },
    { no: '', name: '3.1 เครื่องที่ 1', keywords: ['logger', 'data logger', 'บันทึกข้อมูล'], slotIndex: 0 },
    { no: '', name: '3.2 เครื่องที่ 2', keywords: ['logger', 'data logger', 'บันทึกข้อมูล'], slotIndex: 1 },
    { no: '4', name: 'Power Supply / Solar Charger', isHeader: true },
    { no: '', name: '4.1 เครื่องที่ 1', keywords: ['power supply', 'solar', 'charger', 'โซลาร์', 'แหล่งจ่ายไฟ'], slotIndex: 0 },
    { no: '', name: '4.2 เครื่องที่ 2', keywords: ['power supply', 'solar', 'charger', 'โซลาร์', 'แหล่งจ่ายไฟ'], slotIndex: 1 },
    { no: '5', name: 'กล้อง CCTV', isHeader: true },
    { no: '', name: '5.1 เครื่องที่ 1', keywords: ['cctv', 'กล้อง', 'camera'], slotIndex: 0 },
    { no: '', name: '5.2 เครื่องที่ 2', keywords: ['cctv', 'กล้อง', 'camera'], slotIndex: 1 },
    { no: '', name: '5.3 เครื่องที่ 3', keywords: ['cctv', 'กล้อง', 'camera'], slotIndex: 2 },
    { no: '6', name: 'เครื่องวัดระดับน้ำ', isHeader: true },
    { no: '', name: '6.1 เครื่องที่ 1', keywords: ['ระดับน้ำ', 'water level', 'radar', 'bubble', 'float', 'pressure', 'ultrasonic'], slotIndex: 0 },
    { no: '', name: '6.2 เครื่องที่ 2', keywords: ['ระดับน้ำ', 'water level', 'radar', 'bubble', 'float', 'pressure', 'ultrasonic'], slotIndex: 1 },
    { no: '', name: '6.3 เครื่องที่ 3', keywords: ['ระดับน้ำ', 'water level', 'radar', 'bubble', 'float', 'pressure', 'ultrasonic'], slotIndex: 2 },
    { no: '7', name: 'เครื่องวัดปริมาณฝน', keywords: ['น้ำฝน', 'ปริมาณฝน', 'rain', 'tipping'] },
    { no: '8', name: 'เครื่องวัดปริมาณน้ำ', keywords: ['ปริมาณน้ำ', 'flow', 'discharge', 'adcp', 'velocity'] },
    { no: '9', name: 'เครื่องวัดคุณภาพน้ำ', keywords: ['คุณภาพน้ำ', 'water quality', 'wq', 'ph', 'do sensor', 'salinity'] },
    { no: '10', name: 'Surge Protection', keywords: ['surge', 'กันฟ้าผ่า', 'arrester'] },
    { no: '11', name: 'เครื่องวัดระยะยกบาน', isHeader: true },
    { no: '', name: '11.1 เครื่องที่ 1', keywords: ['ระยะยกบาน', 'gate', 'บานประตู'], slotIndex: 0 },
    { no: '', name: '11.2 เครื่องที่ 2', keywords: ['ระยะยกบาน', 'gate', 'บานประตู'], slotIndex: 1 },
    { no: '', name: '11.3 เครื่องที่ 3', keywords: ['ระยะยกบาน', 'gate', 'บานประตู'], slotIndex: 2 },
    { no: '', name: '11.4 เครื่องที่ 4', keywords: ['ระยะยกบาน', 'gate', 'บานประตู'], slotIndex: 3 },
    { no: '', name: '11.5 เครื่องที่ 5', keywords: ['ระยะยกบาน', 'gate', 'บานประตู'], slotIndex: 4 },
    { no: '', name: '11.6 เครื่องที่ 6', keywords: ['ระยะยกบาน', 'gate', 'บานประตู'], slotIndex: 5 },
    { no: '12', name: 'แบตเตอรี่', isHeader: true },
    { no: '', name: '12.1 แบตเตอรี่ ก้อนที่ 1', keywords: ['battery', 'แบต', 'แบตเตอรี่'], slotIndex: 0 },
    { no: '', name: '12.2 แบตเตอรี่ ก้อนที่ 2', keywords: ['battery', 'แบต', 'แบตเตอรี่'], slotIndex: 1 },
    { no: '', name: '12.3 แบตเตอรี่ ก้อนที่ 3', keywords: ['battery', 'แบต', 'แบตเตอรี่'], slotIndex: 2 },
    { no: '', name: '12.4 แบตเตอรี่ ก้อนที่ 4', keywords: ['battery', 'แบต', 'แบตเตอรี่'], slotIndex: 3 },
    { no: '', name: '12.5 แบตเตอรี่ ก้อนที่ 5', keywords: ['battery', 'แบต', 'แบตเตอรี่'], slotIndex: 4 },
    { no: '', name: '12.6 แบตเตอรี่ ก้อนที่ 6', keywords: ['battery', 'แบต', 'แบตเตอรี่'], slotIndex: 5 }
];

function normalizeCode(str) {
    if (!str) return '';
    return String(str).trim().split('(')[0].trim().replace(/\s+/g, '').toUpperCase();
}

function parsePeriodNum(periodStr) {
    if (!periodStr) return '';
    const m = String(periodStr).match(/\d+/);
    return m ? m[0] : '';
}

function matchEquipmentToRow(itemsList, rowDef) {
    if (!Array.isArray(itemsList) || !rowDef.keywords) return null;
    const matched = itemsList.filter(it => {
        const text = `${it.category || ''} ${it.location_point || ''} ${it.model || ''} ${it.brand || ''}`.toLowerCase();
        return rowDef.keywords.some(kw => text.includes(kw.toLowerCase()));
    });
    if (matched.length === 0) return null;
    const idx = rowDef.slotIndex !== undefined ? rowDef.slotIndex : 0;
    return matched[idx] || null;
}

async function generateInspectionPDF(
    inspections,
    calibrations,
    term,
    basin,
    res,
    equipmentMap,
    hardcodedBasins,
    _fetchImageBufferDirectly,
    _extractDriveId,
    fixThaiVowels,
    extraData = {}
) {
    try {
        const {
            equipmentChecks = [],
            torChecks = [],
            mamEquipments = [],
            contractYear = ''
        } = extraData;

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

        const safeText = (txt) => fixThaiVowels ? fixThaiVowels(txt) : String(txt || '');

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

        const getShortThaiDate = (dateString) => {
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
            const shortMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
            return `${day} ${shortMonths[month - 1]} ${(year + 543) % 100}`;
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
            if (!fileUrl || String(fileUrl).trim() === '') return;
            let buf = null;
            try {
                let pathStr = String(fileUrl).trim();
                let fileId = null;

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

                if (fileId) {
                    if (typeof _fetchImageBufferDirectly === 'function') {
                        buf = await _fetchImageBufferDirectly(fileId);
                    }
                    if (!buf) {
                        const driveThumbnailUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;
                        buf = await fetchImageFromUrl(driveThumbnailUrl);
                    }
                } else if (/^https?:\/\//i.test(pathStr)) {
                    buf = await fetchImageFromUrl(pathStr);
                } else {
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

                if (buf) {
                    doc.image(buf, x + 2, y + 2, { fit: [w - 4, h - 4], align: 'center', valign: 'center' });
                } else {
                    doc.font('ThaiRegular').fontSize(8).fillColor('#64748b').text(safeText('[ไม่พบรูปภาพ]'), x + 5, y + Math.floor(h / 2) - 5, { width: w - 10, align: 'center' });
                }
            } catch (e) {
                doc.font('ThaiRegular').fontSize(8).fillColor('#ef4444').text(safeText('[ภาพขัดข้อง]'), x + 5, y + Math.floor(h / 2) - 5, { width: w - 10, align: 'center' });
            }
        };

        // ============================================================================
        // ส่วนที่ 1: หน้ารายงานตารางสรุปภาพรวมสถานี (คงของเดิมไว้ 100%)
        // ============================================================================
        doc.font('ThaiBold').fontSize(16).fillColor('black');
        doc.text(safeText(`รายงานสรุปสถานีโทรมาตร ลุ่มน้ำ${basin === 'all' ? 'ทั้งหมด' : basin}`), { align: 'center' });

        doc.fontSize(12).fillColor('red');
        doc.text(safeText(`งวดการตรวจสอบ : ${term === 'all' ? 'ทั้งหมด' : term}`), { align: 'center' });

        let inspectDate = inspections.length > 0 ? (inspections[0].timestamp || inspections[0].createdAt || new Date()) : new Date();
        doc.text(safeText(`วันที่ตรวจสอบ : ${getThaiDate(inspectDate)}`), { align: 'center' });

        doc.moveDown(1);

        const startX = 30;
        let currentY = doc.y;
        const colX = [30, 60, 110, 195, 245, 295, 395, 465];
        const colW = [30, 50,  85,  50,  50, 100,  70, 100];
        const headers = ['ลำดับ', 'รหัสสถานี', 'ชื่อสถานี', 'พร้อมใช้งาน', 'ความสะอาด', 'อุปกรณ์ที่ชำรุด', 'หมายเหตุ', 'ข้อคิดเห็นกรรมการ'];

        const drawTableHeader = (yPos) => {
            doc.fillColor('black').font('ThaiBold').fontSize(9);
            doc.rect(startX, yPos, 535, 25).fillAndStroke('#f0f0f0', 'black');
            doc.fillColor('black');

            headers.forEach((h, i) => {
                doc.text(safeText(h), colX[i], yPos + 6, { width: colW[i], align: 'center' });
                if (i > 0) doc.moveTo(colX[i], yPos).lineTo(colX[i], yPos + 25).stroke();
            });
            return yPos + 25;
        };

        currentY = drawTableHeader(currentY);
        doc.font('ThaiRegular').fontSize(8);

        const isBrokenValue = (val) => {
            const v = (val || '').toString().trim().toLowerCase();
            return v === 'o' || v === 'ชำรุด' || v === '0' || v === 'ไม่ผ่าน' || v === 'ไม่ถูกต้อง';
        };

        inspections.forEach((item, index) => {
            let brokenList = [];
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

            const h1 = doc.heightOfString(safeText(item.name_id || '-'), { width: colW[2] - 4 });
            const h2 = doc.heightOfString(safeText(brokenDesc), { width: colW[5] - 4 });
            const h3 = doc.heightOfString(safeText(note1), { width: colW[6] - 4 });
            const h4 = doc.heightOfString(safeText(note2), { width: colW[7] - 4 });
            const rowHeight = Math.max(h1, h2, h3, h4, 15) + 10;

            if (currentY + rowHeight > 780) {
                doc.addPage({ size: 'A4', layout: 'portrait', margin: 30 });
                currentY = drawTableHeader(30);
                doc.font('ThaiRegular').fontSize(8);
            }

            doc.rect(startX, currentY, 535, rowHeight).stroke();
            colX.forEach((x, i) => { if (i > 0) doc.moveTo(x, currentY).lineTo(x, currentY + rowHeight).stroke(); });

            const textY = currentY + 4;
            doc.fillColor('black');
            doc.text(safeText(`${index + 1}`), colX[0], textY, { width: colW[0], align: 'center' });
            doc.text(safeText(item.id_name || '-'), colX[1], textY, { width: colW[1], align: 'center' });
            doc.text(safeText(item.name_id || '-'), colX[2] + 2, textY, { width: colW[2] - 4, align: 'left' });
            doc.text(safeText(statusText), colX[3], textY, { width: colW[3], align: 'center' });
            doc.text(safeText(cleanStatus), colX[4], textY, { width: colW[4], align: 'center' });
            doc.text(safeText(brokenDesc), colX[5] + 2, textY, { width: colW[5] - 4, align: 'left' });
            doc.text(safeText(note1), colX[6] + 2, textY, { width: colW[6] - 4, align: 'left' });
            doc.text(safeText(note2), colX[7] + 2, textY, { width: colW[7] - 4, align: 'left' });

            currentY += rowHeight;
        });

        // ============================================================================
        // ส่วนที่ 2: หน้ารายงานสอบเทียบระดับน้ำและน้ำฝน (คงของเดิมไว้ 100%)
        // ============================================================================
        if (calibrations && calibrations.length > 0) {
            for (const calib of calibrations) {
                doc.addPage({ size: 'A4', layout: 'portrait', margin: 30 });
                doc.font('ThaiBold').fontSize(14).fillColor('black');
                doc.text(safeText(`1. สอบเทียบเซ็นเซอร์อุปกรณ์ตรวจวัดระดับน้ำ สถานี “${calib.myData1 || '-'}”`), 40, 40);

                doc.font('ThaiRegular').fontSize(12);
                const calibDate = calib.timestamp || calib.createdAt || new Date();
                doc.text(safeText(`วันที่บันทึกค่า ${getThaiDate(calibDate)}`), 40, 60);

                doc.font('ThaiBold').fontSize(12);
                doc.text(safeText(`ครั้งที่ 1 เวลา ${getThaiTime(calibDate)} น.`), 40, 85);

                let tY = 105;
                doc.rect(40, tY, 171, 20).stroke(); doc.rect(211, tY, 171, 20).stroke(); doc.rect(382, tY, 171, 20).stroke();
                doc.text(safeText('รูปที่ 1 ค่า ค่าแผ่นวัดระดับน้ำ'), 40, tY + 5, { width: 171, align: 'center' });
                doc.text(safeText('รูปที่ 2 ค่า RTU'), 211, tY + 5, { width: 171, align: 'center' });
                doc.text(safeText('รูปที่ 3 Website'), 382, tY + 5, { width: 171, align: 'center' });

                tY += 20;
                doc.rect(40, tY, 171, 140).stroke(); doc.rect(211, tY, 171, 140).stroke(); doc.rect(382, tY, 171, 140).stroke();
                await renderCalibImage(calib.myFileUrl, 40, tY, 171, 140);
                await renderCalibImage(calib.myFileUrl2, 211, tY, 171, 140);
                await renderCalibImage(calib.myFileUrl3, 382, tY, 171, 140);

                tY += 140;
                doc.rect(40, tY, 171, 25).stroke(); doc.rect(211, tY, 171, 25).stroke(); doc.rect(382, tY, 171, 25).stroke();
                doc.font('ThaiRegular').fillColor('red');
                doc.text(safeText(`${calib.myData4 || '-'} ม.รสม.`), 40, tY + 7, { width: 171, align: 'center' });
                doc.text(safeText(`${calib.myData5 || '-'} ม.รสม.`), 211, tY + 7, { width: 171, align: 'center' });
                doc.text(safeText(`${calib.myData6 || '-'} ม.รสม.`), 382, tY + 7, { width: 171, align: 'center' });

                tY += 40;
                doc.font('ThaiBold').fillColor('black').fontSize(12);
                doc.text(safeText(`ครั้งที่ 2 เวลา ${getThaiTime(calibDate, 10)} น.`), 40, tY);

                tY += 20;
                doc.rect(40, tY, 171, 20).stroke(); doc.rect(211, tY, 171, 20).stroke(); doc.rect(382, tY, 171, 20).stroke();
                doc.text(safeText('รูปที่ 1 ค่า ค่าแผ่นวัดระดับน้ำ'), 40, tY + 5, { width: 171, align: 'center' });
                doc.text(safeText('รูปที่ 2 ค่า RTU'), 211, tY + 5, { width: 171, align: 'center' });
                doc.text(safeText('รูปที่ 3 Website'), 382, tY + 5, { width: 171, align: 'center' });

                tY += 20;
                doc.rect(40, tY, 171, 140).stroke(); doc.rect(211, tY, 171, 140).stroke(); doc.rect(382, tY, 171, 140).stroke();
                await renderCalibImage(calib.myFileUrl4, 40, tY, 171, 140);
                await renderCalibImage(calib.myFileUrl5, 211, tY, 171, 140);
                await renderCalibImage(calib.myFileUrl6, 382, tY, 171, 140);

                tY += 140;
                doc.rect(40, tY, 171, 25).stroke(); doc.rect(211, tY, 171, 25).stroke(); doc.rect(382, tY, 171, 25).stroke();
                doc.font('ThaiRegular').fillColor('red');
                doc.text(safeText(`${calib.myData8 || '-'} ม.รสม.`), 40, tY + 7, { width: 171, align: 'center' });
                doc.text(safeText(`${calib.myData9 || '-'} ม.รสม.`), 211, tY + 7, { width: 171, align: 'center' });
                doc.text(safeText(`${calib.myData10 || '-'} ม.รสม.`), 382, tY + 7, { width: 171, align: 'center' });

                tY += 40;
                doc.font('ThaiRegular').fillColor('black');
                doc.text(safeText(`หมายเหตุ : ${calib.myData7 || '-'}`), 40, tY);

                doc.addPage({ size: 'A4', layout: 'portrait', margin: 30 });
                doc.font('ThaiBold').fontSize(14).fillColor('black');
                doc.text(safeText(`2. สอบเทียบเซ็นเซอร์อุปกรณ์ตรวจวัดค่าน้ำฝน สถานี “${calib.myData1 || '-'}”`), 40, 40);

                doc.font('ThaiRegular').fontSize(12);
                doc.text(safeText(`วันที่บันทึกค่า ${getThaiDate(calibDate)}`), 40, 60);
                doc.text(safeText(`ครั้งที่ 1 เวลา ${getThaiTime(calibDate)} น.`), 40, 80);
                doc.text(safeText(`จำนวนเคาะจากกระบอกน้ำฝน ${calib.myData11 || '-'} ครั้ง`), 40, 100);

                let rY = 125;
                doc.font('ThaiBold').fontSize(12);
                doc.rect(40, rY, 256, 20).stroke(); doc.rect(296, rY, 256, 20).stroke();
                doc.text(safeText('รูปที่ 1 ค่า RTU'), 40, rY + 5, { width: 256, align: 'center' });
                doc.text(safeText('รูปที่ 2 ค่า Website'), 296, rY + 5, { width: 256, align: 'center' });

                rY += 20;
                doc.rect(40, rY, 256, 220).stroke(); doc.rect(296, rY, 256, 220).stroke();
                await renderCalibImage(calib.myFileUrl7, 40, rY, 256, 220);
                await renderCalibImage(calib.myFileUrl8, 296, rY, 256, 220);

                rY += 220;
                doc.rect(40, rY, 256, 25).stroke(); doc.rect(296, rY, 256, 25).stroke();
                doc.font('ThaiRegular').fillColor('red');
                doc.text(safeText(`${calib.myData12 || '-'} มม.`), 40, rY + 7, { width: 256, align: 'center' });
                doc.text(safeText(`${calib.myData13 || '-'} มม.`), 296, rY + 7, { width: 256, align: 'center' });

                rY += 40;
                doc.font('ThaiRegular').fillColor('black');
                doc.text(safeText(`หมายเหตุ : (${calib.myData14 || '-'})`), 40, rY);
            }
        }

        // ============================================================================
        // รวบรวมรายชื่อสถานีทั้งหมดที่เกี่ยวข้องเพื่อสร้างรายงานส่วนที่ 3 และ ส่วนที่ 4
        // ============================================================================
        const stationSet = new Map();

        inspections.forEach(ins => {
            const code = normalizeCode(ins.id_name);
            if (code && !stationSet.has(code)) {
                stationSet.set(code, {
                    code: ins.id_name || code,
                    name: ins.name_id || code,
                    basin: ins.code || basin
                });
            }
        });

        equipmentChecks.forEach(ec => {
            const code = normalizeCode(ec.station_code);
            if (code && !stationSet.has(code)) {
                stationSet.set(code, {
                    code: ec.station_code || code,
                    name: ec.station_name || code,
                    basin: ec.basin || basin
                });
            }
        });

        // ============================================================================
        // ส่วนที่ 3: ตารางประวัติครุภัณฑ์ประจำสถานี 4 งวด (ตามไฟล์ตัวอย่างรายงาน.pdf)
        // ดึงข้อมูลจาก mam_equipment และ EquipmentCheck (report_mam_equipment.html)
        // ============================================================================
        for (const [normCode, stInfo] of stationSet.entries()) {
            const stChecks = equipmentChecks.filter(ec => normalizeCode(ec.station_code) === normCode);
            const stMamBase = mamEquipments.filter(m => normalizeCode(m.station_id || m.station_code) === normCode);

            const periodChecks = { '1': null, '2': null, '3': null, '4': null };
            stChecks.forEach(chk => {
                const pNum = parsePeriodNum(chk.period);
                if (['1', '2', '3', '4'].includes(pNum) && !periodChecks[pNum]) {
                    periodChecks[pNum] = chk;
                }
            });

            doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });

            doc.font('ThaiBold').fontSize(12).fillColor('#0f172a');
            doc.text(safeText(`ตารางประวัติครุภัณฑ์และผลการตรวจสอบอุปกรณ์ประจำสถานี (ฐานข้อมูล MAM) — สถานี ${stInfo.code} (${stInfo.name})`), 20, 18, { align: 'center', width: 802 });
            doc.font('ThaiRegular').fontSize(9).fillColor('#334155');
            doc.text(safeText(`ลุ่มน้ำ: ${stInfo.basin === 'all' ? '-' : stInfo.basin}   |   ปีงบประมาณ: ${contractYear || '-'}`), 20, 34, { align: 'center', width: 802 });

            const tStartX = 20;
            let tY = 50;

            const cWidths = [22, 110, 42, 48, 42, 48, 42, 48, 42, 48, 42, 48, 42, 48, 42, 48, 40];
            const cX = [];
            let accX = tStartX;
            cWidths.forEach(w => { cX.push(accX); accX += w; });
            const totalW = accX - tStartX;

            const drawMamHistoryHeader = (y) => {
                doc.font('ThaiBold').fontSize(6.5).fillColor('black');
                doc.rect(tStartX, y, totalW, 28).fillAndStroke('#e2e8f0', '#334155');
                doc.fillColor('black');

                doc.text(safeText('ลำดับ'), cX[0], y + 10, { width: cWidths[0], align: 'center' });
                doc.text(safeText('รายการอุปกรณ์'), cX[1], y + 10, { width: cWidths[1], align: 'center' });

                const pStarts = [2, 6, 10, 14];
                pStarts.forEach((colIdx, pIdx) => {
                    const groupX = cX[colIdx];
                    const groupW = (colIdx === 14)
                        ? (cWidths[14] + cWidths[15] + cWidths[16])
                        : (cWidths[colIdx] + cWidths[colIdx + 1] + cWidths[colIdx + 2] + cWidths[colIdx + 3]);

                    doc.moveTo(groupX, y).lineTo(groupX, y + 28).stroke();
                    doc.text(safeText(`ประวัติครุภัณฑ์ งวด ${pIdx + 1}`), groupX, y + 3, { width: groupW, align: 'center' });
                    doc.moveTo(groupX, y + 13).lineTo(groupX + groupW, y + 13).stroke();

                    if (colIdx < 14) {
                        const subLabels = ['ยี่ห้อ', 'รุ่น', 'Serial No.', 'หมายเหตุ/วันที่'];
                        subLabels.forEach((lbl, sIdx) => {
                            const scX = cX[colIdx + sIdx];
                            const scW = cWidths[colIdx + sIdx];
                            if (sIdx > 0) doc.moveTo(scX, y + 13).lineTo(scX, y + 28).stroke();
                            doc.fontSize(6).text(safeText(lbl), scX, y + 17, { width: scW, align: 'center' });
                        });
                    } else {
                        const subLabels4 = ['ยี่ห้อ/รุ่น', 'Serial No.', 'หมายเหตุ/วันที่'];
                        subLabels4.forEach((lbl, sIdx) => {
                            const scX = cX[14 + sIdx];
                            const scW = cWidths[14 + sIdx];
                            if (sIdx > 0) doc.moveTo(scX, y + 13).lineTo(scX, y + 28).stroke();
                            doc.fontSize(6).text(safeText(lbl), scX, y + 17, { width: scW, align: 'center' });
                        });
                    }
                });

                doc.moveTo(cX[1], y).lineTo(cX[1], y + 28).stroke();
                return y + 28;
            };

            tY = drawMamHistoryHeader(tY);

            STANDARD_12_EQUIPMENT_ROWS.forEach((rowDef) => {
                const rowH = 11.2;
                if (tY + rowH > 555) {
                    doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
                    tY = drawMamHistoryHeader(20);
                }

                if (rowDef.isHeader) {
                    doc.rect(tStartX, tY, totalW, rowH).fillAndStroke('#f8fafc', '#64748b');
                } else {
                    doc.rect(tStartX, tY, totalW, rowH).stroke('#94a3b8');
                }

                cX.forEach((x, idx) => {
                    if (idx > 0) doc.moveTo(x, tY).lineTo(x, tY + rowH).stroke('#cbd5e1');
                });

                doc.fillColor('#0f172a').font(rowDef.isHeader ? 'ThaiBold' : 'ThaiRegular').fontSize(6.2);
                doc.text(safeText(rowDef.no || ''), cX[0], tY + 2, { width: cWidths[0], align: 'center' });
                doc.text(safeText(rowDef.name), cX[1] + 3, tY + 2, { width: cWidths[1] - 4, align: 'left', lineBreak: false });

                if (!rowDef.isHeader) {
                    const baseItem = matchEquipmentToRow(stMamBase, rowDef);

                    ['1', '2', '3'].forEach((pKey, pIdx) => {
                        const baseCol = 2 + pIdx * 4;
                        const chkDoc = periodChecks[pKey];
                        const chkItem = chkDoc ? matchEquipmentToRow(chkDoc.items || [], rowDef) : null;
                        const itemToUse = chkItem || baseItem;

                        if (itemToUse) {
                            const brand = String(itemToUse.brand || '-').substring(0, 12);
                            const model = String(itemToUse.model || '-').substring(0, 14);
                            const sn = String(itemToUse.serial_number || '-').substring(0, 14);
                            let statusNote = '-';
                            if (chkItem) {
                                const st = chkItem.inspected_status || chkItem.mam_status || 'ปกติ';
                                const dStr = getShortThaiDate(chkDoc.timestamp);
                                statusNote = `${st} (${dStr})`;
                            } else if (baseItem && pKey === '1') {
                                statusNote = baseItem.mam_status || 'ทะเบียน MAM';
                            }

                            doc.font('ThaiRegular').fontSize(5.5).fillColor('#1e293b');
                            doc.text(safeText(brand), cX[baseCol] + 1, tY + 2, { width: cWidths[baseCol] - 2, align: 'center', lineBreak: false });
                            doc.text(safeText(model), cX[baseCol + 1] + 1, tY + 2, { width: cWidths[baseCol + 1] - 2, align: 'center', lineBreak: false });
                            doc.text(safeText(sn), cX[baseCol + 2] + 1, tY + 2, { width: cWidths[baseCol + 2] - 2, align: 'center', lineBreak: false });

                            const isBad = statusNote.includes('ชำรุด');
                            doc.fillColor(isBad ? '#dc2626' : '#0f172a');
                            doc.text(safeText(statusNote), cX[baseCol + 3] + 1, tY + 2, { width: cWidths[baseCol + 3] - 2, align: 'center', lineBreak: false });
                        }
                    });

                    // งวดที่ 4
                    const chkDoc4 = periodChecks['4'];
                    const chkItem4 = chkDoc4 ? matchEquipmentToRow(chkDoc4.items || [], rowDef) : null;
                    const item4 = chkItem4 || baseItem;
                    if (item4 && chkItem4) {
                        const bm = `${item4.brand || '-'}/${item4.model || '-'}`.substring(0, 14);
                        const sn = String(item4.serial_number || '-').substring(0, 14);
                        const st = chkItem4.inspected_status || 'ปกติ';
                        const dStr = getShortThaiDate(chkDoc4.timestamp);
                        doc.font('ThaiRegular').fontSize(5.5).fillColor('#1e293b');
                        doc.text(safeText(bm), cX[14] + 1, tY + 2, { width: cWidths[14] - 2, align: 'center', lineBreak: false });
                        doc.text(safeText(sn), cX[15] + 1, tY + 2, { width: cWidths[15] - 2, align: 'center', lineBreak: false });
                        doc.text(safeText(`${st} (${dStr})`), cX[16] + 1, tY + 2, { width: cWidths[16] - 2, align: 'center', lineBreak: false });
                    }
                }

                tY += rowH;
            });

            doc.font('ThaiBold').fontSize(7.5).fillColor('#334155');
            doc.text(safeText('ภาคผนวก : ข้อมูลทะเบียนอุปกรณ์ซิงก์จากระบบ MAM อัตโนมัติ และบันทึกผลการตรวจเช็ครายงวดโดยคณะกรรมการตรวจรับพัสดุ'), tStartX, tY + 5);
        }

        // ============================================================================
        // ส่วนที่ 4: รายงานผลการตรวจสอบอุปกรณ์สนามรายสถานี (จาก report_inspection.html)
        // สำหรับคณะกรรมการตรวจรับพัสดุใช้แนบเป็นหลักฐานตรวจรับงานพร้อมช่องลงนาม
        // ============================================================================
        for (const item of inspections) {
            doc.addPage({ size: 'A4', layout: 'portrait', margin: 30 });

            const stCode = item.id_name || '-';
            const stName = item.name_id || '-';
            const normSt = normalizeCode(stCode);
            const torDoc = torChecks.find(t => normalizeCode(t.station_id) === normSt);

            // กรอบหัวกระดาษทางการ
            doc.rect(30, 30, 535, 52).fillAndStroke('#f8fafc', '#1e293b');
            doc.font('ThaiBold').fontSize(13).fillColor('#0f172a');
            doc.text(safeText('แบบฟอร์มบันทึกผลการตรวจสอบอุปกรณ์สนามและตรวจรับงานรายสถานี (สำหรับคณะกรรมการ)'), 35, 36, { width: 525, align: 'center' });
            doc.font('ThaiRegular').fontSize(9.5).fillColor('#334155');
            doc.text(safeText(`โครงการบำรุงรักษาสถานีโทรมาตร กรมชลประทาน  |  งวดงาน: ${item.saya || term}  |  วันที่ตรวจ: ${getThaiDate(item.timestamp || item.createdAt)}`), 35, 56, { width: 525, align: 'center' });

            // กล่องข้อมูลสถานี
            let yPos = 90;
            doc.rect(30, yPos, 535, 42).stroke('#94a3b8');
            doc.font('ThaiBold').fontSize(9.5).fillColor('#0f172a');
            doc.text(safeText(`รหัสสถานี: ${stCode}`), 38, yPos + 6);
            doc.text(safeText(`ชื่อสถานี: ${stName}`), 170, yPos + 6);
            doc.text(safeText(`กลุ่มลุ่มน้ำ: ${item.code || basin}`), 410, yPos + 6);

            doc.font('ThaiRegular').fontSize(8.5).fillColor('#334155');
            const latLonStr = (item.lat && item.lon) ? `${item.lat}, ${item.lon}` : 'ไม่ระบุ';
            doc.text(safeText(`พิกัด GPS: ${latLonStr}  |  สถานที่: ${(item.geoAddress || '-').substring(0, 75)}`), 38, yPos + 23);

            // ตาราง 체크ลิสต์ 26 รายการจาก report_inspection.html (แบ่ง 2 คอลัมน์ซ้าย-ขวา)
            yPos += 52;
            doc.font('ThaiBold').fontSize(10).fillColor('#0f172a');
            doc.text(safeText('1. ผลการตรวจสอบสภาพสถานีและอุปกรณ์สนาม (ข้อมูลจากระบบตรวจอุปกรณ์สนาม)'), 30, yPos);
            yPos += 16;

            const keysList = equipmentMap ? Object.keys(equipmentMap) : [];
            const half = Math.ceil(keysList.length / 2);

            const drawEquipGridSide = (startXPos, startYPos, sliceKeys, startIdx) => {
                doc.rect(startXPos, startYPos, 262, 18).fillAndStroke('#e2e8f0', '#475569');
                doc.font('ThaiBold').fontSize(8).fillColor('black');
                doc.text(safeText('ลำดับ'), startXPos, startYPos + 4, { width: 28, align: 'center' });
                doc.text(safeText('รายการตรวจสอบ'), startXPos + 30, startYPos + 4, { width: 155, align: 'left' });
                doc.text(safeText('ผลการตรวจ'), startXPos + 185, startYPos + 4, { width: 75, align: 'center' });

                let curY = startYPos + 18;
                sliceKeys.forEach((k, idx) => {
                    const label = equipmentMap[k] || k;
                    const rawVal = item[k];
                    const broken = isBrokenValue(rawVal);
                    const statusStr = broken ? 'ชำรุด / ไม่ผ่าน' : 'ปกติ / ผ่าน';

                    doc.rect(startXPos, curY, 262, 15).stroke('#cbd5e1');
                    doc.font('ThaiRegular').fontSize(7.5).fillColor('#0f172a');
                    doc.text(safeText(`${startIdx + idx + 1}`), startXPos, curY + 3, { width: 28, align: 'center' });
                    doc.text(safeText(label), startXPos + 32, curY + 3, { width: 150, align: 'left' });

                    doc.font('ThaiBold').fillColor(broken ? '#dc2626' : '#15803d');
                    doc.text(safeText(statusStr), startXPos + 185, curY + 3, { width: 75, align: 'center' });
                    curY += 15;
                });
                return curY;
            };

            const leftBottomY = drawEquipGridSide(30, yPos, keysList.slice(0, half), 0);
            const rightBottomY = drawEquipGridSide(303, yPos, keysList.slice(half), half);
            yPos = Math.max(leftBottomY, rightBottomY) + 10;

            // สรุปผลการประเมินตาม TOR และหมายเหตุหน้างาน
            doc.font('ThaiBold').fontSize(10).fillColor('#0f172a');
            doc.text(safeText('2. สรุปผลการตรวจรับงานตาม TOR และข้อคิดเห็นคณะกรรมการ'), 30, yPos);
            yPos += 15;

            doc.rect(30, yPos, 535, 58).fillAndStroke('#f8fafc', '#94a3b8');
            doc.font('ThaiBold').fontSize(8.5).fillColor('#0f172a');
            doc.text(safeText(`หมายเหตุผู้ตรวจสอบ (หน้างาน): `), 38, yPos + 6, { continued: true })
               .font('ThaiRegular').text(safeText(item.note || '-'));

            doc.font('ThaiBold').text(safeText(`ข้อคิดเห็นกรรมการตรวจรับ: `), 38, yPos + 22, { continued: true })
               .font('ThaiRegular').text(safeText(item.note2 || (torDoc ? torDoc.committee_note : '-') || '-'));

            let torSummaryStr = 'ผ่านเกณฑ์การตรวจรับตามเงื่อนไข TOR (ทำความสะอาด, สอบเทียบ, ตรวจสอบอุปกรณ์)';
            if (torDoc && Array.isArray(torDoc.evaluations) && torDoc.evaluations.length > 0) {
                torSummaryStr = torDoc.evaluations.map(ev => `${ev.task_name}: ${ev.result || 'ผ่าน'}`).join('  |  ');
            }
            doc.font('ThaiBold').text(safeText(`สรุปผลประเมิน TOR: `), 38, yPos + 38, { continued: true })
               .font('ThaiRegular').fillColor('#0369a1').text(safeText(torSummaryStr));

            yPos += 68;

            // แสดงรูปภาพประกอบการตรวจสอบสถานี (สูงสุด 4 รูปจาก item.photos)
            doc.font('ThaiBold').fontSize(10).fillColor('#0f172a');
            doc.text(safeText('3. ประมวลภาพถ่ายการปฏิบัติงานและตรวจสอบอุปกรณ์ประจำสถานี'), 30, yPos);
            yPos += 15;

            const photos = Array.isArray(item.photos) ? item.photos.slice(0, 4) : [];
            const boxW = 128;
            const boxH = 92;
            for (let pIdx = 0; pIdx < 4; pIdx++) {
                const bx = 30 + pIdx * (boxW + 7.5);
                doc.rect(bx, yPos, boxW, boxH).stroke('#94a3b8');
                const ph = photos[pIdx];
                const phUrl = ph ? (ph.thumbnailUrl || ph.webViewLink || ph.url || '') : '';
                if (phUrl) {
                    await renderCalibImage(phUrl, bx, yPos, boxW, boxH);
                } else {
                    doc.font('ThaiRegular').fontSize(7.5).fillColor('#94a3b8')
                       .text(safeText(`รูปประกอบที่ ${pIdx + 1}`), bx, yPos + 40, { width: boxW, align: 'center' });
                }
            }

            yPos += boxH + 22;

            // ช่องลงนามคณะกรรมการตรวจรับพัสดุ
            if (yPos + 80 <= 810) {
                const sigW = 170;
                const sigPositions = [35, 212, 390];
                const sigRoles = ['ประธานกรรมการตรวจรับพัสดุ', 'กรรมการตรวจรับพัสดุ', 'กรรมการหรือตัวแทนกรรมการ'];

                sigPositions.forEach((sx, sIdx) => {
                    doc.font('ThaiRegular').fontSize(8.5).fillColor('#0f172a');
                    doc.text(safeText('ลงชื่อ ......................................................'), sx, yPos + 15, { width: sigW, align: 'center' });
                    doc.text(safeText('( ...................................................... )'), sx, yPos + 32, { width: sigW, align: 'center' });
                    doc.font('ThaiBold').fontSize(8.5).text(safeText(sigRoles[sIdx]), sx, yPos + 48, { width: sigW, align: 'center' });
                    doc.font('ThaiRegular').fontSize(8).text(safeText('วันที่ ......... / ......................... / .............'), sx, yPos + 63, { width: sigW, align: 'center' });
                });
            }
        }

        doc.end();
    } catch (error) {
        console.error('PDF Generation Error:', error);
        if (!res.headersSent) res.status(500).send('เกิดข้อผิดพลาดในการสร้าง PDF: ' + error.message);
    }
}

module.exports = {
    generateInspectionPDF
};