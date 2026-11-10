require('dotenv').config();
const axios = require('axios');
const { parse } = require('csv-parse'); // เปลี่ยนเป็นแบบ Stream
const mongoose = require('mongoose');

// ==========================================
// 1. ตั้งค่า Mongoose Models
// ==========================================
const flexible = (collection) => new mongoose.Schema({}, { strict: false, collection });

const Equipment = mongoose.models.MamEquipment || mongoose.model('MamEquipment', flexible('mam_equipment'));
const TorTask = mongoose.models.MamTorTask || mongoose.model('MamTorTask', flexible('mam_tor_tasks'));

const MamSyncMetaSchema = new mongoose.Schema({
    file_name: { type: String, unique: true },
    etag: String,
    last_generated_at: String,
    last_synced_at: Date,
    row_count: Number
}, { collection: 'mam_sync_meta' });

const MamSyncMeta = mongoose.models.MamSyncMeta || mongoose.model('MamSyncMeta', MamSyncMetaSchema);

// ==========================================
// 2. ฟังก์ชันจัดการและทำความสะอาดข้อมูล CSV
// ==========================================
function cleanExcelFormulaEscape(val) {
    if (typeof val !== 'string') return val;
    const trimmed = val.trim();
    if (/^'+$/.test(trimmed) || /^-+$/.test(trimmed)) return trimmed;
    if (trimmed.length >= 2 && trimmed.startsWith("'") && /^[=+\-@]/.test(trimmed.substring(1))) {
        return trimmed.substring(1);
    }
    return trimmed;
}

function sanitizeRow(row) {
    const cleaned = {};
    for (const key of Object.keys(row)) {
        const cleanKey = key.trim();
        cleaned[cleanKey] = cleanExcelFormulaEscape(row[key]);
    }
    return cleaned;
}

// ==========================================
// 3. ฟังก์ชันเชื่อมต่อ MAM
// ==========================================
const getMamAxios = () => {
    const baseURL = process.env.MAM_BASE_URL || 'https://mam.decode.co.th/api/integration/v1/';
    const apiKey = process.env.MAM_API_KEY || '';
    return axios.create({
        baseURL: baseURL.endsWith('/') ? baseURL : `${baseURL}/`,
        headers: { Authorization: `Bearer ${apiKey}` },
        responseType: 'stream', // โหลดไฟล์แบบ Stream เพื่อแก้ปัญหา RAM เต็ม
        timeout: 120000, // เพิ่มเวลาเผื่อดาวน์โหลดไฟล์ใหญ่
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    });
};

// ==========================================
// 4. ฟังก์ชันนำเข้าข้อมูลแบบ Stream (ประหยัด RAM)
// ==========================================
const processCsvStream = async (fileName, Model, keyOf, scope = {}, useEtag = true) => {
    if (!process.env.MAM_API_KEY) {
        throw new Error('ยังไม่ได้ตั้งค่า MAM_API_KEY ใน Environment Variable');
    }

    const headers = {};
    let meta = null;

    if (useEtag) {
        meta = await MamSyncMeta.findOne({ file_name: fileName }).lean();
        if (meta && meta.etag) {
            headers['If-None-Match'] = meta.etag;
        }
    }

    console.log(`[SYNC] กำลังเชื่อมต่อ MAM API เพื่อดึงไฟล์ ${fileName}...`);
    
    let response;
    try {
        response = await getMamAxios().get(fileName, { headers });
    } catch (error) {
        throw new Error(`โหลดไฟล์ ${fileName} ไม่สำเร็จ: ${error.message}`);
    }

    if (response.status === 304) {
        console.log(`[SYNC] ไฟล์ ${fileName} ไม่มีการเปลี่ยนแปลง (304 Not Modified)`);
        const count = await Model.countDocuments(scope);
        return { status: 'not_modified_304', count };
    }

    const newEtag = response.headers['etag'] || response.headers['ETag'] || null;
    let rowCount = 0;
    let generatedAt = null;
    const batchSize = 1000; // ทยอยเขียนลงฐานข้อมูลทีละ 1000 แถว
    let bulkOps = [];

    console.log(`[SYNC] เริ่มอ่านและประมวลผลไฟล์ ${fileName} แบบ Stream...`);

    return new Promise((resolve, reject) => {
        const parser = parse({
            bom: true,
            columns: true,
            skip_empty_lines: true,
            relax_quotes: true
        });

        response.data.pipe(parser)
            .on('data', async (rawRow) => {
                const row = sanitizeRow(rawRow);
                if (!generatedAt && row.generated_at) {
                    generatedAt = row.generated_at;
                }
                
                bulkOps.push({
                    replaceOne: {
                        filter: keyOf(row),
                        replacement: row,
                        upsert: true
                    }
                });
                
                rowCount++;

                // หากครบ 1000 แถว ให้พักการอ่าน (pause) เขียนลงฐานข้อมูล แล้วค่อยอ่านต่อ (resume)
                if (bulkOps.length >= batchSize) {
                    parser.pause();
                    const opsToExecute = [...bulkOps];
                    bulkOps = [];
                    
                    Model.bulkWrite(opsToExecute).then(() => {
                        parser.resume();
                    }).catch(err => {
                        parser.destroy(err);
                    });
                }
            })
            .on('error', (err) => {
                console.error(`❌ ข้อผิดพลาดขณะอ่าน CSV ${fileName}:`, err.message);
                reject(err);
            })
            .on('end', async () => {
                try {
                    // เขียนข้อมูลส่วนที่เหลือ (เศษที่ยังไม่ครบ 1000)
                    if (bulkOps.length > 0) {
                        await Model.bulkWrite(bulkOps);
                    }

                    if (rowCount === 0) {
                        return reject(new Error(`ไฟล์ ${fileName} ไม่มีข้อมูล (ว่างเปล่า)`));
                    }

                    if (!generatedAt) {
                        return reject(new Error(`ไม่พบคอลัมน์ generated_at ในไฟล์ ${fileName}`));
                    }

                    // ลบข้อมูลแถวเก่าที่ไม่มีในไฟล์รอบนี้
                    console.log(`[SYNC] ประมวลผล ${fileName} ครบ ${rowCount} แถว กำลังล้างข้อมูลเก่า...`);
                    await Model.deleteMany({ ...scope, generated_at: { $ne: generatedAt } });

                    // บันทึกสถานะ ETag
                    await MamSyncMeta.findOneAndUpdate(
                        { file_name: fileName },
                        {
                            etag: newEtag,
                            last_generated_at: generatedAt,
                            last_synced_at: new Date(),
                            row_count: rowCount
                        },
                        { upsert: true }
                    );

                    console.log(`✅ นำเข้า ${fileName} สำเร็จ (${rowCount} รายการ)`);
                    resolve({ status: 'imported_200', count: rowCount });
                } catch (err) {
                    reject(err);
                }
            });
    });
};

const importFromMam = async (year = 2569, options = { force: false }) => {
    const useEtag = !options.force;
    const resultSummary = {
        year: String(year),
        equipment: { status: 'pending', count: 0 },
        tasks: { status: 'pending', count: 0 },
        syncedAt: new Date().toISOString()
    };

    try {
        resultSummary.equipment = await processCsvStream(
            'equipment.csv',
            Equipment,
            (row) => ({ equipment_id: String(row.equipment_id) }),
            {},
            useEtag
        );
    } catch (err) {
        resultSummary.equipment = { status: 'error', error: err.message };
        console.error(err);
    }

    try {
        resultSummary.tasks = await processCsvStream(
            `tor-tasks-${year}.csv`,
            TorTask,
            (row) => ({ mam_record_id: String(row.mam_record_id), task_key: String(row.task_key) }),
            { contract_year: String(year) },
            useEtag
        );
    } catch (err) {
        resultSummary.tasks = { status: 'error', error: err.message };
        console.error(err);
    }

    return resultSummary;
};

module.exports = {
    Equipment,
    TorTask,
    MamSyncMeta,
    cleanExcelFormulaEscape,
    sanitizeRow,
    importFromMam
};