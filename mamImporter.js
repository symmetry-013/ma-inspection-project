require('dotenv').config();
const axios = require('axios');
const { parse } = require('csv-parse/sync');
const mongoose = require('mongoose');

// ==========================================
// 1. ตั้งค่า Mongoose Models (mam_equipment และ mam_tor_tasks)
// ==========================================
const flexible = (collection) => new mongoose.Schema({}, { strict: false, collection });

const Equipment = mongoose.models.MamEquipment || mongoose.model('MamEquipment', flexible('mam_equipment'));
const TorTask = mongoose.models.MamTorTask || mongoose.model('MamTorTask', flexible('mam_tor_tasks'));

// เก็บค่า ETag ของแต่ละไฟล์เพื่อส่ง If-None-Match ลดภาระการโหลดซ้ำ (304 Not Modified)
const MamSyncMetaSchema = new mongoose.Schema({
    file_name: { type: String, unique: true },
    etag: String,
    last_generated_at: String,
    last_synced_at: Date,
    row_count: Number
}, { collection: 'mam_sync_meta' });

const MamSyncMeta = mongoose.models.MamSyncMeta || mongoose.model('MamSyncMeta', MamSyncMetaSchema);

// ==========================================
// 2. ฟังก์ชันจัดการและทำความสะอาดข้อมูล CSV ตามสเปก MAM
// ==========================================
// กติกา: ค่าที่ขึ้นต้นด้วย = + - @ จะมี ' นำหน้า (เช่น '-999) ให้ตัด ' ออกก่อนแสดงผล ยกเว้นค่าที่เป็นขีดล้วน (- หรือ ----)
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
// 3. ฟังก์ชันเชื่อมต่อและดาวน์โหลดไฟล์ CSV จากระบบ MAM
// ==========================================
const mam = () => {
    const baseURL = process.env.MAM_BASE_URL || 'https://mam.decode.co.th/api/integration/v1/';
    const apiKey = process.env.MAM_API_KEY || '';
    return axios.create({
        baseURL: baseURL.endsWith('/') ? baseURL : `${baseURL}/`,
        headers: { Authorization: `Bearer ${apiKey}` },
        responseType: 'text',
        timeout: 60000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    });
};

const download = async (file, useEtag = true) => {
    if (!process.env.MAM_API_KEY) {
        throw new Error('ยังไม่ได้ตั้งค่า MAM_API_KEY ใน Environment Variable');
    }

    const headers = {};
    let meta = null;

    if (useEtag) {
        meta = await MamSyncMeta.findOne({ file_name: file }).lean();
        if (meta && meta.etag) {
            headers['If-None-Match'] = meta.etag;
        }
    }

    try {
        const response = await mam().get(file, { headers });

        // กรณี 304: ไฟล์ไม่เปลี่ยนแปลง ข้ามการนำเข้าในรอบนี้ได้ทันที
        if (response.status === 304) {
            return { notModified: true, rows: [], etag: meta ? meta.etag : null };
        }

        const rawRows = parse(response.data, {
            bom: true,
            columns: true,
            skip_empty_lines: true,
            relax_quotes: true
        });

        const rows = rawRows.map(sanitizeRow);
        const newEtag = response.headers['etag'] || response.headers['ETag'] || null;

        return { notModified: false, rows, etag: newEtag };
    } catch (error) {
        if (error.response) {
            const status = error.response.status;
            let errBody = error.response.data;
            try {
                if (typeof errBody === 'string') errBody = JSON.parse(errBody);
            } catch (_) {}
            const code = (errBody && errBody.code) ? errBody.code : `HTTP_${status}`;
            const msg = (errBody && errBody.error) ? errBody.error : error.message;
            const retryAfter = error.response.headers ? error.response.headers['retry-after'] : null;
            throw new Error(`โหลดไฟล์ ${file} ไม่สำเร็จ [${status} ${code}]: ${msg}${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ''}`);
        }
        throw error;
    }
};

// ==========================================
// 4. ฟังก์ชันนำเข้าข้อมูลลง MongoDB แบบแทนที่ทั้งชุด (Replace All)
// ==========================================
// เขียนแถวใหม่ก่อน แล้วค่อยลบแถวเก่า ถ้าล้มเหลวกลางทาง Collection จะไม่ว่างเปล่า
const replaceAll = async (Model, rows, keyOf, scope = {}) => {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('ไฟล์ไม่มีข้อมูล (มีแต่หัวตารางหรือว่างเปล่า) จึงยกเลิกการแทนที่เพื่อรักษาข้อมูลเดิม');
    }

    const generatedAt = rows[0].generated_at;
    if (!generatedAt) {
        throw new Error('ไม่พบคอลัมน์ generated_at ในไฟล์ CSV');
    }

    await Model.bulkWrite(
        rows.map((row) => ({
            replaceOne: {
                filter: keyOf(row),
                replacement: row,
                upsert: true
            }
        }))
    );

    await Model.deleteMany({ ...scope, generated_at: { $ne: generatedAt } });
    return rows.length;
};

// ฟังก์ชันหลักสำหรับดึงและนำเข้าทั้ง equipment.csv และ tor-tasks-<year>.csv
const importFromMam = async (year = 2569, options = { force: false }) => {
    const useEtag = !options.force;
    const resultSummary = {
        year: String(year),
        equipment: { status: 'pending', count: 0 },
        tasks: { status: 'pending', count: 0 },
        syncedAt: new Date().toISOString()
    };

    // 1. นำเข้าไฟล์ equipment.csv
    const equipFile = 'equipment.csv';
    const equipDownload = await download(equipFile, useEtag);
    if (equipDownload.notModified) {
        const count = await Equipment.countDocuments();
        resultSummary.equipment = { status: 'not_modified_304', count };
    } else {
        const count = await replaceAll(
            Equipment,
            equipDownload.rows,
            (row) => ({ equipment_id: String(row.equipment_id) })
        );
        await MamSyncMeta.findOneAndUpdate(
            { file_name: equipFile },
            {
                etag: equipDownload.etag,
                last_generated_at: equipDownload.rows[0]?.generated_at || '',
                last_synced_at: new Date(),
                row_count: count
            },
            { upsert: true }
        );
        resultSummary.equipment = { status: 'imported_200', count };
    }

    // 2. นำเข้าไฟล์ tor-tasks-<year>.csv
    const taskFile = `tor-tasks-${year}.csv`;
    const taskDownload = await download(taskFile, useEtag);
    if (taskDownload.notModified) {
        const count = await TorTask.countDocuments({ contract_year: String(year) });
        resultSummary.tasks = { status: 'not_modified_304', count };
    } else {
        const count = await replaceAll(
            TorTask,
            taskDownload.rows,
            (row) => ({ mam_record_id: String(row.mam_record_id), task_key: String(row.task_key) }),
            { contract_year: String(year) }
        );
        await MamSyncMeta.findOneAndUpdate(
            { file_name: taskFile },
            {
                etag: taskDownload.etag,
                last_generated_at: taskDownload.rows[0]?.generated_at || '',
                last_synced_at: new Date(),
                row_count: count
            },
            { upsert: true }
        );
        resultSummary.tasks = { status: 'imported_200', count };
    }

    return resultSummary;
};

module.exports = {
    Equipment,
    TorTask,
    MamSyncMeta,
    cleanExcelFormulaEscape,
    sanitizeRow,
    download,
    replaceAll,
    importFromMam
};