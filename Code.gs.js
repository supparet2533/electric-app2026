// ============================================================================
// ⚡ PEA SMART GRID - HYPER-SCALE BACKEND ENGINE v6.5 (Final Zero-Bug Edition)
// รองรับแยกชีตตาม กฟส. + ล็อกสิทธิ์โทเคน HMAC-SHA256 + ซิงค์ใบมิเตอร์รหัสลับ 4 ช่อง
// + ชีตบันทึกสุขภาพระบบ SystemLogs + Fail-Fast Concurrency Lock + วัดโหลด TxLoad & ลบ PDF
// ============================================================================

const SHEET_USERS = 'Users';
const SHEET_GROUP_NODES = 'GroupNodes';
const SHEET_JOBS = 'Jobs';
const SHEET_TECH_STATE = 'TechState';
const SHEET_PINS = 'Pins';
const SHEET_BACKUPS = 'Backups';
const SHEET_TX_LOAD = 'TxLoad';
const SHEET_SYSTEM_LOGS = 'SystemLogs';

const MAX_TX_LOAD_PER_GROUP = 400;
const MAX_SYSTEM_LOGS = 500; // เก็บประวัติล่าสุด 500 รายการ ตัดแถวเก่าอัตโนมัติ
const SCRIPT_LOCK_WAIT_MS = 12000; // รอคิวสูงสุด 12 วินาที ป้องกันเธรดค้างเต็มโควตา Google

const MAX_CELL_CHARS = 45000;
const CACHE_TTL_SEC = 21600; // เก็บใน RAM 6 ชั่วโมง
const CACHE_CHUNK_SIZE = 24000; // ปลอดภัย 100% สำหรับภาษาไทย UTF-8 + Emoji (ไม่เกิน 100KB/คีย์)
const MAX_CACHE_CHUNKS = 100; // รองรับข้อมูลต่อพูลสูงสุด ~2.4 ล้านตัวอักษร (~4,000-5,000 หมุดพร้อมสายไฟ/สาขา)
const CACHE_BATCH_KEYS = 25; // แบ่งอ่าน-เขียนแคชทีละ 25 ก้อน ป้องกัน Error Argument too large
const MAX_PINS_BACKUP_CHARS = 1500000; // สำรองแถว PINS_SNAPSHOT_BAK อัตโนมัติในชีต Pins
const MAX_JOBS_PER_TYPE = 300; // จำกัดใบงานล่าสุดประเภทละ 300 รายการ ตรงกับหน้าเว็บ 100%
const MAX_TECH_LOC_ENTRIES = 250; // จำกัดจำนวนพิกัดช่างสะสมต่อสาขา
const STATE_SHEET_SYNC_INTERVAL_MS = 300000; // บันทึกสถานะพิกัดลงชีตทุก 5 นาทีภายใต้ Lock
const MAX_REGISTRY_AGE_MS = 35 * 24 * 60 * 60 * 1000; // ล้างทะเบียนเก่าเกิน 35 วันอัตโนมัติ
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // อายุโทเคนปลอดภัย 30 วัน

const REGISTRY_LOC_KEY = '__NAV_CANCEL_REGISTRY__';
const PM_LOC_PREFIX = '__PM_SCHEDULE__';
const PASSWORD_SALT = 'PEA_SMART_GRID_SALT_2026';
const CALIB_LOC_PREFIX = '__FAULT_CALIB__';

function getServerMqttSecret_() {
  const masterId = getMasterSpreadsheet_().getId();
  const rawKeyMat = ['PEA_MQTT_AES256_GCM_V1', PASSWORD_SALT, masterId].join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawKeyMat, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(digest); // กุญแจขนาด 256-bit (Base64) ส่งให้เฉพาะผู้ที่ล็อกอินผ่าน
}

let HAS_DIRTY_SHEET_WRITES_ = false;

const PHOTO_ROOT_FOLDER_NAME = '⚡ PEA_SmartGrid_Photos';

// ============================================================================
// 📝 ระบบบันทึกสุขภาพระบบและข้อผิดพลาด (SystemLogs Telemetry)
// ============================================================================

function sanitizeLogCell_(val, maxLen) {
  let s = String(val === undefined || val === null ? '' : val).trim();
  if (!s) return '-';
  // ปิดบังรหัสผ่าน โทเคน กุญแจลับ ข้อมูลลูกค้า เบอร์โทร และเลข CA 12 หลัก ไม่ให้หลุดลงชีต SystemLogs
  s = s.replace(/"(?:password|authToken|sessionToken|mqttKey|base64Data|phone|address|customerName|formattedText)"\s*:\s*"[^"]*"/gi, '"[REDACTED]"');
  s = s.replace(/\b0[2689]\d[\s-]*\d{3}[\s-]*\d{3,4}\b/g, '[REDACTED_TEL]');
  s = s.replace(/\b\d{12}\b/g, '[REDACTED_CA]');
  if (s.length > (maxLen || 500)) s = s.substring(0, maxLen || 500) + '...';
  if (/^[=+\-@']/.test(s)) s = "'" + s;
  return s;
}

function ensureSystemLogsSheet_() {
  const ss = getMasterSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_SYSTEM_LOGS);
  if (sh) return sh;
  try {
    sh = ss.insertSheet(SHEET_SYSTEM_LOGS);
    const hdr = sh.getRange(1, 1, 1, 7);
    hdr.setNumberFormat('@');
    hdr.setFontWeight('bold');
    hdr.setBackground('#0f172a');
    hdr.setFontColor('#ffffff');
    hdr.setValues([[
      'วันเวลา (GMT+7)',
      'ระดับ (Level)',
      'คำสั่ง (Action)',
      'สาขา (Group)',
      'ผู้ใช้งาน (User)',
      'สาเหตุหลัก (Message)',
      'รายละเอียดเชิงลึก (Details / Stack)'
    ]]);
    sh.setFrozenRows(1);
    return sh;
  } catch (e) {
    return ss.getSheetByName(SHEET_SYSTEM_LOGS);
  }
}

function logSystemEvent_(level, action, groupName, username, message, detailObj) {
  try {
    const lvl = String(level || 'ERROR').toUpperCase();
    const act = String(action || '-').trim();

    // จำกัดความถี่ WARN ไม่ให้เขียนชีตรัวซ้ำกันเกิน 1 ครั้งใน 15 วินาทีเมื่อมีคนกดพร้อมกันจำนวนมาก
    if (lvl === 'WARN') {
      const cache = CacheService.getScriptCache();
      const throttleKey = 'PEA_LOG_THROT_' + act + '_' + computeMd5Hex_(String(message || '')).substring(0, 12);
      if (cache.get(throttleKey)) return;
      cache.put(throttleKey, '1', 15);
    }

    const sh = ensureSystemLogsSheet_();
    if (!sh) return;
    const tsStr = Utilities.formatDate(new Date(), 'GMT+7', 'dd/MM/yyyy HH:mm:ss');
    let detailStr = '';
    if (detailObj) {
      if (detailObj instanceof Error) {
        detailStr = (detailObj.message || String(detailObj)) + (detailObj.stack ? '\n' + detailObj.stack : '');
      } else if (typeof detailObj === 'object') {
        detailStr = JSON.stringify(detailObj);
      } else {
        detailStr = String(detailObj);
      }
    }

    sh.appendRow([
      sanitizeLogCell_(tsStr, 30),
      sanitizeLogCell_(lvl, 15),
      sanitizeLogCell_(act, 40),
      sanitizeLogCell_(groupName || '-', 50),
      sanitizeLogCell_(username || '-', 60),
      sanitizeLogCell_(message || '-', 300),
      sanitizeLogCell_(detailStr || '-', 1200)
    ]);

    // ลบแถวเก่าอัตโนมัติเมื่อเกินเพดาน (ขอ Lock สั้นๆ 500ms เฉพาะตอนเกิน 550 แถวจริง)
    const lastRow = sh.getLastRow();
    if (lastRow > MAX_SYSTEM_LOGS + 50) {
      const trimLock = LockService.getScriptLock();
      const alreadyLocked = trimLock.hasLock();
      const gotTrimLock = alreadyLocked ? false : trimLock.tryLock(500);
      if (alreadyLocked || gotTrimLock) {
        try {
          const freshLastRow = sh.getLastRow();
          if (freshLastRow > MAX_SYSTEM_LOGS + 50) {
            sh.deleteRows(2, freshLastRow - MAX_SYSTEM_LOGS);
          }
        } finally {
          if (gotTrimLock) {
            try { trimLock.releaseLock(); } catch (e) {}
          }
        }
      }
    }
  } catch (ignoreErr) {}
}

// ============================================================================
// 📷📄 ระบบจัดเก็บภาพถ่ายหน้างานและใบรายงาน PDF แยกตาม กฟส. และเดือนบน Google Drive
// ============================================================================

function findActiveFolderByName_(parentOrDrive, folderName) {
  const iter = parentOrDrive.getFoldersByName(folderName);
  while (iter.hasNext()) {
    const f = iter.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

function getOrCreateMainPhotoRootFolder_() {
  const cache = CacheService.getScriptCache();
  const cachedId = cache.get('PEA_PHOTO_ROOT_ID');
  if (cachedId) {
    try {
      const f = DriveApp.getFolderById(cachedId);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }
  const folder = findActiveFolderByName_(DriveApp, PHOTO_ROOT_FOLDER_NAME) || DriveApp.createFolder(PHOTO_ROOT_FOLDER_NAME);
  try { cache.put('PEA_PHOTO_ROOT_ID', folder.getId(), CACHE_TTL_SEC); } catch (e) {}
  return folder;
}

function getOrCreateBranchMonthPhotoFolder_(groupName) {
  const cleanGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const ymStr = (nowBkk.getUTCFullYear() + 543) + '-' + String(nowBkk.getUTCMonth() + 1).padStart(2, '0');
  const cacheKey = 'PEA_PHDIR_' + computeMd5Hex_(cleanGrp + '_' + ymStr).substring(0, 16);
  const cache = CacheService.getScriptCache();
  const cachedId = cache.get(cacheKey);
  if (cachedId) {
    try {
      const f = DriveApp.getFolderById(cachedId);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }

  const dirLock = LockService.getScriptLock();
  const alreadyLocked = dirLock.hasLock();
  const gotLock = alreadyLocked ? false : dirLock.tryLock(8000);
  try {
    const againId = cache.get(cacheKey);
    if (againId) {
      try {
        const f2 = DriveApp.getFolderById(againId);
        if (!f2.isTrashed()) return f2;
      } catch (e) {}
    }
    const rootFolder = getOrCreateMainPhotoRootFolder_();
    const grpFolder = findActiveFolderByName_(rootFolder, cleanGrp) || rootFolder.createFolder(cleanGrp);
    const ymFolder = findActiveFolderByName_(grpFolder, ymStr) || grpFolder.createFolder(ymStr);
    try { cache.put(cacheKey, ymFolder.getId(), CACHE_TTL_SEC); } catch (e) {}
    return ymFolder;
  } finally {
    if (gotLock) { try { dirLock.releaseLock(); } catch (e) {} }
  }
}

function handleUploadJobPhoto_(payload, groupName) {
  const reqAct = String((payload && payload.action) || 'uploadFile').trim();
  try {
    const b64Input = String((payload && payload.base64Data) || '').trim();
    const commaIdx = b64Input.indexOf(',');
    const rawB64 = (b64Input.indexOf('data:') === 0 && commaIdx !== -1)
      ? b64Input.substring(commaIdx + 1).replace(/\s+/g, '')
      : b64Input.replace(/\s+/g, '');

    if (!rawB64) return { status: 'error', message: 'Empty file payload' };
    if (rawB64.length > 5500000) {
      logSystemEvent_('WARN', reqAct, groupName, payload && payload.authUser, 'ไฟล์อัปโหลดมีขนาดใหญ่เกินกำหนด', { length: rawB64.length });
      return { status: 'error', message: 'File exceeds size limit' };
    }

    const rawMime = String((payload && payload.mimeType) || 'image/jpeg').toLowerCase().trim();
    const isPdf = (rawMime === 'application/pdf');
    const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].indexOf(rawMime) !== -1 ? rawMime : 'image/jpeg';
    const cleanGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
    const safeLabel = String((payload && payload.jobLabel) || 'Job').replace(/[\\/:*?"<>|#%\r\n]+/g, '_').substring(0, 45).trim() || 'Job';
    const tsStr = Utilities.formatDate(new Date(), 'GMT+7', 'yyyyMMdd_HHmmss');
    const fileName = 'PEA_' + cleanGrp + '_' + safeLabel + '_' + tsStr + (isPdf ? '.pdf' : '.jpg');

    const targetFolder = getOrCreateBranchMonthPhotoFolder_(cleanGrp);
    const blob = Utilities.newBlob(Utilities.base64Decode(rawB64), mimeType, fileName);
    const file = targetFolder.createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}

    const fileId = file.getId();
    return {
      status: 'ok',
      ok: true,
      fileId: fileId,
      fileName: fileName,
      viewUrl: 'https://drive.google.com/file/d/' + fileId + '/view',
      downloadUrl: 'https://drive.google.com/uc?export=download&id=' + fileId,
      thumbUrl: isPdf ? '' : ('https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1000'),
      directUrl: isPdf ? ('https://drive.google.com/file/d/' + fileId + '/view') : ('https://lh3.googleusercontent.com/d/' + fileId + '=w1000')
    };
  } catch (err) {
    logSystemEvent_('ERROR', reqAct, groupName, payload && payload.authUser, 'อัปโหลดไฟล์ขึ้น Google Drive ล้มเหลว', err);
    return { status: 'error', ok: false, message: String(err) };
  }
}

function extractDriveFileIdServer_(idOrUrl) {
  const s = String(idOrUrl || '').trim();
  if (!s || s.indexOf('pdfview=1') !== -1) return '';
  if (/^[a-zA-Z0-9_-]{25,60}$/.test(s)) return s;
  const m = s.match(/\/file\/d\/([a-zA-Z0-9_-]{25,60})/i) ||
            s.match(/[?&]id=([a-zA-Z0-9_-]{25,60})/i) ||
            s.match(/\/d\/([a-zA-Z0-9_-]{25,60})/i);
  return m ? m[1] : '';
}

function trashTxPdfFileSafe_(fileIdOrUrl, groupName, auth) {
  const fileId = extractDriveFileIdServer_(fileIdOrUrl);
  if (!fileId) return { trashed: false, reason: 'NO_FILE_ID' };
  try {
    const file = DriveApp.getFileById(fileId);
    const mime = String(file.getMimeType() || '').toLowerCase();
    const fName = String(file.getName() || '');
    // ล็อกความปลอดภัย: ลบได้เฉพาะไฟล์ .PDF ที่ระบบสร้างขึ้นเท่านั้น (ป้องกันการลบไฟล์ชีตโดยเด็ดขาด)
    if (mime !== 'application/pdf' || fName.indexOf('PEA_') !== 0) {
      logSystemEvent_('WARN', 'deleteTxPdf', groupName, auth && auth.username, 'ปฏิเสธการลบไฟล์ที่ไม่ใช่ใบรายงาน PDF ของระบบ', { fileId: fileId, mime: mime, name: fName });
      return { trashed: false, reason: 'FORBIDDEN_FILE_TYPE' };
    }
    if (auth && auth.role !== 'admin') {
      const userGrp = normalizePeaGroupNameServer_(auth.group) || 'กฟส.บึง';
      if (fName.indexOf('PEA_' + userGrp + '_') !== 0) {
        logSystemEvent_('WARN', 'deleteTxPdf', userGrp, auth.username, 'ปฏิเสธการลบไฟล์ PDF ข้ามสาขา', { fileId: fileId, name: fName });
        return { trashed: false, reason: 'FORBIDDEN_CROSS_BRANCH' };
      }
    }
    file.setTrashed(true);
    return { trashed: true, fileId: fileId, fileName: fName };
  } catch (err) {
    return { trashed: false, fileId: fileId, reason: String(err) };
  }
}
function handleGetJobPhotoBase64_(payload, groupName, auth) {
  const rawIds = Array.isArray(payload && payload.fileIds)
    ? payload.fileIds
    : (payload && payload.fileId ? [payload.fileId] : []);
  const cleanIds = rawIds.map(extractDriveFileIdServer_).filter(Boolean).slice(0, 3);
  if (!cleanIds.length) return { status: 'error', message: 'No valid fileIds' };

  const outFiles = [];
  for (let i = 0; i < cleanIds.length; i++) {
    const fid = cleanIds[i];
    try {
      const file = DriveApp.getFileById(fid);
      if (file.isTrashed()) continue;
      const mime = String(file.getMimeType() || '').toLowerCase();
      const fName = String(file.getName() || '');
      if (mime.indexOf('image/') !== 0 || fName.indexOf('PEA_') !== 0) continue;
      if (auth && auth.role !== 'admin') {
        const userGrp = normalizePeaGroupNameServer_(auth.group) || 'กฟส.บึง';
        if (fName.indexOf('PEA_' + userGrp + '_') !== 0 && fName.indexOf('_PM_') === -1) continue;
      }
      const bytes = file.getBlob().getBytes();
      if (bytes.length > 5000000) continue;
      outFiles.push({
        fileId: fid,
        fileName: fName,
        mimeType: mime,
        base64Data: Utilities.base64Encode(bytes)
      });
    } catch (e) {}
  }
  return { status: 'ok', ok: true, files: outFiles };
}

function handleDeleteJobPhotos_(payload, groupName, auth) {
  const rawIds = Array.isArray(payload && payload.fileIds)
    ? payload.fileIds
    : (payload && payload.fileId ? [payload.fileId] : []);
  const cleanIds = rawIds.map(extractDriveFileIdServer_).filter(Boolean).slice(0, 6);
  let trashedCount = 0;
  for (let i = 0; i < cleanIds.length; i++) {
    const fid = cleanIds[i];
    try {
      const file = DriveApp.getFileById(fid);
      const mime = String(file.getMimeType() || '').toLowerCase();
      const fName = String(file.getName() || '');
      if (mime.indexOf('image/') !== 0 || fName.indexOf('PEA_') !== 0) continue;
      if (auth && auth.role !== 'admin') {
        const userGrp = normalizePeaGroupNameServer_(auth.group) || 'กฟส.บึง';
        if (fName.indexOf('PEA_' + userGrp + '_') !== 0) continue;
      }
      file.setTrashed(true);
      trashedCount++;
    } catch (e) {}
  }
  return { status: 'ok', ok: true, trashedCount: trashedCount };
}


// 🚀 กดปุ่ม "เรียกใช้ (Run)" ที่ฟังก์ชันนี้ 1 ครั้งหลังวางโค้ด เพื่ออนุญาตสิทธิ์ Spreadsheet + UrlFetchApp + DriveApp
// 🔒 ล็อกแท็บ Pins ทั้งระดับแผ่นงาน (บล็อกคนอื่น 100%) และระดับช่วงเซลล์ (เด้งเตือนแม้เป็นเจ้าของไฟล์/Admin)
function protectPinsSheetTab_(ss) {
  if (!ss) return false;
  const sh = ss.getSheetByName(SHEET_PINS);
  if (!sh) return false;
  try { sh.setTabColor('#dc2626'); } catch (e) {}

  try {
    const shProts = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET) || [];
    let hardProt = null;
    for (let i = 0; i < shProts.length; i++) {
      if (!shProts[i].isWarningOnly()) { hardProt = shProts[i]; break; }
    }
    if (!hardProt) hardProt = sh.protect();
    hardProt.setDescription('🔒 ระบบล็อกอัตโนมัติ: ห้ามแก้ไขแท็บ Pins ด้วยมือ (แก้ผ่านหน้าเว็บแอปเท่านั้น)');
    hardProt.setWarningOnly(false);
    const me = Session.getEffectiveUser();
    if (me) hardProt.addEditor(me);
    const editors = hardProt.getEditors();
    if (editors && editors.length > 0) hardProt.removeEditors(editors);
    if (hardProt.canDomainEdit()) hardProt.setDomainEdit(false);
  } catch (e) {}

  try {
    const rgProts = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE) || [];
    let warnProt = null;
    for (let i = 0; i < rgProts.length; i++) {
      if (rgProts[i].isWarningOnly()) { warnProt = rgProts[i]; break; }
    }
const targetRange = sh.getRange(1, 1, Math.max(1, sh.getMaxRows()), Math.max(1, sh.getMaxColumns()));
    if (!warnProt) warnProt = targetRange.protect();
    else warnProt.setRange(targetRange);
    warnProt.setDescription('⚠️ คำเตือนเจ้าของไฟล์: ห้ามลบหรือพิมพ์แก้โค้ด JSON ผังสายไฟ SCADA ในแท็บ Pins ด้วยมือ');
    warnProt.setWarningOnly(true);
  } catch (e) {}
  return true;
}

// 🚀 กดปุ่ม "เรียกใช้ (Run)" ที่ฟังก์ชันนี้ 1 ครั้ง เพื่อไล่ล็อกแท็บ Pins ของทุก กฟส. ที่มีอยู่เดิมทันที
function lockAllExistingPinsSheets() {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const visitedIds = {};
    const targetList = [getMasterSpreadsheet_()];
    visitedIds[targetList[0].getId()] = true;

    const groups = getAllActiveSystemGroups_([]);
    groups.forEach(function(grp) {
      const ss = openGroupSpreadsheet_(grp);
      if (ss && !visitedIds[ss.getId()]) {
        visitedIds[ss.getId()] = true;
        targetList.push(ss);
      }
    });

    let lockedCount = 0;
    targetList.forEach(function(ss) {
      if (protectPinsSheetTab_(ss)) lockedCount++;
    });

    flushDirtySheetsSafe_();
    logSystemEvent_('INFO', 'lockPinsSheets', 'ALL', 'admin', 'ตั้งค่าล็อกป้องกันการเผลอแก้แท็บ Pins ครบทุกสาขาเรียบร้อย', { lockedSheets: lockedCount });
    Logger.log('🔒 ล็อกป้องกันแท็บ Pins เรียบร้อยจำนวน ' + lockedCount + ' ไฟล์');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// 🚀 กดปุ่ม "เรียกใช้ (Run)" ที่ฟังก์ชันนี้ 1 ครั้งหลังวางโค้ด เพื่ออนุญาตสิทธิ์ Spreadsheet + UrlFetchApp + DriveApp
function authorizeAndInitGroupSheets() {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const users = getUsersData_();
    syncAllUserGroupsToSheets_(users);
    if (typeof UrlFetchApp !== 'undefined') {
      Logger.log('🌐 พร้อมใช้งานระบบคลายลิงก์สั้น Google Maps (UrlFetchApp)');
    }
    if (typeof DriveApp !== 'undefined') {
      const photoRoot = getOrCreateMainPhotoRootFolder_();
      Logger.log('📷 พร้อมใช้งานโฟลเดอร์เก็บรูปหน้างานและ PDF บน Google Drive: ' + photoRoot.getName());
    }
    ensureSystemLogsSheet_();
    protectPinsSheetTab_(getMasterSpreadsheet_());
    getAllActiveSystemGroups_([]).forEach(function(grp) {
      protectPinsSheetTab_(openGroupSpreadsheet_(grp));
    });
    logSystemEvent_('INFO', 'initSystem', 'MASTER', 'admin', 'เริ่มต้นระบบ ล็อกแท็บ Pins และสร้างชีต SystemLogs เรียบร้อย', '');
    flushDirtySheetsSafe_();
    Logger.log('✅ ตรวจสอบ สร้างไฟล์ Google Sheets แยกตาม กฟส. และล็อกแท็บ Pins เรียบร้อยแล้ว');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ฟังก์ชันเสริมสำหรับล้างแคชตาราง GroupNodes ทันทีเมื่อมีการเพิ่ม/แก้ไขลิงก์ CustomWebAppUrl
function refreshGroupNodesCache() {
  CacheService.getScriptCache().remove('PEA_V65_NODES');
  Logger.log('✅ ล้างแคช GroupNodes เรียบร้อย พร้อมใช้งานลิงก์ /exec ใหม่ทันที');
}

// ⚡ แปลงรหัสเวลาใบงานเป็นรหัสสั้น 9 หลัก (ตรงกับหน้าเว็บ 100%)
function makeShortJobIdServer_(dtStr) {
  const s = String(dtStr || '').trim();
  if (!s || s === '-') return '';
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?(?:\.(\d+))?$/);
  if (m) {
    const numStr = ('0' + m[1]).slice(-2) + ('0' + m[2]).slice(-2) + m[3] +
                   ('0' + m[4]).slice(-2) + ('0' + m[5]).slice(-2) + ('00' + (m[6] || '00')).slice(-2);
    const b36 = Number(numStr).toString(36);
    return m[7] ? (b36 + '_' + Number(m[7]).toString(36)) : b36;
  }
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return 'k' + (h >>> 0).toString(36);
}

function createServerAuthToken_(accountObj, issuedAtMsOpt) {
  const parsed = parseRoleString_(accountObj.role);
  const baseId = getUserBaseIdServer_(accountObj.username);
  const ts = String(issuedAtMsOpt || Date.now());
  const masterId = getMasterSpreadsheet_().getId();
  const rawSigInput = [
    'PEA_V65_TOK',
    PASSWORD_SALT,
    masterId,
    baseId,
    parsed.role,
    String(accountObj.password || ''),
    ts
  ].join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawSigInput, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i] < 0 ? digest[i] + 256 : digest[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return 'st1_' + ts + '_' + hex.substring(0, 32);
}

function verifyRequestAuth_(authUserRaw, authTokenRaw, usersArrayOpt) {
  const uIn = String(authUserRaw || '').trim();
  const tok = String(authTokenRaw || '').trim();
  if (!uIn || !tok) return { ok: false };

  const users = usersArrayOpt || getUsersData_();
  let matchedAcc = null;
  for (let i = 0; i < users.length; i++) {
    if (isUsernameMatchingServer_(uIn, users[i].username)) {
      matchedAcc = users[i];
      break;
    }
  }
  if (!matchedAcc) return { ok: false };

  const parsed = parseRoleString_(matchedAcc.role);
  let tokenValid = false;

  if (tok.indexOf('st1_') === 0) {
    const parts = tok.split('_');
    if (parts.length === 3) {
      const tsNum = Number(parts[1] || 0);
      if (tsNum > 0 && Math.abs(Date.now() - tsNum) <= TOKEN_MAX_AGE_MS) {
        if (createServerAuthToken_(matchedAcc, parts[1]) === tok) tokenValid = true;
      }
    }
  } else if (parsed.sessionToken && parsed.sessionToken.indexOf('sess_') === 0 && tok === parsed.sessionToken) {
    tokenValid = true;
  }

  if (!tokenValid) return { ok: false };

  const extractedGroup = getUserGroupNameServer_(matchedAcc.username, false);
  const userGroup = extractedGroup || (parsed.role !== 'admin' ? 'กฟส.บึง' : '');
  return {
    ok: true,
    username: matchedAcc.username,
    role: parsed.role,
    group: userGroup,
    displayName: parsed.displayName
  };
}

function collectOrderedMeterSearchGroups_(preferredGroup, nodesMap, rawUsers) {
  const searchGroups = [];
  if (preferredGroup && isKnownOrValidSystemGroup_(preferredGroup, nodesMap, rawUsers)) {
    searchGroups.push(preferredGroup);
  }
  if (searchGroups.indexOf('กฟส.บึง') === -1) searchGroups.push('กฟส.บึง');
  Object.keys(nodesMap || {}).forEach(function(g) {
    const ng = normalizePeaGroupNameServer_(g);
    if (ng && searchGroups.indexOf(ng) === -1) searchGroups.push(ng);
  });
  (rawUsers || []).forEach(function(u) {
    const ug = getUserGroupNameServer_(u && u.username, false);
    if (ug && searchGroups.indexOf(ug) === -1) searchGroups.push(ug);
  });
  return searchGroups;
}

// ============================================================================
// 🛡️ เกราะป้องกันการสุ่มรหัสผ่าน, กันแย่งคิว Lock และคุมโควตาสาธารณะ (Security Shield)
// ============================================================================

const SEC_LOGIN_MAX_FAIL = 6;              // ล็อกอินผิดสูงสุด 6 ครั้งต่อบัญชี พักล็อกชั่วคราว 5 นาที
const SEC_LOGIN_LOCKOUT_SEC = 300;
const SEC_LOGIN_GLOBAL_MAX_FAIL = 45;      // กันบอทสุ่มเปลี่ยนชื่อผู้ใช้รัวๆ เกิน 45 ครั้งใน 5 นาที
const SEC_LOGIN_GLOBAL_WIN_SEC = 300;
const SEC_METER_MAX_FAIL = 30;             // กันบอทสุ่มรหัสลับ k ของใบมิเตอร์เกิน 30 ครั้งใน 5 นาที
const SEC_PUBLIC_SHORTURL_MAX = 60;        // จำกัดคลายลิงก์สั้นสาธารณะ 60 ลิงก์ใหม่ / 10 นาที (สงวนโควตาให้ช่าง)
const SEC_PUBLIC_SHORTURL_WIN_SEC = 600;
const SEC_MAX_POST_CHARS = 7000000;        // ป้องกัน JSON ขนาดยักษ์ถล่มหน่วยความจำ

function readSecCountVal_(rawVal, resetTs) {
  if (!rawVal) return 0;
  const parts = String(rawVal).split('|');
  const cnt = parseInt(parts[0] || '0', 10) || 0;
  const ts = Number(parts[1] || 0);
  if (resetTs > 0 && ts > 0 && ts < resetTs) return 0;
  return cnt;
}

function getSecCountersMap_(keysArray) {
  try {
    const cache = CacheService.getScriptCache();
    const rawMap = cache.getAll((keysArray || []).concat(['PEA_SEC_RESET_TS']));
    const resetTs = Number(rawMap['PEA_SEC_RESET_TS'] || 0);
    const out = {};
    (keysArray || []).forEach(function(k) {
      out[k] = readSecCountVal_(rawMap[k], resetTs);
    });
    return out;
  } catch (e) {
    return {};
  }
}

function bumpSecCounterWithTs_(key, ttlSec) {
  try {
    const cache = CacheService.getScriptCache();
    const rawMap = cache.getAll([key, 'PEA_SEC_RESET_TS']);
    const resetTs = Number(rawMap['PEA_SEC_RESET_TS'] || 0);
    const next = readSecCountVal_(rawMap[key], resetTs) + 1;
    cache.put(key, next + '|' + Date.now(), ttlSec);
    return next;
  } catch (e) {
    return 1;
  }
}

function clearSecCounterSafe_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
}

// 🔓 กด Run ฟังก์ชันนี้ใน Apps Script ได้ทันที หากต้องการปลดล็อกโควตารหัสผ่านผิดให้พนักงานทันทีโดยไม่ต้องรอครบ 5 นาที
function resetSecurityRateLimits() {
  CacheService.getScriptCache().put('PEA_SEC_RESET_TS', String(Date.now()), CACHE_TTL_SEC);
  Logger.log('✅ ปลดล็อกตัวนับป้องกันการสุ่มรหัสผ่านและโควตาสาธารณะทั้งหมดเรียบร้อย');
}

function handleLoginSecure_(payload) {
  const inputUser = String(payload.username || payload.rawUsername || '').trim();
  const rawUserAlt = String(payload.rawUsername || '').trim();
  const inputPass = String(payload.password || '').trim();
  const checkOnly = Boolean(payload.checkOnly);

  if (!inputUser || !inputPass || inputUser.length > 120 || inputPass.length > 128) {
    return { status: 'ok', authenticated: false, verified: false, message: 'รหัสพนักงาน หรือ รหัสผ่านไม่ถูกต้อง' };
  }

  // ⚡ เช็กบัญชีจาก RAM ก่อน: หากบอทยิงชื่อผู้ใช้มั่วที่ไม่มีในระบบ ให้ดีดทิ้งทันทีโดยไม่กระทบพนักงานจริง
  const preUsers = getUsersData_();
  const matchedCandidates = [];
  for (let i = 0; i < preUsers.length; i++) {
    const isUserMatch = isUsernameMatchingServer_(inputUser, preUsers[i].username) ||
                        (rawUserAlt && isUsernameMatchingServer_(rawUserAlt, preUsers[i].username));
    if (isUserMatch) matchedCandidates.push(i);
  }

  if (matchedCandidates.length === 0) {
    return { status: 'ok', authenticated: false, verified: false, message: 'รหัสพนักงาน หรือ รหัสผ่านไม่ถูกต้อง' };
  }

  const targetAccForKey = preUsers[matchedCandidates[0]];
  const canonicalKey = (getUserBaseIdServer_(targetAccForKey.username) + '|' + getUserGroupNameServer_(targetAccForKey.username, false)).toLowerCase();
  const userFailKey = 'PEA_SEC_LFAIL_' + computeMd5Hex_(canonicalKey).substring(0, 16);
  const secCounts = getSecCountersMap_([userFailKey]);

  if ((secCounts[userFailKey] || 0) >= SEC_LOGIN_MAX_FAIL) {
    logSystemEvent_('WARN', 'loginRateLimit', '', targetAccForKey.username, 'ระงับการล็อกอินบัญชีนี้ชั่วคราว 5 นาที เนื่องจากรหัสผิดเกินกำหนด', {
      userFails: secCounts[userFailKey] || 0
    });
    return {
      status: 'ok',
      authenticated: false,
      verified: false,
      rateLimited: true,
      message: 'กรอกรหัสผ่านผิดเกินกำหนด ระบบล็อกบัญชีนี้ชั่วคราว 5 นาที'
    };
  }

  let preMatchIdx = -1;
  for (let k = 0; k < matchedCandidates.length; k++) {
    const idx = matchedCandidates[k];
    if (verifyPasswordMatch_(inputPass, preUsers[idx].password)) {
      preMatchIdx = idx;
      break;
    }
  }

  if (preMatchIdx === -1) {
    const nextFail = bumpSecCounterWithTs_(userFailKey, SEC_LOGIN_LOCKOUT_SEC);
    if (nextFail === SEC_LOGIN_MAX_FAIL) {
      logSystemEvent_('WARN', 'loginLockout', '', targetAccForKey.username, 'กรอกรหัสผ่านผิดครบ 6 ครั้ง ล็อกเฉพาะบัญชีนี้ชั่วคราว 5 นาที', '');
    }
    return { status: 'ok', authenticated: false, verified: false, message: 'รหัสพนักงาน หรือ รหัสผ่านไม่ถูกต้อง' };
  }

  clearSecCounterSafe_(userFailKey);

  if (checkOnly) {
    const accSnap = preUsers[preMatchIdx];
    const parsedSnap = parseRoleString_(accSnap.role);
    const extGrpSnap = getUserGroupNameServer_(accSnap.username, false);
    const usrGrpSnap = extGrpSnap || (parsedSnap.role !== 'admin' ? 'กฟส.บึง' : '');
    const tokSnap = createServerAuthToken_({
      username: accSnap.username,
      role: accSnap.role,
      password: hashPasswordSha256_(accSnap.password)
    });
    return {
      status: 'ok',
      authenticated: true,
      verified: true,
      mqttKey: getServerMqttSecret_(),
      user: { username: accSnap.username, role: parsedSnap.role, group: usrGrpSnap, sessionToken: tokSnap, displayName: parsedSnap.displayName },
      serverTime: new Date().toISOString()
    };
  }

  const loginLock = LockService.getScriptLock();
  if (!loginLock.tryLock(SCRIPT_LOCK_WAIT_MS)) {
    logSystemEvent_('WARN', 'login', '', inputUser, 'คิวเข้าสู่ระบบหนาแน่นเกิน 12 วินาที (Lock Timeout)', '');
    return { status: 'error', busy: true, retryable: true, code: 'SERVER_BUSY', message: 'Server busy, please retry' };
  }

  try {
    const users = getUsersData_();
    let matchedIndex = -1;
    for (let i = 0; i < users.length; i++) {
      const isUserMatch = isUsernameMatchingServer_(inputUser, users[i].username) ||
                          (rawUserAlt && isUsernameMatchingServer_(rawUserAlt, users[i].username));
      if (isUserMatch && verifyPasswordMatch_(inputPass, users[i].password)) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex === -1) {
      return { status: 'ok', authenticated: false, verified: false, message: 'รหัสพนักงาน หรือ รหัสผ่านไม่ถูกต้อง' };
    }

    const matchedAcc = users[matchedIndex];
    const parsed = parseRoleString_(matchedAcc.role);
    const extractedGroup = getUserGroupNameServer_(matchedAcc.username, false);
    const userGroup = extractedGroup || (parsed.role !== 'admin' ? 'กฟส.บึง' : '');

    users[matchedIndex].password = hashPasswordSha256_(matchedAcc.password);
    const signedToken = createServerAuthToken_(users[matchedIndex]);
    users[matchedIndex].role = parsed.role + '::' + signedToken + '::' + parsed.displayName;
    saveUsersData_(users);

    const nodeInfo = userGroup ? ensureGroupSpreadsheetExists_(userGroup, true) : null;
    return {
      status: 'ok',
      authenticated: true,
      mqttKey: getServerMqttSecret_(),
      targetApiUrl: (parsed.role !== 'admin' && nodeInfo && nodeInfo.customWebAppUrl) ? nodeInfo.customWebAppUrl : '',
      sheetUrl: nodeInfo ? nodeInfo.sheetUrl : '',
      user: { username: matchedAcc.username, role: parsed.role, group: userGroup, sessionToken: signedToken, displayName: parsed.displayName },
      users: sanitizeUsersForClient_(users),
      serverTime: new Date().toISOString()
    };
  } finally {
    flushDirtySheetsSafe_();
    try { loginLock.releaseLock(); } catch (err) {}
  }
}

function handleVerifyPasswordInRam_(payload, auth) {
  const inputUser = String(payload.username || auth.username || '').trim();
  const inputPass = String(payload.password || '').trim();
  if (!inputPass || inputPass.length > 128) {
    return { status: 'ok', verified: false, authenticated: false, serverTime: new Date().toISOString() };
  }

  const vpwKey = 'PEA_SEC_VPW_' + computeMd5Hex_(auth.username || inputUser).substring(0, 16);
  const secMap = getSecCountersMap_([vpwKey]);
  if ((secMap[vpwKey] || 0) >= SEC_LOGIN_MAX_FAIL) {
    return { status: 'ok', verified: false, authenticated: false, rateLimited: true, serverTime: new Date().toISOString() };
  }

  const users = getUsersData_();
  let isValid = false;
  for (let i = 0; i < users.length; i++) {
    const parsed = parseRoleString_(users[i].role);
    const isCurrentUser = inputUser && isUsernameMatchingServer_(inputUser, users[i].username);
    if ((isCurrentUser || parsed.role === 'admin') && verifyPasswordMatch_(inputPass, users[i].password)) {
      isValid = true;
      break;
    }
  }

  if (!isValid) bumpSecCounterWithTs_(vpwKey, SEC_LOGIN_LOCKOUT_SEC);
  else clearSecCounterSafe_(vpwKey);

  return { status: 'ok', verified: isValid, authenticated: isValid, serverTime: new Date().toISOString() };
}

function handleGetSingleJobForMeter_(targetShortId, reqMeterKey, preferredGroup, authInfo, safeUsers, nodesMap, rawUsers) {
  const cleanTargetId = String(targetShortId || '').trim();
  if (!cleanTargetId || cleanTargetId.length > 80) {
    return { status: 'ok', job: null, closedReport: null, users: [], serverTime: new Date().toISOString() };
  }

  const isAuthedAny = Boolean(authInfo && authInfo.ok);
  const mkJobKey = 'PEA_SEC_MK_' + computeMd5Hex_(cleanTargetId).substring(0, 12);
  if (!isAuthedAny) {
    const mkCounts = getSecCountersMap_([mkJobKey]);
    if ((mkCounts[mkJobKey] || 0) >= 12) {
      return {
        status: 'error',
        forbiddenMeterKey: true,
        rateLimited: true,
        message: 'ลองรหัสเข้าถึงใบรายงานมิเตอร์ผิดเกินกำหนด กรุณารอ 5 นาที'
      };
    }
  }

  const searchGroups = collectOrderedMeterSearchGroups_(preferredGroup, nodesMap, rawUsers);

  for (let gIdx = 0; gIdx < searchGroups.length; gIdx++) {
    const grp = searchGroups[gIdx];
    const stateObj = getStatePool_(grp);
    const delMap = (stateObj && stateObj.deletedJobsMap) || {};
    const closedMap = (stateObj && stateObj.closedJobsMap) || {};
    const jobsList = getJobsPool_(grp) || [];

    for (let i = 0; i < jobsList.length; i++) {
      const j = jobsList[i];
      if (!j || typeof j !== 'object' || j.jobType === 'fault') continue;
      const rk = getRawJobKey_(j);
      if (!rk) continue;
      if (rk === cleanTargetId || makeShortJobIdServer_(rk) === cleanTargetId) {
        if (delMap[rk] && !isJobNewerThanDelete_(j, delMap[rk])) continue;
        const isAuthedBranchStaff = Boolean(authInfo && authInfo.ok && (authInfo.role === 'admin' || authInfo.group === grp));
        const cleanReqKey = String(reqMeterKey || '').trim();
        if (!isAuthedBranchStaff && (!j.meterKey || !cleanReqKey || String(j.meterKey) !== cleanReqKey)) {
          bumpSecCounterWithTs_(mkJobKey, SEC_LOGIN_LOCKOUT_SEC);
          return {
            status: 'error',
            forbiddenMeterKey: true,
            message: 'รหัสเข้าถึงใบรายงานมิเตอร์ไม่ถูกต้อง'
          };
        }
        const branchOnlyUsers = isAuthedBranchStaff
          ? safeUsers
          : (safeUsers || []).filter(function(u) { return getUserGroupNameServer_(u && u.username, false) === grp; });
        return {
          status: 'ok',
          group: grp,
          job: j,
          closedReport: closedMap[rk] || null,
          users: branchOnlyUsers,
          serverTime: new Date().toISOString()
        };
      }
    }
  }

  return {
    status: 'ok',
    job: null,
    closedReport: null,
    users: [],
    serverTime: new Date().toISOString()
  };
}


// ตรวจสอบใบมิเตอร์และรหัสลับ k ใน RAM ก่อนขอจับ ScriptLock (ล็อกเฉพาะรายใบงาน ไม่กระทบใบงานอื่น)
function preCheckMeterStateInRam_(payload, preferredGroup, authInfo, rawBodyLen) {
  const targetShortId = String(payload.i || payload.shortId || '').trim();
  const reqMeterKey = String(payload.k || payload.meterKey || '').trim();
  const incMeterState = payload.meterFormState;

  if (!targetShortId || targetShortId.length > 80 || !incMeterState || typeof incMeterState !== 'object' || rawBodyLen > 950000) {
    return { ok: false, errorObj: { status: 'error', message: 'Invalid meter state payload' } };
  }

  const mkJobKey = 'PEA_SEC_MK_' + computeMd5Hex_(targetShortId).substring(0, 12);
  if (!authInfo || !authInfo.ok) {
    const mkCounts = getSecCountersMap_([mkJobKey]);
    if ((mkCounts[mkJobKey] || 0) >= 12) {
      return { ok: false, errorObj: { status: 'error', forbiddenMeterKey: true, rateLimited: true, message: 'Too many invalid meter key attempts' } };
    }
  }

  const rawUsers = getUsersData_();
  const nodesMap = getGroupNodesMap_();
  const searchGroups = collectOrderedMeterSearchGroups_(preferredGroup, nodesMap, rawUsers);

  for (let gIdx = 0; gIdx < searchGroups.length; gIdx++) {
    const grp = searchGroups[gIdx];
    const stateObj = getStatePool_(grp);
    const delMap = (stateObj && stateObj.deletedJobsMap) || {};
    const jobsList = getJobsPool_(grp) || [];

    for (let i = 0; i < jobsList.length; i++) {
      const j = jobsList[i];
      if (!j || typeof j !== 'object' || j.jobType === 'fault') continue;
      const rk = getRawJobKey_(j);
      if (!rk) continue;
      if (rk === targetShortId || makeShortJobIdServer_(rk) === targetShortId) {
        if (delMap[rk] && !isJobNewerThanDelete_(j, delMap[rk])) continue;
        const isAuthedWriter = Boolean(authInfo && authInfo.ok && authInfo.role !== 'viewer' && (authInfo.role === 'admin' || authInfo.group === grp));
        if (!isAuthedWriter && (!j.meterKey || !reqMeterKey || String(j.meterKey) !== reqMeterKey)) {
          bumpSecCounterWithTs_(mkJobKey, SEC_LOGIN_LOCKOUT_SEC);
          return { ok: false, errorObj: { status: 'error', forbiddenMeterKey: true, message: 'Invalid meter access key' } };
        }
        return { ok: true, resolvedGroup: grp };
      }
    }
  }

  return { ok: false, errorObj: { status: 'error', message: 'Job not found' } };
}


function handleSaveMeterStatePublic_(payload, preferredGroup, authInfo) {
  const targetShortId = String(payload.i || payload.shortId || '').trim();
  const reqMeterKey = String(payload.k || payload.meterKey || '').trim();
  const incMeterState = payload.meterFormState;
  if (!targetShortId || !incMeterState || typeof incMeterState !== 'object') {
    return { status: 'error', message: 'Invalid meter state payload' };
  }

  const rawUsers = getUsersData_();
  const nodesMap = getGroupNodesMap_();
  const searchGroups = collectOrderedMeterSearchGroups_(preferredGroup, nodesMap, rawUsers);

  for (let gIdx = 0; gIdx < searchGroups.length; gIdx++) {
    const grp = searchGroups[gIdx];
    const stateObj = getStatePool_(grp);
    const delMap = (stateObj && stateObj.deletedJobsMap) || {};
    const jobsList = getJobsPool_(grp) || [];

    for (let i = 0; i < jobsList.length; i++) {
      const j = jobsList[i];
      if (!j || typeof j !== 'object' || j.jobType === 'fault') continue;
      const rk = getRawJobKey_(j);
      if (!rk) continue;
      if (rk === targetShortId || makeShortJobIdServer_(rk) === targetShortId) {
        if (delMap[rk] && !isJobNewerThanDelete_(j, delMap[rk])) continue;
        const isAuthedWriter = Boolean(authInfo && authInfo.ok && authInfo.role !== 'viewer' && (authInfo.role === 'admin' || authInfo.group === grp));
        if (!isAuthedWriter && (!j.meterKey || !reqMeterKey || String(j.meterKey) !== reqMeterKey)) {
          return { status: 'error', forbiddenMeterKey: true, message: 'Invalid meter access key' };
        }
        jobsList[i] = Object.assign({}, j, {
          meterFormState: mergeMeterFormStateServer_(j.meterFormState, incMeterState)
        });
        saveJobsPool_(grp, jobsList, true);
        return {
          status: 'ok',
          savedMeterState: true,
          group: grp,
          serverTime: new Date().toISOString()
        };
      }
    }
  }
  return { status: 'error', message: 'Job not found' };
}

function doGet(e) {
  try {
    const reqAction = cleanGroupParam_(e && e.parameter ? e.parameter.action : '');
    // ⚡ Fast-Exit สำหรับหน้าแมพเรดาร์แจ้งดับไฟประชาชน (อ่านจาก RAM Cache ไม่แตะ Users/SCADA/Lock)
    if (reqAction === 'getPublicOutages') {
      return handleGetPublicOutagesFast_(e);
    }

    const reqShortId = String((e && e.parameter && e.parameter.i) || '').trim();
    const reqMeterKey = String((e && e.parameter && e.parameter.k) || '').trim();
    const rawGroup = cleanGroupParam_(e && e.parameter ? e.parameter.group : '');
    const reqGroup = normalizePeaGroupNameServer_(rawGroup);
    const authUser = String((e && e.parameter && e.parameter.authUser) || '').trim();
    const authToken = String((e && e.parameter && e.parameter.authToken) || '').trim();

    const rawUsers = getUsersData_();
    const safeUsers = sanitizeUsersForClient_(rawUsers);
    const nodesMap = getGroupNodesMap_();
    const auth = verifyRequestAuth_(authUser, authToken, rawUsers);

    // ⚡ โหมดดึงข้อมูลใบมิเตอร์เฉพาะใบงานเดียว (ตรวจรหัสลับ k + กันสุ่มรหัส)
    if (reqAction === 'getJob' && reqShortId) {
      return buildJsonResponse_(handleGetSingleJobForMeter_(reqShortId, reqMeterKey, reqGroup || 'กฟส.บึง', auth, safeUsers, nodesMap, rawUsers));
    }

    // 🔒 บังคับตรวจสอบโทเคนก่อนดึงข้อมูลใบงานและผัง SCADA ทั้งหมด
    if (!auth.ok) {
      return buildJsonResponse_({ status: 'error', unauthorized: true, message: 'กรุณาเข้าสู่ระบบ' });
    }

    if (reqAction === 'listTxLoads') {
      return buildJsonResponse_(handleListTxLoads_(reqGroup, auth, nodesMap, rawUsers));
    }

    let jobs = [];
    let activeGroupLabel = 'ALL';

    if (auth.role === 'admin' && !reqGroup) {
      jobs = assembleAllGroupsJobsForAdmin_(nodesMap, rawUsers);
    } else {
      const targetGrp = (auth.role === 'admin' && reqGroup) ? reqGroup : auth.group;
      const validGroup = (targetGrp && isKnownOrValidSystemGroup_(targetGrp, nodesMap, rawUsers))
        ? targetGrp
        : 'กฟส.บึง';
      activeGroupLabel = validGroup;
      jobs = assembleFullJobsForGroup_(validGroup);
    }

    return buildJsonResponse_({
      status: 'ok',
      mqttKey: getServerMqttSecret_(),
      users: safeUsers,
      groupNodes: nodesMap,
      activeGroup: activeGroupLabel,
      jobs: jobs,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    const gAct = (e && e.parameter && e.parameter.action) || 'doGet';
    const gGrp = (e && e.parameter && e.parameter.group) || '';
    const gUsr = (e && e.parameter && e.parameter.authUser) || '';
    logSystemEvent_('ERROR', gAct, gGrp, gUsr, 'เกิดข้อผิดพลาดใน doGet', err);
    return buildJsonResponse_({ status: 'error', message: String(err) });
  }
}

function doPost(e) {
  let logAction = 'doPost';
  let logGroup = (e && e.parameter && e.parameter.group) || '';
  let logUser = (e && e.parameter && e.parameter.authUser) || '';

  try {
    if (typeof tryHandlePmPushPost === 'function') {
      const pmPushRes = tryHandlePmPushPost(e);
      if (pmPushRes) return pmPushRes;
    }

    const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    if (rawBody.length > SEC_MAX_POST_CHARS) {
      logSystemEvent_('WARN', 'payloadTooLarge', logGroup, logUser, 'ปฏิเสธคำขอขนาดใหญ่เกินเพดานความปลอดภัย', { length: rawBody.length });
      return buildJsonResponse_({ status: 'error', message: 'Payload exceeds maximum allowed size' });
    }

    const payload = JSON.parse(rawBody);
    const action = String(payload.action || '').trim();
    const rawGroup = cleanGroupParam_((e && e.parameter && e.parameter.group) || payload.group || payload.ownerGroup || '');
    const reqGroup = normalizePeaGroupNameServer_(rawGroup);
    if (action) logAction = action;
    if (reqGroup) logGroup = reqGroup;

    const authUser = String((e && e.parameter && e.parameter.authUser) || payload.authUser || '').trim();
    const authToken = String((e && e.parameter && e.parameter.authToken) || payload.authToken || '').trim();
    if (authUser) logUser = authUser;

    // 🌐 คลายลิงก์สั้น Google Maps (พนักงานที่ส่งโทเคนมาด้วยจะข้ามโควตาจำกัดฝั่งสาธารณะอัตโนมัติ)
    if (action === 'resolveShortUrl') {
      const optAuth = (authUser && authToken) ? verifyRequestAuth_(authUser, authToken, null) : { ok: false };
      return buildJsonResponse_(handleResolveShortUrl_(payload.url || '', Boolean(optAuth && optAuth.ok)));
    }

    // 🔐 ล็อกอินปลอดภัย (เช็กรหัสผ่าน + บล็อก Brute-Force ใน RAM ก่อน ไม่แย่ง ScriptLock ของช่าง)
    if (action === 'verifyLogin' || action === 'login') {
      return buildJsonResponse_(handleLoginSecure_(payload));
    }

    const auth = verifyRequestAuth_(authUser, authToken, null);
    if (auth.ok && auth.username) logUser = auth.username;

    // ✍️ บันทึกลายเซ็นจากหน้าใบมิเตอร์ (ตรวจใบงานและรหัส k ใน RAM ให้ผ่านก่อน จึงค่อยขอจับ Lock)
    if (action === 'saveMeterState') {
      const preCheck = preCheckMeterStateInRam_(payload, reqGroup || 'กฟส.บึง', auth, rawBody.length);
      if (!preCheck.ok) {
        return buildJsonResponse_(preCheck.errorObj);
      }
      const mLock = LockService.getScriptLock();
      if (!mLock.tryLock(SCRIPT_LOCK_WAIT_MS)) {
        logSystemEvent_('WARN', 'saveMeterState', preCheck.resolvedGroup || reqGroup || 'กฟส.บึง', logUser, 'คิวบันทึกใบมิเตอร์หนาแน่น (Lock Timeout)', { shortId: payload.i || '' });
        return buildJsonResponse_({ status: 'error', busy: true, retryable: true, code: 'SERVER_BUSY', message: 'Server busy, please retry' });
      }
      try {
        return buildJsonResponse_(handleSaveMeterStatePublic_(payload, preCheck.resolvedGroup || reqGroup || 'กฟส.บึง', auth));
      } finally {
        flushDirtySheetsSafe_();
        try { mLock.releaseLock(); } catch (err) {}
      }
    }

    // 🔒 บังคับตรวจโทเคนสำหรับทุกคำสั่งแก้ไขข้อมูลและดึงสิทธิ์จริงจากชีต Users เท่านั้น
    if (!auth.ok) {
      return buildJsonResponse_({ status: 'error', unauthorized: true, message: 'กรุณาเข้าสู่ระบบ' });
    }

    // ตรวจรหัสผ่านซ้ำใน RAM โดยไม่ต้องรอคิว ScriptLock
    if (action === 'verifyUserPassword' || action === 'verifyPassword') {
      return buildJsonResponse_(handleVerifyPasswordInRam_(payload, auth));
    }

    const reqRole = auth.role;
    const effectiveGroup = (reqRole === 'admin') ? reqGroup : (auth.group || 'กฟส.บึง');
    if (effectiveGroup) logGroup = effectiveGroup;

    const isAuthReadOnlyAction = (
      action === 'listTxLoads' ||
      action === 'getJobPhotoBase64'
    );
    if (reqRole === 'viewer' && !isAuthReadOnlyAction) {
      return buildJsonResponse_({ status: 'ok', skippedViewer: true, serverTime: new Date().toISOString() });
    }

    if (action === 'listTxLoads') {
      return buildJsonResponse_(handleListTxLoads_(effectiveGroup, auth, null, null));
    }

    if (action === 'uploadJobPhoto' || action === 'uploadTxPdf') {
      if (!payload.authUser && logUser) payload.authUser = logUser;
      return buildJsonResponse_(handleUploadJobPhoto_(payload, effectiveGroup || 'กฟส.บึง'));
    }

    if (action === 'getJobPhotoBase64') {
      return buildJsonResponse_(handleGetJobPhotoBase64_(payload, effectiveGroup || 'กฟส.บึง', auth));
    }

    if (action === 'deleteJobPhoto') {
      return buildJsonResponse_(handleDeleteJobPhotos_(payload, effectiveGroup || 'กฟส.บึง', auth));
    }

    // 🗑️ ลบเฉพาะไฟล์ใบงาน .PDF (ล้างลิงก์ในชีตภายใต้ Lock ก่อน แล้วจึงลบไฟล์ใน Drive นอก Lock)
    if (action === 'deleteTxPdf') {
      const targetRecId = String(payload.id || '').trim();
      const reqPdfRef = String(payload.fileId || payload.pdfUrl || '').trim();
      if (!targetRecId) {
        const trashOnly = trashTxPdfFileSafe_(reqPdfRef, effectiveGroup || 'กฟส.บึง', auth);
        return buildJsonResponse_({ status: 'ok', deletedPdf: true, driveTrashed: trashOnly.trashed, serverTime: new Date().toISOString() });
      }
      const pLock = LockService.getScriptLock();
      if (!pLock.tryLock(SCRIPT_LOCK_WAIT_MS)) {
        logSystemEvent_('WARN', 'deleteTxPdf', effectiveGroup || 'กฟส.บึง', logUser, 'คิวลบข้อมูล PDF หนาแน่น (Lock Timeout)', { id: targetRecId });
        return buildJsonResponse_({ status: 'error', busy: true, retryable: true, code: 'SERVER_BUSY', message: 'Server busy, please retry' });
      }
      let sheetPdfRef = '';
      let resClear = null;
      try {
        resClear = handleWriteTxLoadLocked_('clearTxPdfLink', payload, effectiveGroup, auth);
        sheetPdfRef = String(resClear._removedPdfRef || '').trim();
        delete resClear._removedPdfRef;
      } finally {
        flushDirtySheetsSafe_();
        try { pLock.releaseLock(); } catch (err) {}
      }
      const resolvedGrp = (resClear && resClear.group) || effectiveGroup || 'กฟส.บึง';
      const reqFileId = extractDriveFileIdServer_(reqPdfRef);
      const sheetFileId = extractDriveFileIdServer_(sheetPdfRef);
      let driveTrashed = false;
      if (reqFileId) {
        driveTrashed = trashTxPdfFileSafe_(reqFileId, resolvedGrp, auth).trashed || driveTrashed;
      }
      if (sheetFileId && sheetFileId !== reqFileId) {
        driveTrashed = trashTxPdfFileSafe_(sheetFileId, resolvedGrp, auth).trashed || driveTrashed;
      }
      resClear.driveTrashed = driveTrashed;
      return buildJsonResponse_(resClear);
    }

    if (action === 'patchDelta' && payload.techLocDelta) {
      payload.techLocDelta._explicitReplaceBackups = (payload.techLocDelta._keepBackups === false);
      if (payload.techLocDelta.electricEquipmentPins === undefined) payload.techLocDelta._keepPins = true;
      if (payload.techLocDelta.deletedElectricEquipmentMap === undefined) payload.techLocDelta._keepDelPins = true;
      if (payload.techLocDelta.deletedEquipAuditLogs === undefined) payload.techLocDelta._keepAuditLogs = true;
      if (payload.techLocDelta.cloudGroupBackups === undefined) payload.techLocDelta._keepBackups = true;
    }

    const canEditScadaServer = (reqRole === 'admin' || reqRole === 'user');
    if (!canEditScadaServer) {
      if (action === 'patchDelta' && payload.techLocDelta) {
        payload.techLocDelta._keepPins = true;
        payload.techLocDelta._keepDelPins = true;
        payload.techLocDelta._keepAuditLogs = true;
        payload.techLocDelta._keepBackups = true;
        payload.techLocDelta._explicitReplaceBackups = false;
        delete payload.techLocDelta.electricEquipmentPins;
        delete payload.techLocDelta.deletedElectricEquipmentMap;
        delete payload.techLocDelta.deletedEquipAuditLogs;
        delete payload.techLocDelta.clearedAuditLogsTimestamp;
        delete payload.techLocDelta.cloudGroupBackups;
      } else if (action === 'saveJobs' && Array.isArray(payload.jobs)) {
        payload.jobs.forEach(function(j) {
          if (j && (j.jobType === 'tech_loc' || j.dateTimeSaved === 'TECH_LOC_REGISTRY')) {
            delete j.electricEquipmentPins;
            delete j.deletedElectricEquipmentMap;
            delete j.deletedEquipAuditLogs;
            delete j.clearedAuditLogsTimestamp;
            delete j.cloudGroupBackups;
            j._authoritativeBackups = false;
          }
        });
      }
    }

    if (action === 'patchDelta' && effectiveGroup && reqRole !== 'admin' && isPureRamStateDelta_(payload, effectiveGroup)) {
      const fastLock = LockService.getScriptLock();
      if (!fastLock.tryLock(2500)) {
        return buildJsonResponse_({ status: 'ok', patched: false, skippedBusyRam: true, serverTime: new Date().toISOString() });
      }
      try {
        if (isPureRamStateDelta_(payload, effectiveGroup)) {
          const fastState = updateStatePoolInRamOnly_(effectiveGroup, payload.techLocDelta);
          return buildJsonResponse_({ status: 'ok', patched: true, ramFastPath: true, group: effectiveGroup, updatedAt: fastState.updatedAt, serverTime: new Date().toISOString() });
        }
      } finally {
        try { fastLock.releaseLock(); } catch (err) {}
      }
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(SCRIPT_LOCK_WAIT_MS)) {
      logSystemEvent_('WARN', action, effectiveGroup || reqGroup || 'ALL', logUser, 'คิวเขียนข้อมูลหนาแน่นเกิน 12 วินาที (Lock Timeout)', '');
      return buildJsonResponse_({ status: 'error', busy: true, retryable: true, code: 'SERVER_BUSY', message: 'Server busy, please retry' });
    }

    let postUnlockSheetPdfRef = '';
    let postUnlockReqPdfRef = '';
    let postUnlockPdfGroup = effectiveGroup || 'กฟส.บึง';
    let txWriteResult = null;

    try {
      if (action === 'saveUsers' && Array.isArray(payload.users)) {
        if (reqRole !== 'admin') {
          return buildJsonResponse_({ status: 'error', message: 'Admin permission required' });
        }
        const hasAdmin = payload.users.some(function(u) { return u && parseRoleString_(u.role).role === 'admin'; });
        if (!hasAdmin) {
          return buildJsonResponse_({ status: 'error', message: 'At least one admin account is required' });
        }
        saveUsersData_(payload.users);
        syncAllUserGroupsToSheets_(payload.users);
        return buildJsonResponse_({ status: 'ok', count: payload.users.length, groupNodes: getGroupNodesMap_(), serverTime: new Date().toISOString() });
      }

      if (action === 'patchDelta') {
        if (reqRole === 'admin' && !effectiveGroup) {
          const targetGroups = detectAllTargetGroupsForAdminDelta_(payload);
          const writtenPerGroup = {};
          targetGroups.forEach(function(g) {
            const subPayload = filterDeltaPayloadForSingleGroup_(payload, g);
            writtenPerGroup[g] = applyModularDeltaPatch_(g, subPayload).writtenTabs;
          });
          return buildJsonResponse_({ status: 'ok', patched: true, adminMultiGroup: true, writtenGroups: writtenPerGroup, serverTime: new Date().toISOString() });
        }
        const result = applyModularDeltaPatch_(effectiveGroup || 'กฟส.บึง', payload);
        return buildJsonResponse_({ status: 'ok', patched: true, group: effectiveGroup || 'กฟส.บึง', writtenTabs: result.writtenTabs, serverTime: new Date().toISOString() });
      }

      if (action === 'saveJobs' && Array.isArray(payload.jobs)) {
        if (reqRole === 'admin' && !effectiveGroup) {
          const allGroups = getAllActiveSystemGroups_(payload.jobs);
          let totalCount = 0;
          allGroups.forEach(function(g) {
            const subJobs = filterFullJobsArrayForSingleGroup_(payload.jobs, g);
            totalCount += applyModularFullSync_(g, subJobs).jobCount;
          });
          return buildJsonResponse_({ status: 'ok', adminMultiGroup: true, count: totalCount, serverTime: new Date().toISOString() });
        }
        const result = applyModularFullSync_(effectiveGroup || 'กฟส.บึง', payload.jobs);
        return buildJsonResponse_({ status: 'ok', group: effectiveGroup || 'กฟส.บึง', writtenTabs: result.writtenTabs, count: result.jobCount, serverTime: new Date().toISOString() });
      }

      if (action === 'saveTxLoad' || action === 'deleteTxLoad') {
        txWriteResult = handleWriteTxLoadLocked_(action, payload, effectiveGroup, auth);
        if (txWriteResult) {
          postUnlockSheetPdfRef = String(txWriteResult._removedPdfRef || '').trim();
          if (action === 'deleteTxLoad') {
            postUnlockReqPdfRef = String(payload.fileId || payload.pdfUrl || '').trim();
          }
          postUnlockPdfGroup = txWriteResult.group || postUnlockPdfGroup;
          delete txWriteResult._removedPdfRef;
        }
      } else {
        return buildJsonResponse_({ status: 'error', message: 'Unknown action: ' + action });
      }

    } finally {
      flushDirtySheetsSafe_();
      try { lock.releaseLock(); } catch (err) {}
    }

    const sheetTrashId = extractDriveFileIdServer_(postUnlockSheetPdfRef);
    const reqTrashId = extractDriveFileIdServer_(postUnlockReqPdfRef);
    if (sheetTrashId) {
      trashTxPdfFileSafe_(sheetTrashId, postUnlockPdfGroup, auth);
    }
    if (reqTrashId && reqTrashId !== sheetTrashId) {
      trashTxPdfFileSafe_(reqTrashId, postUnlockPdfGroup, auth);
    }
    if (txWriteResult) {
      return buildJsonResponse_(txWriteResult);
    }
    return buildJsonResponse_({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    logSystemEvent_('ERROR', logAction, logGroup, logUser, 'เกิดข้อผิดพลาดร้ายแรงใน doPost', err);
    return buildJsonResponse_({ status: 'error', message: String(err) });
  }
}

// ============================================================================
// 🌐 ระบบคลายลิงก์สั้น Google Maps ฝั่งเซิร์ฟเวอร์ (จำกัดโดเมน + สงวนโควตา UrlFetchApp)
// ============================================================================

function isAllowedShortMapHost_(urlStr) {
  const m = String(urlStr || '').trim().match(/^https?:\/\/([^\/:?#]+)/i);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (host === 'goo.gl' || host === 'maps.app.goo.gl') return true;
  if (/^(?:www\.|maps\.)?google\.[a-z.]{2,6}$/.test(host)) return true;
  return false;
}

function extractCoordsFromUrlServer_(rawStr) {
  if (!rawStr) return null;
  let s = String(rawStr).trim();
  try { s = decodeURIComponent(s); } catch (e) {}

  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/i) ||
            s.match(/[?&](?:q|ll|destination|query|center|daddr)=(-?\d+\.\d+)\s*,\s*\+?(-?\d+\.\d+)/i) ||
            s.match(/@(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/) ||
            s.match(/(?:lat(?:itude)?|ละติจูด)\s*[:：=]?\s*(-?\d{1,3}\.\d{3,})[\s,;\/|]*(?:long(?:itude)?|lon|lng|ลองจิจูด)\s*[:：=]?\s*\+?(-?\d{1,3}\.\d{3,})/i) ||
            s.match(/(-?\d{1,3}\.\d{3,})\s*,\s*\+?(-?\d{1,3}\.\d{3,})/);
  if (!m) return null;

  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lon)) return null;
  if (lat >= 95 && lat <= 108 && lon >= 4 && lon <= 23) {
    const tmp = lat;
    lat = lon;
    lon = tmp;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}

function handleResolveShortUrl_(rawUrl, isAuthedStaff) {
  let u = String(rawUrl || '').trim();
  if (!u || u.length > 2048) return { status: 'error', message: 'Invalid URL' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

  const direct = extractCoordsFromUrlServer_(u);
  if (direct) {
    return { status: 'ok', resolvedUrl: u, lat: direct.lat, lon: direct.lon };
  }
  if (!isAllowedShortMapHost_(u)) {
    return { status: 'error', message: 'Unsupported map URL domain' };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'PEA_SHORTURL_' + computeMd5Hex_(u);
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  // สงวนโควตา UrlFetchApp รายวัน: จำกัดฝั่งสาธารณะที่ไม่ล็อกอินไม่เกิน 60 ลิงก์ใหม่ต่อ 10 นาที
  if (!isAuthedStaff) {
    const winBucket = Math.floor(Date.now() / (SEC_PUBLIC_SHORTURL_WIN_SEC * 1000));
    const quotaKey = 'PEA_SEC_SURL_' + winBucket;
    const qMap = getSecCountersMap_([quotaKey]);
    if ((qMap[quotaKey] || 0) >= SEC_PUBLIC_SHORTURL_MAX) {
      logSystemEvent_('WARN', 'shortUrlQuotaGuard', 'PUBLIC', 'PUBLIC', 'จำกัดโควตาแปลงลิงก์สั้นสาธารณะชั่วคราวเพื่อสงวนโควตาให้ระบบหลัก', { limit: SEC_PUBLIC_SHORTURL_MAX });
      return {
        status: 'error',
        rateLimited: true,
        message: 'ขณะนี้มีผู้ใช้งานแปลงลิงก์สั้นจำนวนมาก กรุณาแตะเลือกจุดบนแผนที่โดยตรง หรือวางพิกัดตัวเลข Lat, Lon'
      };
    }
    bumpSecCounterWithTs_(quotaKey, SEC_PUBLIC_SHORTURL_WIN_SEC + 30);
  }

  let currentUrl = u;
  let foundCoords = null;
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (!isAllowedShortMapHost_(currentUrl)) break;
      const resp = UrlFetchApp.fetch(currentUrl, {
        method: 'get',
        followRedirects: false,
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PEASmartGrid/6.5)' }
      });
      const headers = resp.getAllHeaders ? resp.getAllHeaders() : resp.getHeaders();
      const loc = headers ? (headers['Location'] || headers['location'] || '') : '';
      if (loc) {
        let nextUrl = String(Array.isArray(loc) ? loc[0] : loc).trim();
        if (nextUrl.indexOf('/') === 0) {
          const originMatch = currentUrl.match(/^(https?:\/\/[^\/]+)/i);
          if (originMatch) nextUrl = originMatch[1] + nextUrl;
        }
        currentUrl = nextUrl;
        foundCoords = extractCoordsFromUrlServer_(currentUrl);
        if (foundCoords) break;
      } else {
        const htmlSnippet = resp.getContentText().substring(0, 35000);
        foundCoords = extractCoordsFromUrlServer_(htmlSnippet);
        break;
      }
    }
  } catch (err) {
    return { status: 'error', resolvedUrl: currentUrl, message: String(err) };
  }

  const out = foundCoords
    ? { status: 'ok', resolvedUrl: currentUrl, lat: foundCoords.lat, lon: foundCoords.lon }
    : { status: 'ok', resolvedUrl: currentUrl };

  // จำแคชทั้งลิงก์ที่สำเร็จ (6 ชม.) และลิงก์เสีย/หาไม่เจอ (10 นาที) กันบอทยิงลิงก์ปลอมซ้ำๆ
  try { cache.put(cacheKey, JSON.stringify(out), foundCoords ? CACHE_TTL_SEC : 600); } catch (e) {}
  return out;
}
// ============================================================================
// 🏗️ ระบบจัดมาตรฐานชื่อสาขา (กฟส.) + กั้นข้อมูลไม่ให้รั่วหรือปนข้ามสาขา 100%
// ============================================================================

function cleanGroupParam_(rawStr) {
  if (!rawStr) return '';
  return String(rawStr).split('?')[0].split('&')[0].trim();
}

function normalizePeaGroupNameServer_(rawGrp) {
  let g = String(rawGrp || '').replace(/[\r\n\t]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!g || g.toLowerCase() === 'admin' || g.toUpperCase() === 'ALL' || g === '__ADMIN_ALL__') {
    return '';
  }
  if (/[()[\]{}<>\\\/]/.test(g) || /^\d+$/.test(g)) return '';
  g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.');
  g = g.replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.');
  g = g.replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
  return g.length > 60 ? g.substring(0, 60).trim() : g.trim();
}

function isKnownOrValidSystemGroup_(groupName, nodesMapOpt, usersOpt) {
  const norm = normalizePeaGroupNameServer_(groupName);
  if (!norm) return false;
  if (norm === 'กฟส.บึง') return true;
  const nodes = nodesMapOpt || getGroupNodesMap_();
  if (nodes && nodes[norm]) return true;
  const users = usersOpt || getUsersData_();
  for (let i = 0; i < (users || []).length; i++) {
    if (getUserGroupNameServer_(users[i] && users[i].username, false) === norm) return true;
  }
  return false;
}

function inferRecordOwnerGroup_(rec) {
  if (!rec || typeof rec !== 'object') return 'กฟส.บึง';
  if (rec.ownerGroup && String(rec.ownerGroup).trim()) {
    const og = normalizePeaGroupNameServer_(rec.ownerGroup);
    if (og) return og;
  }
  const ownerGrp = getUserGroupNameServer_(rec.ownerUser, false);
  if (ownerGrp) return ownerGrp;

  const strictCandidates = [rec.techNav && rec.techNav.techName, rec.techReport && rec.techReport.inspector];
  for (let i = 0; i < strictCandidates.length; i++) {
    const g = getUserGroupNameServer_(strictCandidates[i], true);
    if (g) return g;
  }
  return 'กฟส.บึง';
}

function filterTechLocationsForGroup_(techLocationsObj, groupName) {
  if (!techLocationsObj || typeof techLocationsObj !== 'object') return {};
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const filtered = {};

  Object.keys(techLocationsObj).forEach(function(k) {
    if (k === REGISTRY_LOC_KEY) {
      filtered[k] = techLocationsObj[k];
      return;
    }
    const loc = techLocationsObj[k];
    if (!loc || typeof loc !== 'object') return;

    if (String(k).indexOf(PM_LOC_PREFIX) === 0) {
      const shardGrp = normalizePeaGroupNameServer_(k.substring(PM_LOC_PREFIX.length)) ||
                       normalizePeaGroupNameServer_(loc.group) ||
                       'กฟส.บึง';
      if (shardGrp === targetGrp) {
        filtered[PM_LOC_PREFIX + targetGrp] = Object.assign({}, loc, { group: targetGrp });
      }
      return;
    }
    if (String(k).indexOf(CALIB_LOC_PREFIX) === 0) {
      const calGrp = normalizePeaGroupNameServer_(k.substring(CALIB_LOC_PREFIX.length)) ||
                     normalizePeaGroupNameServer_(loc.group) ||
                     'กฟส.บึง';
      if (calGrp === targetGrp) {
        filtered[CALIB_LOC_PREFIX + targetGrp] = Object.assign({}, loc, { group: targetGrp });
      }
      return;
    }

    const locGrp = normalizePeaGroupNameServer_(loc.group) ||
                   getUserGroupNameServer_(k, false) ||
                   getUserGroupNameServer_(loc.username, false);
    if (locGrp === targetGrp || (!locGrp && targetGrp === 'กฟส.บึง')) {
      filtered[k] = loc;
    }
  });
  return filtered;
}

function getAllActiveSystemGroups_(optionalJobsArray) {
  const groups = { 'กฟส.บึง': true };
  const nodesMap = getGroupNodesMap_();
  Object.keys(nodesMap || {}).forEach(function(g) {
    const ng = normalizePeaGroupNameServer_(g);
    if (ng) groups[ng] = true;
  });
  (getUsersData_() || []).forEach(function(u) {
    const g = getUserGroupNameServer_(u && u.username, false);
    if (g) groups[g] = true;
  });
  (optionalJobsArray || []).forEach(function(j) {
    if (!j || typeof j !== 'object') return;
    if (j.jobType === 'tech_loc') {
      (j.electricEquipmentPins || []).forEach(function(p) {
        const pg = p && p.ownerGroup ? normalizePeaGroupNameServer_(p.ownerGroup) : '';
        if (pg) groups[pg] = true;
      });
      Object.keys(j.techLocations || {}).forEach(function(tk) {
        if (String(tk).indexOf(PM_LOC_PREFIX) === 0) {
          const sg = normalizePeaGroupNameServer_(tk.substring(PM_LOC_PREFIX.length));
          if (sg) groups[sg] = true;
        }
      });
    } else {
      const g = inferRecordOwnerGroup_(j);
      if (g) groups[g] = true;
    }
  });
  return Object.keys(groups);
}

function groupOwnsJobKey_(groupName, rawKey) {
  if (!rawKey) return false;
  const st = getStatePool_(groupName);
  if ((st.deletedJobsMap && st.deletedJobsMap[rawKey]) || (st.closedJobsMap && st.closedJobsMap[rawKey])) return true;
  const jobs = getJobsPool_(groupName);
  for (let i = 0; i < jobs.length; i++) {
    if (getRawJobKey_(jobs[i]) === rawKey) return true;
  }
  return false;
}

function filterDeletedJobsMapForAdminGroup_(rawDelMap, targetGrp, allGroups) {
  if (!rawDelMap || typeof rawDelMap !== 'object') return {};
  const out = {};
  Object.keys(rawDelMap).forEach(function(rk) {
    if (groupOwnsJobKey_(targetGrp, rk)) {
      out[rk] = rawDelMap[rk];
      return;
    }
    if (targetGrp === 'กฟส.บึง') {
      const ownedElsewhere = (allGroups || []).some(function(g) { return g !== 'กฟส.บึง' && groupOwnsJobKey_(g, rk); });
      if (!ownedElsewhere) out[rk] = rawDelMap[rk];
    }
  });
  return out;
}

function detectAllTargetGroupsForAdminDelta_(deltaPayload) {
  const upserted = Array.isArray(deltaPayload.upsertedJobs) ? deltaPayload.upsertedJobs : [];
  const removed = Array.isArray(deltaPayload.removedJobKeys) ? deltaPayload.removedJobKeys : [];
  const tDelta = deltaPayload.techLocDelta || {};
  const allGroups = getAllActiveSystemGroups_(upserted);
  const targetMap = {};

  upserted.forEach(function(j) { targetMap[inferRecordOwnerGroup_(j)] = true; });
  Object.keys(tDelta.techLocations || {}).forEach(function(k) {
    if (k === REGISTRY_LOC_KEY) return;
    if (String(k).indexOf(PM_LOC_PREFIX) === 0) {
      const sg = normalizePeaGroupNameServer_(k.substring(PM_LOC_PREFIX.length)) || 'กฟส.บึง';
      targetMap[sg] = true;
      return;
    }
    const loc = tDelta.techLocations[k];
    const g = (loc && loc.group ? normalizePeaGroupNameServer_(loc.group) : '') || getUserGroupNameServer_(k, false) || 'กฟส.บึง';
    targetMap[g] = true;
  });

  if (removed.length > 0 || Object.keys(tDelta.deletedJobsMap || {}).length > 0 || !tDelta._keepPins || !tDelta._keepDelPins || !tDelta._keepAuditLogs || !tDelta._keepBackups) {
    allGroups.forEach(function(g) { targetMap[g] = true; });
  }
  const keys = Object.keys(targetMap);
  return keys.length > 0 ? keys : ['กฟส.บึง'];
}

function filterDeltaPayloadForSingleGroup_(deltaPayload, groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const allGroups = getAllActiveSystemGroups_(deltaPayload.upsertedJobs);
  const upserted = (deltaPayload.upsertedJobs || []).filter(function(j) { return inferRecordOwnerGroup_(j) === targetGrp; });
  const removed = (deltaPayload.removedJobKeys || []).filter(function(rk) {
    const rawK = String(rk || '').replace(/^[FO]_/, '');
    return groupOwnsJobKey_(targetGrp, rawK);
  });

  let tDeltaCopy = null;
  if (deltaPayload.techLocDelta) {
    tDeltaCopy = Object.assign({}, deltaPayload.techLocDelta);
    if (tDeltaCopy.techLocations) tDeltaCopy.techLocations = filterTechLocationsForGroup_(tDeltaCopy.techLocations, targetGrp);
    if (tDeltaCopy.deletedJobsMap) tDeltaCopy.deletedJobsMap = filterDeletedJobsMapForAdminGroup_(tDeltaCopy.deletedJobsMap, targetGrp, allGroups);
    if (!tDeltaCopy._keepPins && Array.isArray(tDeltaCopy.electricEquipmentPins)) {
      tDeltaCopy.electricEquipmentPins = tDeltaCopy.electricEquipmentPins.filter(function(p) {
        return p && (normalizePeaGroupNameServer_(p.ownerGroup) || 'กฟส.บึง') === targetGrp;
      });
    }
    if (!tDeltaCopy._keepAuditLogs && Array.isArray(tDeltaCopy.deletedEquipAuditLogs)) {
      tDeltaCopy.deletedEquipAuditLogs = tDeltaCopy.deletedEquipAuditLogs.filter(function(log) {
        return log && (normalizePeaGroupNameServer_(log.ownerGroup) || 'กฟส.บึง') === targetGrp;
      });
    }
    if (!tDeltaCopy._keepBackups && tDeltaCopy.cloudGroupBackups && typeof tDeltaCopy.cloudGroupBackups === 'object') {
      const singleBackup = {};
      Object.keys(tDeltaCopy.cloudGroupBackups).forEach(function(bkGrp) {
        if ((normalizePeaGroupNameServer_(bkGrp) || bkGrp) === targetGrp && tDeltaCopy.cloudGroupBackups[bkGrp]) {
          singleBackup[targetGrp] = tDeltaCopy.cloudGroupBackups[bkGrp];
        }
      });
      tDeltaCopy.cloudGroupBackups = singleBackup;
    }
  }
  return {
    action: 'patchDelta',
    ramOnly: deltaPayload.ramOnly,
    forceSheetWrite: deltaPayload.forceSheetWrite,
    upsertedJobs: upserted,
    removedJobKeys: removed,
    techLocDelta: tDeltaCopy
  };
}

function filterFullJobsArrayForSingleGroup_(jobsArray, groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const allGroups = getAllActiveSystemGroups_(jobsArray);
  const filtered = [];
  (jobsArray || []).forEach(function(j) {
    if (!j || typeof j !== 'object') return;
    if (j.jobType === 'tech_loc' || j.dateTimeSaved === 'TECH_LOC_REGISTRY') {
      const locCopy = Object.assign({}, j);
      if (locCopy.techLocations) locCopy.techLocations = filterTechLocationsForGroup_(locCopy.techLocations, targetGrp);
      if (locCopy.deletedJobsMap) locCopy.deletedJobsMap = filterDeletedJobsMapForAdminGroup_(locCopy.deletedJobsMap, targetGrp, allGroups);
      if (Array.isArray(locCopy.electricEquipmentPins)) {
        locCopy.electricEquipmentPins = locCopy.electricEquipmentPins.filter(function(p) {
          return p && (normalizePeaGroupNameServer_(p.ownerGroup) || 'กฟส.บึง') === targetGrp;
        });
      }
      if (Array.isArray(locCopy.deletedEquipAuditLogs)) {
        locCopy.deletedEquipAuditLogs = locCopy.deletedEquipAuditLogs.filter(function(log) {
          return log && (normalizePeaGroupNameServer_(log.ownerGroup) || 'กฟส.บึง') === targetGrp;
        });
      }
      if (locCopy.cloudGroupBackups && typeof locCopy.cloudGroupBackups === 'object') {
        const grpB = {};
        Object.keys(locCopy.cloudGroupBackups).forEach(function(bkGrp) {
          if ((normalizePeaGroupNameServer_(bkGrp) || bkGrp) === targetGrp && locCopy.cloudGroupBackups[bkGrp]) {
            grpB[targetGrp] = locCopy.cloudGroupBackups[bkGrp];
          }
        });
        locCopy.cloudGroupBackups = grpB;
        locCopy._authoritativeBackups = Boolean(j._authoritativeBackups);
      }
      filtered.push(locCopy);
    } else if (inferRecordOwnerGroup_(j) === targetGrp) {
      filtered.push(j);
    }
  });
  return filtered;
}

// ============================================================================
// 🗂️ ระบบจัดการ Spreadsheet แยกสาขา (Double-Checked Lock + Auto-Rebuild + MD5)
// ============================================================================

const OPEN_SS_MEMO_ = {};
let MASTER_SS_MEMO_ = null;
const NODE_SHEET_HEADERS_ = [
  'GroupName (ชื่อ กฟส.)',
  'SpreadsheetId (สร้างอัตโนมัติ)',
  'SheetUrl (ลิงก์เปิดไฟล์ชีตของ กฟส.)',
  'CustomWebAppUrl (ลิงก์ /exec แยกถ้ามี)'
];

function flushDirtySheetsSafe_() {
  if (!HAS_DIRTY_SHEET_WRITES_) return;
  try { SpreadsheetApp.flush(); } catch (e) {}
  HAS_DIRTY_SHEET_WRITES_ = false;
}

function computeMd5Hex_(inputStr) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(inputStr || ''),
    Utilities.Charset.UTF_8
  );
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i] < 0 ? digest[i] + 256 : digest[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function getMasterSpreadsheet_() {
  if (!MASTER_SS_MEMO_) {
    MASTER_SS_MEMO_ = SpreadsheetApp.getActiveSpreadsheet();
  }
  return MASTER_SS_MEMO_;
}

function getGroupCacheKey_(basePrefix, groupName) {
  const cleanGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  return basePrefix + '_' + computeMd5Hex_(cleanGrp).substring(0, 16);
}

function readGroupNodesDirectFromMaster_() {
  const ss = getMasterSpreadsheet_();
  const sheet = ss.getSheetByName(SHEET_GROUP_NODES);
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};

  const values = sheet.getRange(2, 1, lastRow - 1, 4).getDisplayValues();
  const map = {};
  for (let i = 0; i < values.length; i++) {
    const rawGrp = String(values[i][0] || '').trim();
    const grp = normalizePeaGroupNameServer_(rawGrp) || rawGrp;
    const sheetId = String(values[i][1] || '').trim();
    const sheetUrl = String(values[i][2] || '').trim();
    const customExec = String(values[i][3] || '').trim();
    if (grp && sheetId) {
      map[grp] = { groupName: grp, spreadsheetId: sheetId, sheetUrl: sheetUrl, customWebAppUrl: customExec };
    }
  }
  return map;
}

function getGroupNodesMap_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('PEA_V65_NODES');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  const map = readGroupNodesDirectFromMaster_();
  try { cache.put('PEA_V65_NODES', JSON.stringify(map), CACHE_TTL_SEC); } catch (e) {}
  return map;
}

function upsertGroupNodeRow_(cleanGrp, nodeObj) {
  const masterSs = getMasterSpreadsheet_();
  let nodeSheet = masterSs.getSheetByName(SHEET_GROUP_NODES);
  if (!nodeSheet) {
    nodeSheet = masterSs.insertSheet(SHEET_GROUP_NODES);
    const hdrRange = nodeSheet.getRange(1, 1, 1, 4);
    hdrRange.setNumberFormat('@');
    hdrRange.setValues([NODE_SHEET_HEADERS_]);
  }

  const lastRow = nodeSheet.getLastRow();
  let updatedExisting = false;
  if (lastRow > 1) {
    const rows = nodeSheet.getRange(2, 1, lastRow - 1, 4).getDisplayValues();
    for (let i = 0; i < rows.length; i++) {
      const rowGrp = normalizePeaGroupNameServer_(rows[i][0]) || String(rows[i][0] || '').trim();
      if (rowGrp === cleanGrp) {
        const keepExec = nodeObj.customWebAppUrl || String(rows[i][3] || '').trim();
        nodeObj.customWebAppUrl = keepExec;
        const rRange = nodeSheet.getRange(i + 2, 1, 1, 4);
        rRange.setNumberFormat('@');
        rRange.setValues([[cleanGrp, nodeObj.spreadsheetId, nodeObj.sheetUrl, keepExec]]);
        updatedExisting = true;
        break;
      }
    }
  }

  if (!updatedExisting) {
    const newRowIdx = Math.max(2, lastRow + 1);
    const nRange = nodeSheet.getRange(newRowIdx, 1, 1, 4);
    nRange.setNumberFormat('@');
    nRange.setValues([[cleanGrp, nodeObj.spreadsheetId, nodeObj.sheetUrl, nodeObj.customWebAppUrl || '']]);
  }
  HAS_DIRTY_SHEET_WRITES_ = true;

  const freshMap = readGroupNodesDirectFromMaster_();
  freshMap[cleanGrp] = nodeObj;
  try { CacheService.getScriptCache().put('PEA_V65_NODES', JSON.stringify(freshMap), CACHE_TTL_SEC); } catch (e) {}
}

function createFreshGroupSpreadsheetFile_(cleanGrp) {
  const newSs = SpreadsheetApp.create('⚡ PEA_SmartGrid_' + cleanGrp);
  OPEN_SS_MEMO_[newSs.getId()] = newSs;
  const defaultSheet = newSs.getSheets()[0];

  const tabNames = [SHEET_JOBS, SHEET_TECH_STATE, SHEET_PINS, SHEET_BACKUPS, SHEET_TX_LOAD];
  tabNames.forEach(function(tName) {
    let sh = newSs.getSheetByName(tName);
    if (!sh) {
      sh = newSs.insertSheet(tName);
      const r = sh.getRange(1, 1, 1, 2);
      r.setNumberFormat('@');
      r.setValues([['Key', 'JSON_Part_1']]);
    }
  });

  if (defaultSheet && tabNames.indexOf(defaultSheet.getName()) === -1 && newSs.getSheets().length > 1) {
    try { newSs.deleteSheet(defaultSheet); } catch (e) {}
  }
  protectPinsSheetTab_(newSs);
  return newSs;
}

function ensureGroupSpreadsheetExists_(groupName, callerHoldsLock) {
  const cleanGrp = normalizePeaGroupNameServer_(groupName);
  if (!cleanGrp) return null;

  const cachedMap = getGroupNodesMap_();
  if (cachedMap[cleanGrp] && cachedMap[cleanGrp].spreadsheetId) {
    return cachedMap[cleanGrp];
  }

  const scriptLock = LockService.getScriptLock();
  const acquiredHere = (!callerHoldsLock && !scriptLock.hasLock());
  if (acquiredHere) {
    try { scriptLock.waitLock(20000); } catch (lockErr) {}
  }

  try {
    const directMap = readGroupNodesDirectFromMaster_();
    if (directMap[cleanGrp] && directMap[cleanGrp].spreadsheetId) {
      try { CacheService.getScriptCache().put('PEA_V65_NODES', JSON.stringify(directMap), CACHE_TTL_SEC); } catch (e) {}
      return directMap[cleanGrp];
    }

    const newSs = createFreshGroupSpreadsheetFile_(cleanGrp);
    migrateGroupDataFromMasterSheet_(cleanGrp, newSs);
    const newNode = { groupName: cleanGrp, spreadsheetId: newSs.getId(), sheetUrl: newSs.getUrl(), customWebAppUrl: '' };
    upsertGroupNodeRow_(cleanGrp, newNode);
    if (acquiredHere) flushDirtySheetsSafe_();
    return newNode;
  } catch (err) {
    const fallbackSs = getMasterSpreadsheet_();
    return { groupName: cleanGrp, spreadsheetId: fallbackSs.getId(), sheetUrl: fallbackSs.getUrl(), customWebAppUrl: '' };
  } finally {
    if (acquiredHere) {
      try { scriptLock.releaseLock(); } catch (e) {}
    }
  }
}

function rebuildDeletedGroupSpreadsheet_(cleanGrp, brokenSheetId) {
  const rebuildLock = LockService.getScriptLock();
  const alreadyHeld = rebuildLock.hasLock();
  let gotLock = false;
  if (!alreadyHeld) {
    try { gotLock = rebuildLock.tryLock(15000); } catch (e) {}
  }
  try {
    delete OPEN_SS_MEMO_[brokenSheetId];
    const directMap = readGroupNodesDirectFromMaster_();
    if (directMap[cleanGrp] && directMap[cleanGrp].spreadsheetId && directMap[cleanGrp].spreadsheetId !== brokenSheetId) {
      return SpreadsheetApp.openById(directMap[cleanGrp].spreadsheetId);
    }
    const newSs = createFreshGroupSpreadsheetFile_(cleanGrp);
    const prevExec = (directMap[cleanGrp] && directMap[cleanGrp].customWebAppUrl) || '';
    upsertGroupNodeRow_(cleanGrp, { groupName: cleanGrp, spreadsheetId: newSs.getId(), sheetUrl: newSs.getUrl(), customWebAppUrl: prevExec });
    if (!alreadyHeld) flushDirtySheetsSafe_();
    return newSs;
  } catch (err) {
    return getMasterSpreadsheet_();
  } finally {
    if (gotLock && !alreadyHeld) {
      try { rebuildLock.releaseLock(); } catch (e) {}
    }
  }
}

function syncAllUserGroupsToSheets_(usersArray) {
  const groups = { 'กฟส.บึง': true };
  (usersArray || []).forEach(function(u) {
    const g = getUserGroupNameServer_(u && u.username, false);
    if (g) groups[g] = true;
  });
  Object.keys(groups).forEach(function(gName) { ensureGroupSpreadsheetExists_(gName, true); });
}

function openGroupSpreadsheet_(groupName) {
  const cleanGrp = normalizePeaGroupNameServer_(groupName);
  if (!cleanGrp) return getMasterSpreadsheet_();

  const node = ensureGroupSpreadsheetExists_(cleanGrp, false);
  if (node && node.spreadsheetId) {
    if (OPEN_SS_MEMO_[node.spreadsheetId]) return OPEN_SS_MEMO_[node.spreadsheetId];
    try {
      const opened = SpreadsheetApp.openById(node.spreadsheetId);
      OPEN_SS_MEMO_[node.spreadsheetId] = opened;
      return opened;
    } catch (e) {
      return rebuildDeletedGroupSpreadsheet_(cleanGrp, node.spreadsheetId);
    }
  }
  return getMasterSpreadsheet_();
}

// ============================================================================
// ⚡ ระบบ 5-Pool RAM-First Fast-Path & ประกอบใบงานรายสาขา/ส่วนกลาง (Zero-Collision)
// ============================================================================

function hasNewerRegistryEntries_(oldMap, newMap) {
  if (!newMap || typeof newMap !== 'object') return false;
  const nKeys = Object.keys(newMap);
  if (nKeys.length === 0) return false;
  for (let i = 0; i < nKeys.length; i++) {
    const k = nKeys[i], nVal = newMap[k];
    if (!nVal) continue;
    if (!oldMap || oldMap[k] === undefined) return true;
    const oVal = oldMap[k];
    const oMs = (oVal && typeof oVal === 'object') ? parseTimestampMs_(oVal.updatedAt) : parseTimestampMs_(oVal);
    const nMs = (nVal && typeof nVal === 'object') ? parseTimestampMs_(nVal.updatedAt) : parseTimestampMs_(nVal);
    if (nMs > 0 && oMs > 0) {
      if (nMs > oMs) return true;
    } else if (JSON.stringify(oVal) !== JSON.stringify(nVal) && oMs === 0) {
      return true;
    }
  }
  return false;
}

function hasNewerPmSchedule_(oldLocs, newLocs, groupName) {
  if (!newLocs || typeof newLocs !== 'object') return false;
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const pmKeys = Object.keys(newLocs).filter(function(k) { return String(k).indexOf(PM_LOC_PREFIX) === 0; });
  for (let i = 0; i < pmKeys.length; i++) {
    const keyGrp = normalizePeaGroupNameServer_(pmKeys[i].substring(PM_LOC_PREFIX.length)) || 'กฟส.บึง';
    if (keyGrp !== targetGrp) continue;
    const incPm = newLocs[pmKeys[i]];
    const curPm = (oldLocs && oldLocs[PM_LOC_PREFIX + targetGrp]) || null;
    if (!incPm || typeof incPm !== 'object') continue;
    if (!curPm) return true;
    const incMs = parseTimestampMs_(incPm.updatedAt), curMs = parseTimestampMs_(curPm.updatedAt);
    if (incMs > curMs) return true;
    if (incPm.pmPlansMap && typeof incPm.pmPlansMap === 'object') {
      const curMap = curPm.pmPlansMap || {}, pIds = Object.keys(incPm.pmPlansMap);
      for (let j = 0; j < pIds.length; j++) {
        const pid = pIds[j], inP = incPm.pmPlansMap[pid], exP = curMap[pid];
        if (!inP || typeof inP !== 'object') continue;
        if (!exP) return true;
        const inPMs = parseTimestampMs_(inP.updatedAt), exPMs = parseTimestampMs_(exP.updatedAt);
        if (inPMs > exPMs || (inPMs === exPMs && Boolean(inP.pmDeleted) && !Boolean(exP.pmDeleted))) return true;
      }
    }
    if (Array.isArray(incPm.plans) && incMs === curMs && JSON.stringify(incPm.plans) !== JSON.stringify(curPm.plans || [])) return true;
  }

  // บังคับเขียนลงชีตทันทีเมื่อมีการอัปเดตค่าปรับเทียบ __FAULT_CALIB__ ของ scada-fault-locator.js
  const calKeys = Object.keys(newLocs).filter(function(k) { return String(k).indexOf(CALIB_LOC_PREFIX) === 0; });
  for (let c = 0; c < calKeys.length; c++) {
    const calGrp = normalizePeaGroupNameServer_(calKeys[c].substring(CALIB_LOC_PREFIX.length)) || 'กฟส.บึง';
    if (calGrp !== targetGrp) continue;
    const incCal = newLocs[calKeys[c]];
    const curCal = (oldLocs && oldLocs[CALIB_LOC_PREFIX + targetGrp]) || null;
    if (!incCal || typeof incCal !== 'object') continue;
    if (!curCal) return true;
    const incCMs = parseTimestampMs_(incCal.updatedAt || incCal.lastSeenAt);
    const curCMs = parseTimestampMs_(curCal.updatedAt || curCal.lastSeenAt);
    if (incCMs > curCMs || (incCMs === curCMs && JSON.stringify(incCal) !== JSON.stringify(curCal))) return true;
  }
  return false;
}


function isPureRamStateDelta_(payload, groupName) {
  if (payload.forceSheetWrite) return false;
  const upserted = Array.isArray(payload.upsertedJobs) ? payload.upsertedJobs : [];
  const removed = Array.isArray(payload.removedJobKeys) ? payload.removedJobKeys : [];
  const tDelta = payload.techLocDelta;
  if (upserted.length > 0 || !tDelta) return false;
  if (!tDelta._keepPins || !tDelta._keepDelPins || !tDelta._keepAuditLogs || !tDelta._keepBackups) return false;

  const currentState = getStatePool_(groupName);
  if (removed.length > 0) {
    const curDel = currentState.deletedJobsMap || {};
    for (let i = 0; i < removed.length; i++) {
      const rawK = String(removed[i] || '').replace(/^[FO]_/, '');
      if (rawK && !curDel[rawK]) return false;
    }
  }
  if (Date.now() - Number(currentState.lastSheetWriteMs || 0) >= STATE_SHEET_SYNC_INTERVAL_MS) return false;
  if (hasNewerPmSchedule_(currentState.techLocations, tDelta.techLocations, groupName)) return false;

  const oldCancelReg = (currentState.techLocations && currentState.techLocations[REGISTRY_LOC_KEY]) || {};
  const newCancelReg = (tDelta.techLocations && tDelta.techLocations[REGISTRY_LOC_KEY]) || {};
  if (hasNewerRegistryEntries_(oldCancelReg.equipCancelMap, newCancelReg.equipCancelMap)) return false;
  if (hasNewerRegistryEntries_(oldCancelReg.jobCancelMap, newCancelReg.jobCancelMap)) return false;
  if (hasNewerRegistryEntries_(currentState.closedJobsMap, tDelta.closedJobsMap || tDelta.closedReports)) return false;
  if (hasNewerRegistryEntries_(currentState.deletedJobsMap, tDelta.deletedJobsMap)) return false;
  return true;
}

function updateStatePoolInRamOnly_(groupName, techLocDelta) {
  const currentState = getStatePool_(groupName);
  const mergedState = mergeStateObjects_(currentState, techLocDelta, null, groupName);
  mergedState.lastSheetWriteMs = Number(currentState.lastSheetWriteMs || Date.now());
  saveStatePool_(groupName, mergedState, false, true);
  return mergedState;
}

// ตัดก้อนภาพลายเซ็นออกจากลูปซิงค์ทุก 6 วินาที เพื่อประหยัดดาต้ามือถือ (ส่งให้เต็ม 100% เมื่อเรียก ?action=getJob)
function stripMeterFormStateForPolling_(job) {
  if (!job || !job.meterFormState) return job;
  const lite = Object.assign({}, job);
  delete lite.meterFormState;
  return lite;
}

function assembleFullJobsForGroup_(groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const jobsList = getJobsPool_(targetGrp), stateObj = getStatePool_(targetGrp);
  const pinsObj = getPinsPool_(targetGrp), backupsMap = getBackupsPool_(targetGrp);
  const deletedJobsMap = stateObj.deletedJobsMap || {};
  const activeJobs = jobsList.filter(function(j) {
    const rk = getRawJobKey_(j);
    return j && typeof j === 'object' && !(rk && deletedJobsMap[rk] && !isJobNewerThanDelete_(j, deletedJobsMap[rk]));
  }).map(stripMeterFormStateForPolling_);
  return activeJobs.concat([{
    jobType: 'tech_loc',
    dateTimeSaved: 'TECH_LOC_REGISTRY',
    techLocations: stateObj.techLocations || {},
    closedJobsMap: stateObj.closedJobsMap || {},
    closedReports: stateObj.closedJobsMap || {},
    deletedJobsMap: deletedJobsMap,
    electricEquipmentPins: Array.isArray(pinsObj.electricEquipmentPins) ? pinsObj.electricEquipmentPins : [],
    deletedElectricEquipmentMap: pinsObj.deletedElectricEquipmentMap || {},
    deletedEquipAuditLogs: Array.isArray(pinsObj.deletedEquipAuditLogs) ? pinsObj.deletedEquipAuditLogs : [],
    clearedAuditLogsTimestamp: Number(pinsObj.clearedAuditLogsTimestamp || 0),
    cloudGroupBackups: backupsMap || {},
    updatedAt: stateObj.updatedAt || new Date().toISOString()
  }]);
}

function assembleAllGroupsJobsForAdmin_(nodesMap, rawUsers) {
  const groupSet = { 'กฟส.บึง': true };
  Object.keys(nodesMap || {}).forEach(function(g) { const ng = normalizePeaGroupNameServer_(g); if (ng) groupSet[ng] = true; });
  (rawUsers || []).forEach(function(u) { const g = getUserGroupNameServer_(u && u.username, false); if (g) groupSet[g] = true; });

  const allJobsMap = new Map();
  let mergedState = { techLocations: {}, closedJobsMap: {}, deletedJobsMap: {} };
  let mergedPins = { electricEquipmentPins: [], deletedElectricEquipmentMap: {}, deletedEquipAuditLogs: [], clearedAuditLogsTimestamp: 0 };
  let mergedBackups = {};

  Object.keys(groupSet).forEach(function(grp) {
    const grpJobs = getJobsPool_(grp) || [], grpState = getStatePool_(grp);
    const grpDel = grpState.deletedJobsMap || {}, grpReopen = collectReopenedJobsMap_(grpJobs, null);
    grpJobs.forEach(function(j) {
      const uKey = getJobUniqueKey_(j), rk = getRawJobKey_(j);
      if (uKey && !(rk && grpDel[rk] && !isJobNewerThanDelete_(j, grpDel[rk]))) {
        const cleanCopy = stripMeterFormStateForPolling_(Object.assign({}, j, { ownerGroup: inferRecordOwnerGroup_(j) || grp }));
        allJobsMap.set(grp + '::' + uKey, cleanCopy);
      }
    });
    mergedState = mergeStateObjects_(mergedState, grpState, grpReopen, '');
    mergedPins = mergePinsObjects_(mergedPins, getPinsPool_(grp));
    mergedBackups = mergeBackupsObjects_(mergedBackups, getBackupsPool_(grp), false);
  });

  const finalJobs = Array.from(allJobsMap.values());
  finalJobs.push({
    jobType: 'tech_loc',
    dateTimeSaved: 'TECH_LOC_REGISTRY',
    techLocations: mergedState.techLocations || {},
    closedJobsMap: mergedState.closedJobsMap || {},
    closedReports: mergedState.closedJobsMap || {},
    deletedJobsMap: mergedState.deletedJobsMap || {},
    electricEquipmentPins: mergedPins.electricEquipmentPins || [],
    deletedElectricEquipmentMap: mergedPins.deletedElectricEquipmentMap || {},
    deletedEquipAuditLogs: mergedPins.deletedEquipAuditLogs || [],
    clearedAuditLogsTimestamp: Number(mergedPins.clearedAuditLogsTimestamp || 0),
    cloudGroupBackups: mergedBackups,
    updatedAt: new Date().toISOString()
  });
  return finalJobs;
}

// ============================================================================
// 🗄️ ระบบฐานข้อมูล Pool 1-4 แยกตาม กฟส. (Jobs, TechState, Pins, Backups)
// ============================================================================

function parseJobSortTimeMs_(job) {
  if (!job || typeof job !== 'object') return 0;
  if (job.jobType === 'fault') {
    return parseAnyRecordDateMs_(job.timestamp) || Number(job.createdAtMs || 0) || 0;
  }
  if (job.createdAtMs && Number(job.createdAtMs) > 0) return Number(job.createdAtMs);
  if (!job.dateTimeSaved) return 0;
  return parseAnyRecordDateMs_(job.dateTimeSaved);
}

const MAX_JOB_RETENTION_DAYS = 365; // ลบเฉพาะใบงานไฟดับลูกค้า (outage) ที่เกิน 1 ปี ส่วนใบงานฟอลต์ (fault) เก็บไว้เป็นสถิติได้ต่อเนื่อง
function sortAndCapJobsList_(jobsArray) {
  const fltMap = new Map(), outMap = new Map();
  const cutoffMs = Date.now() - (MAX_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  (jobsArray || []).forEach(function(j) {
    if (!j || typeof j !== 'object' || j.jobType === 'tech_loc' || j.dateTimeSaved === 'TECH_LOC_REGISTRY') return;
    const jobMs = parseJobSortTimeMs_(j);
    if (j.jobType !== 'fault' && jobMs > 0 && jobMs < cutoffMs) return; // ไม่ตัดใบงาน fault เพื่อให้ scada-fault-locator.js ใช้ข้อมูลย้อนหลังได้
    const uk = getJobUniqueKey_(j);
    if (!uk) return;
    if (j.jobType === 'fault') fltMap.set(uk, j);
    else outMap.set(uk, j);
  });
  const sortedOut = Array.from(outMap.values()).sort(function(a, b) {
    return parseJobSortTimeMs_(b) - parseJobSortTimeMs_(a);
  }).slice(0, MAX_JOBS_PER_TYPE);
  const sortedFlt = Array.from(fltMap.values()).sort(function(a, b) {
    return parseJobSortTimeMs_(b) - parseJobSortTimeMs_(a);
  }).slice(0, MAX_JOBS_PER_TYPE);
  return sortedOut.concat(sortedFlt);
}

// Pool 1: JOBS
function getJobsPool_(groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const cacheKey = getGroupCacheKey_('PEA_V65_JOBS', targetGrp);
  const cached = getLargeCache_(cacheKey);
  if (cached && Array.isArray(cached)) return cached;

  const ss = openGroupSpreadsheet_(targetGrp);
  if (ss.getId() !== getMasterSpreadsheet_().getId() && isSheetTabEmpty_(ss, SHEET_TECH_STATE) && isSheetTabEmpty_(ss, SHEET_JOBS)) {
    migrateGroupDataFromMasterSheet_(targetGrp, ss);
  }

  const records = readKeyedSheetRecords_(ss, SHEET_JOBS, true);
  const realJobs = [];
  for (let i = 0; i < records.length; i++) {
    const item = records[i].data;
    if (item && typeof item === 'object' && item.jobType !== 'tech_loc' && item.dateTimeSaved !== 'TECH_LOC_REGISTRY') {
      realJobs.push(item);
    }
  }
  const capped = sortAndCapJobsList_(realJobs);
  putLargeCache_(cacheKey, capped);
  return capped;
}

function saveJobsPool_(groupName, jobsArray, writeToSheet) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const cappedJobs = sortAndCapJobsList_(jobsArray);
  const cacheKey = getGroupCacheKey_('PEA_V65_JOBS', targetGrp);
  putLargeCache_(cacheKey, cappedJobs);
  if (!writeToSheet) return;

  const ss = openGroupSpreadsheet_(targetGrp);
  const records = [];
  cappedJobs.forEach(function(job) {
    const key = getRawJobKey_(job);
    if (key) records.push({ key: key, data: job });
  });
  writeKeyedSheetRecords_(ss, SHEET_JOBS, records);
}

// Pool 2: STATE
function getStatePool_(groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const cacheKey = getGroupCacheKey_('PEA_V65_STATE', targetGrp);
  const cached = getLargeCache_(cacheKey);
  if (cached && typeof cached === 'object') return cached;

  const ss = openGroupSpreadsheet_(targetGrp);
  if (ss.getId() !== getMasterSpreadsheet_().getId() && isSheetTabEmpty_(ss, SHEET_TECH_STATE) && isSheetTabEmpty_(ss, SHEET_JOBS)) {
    migrateGroupDataFromMasterSheet_(targetGrp, ss);
  }
  const records = readKeyedSheetRecords_(ss, SHEET_TECH_STATE, true);
  const data = (records.length > 0 && records[0].data) ? records[0].data : {
    migratedFromMaster: true,
    techLocations: {},
    closedJobsMap: {},
    deletedJobsMap: {},
    lastSheetWriteMs: Date.now(),
    updatedAt: new Date().toISOString()
  };
  putLargeCache_(cacheKey, data);
  return data;
}

function saveStatePool_(groupName, stateObj, writeToSheet, skipPublicCacheInvalidate) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  stateObj.migratedFromMaster = true;
  putLargeCache_(getGroupCacheKey_('PEA_V65_STATE', targetGrp), stateObj);
  if (!skipPublicCacheInvalidate) invalidatePublicOutageCache_(targetGrp);
  if (!writeToSheet) return;
  writeKeyedSheetRecords_(openGroupSpreadsheet_(targetGrp), SHEET_TECH_STATE, [{ key: 'TECH_STATE', data: stateObj }]);
}

// Pool 3: PINS (พร้อมระบบสำรองแถวที่ 3 PINS_SNAPSHOT_BAK กู้คืนอัตโนมัติหากเซลล์หลักถูกแก้พัง)
function getPinsPool_(groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const cacheKey = getGroupCacheKey_('PEA_V65_PINS', targetGrp);
  const cached = getLargeCache_(cacheKey);
  if (cached && typeof cached === 'object') return cached;

  const ss = openGroupSpreadsheet_(targetGrp);
  const records = readKeyedSheetRecords_(ss, SHEET_PINS, true);
  let mainRec = null;
  let bakRec = null;
  for (let i = 0; i < records.length; i++) {
    if (records[i].key === 'PINS_DATA' && records[i].data) mainRec = records[i].data;
    else if (records[i].key === 'PINS_SNAPSHOT_BAK' && records[i].data) bakRec = records[i].data;
  }
  if (!mainRec && records.length > 0 && records[0].key !== 'PINS_SNAPSHOT_BAK' && records[0].data) {
    mainRec = records[0].data;
  }

  let data = mainRec;
  if (!data && bakRec) {
    data = bakRec;
    logSystemEvent_('WARN', 'recoverPinsPool', targetGrp, 'SYSTEM', 'ตรวจพบแถว PINS_DATA เสียหายหรือถูกลบ ระบบกู้คืนผังสายไฟจาก PINS_SNAPSHOT_BAK อัตโนมัติ', { restoredPins: (bakRec.electricEquipmentPins || []).length });
    try {
      if (LockService.getScriptLock().hasLock()) {
        writeKeyedSheetRecords_(ss, SHEET_PINS, [{ key: 'PINS_DATA', data: bakRec }, { key: 'PINS_SNAPSHOT_BAK', data: bakRec }]);
      }
    } catch (e) {}
  }

  if (!data) {
    data = {
      electricEquipmentPins: [],
      deletedElectricEquipmentMap: {},
      deletedEquipAuditLogs: [],
      clearedAuditLogsTimestamp: 0,
      updatedAt: new Date().toISOString()
    };
  }
  putLargeCache_(cacheKey, data);
  return data;
}

function savePinsPool_(groupName, pinsObj, writeToSheet) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  putLargeCache_(getGroupCacheKey_('PEA_V65_PINS', targetGrp), pinsObj);
  if (!writeToSheet) return;
  const rows = [{ key: 'PINS_DATA', data: pinsObj }];
  if (JSON.stringify(pinsObj || {}).length <= MAX_PINS_BACKUP_CHARS) {
    rows.push({ key: 'PINS_SNAPSHOT_BAK', data: pinsObj });
  }
  writeKeyedSheetRecords_(openGroupSpreadsheet_(targetGrp), SHEET_PINS, rows);
}

// Pool 4: BACKUPS
function getBackupsPool_(groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const cacheKey = getGroupCacheKey_('PEA_V65_BACKUPS', targetGrp);
  const cached = getLargeCache_(cacheKey);
  if (cached && typeof cached === 'object') return cached;

  const records = readKeyedSheetRecords_(openGroupSpreadsheet_(targetGrp), SHEET_BACKUPS, true);
  const map = {};
  for (let i = 0; i < records.length; i++) {
    if (records[i].key && records[i].data) {
      map[normalizePeaGroupNameServer_(records[i].key) || records[i].key] = records[i].data;
    }
  }
  putLargeCache_(cacheKey, map);
  return map;
}

function saveBackupsPool_(groupName, backupsMap, writeToSheet) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  putLargeCache_(getGroupCacheKey_('PEA_V65_BACKUPS', targetGrp), backupsMap);
  if (!writeToSheet) return;
  const rows = [];
  Object.keys(backupsMap || {}).forEach(function(grp) {
    if (grp && backupsMap[grp]) rows.push({ key: grp, data: backupsMap[grp] });
  });
  writeKeyedSheetRecords_(openGroupSpreadsheet_(targetGrp), SHEET_BACKUPS, rows);
}

function isSheetTabEmpty_(ss, sheetName) {
  const sh = ss.getSheetByName(sheetName);
  return !sh || sh.getLastRow() <= 1;
}

function migrateGroupDataFromMasterSheet_(groupName, targetSs) {
  try {
    const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
    const masterSs = getMasterSpreadsheet_();
    if (!targetSs || targetSs.getId() === masterSs.getId()) return;

    const masterJobRecs = readKeyedSheetRecords_(masterSs, SHEET_JOBS, false);
    const groupJobs = [];
    let legacyTechLoc = null;
    masterJobRecs.forEach(function(r) {
      if (!r || !r.data) return;
      if (r.data.jobType === 'tech_loc' || r.key === 'TECH_LOC_REGISTRY') legacyTechLoc = r.data;
      else if (inferRecordOwnerGroup_(r.data) === targetGrp) groupJobs.push({ key: r.key, data: r.data });
    });

    if (groupJobs.length > 0 && isSheetTabEmpty_(targetSs, SHEET_JOBS)) {
      writeKeyedSheetRecords_(targetSs, SHEET_JOBS, groupJobs);
    }
    if (isSheetTabEmpty_(targetSs, SHEET_TECH_STATE)) {
      const mState = readKeyedSheetRecords_(masterSs, SHEET_TECH_STATE, false);
      const baseSt = (mState.length > 0 && mState[0].data) ? mState[0].data : (legacyTechLoc || {});
      writeKeyedSheetRecords_(targetSs, SHEET_TECH_STATE, [{
        key: 'TECH_STATE',
        data: {
          migratedFromMaster: true,
          techLocations: filterTechLocationsForGroup_(baseSt.techLocations || {}, targetGrp),
          closedJobsMap: pruneAgedRegistry_(Object.assign({}, baseSt.closedJobsMap || {}, baseSt.closedReports || {}), true),
          deletedJobsMap: pruneAgedRegistry_(baseSt.deletedJobsMap || {}, false),
          lastSheetWriteMs: Date.now(),
          updatedAt: new Date().toISOString()
        }
      }]);
    }
    if (isSheetTabEmpty_(targetSs, SHEET_PINS)) {
      const mPins = readKeyedSheetRecords_(masterSs, SHEET_PINS, false);
      const baseP = (mPins.length > 0 && mPins[0].data) ? mPins[0].data : (legacyTechLoc || {});
      if (Array.isArray(baseP.electricEquipmentPins)) {
        const grpPins = baseP.electricEquipmentPins.filter(function(p) { return p && (normalizePeaGroupNameServer_(p.ownerGroup) || 'กฟส.บึง') === targetGrp; });
        const grpLogs = (baseP.deletedEquipAuditLogs || []).filter(function(l) { return l && (normalizePeaGroupNameServer_(l.ownerGroup) || 'กฟส.บึง') === targetGrp; });
        writeKeyedSheetRecords_(targetSs, SHEET_PINS, [{
          key: 'PINS_DATA',
          data: {
            electricEquipmentPins: grpPins,
            deletedElectricEquipmentMap: baseP.deletedElectricEquipmentMap || {},
            deletedEquipAuditLogs: grpLogs,
            clearedAuditLogsTimestamp: Number(baseP.clearedAuditLogsTimestamp || 0),
            updatedAt: new Date().toISOString()
          }
        }]);
      }
    }
    if (isSheetTabEmpty_(targetSs, SHEET_BACKUPS)) {
      const mBk = readKeyedSheetRecords_(masterSs, SHEET_BACKUPS, false), bkRows = [];
      mBk.forEach(function(r) { if (r && r.key && r.data && (normalizePeaGroupNameServer_(r.key) || r.key) === targetGrp) bkRows.push({ key: targetGrp, data: r.data }); });
      if (bkRows.length === 0 && legacyTechLoc && legacyTechLoc.cloudGroupBackups && legacyTechLoc.cloudGroupBackups[targetGrp]) {
        bkRows.push({ key: targetGrp, data: legacyTechLoc.cloudGroupBackups[targetGrp] });
      }
      if (bkRows.length > 0) writeKeyedSheetRecords_(targetSs, SHEET_BACKUPS, bkRows);
    }
  } catch (e) {}
}

// ============================================================================
// 🔄 ฟังก์ชันเทียบเวลาและซิงค์เฉพาะส่วนต่าง (Delta Patch & Full Sync Engine)
// ============================================================================

function parseTimestampMs_(val) {
  if (!val || val === true) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const s = String(val).trim();
  if (/^\d{11,15}$/.test(s)) return Number(s);
  const parsed = new Date(s).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

function isJobNewerThanDelete_(job, delVal) {
  if (!job || !delVal) return false;
  const delMs = parseTimestampMs_(delVal);
  if (delMs <= 0) return Boolean(job.restoredAtMs);
  return Math.max(Number(job.restoredAtMs || 0), parseTimestampMs_(job.editedAt), parseTimestampMs_(job.reopenedAt)) > delMs;
}

function collectReopenedJobsMap_(jobsListA, jobsListB) {
  const map = {};
  const scan = function(arr) {
    (arr || []).forEach(function(j) {
      if (!j || typeof j !== 'object' || j.jobType === 'tech_loc') return;
      const rk = getRawJobKey_(j);
      if (rk && j.reopenedAt && (!map[rk] || String(j.reopenedAt) > map[rk])) map[rk] = String(j.reopenedAt);
    });
  };
  scan(jobsListA);
  scan(jobsListB);
  return map;
}

function arePinsSemanticallyEqual_(pinsA, pinsB) {
  const a = pinsA || {}, b = pinsB || {};
  if (Number(a.clearedAuditLogsTimestamp || 0) !== Number(b.clearedAuditLogsTimestamp || 0)) return false;
  if (JSON.stringify(a.electricEquipmentPins || []) !== JSON.stringify(b.electricEquipmentPins || [])) return false;
  if (JSON.stringify(a.deletedElectricEquipmentMap || {}) !== JSON.stringify(b.deletedElectricEquipmentMap || {})) return false;
  if (JSON.stringify(a.deletedEquipAuditLogs || []) !== JSON.stringify(b.deletedEquipAuditLogs || [])) return false;
  return true;
}

function applyModularDeltaPatch_(groupName, deltaPayload) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const upserted = Array.isArray(deltaPayload.upsertedJobs) ? deltaPayload.upsertedJobs : [];
  const removedKeys = new Set(Array.isArray(deltaPayload.removedJobKeys) ? deltaPayload.removedJobKeys : []);
  const tDelta = deltaPayload.techLocDelta || null, ramOnly = Boolean(deltaPayload.ramOnly);
  const writtenTabs = { jobs: false, techState: false, pins: false, backups: false };
  const currentJobs = getJobsPool_(targetGrp), reopenedMap = collectReopenedJobsMap_(currentJobs, upserted);
  let currentState = getStatePool_(targetGrp);

  const revivedKeys = [];
  upserted.forEach(function(inJob) {
    const rk = getRawJobKey_(inJob);
    if (rk && currentState.deletedJobsMap && currentState.deletedJobsMap[rk] && isJobNewerThanDelete_(inJob, currentState.deletedJobsMap[rk])) {
      revivedKeys.push(rk);
    }
  });

  if (tDelta || revivedKeys.length > 0) {
    const prevLocsSnap = currentState.techLocations || {};
    const oldClosedStr = JSON.stringify(currentState.closedJobsMap || {}), oldDelStr = JSON.stringify(currentState.deletedJobsMap || {});
    currentState = mergeStateObjects_(currentState, tDelta || {}, reopenedMap, targetGrp);
    revivedKeys.forEach(function(rk) { if (currentState.deletedJobsMap) delete currentState.deletedJobsMap[rk]; });

    const pmChanged = tDelta ? hasNewerPmSchedule_(prevLocsSnap, tDelta.techLocations, targetGrp) : false;
    const oldCancelReg = prevLocsSnap[REGISTRY_LOC_KEY] || {}, incCancelReg = (tDelta && tDelta.techLocations && tDelta.techLocations[REGISTRY_LOC_KEY]) || {};
    const cancelChanged = hasNewerRegistryEntries_(oldCancelReg.equipCancelMap, incCancelReg.equipCancelMap) ||
                          hasNewerRegistryEntries_(oldCancelReg.jobCancelMap, incCancelReg.jobCancelMap);
    const nowMs = Date.now();
    const importantChanged = (
      oldClosedStr !== JSON.stringify(currentState.closedJobsMap || {}) ||
      oldDelStr !== JSON.stringify(currentState.deletedJobsMap || {}) ||
      pmChanged ||
      cancelChanged ||
      revivedKeys.length > 0 ||
      Boolean(deltaPayload.forceSheetWrite)
    );
    const shouldWriteStateSheet = (!ramOnly || pmChanged || cancelChanged || revivedKeys.length > 0) &&
                                  (importantChanged || (nowMs - Number(currentState.lastSheetWriteMs || 0) >= STATE_SHEET_SYNC_INTERVAL_MS));
    if (shouldWriteStateSheet) currentState.lastSheetWriteMs = nowMs;
    saveStatePool_(targetGrp, currentState, shouldWriteStateSheet);
    writtenTabs.techState = shouldWriteStateSheet;
  }

  const deletedJobsMap = currentState.deletedJobsMap || {};
  if (upserted.length > 0 || removedKeys.size > 0 || Object.keys(deletedJobsMap).length > 0) {
    const jobMap = new Map();
    let jobsChanged = (upserted.length > 0);
    currentJobs.forEach(function(job) {
      const uKey = getJobUniqueKey_(job), rawK = getRawJobKey_(job);
      if (rawK && deletedJobsMap[rawK] && !isJobNewerThanDelete_(job, deletedJobsMap[rawK])) { jobsChanged = true; return; }
      const isRemoved = (uKey && removedKeys.has(uKey)) || (rawK && removedKeys.has(rawK));
      if (uKey && !isRemoved) jobMap.set(uKey, job); else if (uKey && isRemoved) jobsChanged = true;
    });
    upserted.forEach(function(inJob) {
      if (!inJob || typeof inJob !== 'object' || inJob.jobType === 'tech_loc') return;
      const rawK = getRawJobKey_(inJob), uKey = getJobUniqueKey_(inJob);
      if (!uKey || (rawK && deletedJobsMap[rawK] && !isJobNewerThanDelete_(inJob, deletedJobsMap[rawK]))) return;
      const mergedJob = jobMap.has(uKey) ? mergeSingleJobRecord_(jobMap.get(uKey), inJob) : Object.assign({}, inJob);
      mergedJob.ownerGroup = inferRecordOwnerGroup_(mergedJob);
      if (inJob.restoredAtMs) {
        const rMs = Math.max(Number(inJob.restoredAtMs) || 0, parseTimestampMs_(mergedJob.editedAt));
        if (rMs > 0) mergedJob.editedAt = new Date(rMs).toISOString();
      }
      delete mergedJob.restoredAtMs;
      jobMap.set(uKey, mergedJob);
    });
    if (jobsChanged) {
      saveJobsPool_(targetGrp, Array.from(jobMap.values()), !ramOnly);
      writtenTabs.jobs = !ramOnly;
    }
  }

  if (tDelta && (!tDelta._keepPins || !tDelta._keepDelPins || !tDelta._keepAuditLogs)) {
    const currentPins = getPinsPool_(targetGrp), mergedPins = mergePinsObjects_(currentPins, tDelta);
    if (!arePinsSemanticallyEqual_(currentPins, mergedPins)) {
      savePinsPool_(targetGrp, mergedPins, !ramOnly);
      writtenTabs.pins = !ramOnly;
    }
  }

  if (tDelta && !tDelta._keepBackups && tDelta.cloudGroupBackups && typeof tDelta.cloudGroupBackups === 'object') {
    const currentBackups = getBackupsPool_(targetGrp), singleGrpBackup = {};
    Object.keys(tDelta.cloudGroupBackups).forEach(function(bkGrp) {
      if ((normalizePeaGroupNameServer_(bkGrp) || bkGrp) === targetGrp && tDelta.cloudGroupBackups[bkGrp]) {
        singleGrpBackup[targetGrp] = tDelta.cloudGroupBackups[bkGrp];
      }
    });
    const allowWipeEmpty = Boolean(tDelta._explicitReplaceBackups) && Object.keys(singleGrpBackup).length === 0;
    if (Object.keys(singleGrpBackup).length > 0 || allowWipeEmpty) {
      const mergedBackups = mergeBackupsObjects_(currentBackups, singleGrpBackup, allowWipeEmpty);
      if (JSON.stringify(currentBackups) !== JSON.stringify(mergedBackups)) {
        saveBackupsPool_(targetGrp, mergedBackups, !ramOnly);
        writtenTabs.backups = !ramOnly;
      }
    }
  }
  return { writtenTabs: writtenTabs };
}

function applyModularFullSync_(groupName, incomingJobs) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  let incomingTechLoc = null;
  const currentJobs = getJobsPool_(targetGrp);
  let currentState = getStatePool_(targetGrp);
  const existingMap = new Map();

  currentJobs.forEach(function(j) {
    const k = getJobUniqueKey_(j);
    if (k) existingMap.set(k, j);
  });

  (incomingJobs || []).forEach(function(inJob) {
    if (inJob && (inJob.jobType === 'tech_loc' || inJob.dateTimeSaved === 'TECH_LOC_REGISTRY')) {
      incomingTechLoc = inJob;
    }
  });

  const oldDelMap = currentState.deletedJobsMap || {};
  const incDelMap = (incomingTechLoc && incomingTechLoc.deletedJobsMap) || {};
  const revivedKeys = [];

  const finalMap = new Map();
  existingMap.forEach(function(exJob, uKey) {
    const rk = getRawJobKey_(exJob);
    if (rk && (oldDelMap[rk] || incDelMap[rk]) && !isJobNewerThanDelete_(exJob, oldDelMap[rk] || incDelMap[rk])) {
      return;
    }
    finalMap.set(uKey, exJob);
  });

  (incomingJobs || []).forEach(function(inJob) {
    if (!inJob || typeof inJob !== 'object') return;
    if (inJob.jobType === 'tech_loc' || inJob.dateTimeSaved === 'TECH_LOC_REGISTRY') return;
    const k = getJobUniqueKey_(inJob);
    if (!k) return;

    const rk = getRawJobKey_(inJob);
    if (rk && oldDelMap[rk] && isJobNewerThanDelete_(inJob, oldDelMap[rk])) {
      revivedKeys.push(rk);
    }

    const prev = finalMap.get(k);
    const mergedJob = prev ? mergeSingleJobRecord_(prev, inJob) : Object.assign({}, inJob);
    mergedJob.ownerGroup = inferRecordOwnerGroup_(mergedJob);
    delete mergedJob.pendingInitialUpload;
    if (inJob.restoredAtMs) {
      const rMs = Math.max(Number(inJob.restoredAtMs) || 0, parseTimestampMs_(mergedJob.editedAt));
      if (rMs > 0) mergedJob.editedAt = new Date(rMs).toISOString();
    }
    delete mergedJob.restoredAtMs;
    finalMap.set(k, mergedJob);
  });

  const writtenTabs = { jobs: false, techState: false, pins: false, backups: false };
  const reopenedMap = collectReopenedJobsMap_(Array.from(finalMap.values()), null);

  if (incomingTechLoc || revivedKeys.length > 0) {
    const prevLocsSnap = currentState.techLocations || {};
    const oldClosedStr = JSON.stringify(currentState.closedJobsMap || {});
    const oldDelStr = JSON.stringify(currentState.deletedJobsMap || {});

    currentState = mergeStateObjects_(currentState, incomingTechLoc || {}, reopenedMap, targetGrp);
    revivedKeys.forEach(function(rk) {
      if (currentState.deletedJobsMap) delete currentState.deletedJobsMap[rk];
    });

    const newClosedStr = JSON.stringify(currentState.closedJobsMap || {});
    const newDelStr = JSON.stringify(currentState.deletedJobsMap || {});
    const pmChanged = incomingTechLoc ? hasNewerPmSchedule_(prevLocsSnap, incomingTechLoc.techLocations, targetGrp) : false;
    const oldCancelReg = prevLocsSnap[REGISTRY_LOC_KEY] || {};
    const incCancelReg = (incomingTechLoc && incomingTechLoc.techLocations && incomingTechLoc.techLocations[REGISTRY_LOC_KEY]) || {};
    const cancelChanged = hasNewerRegistryEntries_(oldCancelReg.equipCancelMap, incCancelReg.equipCancelMap) ||
                          hasNewerRegistryEntries_(oldCancelReg.jobCancelMap, incCancelReg.jobCancelMap);

    const nowMs = Date.now();
    const shouldWriteState = (
      oldClosedStr !== newClosedStr ||
      oldDelStr !== newDelStr ||
      pmChanged ||
      cancelChanged ||
      revivedKeys.length > 0 ||
      (nowMs - Number(currentState.lastSheetWriteMs || 0) >= STATE_SHEET_SYNC_INTERVAL_MS)
    );
    if (shouldWriteState) currentState.lastSheetWriteMs = nowMs;
    saveStatePool_(targetGrp, currentState, shouldWriteState);
    writtenTabs.techState = shouldWriteState;
  }

  const deletedJobsMap = currentState.deletedJobsMap || {};
  const rawFinalJobs = [];
  finalMap.forEach(function(job) {
    const rawK = getRawJobKey_(job);
    if (rawK && deletedJobsMap[rawK] && !isJobNewerThanDelete_(job, deletedJobsMap[rawK])) return;
    rawFinalJobs.push(job);
  });

  const finalJobs = sortAndCapJobsList_(rawFinalJobs);
  if (JSON.stringify(currentJobs) !== JSON.stringify(finalJobs)) {
    saveJobsPool_(targetGrp, finalJobs, true);
    writtenTabs.jobs = true;
  }

  if (incomingTechLoc && (Array.isArray(incomingTechLoc.electricEquipmentPins) || incomingTechLoc.deletedElectricEquipmentMap || Array.isArray(incomingTechLoc.deletedEquipAuditLogs))) {
    const currentPins = getPinsPool_(targetGrp);
    const mergedPins = mergePinsObjects_(currentPins, incomingTechLoc);
    if (!arePinsSemanticallyEqual_(currentPins, mergedPins)) {
      savePinsPool_(targetGrp, mergedPins, true);
      writtenTabs.pins = true;
    }
  }

  if (incomingTechLoc && incomingTechLoc.cloudGroupBackups && typeof incomingTechLoc.cloudGroupBackups === 'object') {
    const currentBackups = getBackupsPool_(targetGrp);
    const singleGrpB = {};
    Object.keys(incomingTechLoc.cloudGroupBackups).forEach(function(bkGrp) {
      if ((normalizePeaGroupNameServer_(bkGrp) || bkGrp) === targetGrp && incomingTechLoc.cloudGroupBackups[bkGrp]) {
        singleGrpB[targetGrp] = incomingTechLoc.cloudGroupBackups[bkGrp];
      }
    });
    const isAuthBackup = Boolean(incomingTechLoc._authoritativeBackups);
    if (isAuthBackup || Object.keys(singleGrpB).length > 0) {
      const mergedBackups = mergeBackupsObjects_(currentBackups, singleGrpB, isAuthBackup);
      if (JSON.stringify(currentBackups) !== JSON.stringify(mergedBackups)) {
        saveBackupsPool_(targetGrp, mergedBackups, true);
        writtenTabs.backups = true;
      }
    }
  }

  return { writtenTabs: writtenTabs, jobCount: finalJobs.length };
}

function pruneAgedRegistry_(rawMap, isClosedMap) {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const now = Date.now();
  const entries = [];
  Object.keys(rawMap).forEach(function(k) {
    const val = rawMap[k];
    if (!val) return;
    if (isClosedMap) {
      if (typeof val !== 'object') return;
      const ts = parseTimestampMs_(val.updatedAt) || now;
      if (!val.updatedAt) val.updatedAt = new Date(ts).toISOString();
      if (now - ts <= MAX_REGISTRY_AGE_MS) entries.push([k, val, ts]);
    } else {
      const parsedTs = parseTimestampMs_(val);
      const ts = parsedTs > 0 ? parsedTs : now;
      const storedVal = (val === true || parsedTs <= 0) ? ts : val;
      if (now - ts <= MAX_REGISTRY_AGE_MS) entries.push([k, storedVal, ts]);
    }
  });
  entries.sort(function(a, b) { return b[2] - a[2]; });
  const out = {};
  const limit = Math.min(entries.length, 350);
  for (let i = 0; i < limit; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function pruneCancelMap_(rawCancelMap) {
  if (!rawCancelMap || typeof rawCancelMap !== 'object') return {};
  const now = Date.now();
  const entries = [];
  Object.keys(rawCancelMap).forEach(function(k) {
    const val = rawCancelMap[k];
    const ts = parseTimestampMs_(val);
    if (ts > 0 && (now - ts <= MAX_REGISTRY_AGE_MS)) entries.push([k, val, ts]);
  });
  entries.sort(function(a, b) { return b[2] - a[2]; });
  const out = {};
  const limit = Math.min(entries.length, 400);
  for (let i = 0; i < limit; i++) out[entries[i][0]] = entries[i][1];
  return out;
}
function pruneTechLocationsMap_(locsMap) {
  if (!locsMap || typeof locsMap !== 'object') return {};
  const now = Date.now();
  const out = {};
  const userEntries = [];
  Object.keys(locsMap).forEach(function(k) {
    const item = locsMap[k];
    if (!item || typeof item !== 'object') return;
    if (k === REGISTRY_LOC_KEY || String(k).indexOf(PM_LOC_PREFIX) === 0 || String(k).indexOf(CALIB_LOC_PREFIX) === 0 || item.isSystemRegistry) {
      out[k] = item;
      return;
    }
    const seenMs = parseTimestampMs_(item.lastSeenAt || item.updatedAt);
    if (seenMs > 0 && (now - seenMs > MAX_REGISTRY_AGE_MS)) return;
    userEntries.push([k, item, seenMs || 0]);
  });
  userEntries.sort(function(a, b) { return b[2] - a[2]; });
  const limit = Math.min(userEntries.length, MAX_TECH_LOC_ENTRIES);
  for (let i = 0; i < limit; i++) out[userEntries[i][0]] = userEntries[i][1];
  return out;
}

function mergePmScheduleRecord_(oldPm, incPm, pmGroup) {
  if (!oldPm || typeof oldPm !== 'object') return Object.assign({}, incPm, { group: pmGroup });
  if (!incPm || typeof incPm !== 'object') return Object.assign({}, oldPm, { group: pmGroup });

  const nowMs = Date.now();
  const maxDoneAgeMs = 60 * 24 * 60 * 60 * 1000;
  const oldMs = parseTimestampMs_(oldPm.updatedAt), incMs = parseTimestampMs_(incPm.updatedAt);
  const merged = (incMs >= oldMs) ? Object.assign({}, oldPm, incPm) : Object.assign({}, incPm, oldPm);

  if ((oldPm.pmPlansMap && typeof oldPm.pmPlansMap === 'object') || (incPm.pmPlansMap && typeof incPm.pmPlansMap === 'object')) {
    const mergedMap = Object.assign({}, oldPm.pmPlansMap || {});
    Object.keys(incPm.pmPlansMap || {}).forEach(function(pid) {
      const pObj = incPm.pmPlansMap[pid];
      if (!pObj || typeof pObj !== 'object') return;
      const exP = mergedMap[pid];
      const cUpd = Math.max(parseTimestampMs_(pObj.updatedAt), Number(pObj.updatedAtMs || 0), parseTimestampMs_(pObj.createdAt));
      const lUpd = exP ? Math.max(parseTimestampMs_(exP.updatedAt), Number(exP.updatedAtMs || 0), parseTimestampMs_(exP.createdAt)) : -1;
      if (!exP || cUpd > lUpd || (cUpd === lUpd && pObj.pmDeleted && !exP.pmDeleted)) {
        mergedMap[pid] = Object.assign({}, pObj, { id: pObj.id || pid });
      }
    });
    const entries = Object.keys(mergedMap).map(function(pid) { return [pid, mergedMap[pid]]; }).filter(function(pair) {
      const p = pair[1];
      if (!p || !p.id) return false;
      const pMs = parseTimestampMs_(p.updatedAt);
      if (p.pmDeleted && pMs > 0 && (nowMs - pMs > MAX_REGISTRY_AGE_MS)) return false;
      if (!p.pmDeleted && p.status === 'done') {
        const dMs = parseAnyRecordDateMs_(p.date);
        if (dMs > 0 && (nowMs - dMs > maxDoneAgeMs)) return false;
      }
      return true;
    });
    entries.sort(function(a, b) {
      const pa = a[1], pb = b[1];
      const rkA = (!pa.pmDeleted && pa.status !== 'done') ? 0 : 1;
      const rkB = (!pb.pmDeleted && pb.status !== 'done') ? 0 : 1;
      return (rkA - rkB) || (parseTimestampMs_(pb.updatedAt) - parseTimestampMs_(pa.updatedAt));
    });
    const cappedObj = {}, limit = Math.min(entries.length, 100);
    for (let i = 0; i < limit; i++) cappedObj[entries[i][0]] = entries[i][1];
    merged.pmPlansMap = cappedObj;
  }

  if (Array.isArray(oldPm.plans) || Array.isArray(incPm.plans)) {
    const authPlans = (incMs >= oldMs ? incPm.plans : oldPm.plans) || [];
    const otherPlans = (incMs >= oldMs ? oldPm.plans : incPm.plans) || [];
    const authBaseMs = Math.min(oldMs, incMs), planMap = new Map();
    authPlans.forEach(function(p) { const pid = p && (p.id || p.planId); if (pid) planMap.set(pid, p); });
    otherPlans.forEach(function(p) {
      const pid = p && (p.id || p.planId);
      if (!pid || planMap.has(pid)) return;
      const pMs = Math.max(parseTimestampMs_(p.updatedAt), Number(p.updatedAtMs || 0), parseTimestampMs_(p.createdAt));
      if (authBaseMs > 0 && pMs > authBaseMs) planMap.set(pid, p);
    });
    merged.plans = Array.from(planMap.values());
  }

  const bestIso = (incMs >= oldMs ? (incPm.updatedAt || incPm.lastSeenAt) : (oldPm.updatedAt || oldPm.lastSeenAt)) || new Date().toISOString();
  merged.group = pmGroup;
  merged.updatedAt = bestIso;
  merged.lastSeenAt = bestIso;
  return merged;
}

function mergeFaultCalibRecord_(oldCal, incCal, calGroup) {
if (!oldCal || typeof oldCal !== 'object') return Object.assign({}, incCal, { group: calGroup });
if (!incCal || typeof incCal !== 'object') return Object.assign({}, oldCal, { group: calGroup });

const nowMs = Date.now();
const oldMs = parseTimestampMs_(oldCal.updatedAt || oldCal.lastSeenAt);
const incMs = parseTimestampMs_(incCal.updatedAt || incCal.lastSeenAt);
const merged = (incMs >= oldMs) ? Object.assign({}, oldCal, incCal) : Object.assign({}, incCal, oldCal);

if ((oldCal.calibMap && typeof oldCal.calibMap === 'object') || (incCal.calibMap && typeof incCal.calibMap === 'object')) {
const mergedMap = Object.assign({}, oldCal.calibMap || {});
Object.keys(incCal.calibMap || {}).forEach(function(ck) {
const cObj = incCal.calibMap[ck];
if (!cObj || typeof cObj !== 'object') return;
const exC = mergedMap[ck];
const cUpd = parseTimestampMs_(cObj.updatedAt);
const lUpd = exC ? parseTimestampMs_(exC.updatedAt) : -1;
if (!exC || cUpd > lUpd || (cUpd === lUpd && Boolean(cObj.deleted) && !Boolean(exC.deleted))) {
mergedMap[ck] = cObj;
}
});
const cleanMap = {};
Object.keys(mergedMap).forEach(function(ck) {
const rec = mergedMap[ck];
if (!rec || typeof rec !== 'object') return;
const rMs = parseTimestampMs_(rec.updatedAt);
if (rec.deleted && rMs > 0 && (nowMs - rMs > MAX_REGISTRY_AGE_MS)) return;
cleanMap[ck] = rec;
});
merged.calibMap = cleanMap;
}

const bestIso = (incMs >= oldMs ? (incCal.updatedAt || incCal.lastSeenAt) : (oldCal.updatedAt || oldCal.lastSeenAt)) || new Date().toISOString();
merged.group = calGroup;
merged.updatedAt = bestIso;
merged.lastSeenAt = bestIso;
return merged;
}

function mergeStateObjects_(oldState, incReg, reopenedMap, targetGroup) {
const base = oldState || {};
const inc = incReg || {};
const normTarget = targetGroup ? (normalizePeaGroupNameServer_(targetGroup) || 'กฟส.บึง') : '';

const oldLocs = normTarget ? filterTechLocationsForGroup_(base.techLocations || {}, normTarget) : (base.techLocations || {});
const newLocs = normTarget ? filterTechLocationsForGroup_(inc.techLocations || {}, normTarget) : (inc.techLocations || {});
const mergedLocs = Object.assign({}, oldLocs);

Object.keys(newLocs).forEach(function(k) {
if (k === REGISTRY_LOC_KEY) return;
const inItem = newLocs[k];
if (!inItem || typeof inItem !== 'object') return;

if (String(k).indexOf(PM_LOC_PREFIX) === 0) {
const pmGrp = normalizePeaGroupNameServer_(k.substring(PM_LOC_PREFIX.length)) || normTarget || 'กฟส.บึง';
const pmKey = PM_LOC_PREFIX + pmGrp;
mergedLocs[pmKey] = mergePmScheduleRecord_(mergedLocs[pmKey], inItem, pmGrp);
return;
}

if (String(k).indexOf(CALIB_LOC_PREFIX) === 0) {
const calGrp = normalizePeaGroupNameServer_(k.substring(CALIB_LOC_PREFIX.length)) || normTarget || 'กฟส.บึง';
const calKey = CALIB_LOC_PREFIX + calGrp;
mergedLocs[calKey] = mergeFaultCalibRecord_(mergedLocs[calKey], inItem, calGrp);
return;
}

const exItem = mergedLocs[k];
if (!exItem || typeof exItem !== 'object') {
mergedLocs[k] = inItem;
return;
}
const inTime = parseTimestampMs_(inItem.lastSeenAt || inItem.updatedAt);
const exTime = parseTimestampMs_(exItem.lastSeenAt || exItem.updatedAt);
const bestBase = (inTime >= exTime) ? Object.assign({}, exItem, inItem) : Object.assign({}, inItem, exItem);
const exNavTime = getNavTimeMs_(exItem.activeEquipNav), inNavTime = getNavTimeMs_(inItem.activeEquipNav);
if (inNavTime >= exNavTime && inItem.activeEquipNav) bestBase.activeEquipNav = inItem.activeEquipNav;
else if (exItem.activeEquipNav) bestBase.activeEquipNav = exItem.activeEquipNav;
mergedLocs[k] = bestBase;
});

const oldCancelReg = (base.techLocations && base.techLocations[REGISTRY_LOC_KEY]) || {};
const newCancelReg = (inc.techLocations && inc.techLocations[REGISTRY_LOC_KEY]) || {};
const rawEquipCancel = Object.assign({}, oldCancelReg.equipCancelMap || {});
Object.keys(newCancelReg.equipCancelMap || {}).forEach(function(ck) {
const val = Number(newCancelReg.equipCancelMap[ck] || 0);
if (val > Number(rawEquipCancel[ck] || 0)) rawEquipCancel[ck] = val;
});
const rawJobCancel = Object.assign({}, oldCancelReg.jobCancelMap || {});
Object.keys(newCancelReg.jobCancelMap || {}).forEach(function(jk) {
const incVal = newCancelReg.jobCancelMap[jk];
if (incVal && (!rawJobCancel[jk] || parseTimestampMs_(incVal) >= parseTimestampMs_(rawJobCancel[jk]))) rawJobCancel[jk] = incVal;
});

const prunedLocs = pruneTechLocationsMap_(mergedLocs);
prunedLocs[REGISTRY_LOC_KEY] = {
isSystemRegistry: true,
updatedAt: new Date().toISOString(),
equipCancelMap: pruneCancelMap_(rawEquipCancel),
jobCancelMap: pruneCancelMap_(rawJobCancel)
};

const rawMergedClosed = {};
[base.closedReports || {}, base.closedJobsMap || {}, inc.closedReports || {}, inc.closedJobsMap || {}].forEach(function(srcMap) {
Object.keys(srcMap).forEach(function(rk) {
const cand = srcMap[rk];
if (!cand || typeof cand !== 'object') return;
const ex = rawMergedClosed[rk];
if (!ex || parseTimestampMs_(cand.updatedAt) >= parseTimestampMs_(ex.updatedAt)) rawMergedClosed[rk] = cand;
});
});

if (reopenedMap && typeof reopenedMap === 'object') {
Object.keys(reopenedMap).forEach(function(rk) {
const closedRep = rawMergedClosed[rk];
if (closedRep && parseTimestampMs_(reopenedMap[rk]) > parseTimestampMs_(closedRep.updatedAt)) delete rawMergedClosed[rk];
});
}

const rawMergedDeleted = {};
[base.deletedJobsMap || {}, inc.deletedJobsMap || {}].forEach(function(srcDel) {
Object.keys(srcDel).forEach(function(rk) {
if (!srcDel[rk]) return;
const ms = (srcDel[rk] === true) ? Date.now() : (parseTimestampMs_(srcDel[rk]) || Date.now());
if (!rawMergedDeleted[rk] || ms > parseTimestampMs_(rawMergedDeleted[rk])) rawMergedDeleted[rk] = ms;
});
});

const mergedClosed = pruneAgedRegistry_(rawMergedClosed, true);
const mergedDeletedJobs = pruneAgedRegistry_(rawMergedDeleted, false);
Object.keys(mergedDeletedJobs).forEach(function(delKey) { delete mergedClosed[delKey]; });

return {
migratedFromMaster: true,
techLocations: prunedLocs,
closedJobsMap: mergedClosed,
deletedJobsMap: mergedDeletedJobs,
lastSheetWriteMs: base.lastSheetWriteMs || Date.now(),
updatedAt: new Date().toISOString()
};
}
function mergePinsObjects_(oldPins, incReg) {
  const base = oldPins || {};
  const inc = incReg || {};
  const nowMs = Date.now();
  const mergedDelPins = Object.assign({}, base.deletedElectricEquipmentMap || {});
  if (!inc._keepDelPins && inc.deletedElectricEquipmentMap && typeof inc.deletedElectricEquipmentMap === 'object') {
    Object.keys(inc.deletedElectricEquipmentMap).forEach(function(pid) {
      const inDel = inc.deletedElectricEquipmentMap[pid];
      if (!mergedDelPins[pid] || parseTimestampMs_(inDel) >= parseTimestampMs_(mergedDelPins[pid])) mergedDelPins[pid] = inDel;
    });
  }
  Object.keys(mergedDelPins).forEach(function(pid) {
    const dMs = parseTimestampMs_(mergedDelPins[pid]);
    if (dMs > 0 && (nowMs - dMs > MAX_REGISTRY_AGE_MS)) delete mergedDelPins[pid];
  });

  let finalPins = Array.isArray(base.electricEquipmentPins) ? base.electricEquipmentPins : [];
  if (!inc._keepPins && Array.isArray(inc.electricEquipmentPins)) {
    const pinMap = new Map();
    finalPins.concat(inc.electricEquipmentPins).forEach(function(p) {
      if (!p || !p.id) return;
      const pinMs = parseTimestampMs_(p.updatedAt);
      if (mergedDelPins[p.id]) {
        if (pinMs <= parseTimestampMs_(mergedDelPins[p.id])) return;
        delete mergedDelPins[p.id];
      }
      const ex = pinMap.get(p.id);
      if (!ex || parseTimestampMs_(p.updatedAt) >= parseTimestampMs_(ex.updatedAt)) pinMap.set(p.id, p);
    });
    finalPins = Array.from(pinMap.values());
  } else {
    finalPins = finalPins.filter(function(p) {
      return p && p.id && (!mergedDelPins[p.id] || parseTimestampMs_(p.updatedAt) > parseTimestampMs_(mergedDelPins[p.id]));
    });
  }

  const activePinTimeMap = new Map();
  finalPins.forEach(function(p) { if (p && p.id) activePinTimeMap.set(p.id, parseTimestampMs_(p.updatedAt)); });
  const clearedTs = Math.max(Number(base.clearedAuditLogsTimestamp || 0), Number(inc.clearedAuditLogsTimestamp || 0));
  let finalAuditLogs = Array.isArray(base.deletedEquipAuditLogs) ? base.deletedEquipAuditLogs : [];
  if (!inc._keepAuditLogs && Array.isArray(inc.deletedEquipAuditLogs)) finalAuditLogs = finalAuditLogs.concat(inc.deletedEquipAuditLogs);

  const logMap = new Map();
  finalAuditLogs.forEach(function(log) {
    if (!log || !log.logId) return;
    const delMs = parseTimestampMs_(log.deletedAt);
    if ((clearedTs > 0 && delMs <= clearedTs) || (log.pinId && activePinTimeMap.has(log.pinId) && activePinTimeMap.get(log.pinId) > delMs)) return;
    logMap.set(log.logId, log);
  });
  const sortedLogs = Array.from(logMap.values()).sort(function(a, b) { return parseTimestampMs_(b.deletedAt) - parseTimestampMs_(a.deletedAt); }).slice(0, 60);
  const candidate = {
    electricEquipmentPins: finalPins,
    deletedElectricEquipmentMap: mergedDelPins,
    deletedEquipAuditLogs: sortedLogs,
    clearedAuditLogsTimestamp: clearedTs,
    updatedAt: base.updatedAt || new Date().toISOString()
  };
  if (!arePinsSemanticallyEqual_(base, candidate)) candidate.updatedAt = new Date().toISOString();
  return candidate;
}

function mergeBackupsObjects_(oldBackups, incBackups, replaceAllKeys) {
  if (replaceAllKeys) {
    const nextMap = {};
    Object.keys(incBackups || {}).forEach(function(grp) { if (grp && incBackups[grp]) nextMap[grp] = incBackups[grp]; });
    return nextMap;
  }
  const merged = Object.assign({}, oldBackups || {});
  Object.keys(incBackups || {}).forEach(function(grp) {
    const rB = incBackups[grp], lB = merged[grp];
    if (rB && (!lB || parseTimestampMs_(rB.updatedAt) >= parseTimestampMs_(lB.updatedAt))) merged[grp] = rB;
  });
  return merged;
}

// ผสานข้อมูลใบรายงานมิเตอร์ชำรุดและลายเซ็นทั้ง 4 ช่อง (พนักงานเวรฯ / ลูกค้า / หผ.ปบ. / ผมต.) ไม่ให้ทับกัน
function mergeMeterFormStateServer_(oldM, newM) {
if (!oldM && !newM) return undefined;
if (!oldM || typeof oldM !== 'object') return newM;
if (!newM || typeof newM !== 'object') return oldM;

const oldTs = Number(oldM.updatedAt || 0);
const newTs = Number(newM.updatedAt || 0);
const primary = (newTs >= oldTs) ? newM : oldM;
const secondary = (newTs >= oldTs) ? oldM : newM;

const primaryMissingBase = (primary.hasBaseJobLoaded === false);
const autoDateIds = { docDateInput: true, shiftDateInput: true };
const mergedFields = Object.assign({}, secondary.fields || {});

Object.keys(primary.fields || {}).forEach(function(fid) {
const pVal = primary.fields[fid];
if (pVal === undefined || pVal === null) return;
const existingVal = mergedFields[fid] ? String(mergedFields[fid]).trim() : '';
if (primaryMissingBase && existingVal) {
if (!String(pVal).trim() || (secondary.hasBaseJobLoaded !== false && autoDateIds[fid])) return;
}
mergedFields[fid] = pVal;
});

['newPeaInput', 'startUnitInput', 'causeOtherInput', 'docNoInput', 'name-sig1', 'name-sig2', 'name-sig3', 'name-sig4'].forEach(function(fid) {
if ((!mergedFields[fid] || !String(mergedFields[fid]).trim()) && secondary.fields && secondary.fields[fid]) {
mergedFields[fid] = secondary.fields[fid];
}
});

const mergedChecks = (primaryMissingBase && secondary.hasBaseJobLoaded !== false)
? Object.assign({}, primary.checks || {}, secondary.checks || {})
: Object.assign({}, secondary.checks || {}, primary.checks || {});

const mergedSigs = {};
['sig1', 'sig2', 'sig3', 'sig4'].forEach(function(slot) {
const sOld = oldM.sigs && oldM.sigs[slot];
const sNew = newM.sigs && newM.sigs[slot];
if (sOld && sNew) {
mergedSigs[slot] = (Number(sNew.ts || 0) >= Number(sOld.ts || 0)) ? sNew : sOld;
} else if (sNew || sOld) {
mergedSigs[slot] = sNew || sOld;
}
});

const hasBaseLoaded = (oldM.hasBaseJobLoaded !== false && Boolean(oldM.fields)) ||
(newM.hasBaseJobLoaded !== false && Boolean(newM.fields));

return {
office: primary.office || secondary.office || 'กฟส.บึง',
jobFingerprint: primary.jobFingerprint || secondary.jobFingerprint || '',
hasBaseJobLoaded: hasBaseLoaded,
fields: mergedFields,
checks: mergedChecks,
sigs: mergedSigs,
updatedAt: Math.max(oldTs, newTs) || Date.now()
};
}
function mergeSingleJobRecord_(oldJob, newJob) {
  if (!oldJob) return newJob;
  if (!newJob) return oldJob;
  const TECH_SEP = '\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---';
  const oldRepTime = (oldJob.techReport && oldJob.techReport.updatedAt) ? String(oldJob.techReport.updatedAt) : '';
  const newRepTime = (newJob.techReport && newJob.techReport.updatedAt) ? String(newJob.techReport.updatedAt) : '';
  let bestReport = (newRepTime >= oldRepTime) ? (newJob.techReport || oldJob.techReport) : oldJob.techReport;

  const oldReopen = String(oldJob.reopenedAt || ''), newReopen = String(newJob.reopenedAt || '');
  const latestReopen = (newReopen >= oldReopen) ? newReopen : oldReopen;
  if (latestReopen && (!bestReport || !bestReport.updatedAt || latestReopen > String(bestReport.updatedAt))) bestReport = undefined;

  const oldCancel = String(oldJob.navCancelledAt || ''), newCancel = String(newJob.navCancelledAt || '');
  const latestCancel = (newCancel >= oldCancel) ? newCancel : oldCancel;
  const oldNavTime = (oldJob.techNav && oldJob.techNav.updatedAt) ? String(oldJob.techNav.updatedAt) : '';
  const newNavTime = (newJob.techNav && newJob.techNav.updatedAt) ? String(newJob.techNav.updatedAt) : '';
  let bestNav = (newNavTime >= oldNavTime) ? (newJob.techNav || oldJob.techNav) : oldJob.techNav;

  const isDone = Boolean(bestReport && String(bestReport.status || '').indexOf('เสร็จสิ้น') !== -1);
  const repBeatNav = Boolean(bestReport && bestReport.updatedAt && (!bestNav || !bestNav.updatedAt || String(bestReport.updatedAt) >= String(bestNav.updatedAt)));
  if (isDone || repBeatNav || (latestCancel && (!bestNav || !bestNav.updatedAt || latestCancel >= String(bestNav.updatedAt)))) bestNav = undefined;

  const oldEdMs = parseTimestampMs_(oldJob.editedAt), newEdMs = parseTimestampMs_(newJob.editedAt);
  const preferOldCore = (oldEdMs > newEdMs) || (Boolean(newJob.restoredAtMs) && oldEdMs >= newEdMs);
  const coreSource = preferOldCore ? oldJob : newJob;
  const merged = preferOldCore ? Object.assign({}, newJob, oldJob) : Object.assign({}, oldJob, newJob);
  const baseFormatted = String(coreSource.formattedText || merged.formattedText || '').split(TECH_SEP)[0];

  const mergedMeterState = mergeMeterFormStateServer_(oldJob.meterFormState, newJob.meterFormState);
  if (mergedMeterState) merged.meterFormState = mergedMeterState;
  else delete merged.meterFormState;

  if (bestReport) {
    merged.techReport = Object.assign({}, bestReport);
    delete merged.techReport.needsMainSync;
    const repSrc = (bestReport === oldJob.techReport && bestReport !== newJob.techReport) ? oldJob : newJob;
    const altSrc = (repSrc === oldJob) ? newJob : oldJob;
    const repTxt = String(repSrc.formattedText || ''), altTxt = String(altSrc.formattedText || '');
    const techTail = repTxt.indexOf(TECH_SEP) !== -1 ? repTxt.split(TECH_SEP)[1] : (altTxt.indexOf(TECH_SEP) !== -1 ? altTxt.split(TECH_SEP)[1] : '');
    merged.formattedText = techTail ? (baseFormatted + TECH_SEP + techTail) : baseFormatted;
    if (bestReport.fieldGps && bestReport.fieldGps !== '-' && (!merged.gps || merged.gps === '-' || parseTimestampMs_(bestReport.updatedAt) >= Math.max(oldEdMs, newEdMs))) {
      merged.gps = bestReport.fieldGps;
    }
  } else {
    delete merged.techReport;
    merged.formattedText = baseFormatted;
  }

  if (bestNav) { merged.techNav = Object.assign({}, bestNav); delete merged.techNav.needsMainSync; } else delete merged.techNav;
  if (latestReopen) merged.reopenedAt = latestReopen; else delete merged.reopenedAt;
  if (latestCancel) merged.navCancelledAt = latestCancel; else delete merged.navCancelledAt;
  const keepMeterKey = oldJob.meterKey || newJob.meterKey;
  if (keepMeterKey) merged.meterKey = keepMeterKey;
  delete merged.pendingInitialUpload;
  delete merged.restoredAtMs;
  return merged;
}

function getJobUniqueKey_(job) {
  if (!job || typeof job !== 'object') return '';
  if (job.jobType === 'tech_loc' || job.dateTimeSaved === 'TECH_LOC_REGISTRY') return 'TECH_LOC_REGISTRY';
  const isFault = (job.jobType === 'fault');
  const rawKey = isFault ? (job.timestamp || '') : (job.dateTimeSaved || job.timestamp || '');
  return rawKey ? ((isFault ? 'F_' : 'O_') + String(rawKey)) : '';
}

function getRawJobKey_(job) {
  if (!job || typeof job !== 'object') return '';
  return job.jobType === 'fault' ? String(job.timestamp || '') : String(job.dateTimeSaved || job.timestamp || '');
}

function getNavTimeMs_(navObj) {
  if (!navObj || typeof navObj !== 'object') return 0;
  return Math.max(Number(navObj.departTimestamp || 0) || 0, parseTimestampMs_(navObj.updatedAt), Number(navObj.cancelledAtMs || 0) || 0);
}

// ============================================================================
// 🔒 จัดการบัญชี Users, รักษา Session, Safe UTF-16 Chunker & Zero-Loss Sheet I/O
// ============================================================================

function hashPasswordSha256_(rawPassword) {
  const str = String(rawPassword || '').trim();
  if (!str || str.indexOf('sha256$') === 0) return str;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, PASSWORD_SALT + '::' + str, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i] < 0 ? digest[i] + 256 : digest[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return 'sha256$' + hex;
}

function verifyPasswordMatch_(inputPlainPass, storedPass) {
  const inputTrim = String(inputPlainPass || '').trim(), storedTrim = String(storedPass || '').trim();
  if (!inputTrim || !storedTrim) return false;
  return storedTrim.indexOf('sha256$') === 0 ? (hashPasswordSha256_(inputTrim) === storedTrim) : (inputTrim === storedTrim);
}

function sanitizeUsersForClient_(usersArray) {
  if (!Array.isArray(usersArray)) return [];
  return usersArray.map(function(u) {
    const p = parseRoleString_(u && u.role);
    return {
      username: u.username,
      password: '',
      role: p.role + '::::' + p.displayName
    };
  });
}

function parseRoleString_(rawRole) {
  const parts = String(rawRole || 'user').split('::');
  return { role: (parts[0] || 'user').trim(), sessionToken: (parts[1] || '').trim(), displayName: (parts[2] || '').trim() };
}

function resolveSafeSessionToken_(oldRoleRaw, newRoleRaw) {
  const oldP = parseRoleString_(oldRoleRaw), newP = parseRoleString_(newRoleRaw);
  if (oldP.role !== newP.role) return newP.sessionToken || ('reset_' + Date.now());
  if (!newP.sessionToken) return oldP.sessionToken || '';
  if (!oldP.sessionToken || newP.sessionToken === oldP.sessionToken) return newP.sessionToken;
  const mOld = oldP.sessionToken.match(/^(?:st1|sess|reset)_(\d{11,15})/), mNew = newP.sessionToken.match(/^(?:st1|sess|reset)_(\d{11,15})/);
  if (mOld && mNew) return Number(mNew[1]) >= Number(mOld[1]) ? newP.sessionToken : oldP.sessionToken;
  return newP.sessionToken;
}

function normalizeAccountUsernameServer_(rawUsername) {
  const s = String(rawUsername || '').trim().replace(/\s+/g, ' ');
  if (!s || s.toLowerCase() === 'admin') return s;
  const peaMatch = s.match(/^(.*?)\s*(กฟ[ก-ฮ]{1,3}\.?.*)$/);
  return (peaMatch && peaMatch[1].trim()) ? (peaMatch[1].trim() + ' ' + normalizePeaGroupNameServer_(peaMatch[2])) : s;
}

function getUserGroupNameServer_(username, strictPeaPrefixOnly) {
  if (!username) return '';
  const cleaned = String(username).replace(/\([^)]*\)/g, ' ').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.toLowerCase() === 'admin') return '';
  const peaMatch = cleaned.match(/(กฟ[ก-ฮ]{1,3}\.?.*)$/);
  if (peaMatch) return normalizePeaGroupNameServer_(peaMatch[1]);
  if (strictPeaPrefixOnly) return '';
  const numMatch = cleaned.match(/^(\d{3,12})\s+([ก-๙a-zA-Z].*)$/);
  if (numMatch && !/^(?:นาย|นาง|น\.ส\.|นางสาว|คุณ|ช่าง)/.test(numMatch[2])) return normalizePeaGroupNameServer_(numMatch[2]);
  const idMatch = cleaned.match(/^([a-zA-Z0-9_.-]+)\s+(.+)$/);
  if (idMatch && !/^(?:นาย|นาง|น\.ส\.|นางสาว|คุณ|ช่าง)/.test(idMatch[2])) return normalizePeaGroupNameServer_(idMatch[2]);
  return '';
}

function getUserBaseIdServer_(username) {
  if (!username) return '';
  const s = String(username).replace(/\([^)]*\)/g, ' ').trim();
  const withoutPea = s.split(/\s+/)[0].replace(/(กฟ[ก-ฮ]{1,3}\.?.*)$/, '').trim();
  if (!withoutPea) return s.toLowerCase();
  const numMatch = withoutPea.match(/^(\d{3,12})/);
  return (numMatch ? numMatch[1] : withoutPea).toLowerCase();
}

function isUsernameMatchingServer_(inputUser, accountUser) {
  if (!inputUser || !accountUser) return false;
  const inTrim = String(inputUser).trim().toLowerCase(), accTrim = String(accountUser).trim().toLowerCase();
  if (inTrim === accTrim) return true;
  const inBase = getUserBaseIdServer_(inputUser), accBase = getUserBaseIdServer_(accountUser);
  if (!inBase || !accBase || inBase !== accBase) return false;
  const inGroup = getUserGroupNameServer_(inputUser, false).toLowerCase(), accGroup = getUserGroupNameServer_(accountUser, false).toLowerCase();
  return !(inGroup && accGroup && inGroup !== accGroup);
}

function getUsersData_() {
  const cachedUsers = getLargeCache_('PEA_V65_USERS');
  if (cachedUsers && Array.isArray(cachedUsers)) return cachedUsers;
  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_USERS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_USERS);
    const initRange = sheet.getRange(1, 1, 2, 3);
    initRange.setNumberFormat('@');
    initRange.setValues([['username', 'password', 'role'], ['admin', hashPasswordSha256_('1234'), 'admin::']]);
    HAS_DIRTY_SHEET_WRITES_ = true;
  }
  getGroupNodesMap_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [{ username: 'admin', password: hashPasswordSha256_('1234'), role: 'admin' }];
  const data = sheet.getRange(2, 1, lastRow - 1, 3).getDisplayValues();
  const users = [];
  let needsMigration = false;
  for (let i = 0; i < data.length; i++) {
    const rawU = String(data[i][0] || '').trim(), u = normalizeAccountUsernameServer_(rawU);
    let p = String(data[i][1] || '').trim();
    const r = String(data[i][2] || 'user').trim();
    if (u) {
      if (u !== rawU) needsMigration = true;
      if (p && p.indexOf('sha256$') !== 0) { p = hashPasswordSha256_(p); needsMigration = true; }
      users.push({ username: u, password: p, role: r });
    }
  }
  if (needsMigration) saveUsersData_(users); else putLargeCache_('PEA_V65_USERS', users);
  return users;
}

function saveUsersData_(usersArray) {
  const ss = getMasterSpreadsheet_();
  const sheet = ss.getSheetByName(SHEET_USERS) || ss.insertSheet(SHEET_USERS);
  const existingPassMap = {}, existingRoleMap = {}, prevLastRow = sheet.getLastRow(), prevLastCol = sheet.getLastColumn();
  if (prevLastRow > 1) {
    const oldData = sheet.getRange(2, 1, prevLastRow - 1, 3).getDisplayValues();
    for (let i = 0; i < oldData.length; i++) {
      const oldU = String(oldData[i][0] || '').trim(), oldP = String(oldData[i][1] || '').trim(), oldR = String(oldData[i][2] || '').trim();
      if (oldU) {
        const normOldU = normalizeAccountUsernameServer_(oldU).toLowerCase(), baseId = getUserBaseIdServer_(oldU);
        if (oldP) { existingPassMap[oldU.toLowerCase()] = oldP; existingPassMap[normOldU] = oldP; if (baseId) existingPassMap['base::' + baseId] = oldP; }
        if (oldR) { existingRoleMap[oldU.toLowerCase()] = oldR; existingRoleMap[normOldU] = oldR; if (baseId) existingRoleMap['base::' + baseId] = oldR; }
      }
    }
  }
  const rows = [['username', 'password', 'role']], cleanUsersForCache = [];
  (usersArray || []).forEach(function(u) {
    if (!u || !u.username) return;
    const rawName = String(u.username).trim(), uName = normalizeAccountUsernameServer_(rawName), baseId = getUserBaseIdServer_(uName);
    let rawPass = String(u.password || '').trim();
    if (!rawPass || rawPass === '••••••' || rawPass === 'UNCHANGED') {
      rawPass = existingPassMap[uName.toLowerCase()] || existingPassMap[rawName.toLowerCase()] || (baseId ? existingPassMap['base::' + baseId] : '') || hashPasswordSha256_('1234');
    }
    const prevRoleStr = existingRoleMap[uName.toLowerCase()] || existingRoleMap[rawName.toLowerCase()] || (baseId ? existingRoleMap['base::' + baseId] : '') || '';
    const incP = parseRoleString_(u.role), safeTok = resolveSafeSessionToken_(prevRoleStr, u.role);
    const finalRole = incP.role + '::' + safeTok + '::' + incP.displayName, finalHashedPass = hashPasswordSha256_(rawPass);
    rows.push([uName, finalHashedPass, finalRole]);
    cleanUsersForCache.push({ username: uName, password: finalHashedPass, role: finalRole });
  });
  if (sheet.getMaxColumns() < 3) sheet.insertColumnsAfter(sheet.getMaxColumns(), 3 - sheet.getMaxColumns());
  if (sheet.getMaxRows() < rows.length) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length - sheet.getMaxRows());
  const writeRange = sheet.getRange(1, 1, rows.length, 3);
  writeRange.setNumberFormat('@');
  writeRange.setValues(rows);
  if (prevLastRow > rows.length) sheet.getRange(rows.length + 1, 1, prevLastRow - rows.length, Math.max(prevLastCol, 3)).clearContent();
  HAS_DIRTY_SHEET_WRITES_ = true;
  putLargeCache_('PEA_V65_USERS', cleanUsersForCache);
}

function readKeyedSheetRecords_(ss, sheetName, createIfMissing) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    if (createIfMissing) {
      sheet = ss.insertSheet(sheetName);
      const r = sheet.getRange(1, 1, 1, 2);
      r.setNumberFormat('@');
      r.setValues([['Key', 'JSON_Part_1']]);
      if (sheetName === SHEET_PINS) protectPinsSheetTab_(ss);
      HAS_DIRTY_SHEET_WRITES_ = true;
    }
    return [];
  }
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues(), records = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i], key = String(row[0] || '').trim();
    if (!key) continue;
    let jsonStr = '';
    for (let c = 1; c < row.length; c++) if (row[c]) jsonStr += String(row[c]);
    if (jsonStr) {
      try {
        const parsedData = JSON.parse(jsonStr);
        records.push({ key: key, data: unprotectRecordPiiFromSheet_(sheetName, parsedData) });
      } catch (e) {
        logSystemEvent_('ERROR', 'corruptSheetJson', ss.getName(), 'SYSTEM', 'อ่าน JSON ไม่สำเร็จในแท็บ ' + sheetName + ' แถวคีย์ ' + key, e);
      }
    }
  }
  return records;
}

function writeKeyedSheetRecords_(ss, sheetName, recordsArray) {
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  const prevLastRow = sheet.getLastRow(), prevLastCol = sheet.getLastColumn(), rawRows = [];
  let maxChunks = 1;
  (recordsArray || []).forEach(function(rec) {
    if (!rec || !rec.key || !rec.data) return;
    const safeSheetData = protectRecordPiiForSheet_(sheetName, rec.data);
    const chunks = splitStringSafeUtf16_(JSON.stringify(safeSheetData), MAX_CELL_CHARS);
    if (chunks.length > maxChunks) maxChunks = chunks.length;
    rawRows.push([String(rec.key)].concat(chunks));
  });
  const totalCols = maxChunks + 1, header = ['Key'];
  for (let c = 1; c <= maxChunks; c++) header.push('JSON_Part_' + c);
  const matrix = [header];
  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r];
    while (row.length < totalCols) row.push('');
    matrix.push(row);
  }
  if (sheet.getMaxColumns() < totalCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), totalCols - sheet.getMaxColumns());
  if (sheet.getMaxRows() < matrix.length) sheet.insertRowsAfter(sheet.getMaxRows(), matrix.length - sheet.getMaxRows());
  const writeRange = sheet.getRange(1, 1, matrix.length, totalCols);
  writeRange.setNumberFormat('@');
  writeRange.setValues(matrix);
  if (prevLastRow > matrix.length) sheet.getRange(matrix.length + 1, 1, prevLastRow - matrix.length, Math.max(prevLastCol, totalCols)).clearContent();
  if (prevLastCol > totalCols) sheet.getRange(1, totalCols + 1, matrix.length, prevLastCol - totalCols).clearContent();
  HAS_DIRTY_SHEET_WRITES_ = true;
}
function splitStringSafeUtf16_(str, chunkSize) {
  const s = String(str || '');
  if (!s) return [''];
  const chunks = [], total = s.length;
  let pos = 0;
  while (pos < total) {
    let end = Math.min(pos + chunkSize, total);
    if (end < total) {
      if (s.charCodeAt(end - 1) >= 0xD800 && s.charCodeAt(end - 1) <= 0xDBFF) end--;
      let guard = 0;
      while (end > pos + 10 && guard < 10 && '=+-@\''.indexOf(s.charAt(end)) !== -1) {
        end--;
        if (s.charCodeAt(end - 1) >= 0xD800 && s.charCodeAt(end - 1) <= 0xDBFF) end--;
        guard++;
      }
    }
    chunks.push(s.substring(pos, end));
    pos = end;
  }
  return chunks;
}

function putLargeCache_(prefix, dataObj) {
  const cache = CacheService.getScriptCache();
  try {
    const chunks = splitStringSafeUtf16_(JSON.stringify(dataObj), CACHE_CHUNK_SIZE);
    if (chunks.length > MAX_CACHE_CHUNKS) { cache.remove(prefix + '_META'); return; }
    for (let start = 0; start < chunks.length; start += CACHE_BATCH_KEYS) {
      const batchPayload = {};
      const end = Math.min(start + CACHE_BATCH_KEYS, chunks.length);
      for (let i = start; i < end; i++) batchPayload[prefix + '_' + i] = chunks[i];
      cache.putAll(batchPayload, CACHE_TTL_SEC);
    }
    cache.put(prefix + '_META', String(chunks.length), CACHE_TTL_SEC);
  } catch (e) { try { cache.remove(prefix + '_META'); } catch (err) {} }
}

function getLargeCache_(prefix) {
  try {
    const cache = CacheService.getScriptCache();
    const count = parseInt(cache.get(prefix + '_META') || '', 10);
    if (isNaN(count) || count <= 0 || count > MAX_CACHE_CHUNKS) return null;
    let fullStr = '';
    for (let start = 0; start < count; start += CACHE_BATCH_KEYS) {
      const batchKeys = [];
      const end = Math.min(start + CACHE_BATCH_KEYS, count);
      for (let i = start; i < end; i++) batchKeys.push(prefix + '_' + i);
      const map = cache.getAll(batchKeys);
      for (let i = start; i < end; i++) {
        const part = map[prefix + '_' + i];
        if (part === undefined || part === null) return null;
        fullStr += part;
      }
    }
    return JSON.parse(fullStr);
  } catch (e) { return null; }
}

function buildJsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// 📊 Pool 5: ระบบวัดโหลดหม้อแปลงแยกตาม กฟส. (TxLoad — RAM Cache + Multi-Sheet Safe)
// ============================================================================

function sortAndCapTxLoadList_(recordsArray) {
  const nowMs = Date.now();
  const byId = new Map();
  (recordsArray || []).forEach(function(r) {
    if (!r || typeof r !== 'object' || !r.id) return;
    const id = String(r.id).trim();
    if (!id) return;
    const rMs = parseTimestampMs_(r.updatedAt);
    if (r.deleted && rMs > 0 && (nowMs - rMs > MAX_REGISTRY_AGE_MS)) return;
    const ex = byId.get(id);
    const exMs = ex ? parseTimestampMs_(ex.updatedAt) : -1;
    if (!ex || rMs > exMs || (rMs === exMs && Boolean(r.deleted) && !Boolean(ex.deleted))) {
      byId.set(id, r);
    }
  });

  const activeList = [];
  const tombstones = [];
  byId.forEach(function(item) {
    if (item.deleted) tombstones.push(item);
    else activeList.push(item);
  });

  activeList.sort(function(a, b) { return parseTimestampMs_(b.updatedAt) - parseTimestampMs_(a.updatedAt); });
  tombstones.sort(function(a, b) { return parseTimestampMs_(b.updatedAt) - parseTimestampMs_(a.updatedAt); });

  const maxActive = typeof MAX_TX_LOAD_PER_GROUP !== 'undefined' ? MAX_TX_LOAD_PER_GROUP : 400;
  return activeList.slice(0, maxActive).concat(tombstones.slice(0, 100));
}

function getTxLoadPool_(groupName) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const cacheKey = getGroupCacheKey_('PEA_V65_TXLOAD', targetGrp);
  const cached = getLargeCache_(cacheKey);
  if (cached && Array.isArray(cached)) return cached;

  const ss = openGroupSpreadsheet_(targetGrp);
  const tabName = typeof SHEET_TX_LOAD !== 'undefined' ? SHEET_TX_LOAD : 'TxLoad';
  const rows = readKeyedSheetRecords_(ss, tabName, false);
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].data && rows[i].data.id) {
      items.push(rows[i].data);
    }
  }
  const capped = sortAndCapTxLoadList_(items);
  putLargeCache_(cacheKey, capped);
  return capped;
}

function saveTxLoadPool_(groupName, listArray, writeToSheet) {
  const targetGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const capped = sortAndCapTxLoadList_(listArray);
  const cacheKey = getGroupCacheKey_('PEA_V65_TXLOAD', targetGrp);
  putLargeCache_(cacheKey, capped);
  if (!writeToSheet) return;

  const ss = openGroupSpreadsheet_(targetGrp);
  const tabName = typeof SHEET_TX_LOAD !== 'undefined' ? SHEET_TX_LOAD : 'TxLoad';
  const keyedRows = [];
  capped.forEach(function(rec) {
    if (rec && rec.id) keyedRows.push({ key: String(rec.id), data: rec });
  });
  writeKeyedSheetRecords_(ss, tabName, keyedRows);
}

function handleListTxLoads_(reqGroup, auth, nodesMapOpt, rawUsersOpt) {
  const nodesMap = nodesMapOpt || getGroupNodesMap_();
  const rawUsers = rawUsersOpt || getUsersData_();

  if (auth.role === 'admin' && !reqGroup) {
    const groups = collectOrderedMeterSearchGroups_('', nodesMap, rawUsers);
    const merged = [];
    groups.forEach(function(g) {
      const gList = getTxLoadPool_(g) || [];
      gList.forEach(function(item) {
        if (item && item.id) {
          merged.push(Object.assign({}, item, { ownerGroup: normalizePeaGroupNameServer_(item.ownerGroup) || g }));
        }
      });
    });
    merged.sort(function(a, b) { return parseTimestampMs_(b.updatedAt) - parseTimestampMs_(a.updatedAt); });
    return { status: 'ok', activeGroup: 'ALL', records: merged, serverTime: new Date().toISOString() };
  }

  const targetGrp = (auth.role === 'admin' && reqGroup) ? reqGroup : (auth.group || 'กฟส.บึง');
  const validGroup = (targetGrp && isKnownOrValidSystemGroup_(targetGrp, nodesMap, rawUsers))
    ? targetGrp
    : 'กฟส.บึง';

  return {
    status: 'ok',
    group: validGroup,
    records: getTxLoadPool_(validGroup),
    serverTime: new Date().toISOString()
  };
}

function handleWriteTxLoadLocked_(action, payload, effectiveGroup, auth) {
  if (action === 'saveTxLoad') {
    const rec = payload && payload.record;
    if (!rec || typeof rec !== 'object' || !rec.id) {
      return { status: 'error', message: 'Invalid TxLoad record' };
    }
    const targetGrp = (auth.role === 'admin')
      ? (normalizePeaGroupNameServer_(rec.ownerGroup || effectiveGroup) || 'กฟส.บึง')
      : (normalizePeaGroupNameServer_(auth.group) || 'กฟส.บึง');

    const currentList = getTxLoadPool_(targetGrp);
    const recId = String(rec.id).trim();
    let prevMs = 0;
    let prevPdfRef = '';
    const filtered = currentList.filter(function(item) {
      if (item && String(item.id) === recId) {
        prevMs = Math.max(prevMs, parseTimestampMs_(item.updatedAt));
        if (!prevPdfRef && (item.pdfFileId || item.pdfUrl)) {
          prevPdfRef = item.pdfFileId || item.pdfUrl;
        }
        return false;
      }
      return true;
    });

    const inMs = parseTimestampMs_(rec.updatedAt) || Date.now();
    const safeIso = new Date(Math.max(Date.now(), inMs, prevMs + 1000)).toISOString();
    const cleanRec = Object.assign({}, rec, {
      id: recId,
      ownerGroup: targetGrp,
      deleted: false,
      updatedAt: safeIso
    });

    const oldFileId = extractDriveFileIdServer_(prevPdfRef);
    const newFileId = extractDriveFileIdServer_(cleanRec.pdfFileId || cleanRec.pdfUrl);
    const orphanPdfRef = (oldFileId && oldFileId !== newFileId) ? oldFileId : '';

    filtered.unshift(cleanRec);
    saveTxLoadPool_(targetGrp, filtered, true);
    return { status: 'ok', saved: true, id: recId, group: targetGrp, updatedAt: safeIso, _removedPdfRef: orphanPdfRef, serverTime: new Date().toISOString() };
  }

  if (action === 'deleteTxLoad') {
    const targetId = String((payload && payload.id) || '').trim();
    if (!targetId) return { status: 'error', message: 'Missing TxLoad id' };

    let targetGrp = (auth.role === 'admin')
      ? normalizePeaGroupNameServer_(payload.group || effectiveGroup)
      : (normalizePeaGroupNameServer_(auth.group) || 'กฟส.บึง');

    if (auth.role === 'admin' && !targetGrp) {
      const groups = collectOrderedMeterSearchGroups_('', getGroupNodesMap_(), getUsersData_());
      for (let i = 0; i < groups.length; i++) {
        if ((getTxLoadPool_(groups[i]) || []).some(function(r) { return r && String(r.id) === targetId; })) {
          targetGrp = groups[i];
          break;
        }
      }
      if (!targetGrp) targetGrp = 'กฟส.บึง';
    }

    const currentList = getTxLoadPool_(targetGrp);
    let prevMs = 0;
    let removedPdfRef = '';
    const filtered = currentList.filter(function(item) {
      if (item && String(item.id) === targetId) {
        prevMs = Math.max(prevMs, parseTimestampMs_(item.updatedAt));
        if (!removedPdfRef && (item.pdfFileId || item.pdfUrl)) {
          removedPdfRef = item.pdfFileId || item.pdfUrl;
        }
        return false;
      }
      return true;
    });

    const delIso = new Date(Math.max(Date.now(), prevMs + 1000)).toISOString();
    filtered.push({ id: targetId, ownerGroup: targetGrp, deleted: true, updatedAt: delIso });
    saveTxLoadPool_(targetGrp, filtered, true);
    return { status: 'ok', deleted: true, id: targetId, group: targetGrp, updatedAt: delIso, _removedPdfRef: removedPdfRef, serverTime: new Date().toISOString() };
  }

  if (action === 'clearTxPdfLink') {
    const targetId = String((payload && payload.id) || '').trim();
    if (!targetId) return { status: 'ok', deletedPdf: true, cleared: false, serverTime: new Date().toISOString() };

    let targetGrp = (auth.role === 'admin')
      ? normalizePeaGroupNameServer_(payload.group || effectiveGroup)
      : (normalizePeaGroupNameServer_(auth.group) || 'กฟส.บึง');

    if (auth.role === 'admin' && !targetGrp) {
      const groups = collectOrderedMeterSearchGroups_('', getGroupNodesMap_(), getUsersData_());
      for (let i = 0; i < groups.length; i++) {
        if ((getTxLoadPool_(groups[i]) || []).some(function(r) { return r && String(r.id) === targetId; })) {
          targetGrp = groups[i];
          break;
        }
      }
      if (!targetGrp) targetGrp = 'กฟส.บึง';
    }

    const currentList = getTxLoadPool_(targetGrp);
    let updated = false;
    let removedPdfRef = '';
    const nextList = currentList.map(function(item) {
      if (item && String(item.id) === targetId && !item.deleted) {
        updated = true;
        if (!removedPdfRef && (item.pdfFileId || item.pdfUrl)) {
          removedPdfRef = item.pdfFileId || item.pdfUrl;
        }
        const prevMs = parseTimestampMs_(item.updatedAt);
        const safeIso = new Date(Math.max(Date.now(), prevMs + 1000)).toISOString();
        return Object.assign({}, item, { pdfUrl: '', pdfFileId: '', pdfFp: '', updatedAt: safeIso });
      }
      return item;
    });
    if (updated) saveTxLoadPool_(targetGrp, nextList, true);
    return { status: 'ok', deletedPdf: true, cleared: updated, id: targetId, group: targetGrp, _removedPdfRef: removedPdfRef, serverTime: new Date().toISOString() };
  }

  return { status: 'error', message: 'Unsupported TxLoad action' };
}
// ============================================================================
// 🔐 ระบบเข้ารหัสข้อมูลส่วนบุคคลลูกค้าและเบอร์โทรศัพท์ใน Google Sheets (PDPA At-Rest Encryption)
// มาตรฐาน RFC 8439 ChaCha20 (256-bit) + HMAC-SHA256 (128-bit Auth Tag) เก็บกุญแจใน ScriptProperties
// ============================================================================

const PII_ENC_PREFIX_ = '🔒ENC1$';
const PII_PROP_KEY_NAME_ = 'PEA_PII_MASTER_KEY_B64';
const B64_ALPHABET_PII_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const JOB_CUSTOMER_PII_FIELDS_ = [
  'phone', 'tel', 'mobile', 'address', 'customerName', 'custName',
  'ca', 'caNo', 'caNumber', 'meterNo', 'peaMeterNo', 'reporter', 'workerName', 'formattedText'
];
const TX_CUSTOMER_PII_FIELDS_ = [
  'customerName', 'custName', 'applicant', 'applicantName', 'requester',
  'phone', 'tel', 'mobile', 'ca', 'caNo', 'caNumber', 'address', 'houseNo'
];
const BACKUP_SETTINGS_PII_KEYS_ = [
  'overdue_ca_list', 'elec_ca_overdue_list',
  'outageHistory', 'faultHistory', 'elecReportsComplete_all', 'fault_reports_all'
];

const SHA256_K_PII_ = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

let PII_SUBKEYS_MEMO_ = null;
let PII_NONCE_SEQ_ = 0;

function rotl32Pii_(v, c) { return ((v << c) | (v >>> (32 - c))) >>> 0; }
function rotr32Pii_(v, c) { return ((v >>> c) | (v << (32 - c))) >>> 0; }

function utf8EncodePii_(str) {
  const s = String(str || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8DecodePii_(bytes) {
  const chars = [];
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      chars.push(b1);
    } else if ((b1 & 0xe0) === 0xc0 && i < len) {
      chars.push(((b1 & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if ((b1 & 0xf0) === 0xe0 && i + 1 < len) {
      const b2 = bytes[i++] & 0x3f, b3 = bytes[i++] & 0x3f;
      chars.push(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
    } else if ((b1 & 0xf8) === 0xf0 && i + 2 < len) {
      const b2 = bytes[i++] & 0x3f, b3 = bytes[i++] & 0x3f, b4 = bytes[i++] & 0x3f;
      const cp = (((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4) - 0x10000;
      chars.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
    }
  }
  let res = '';
  for (let k = 0; k < chars.length; k += 8192) {
    res += String.fromCharCode.apply(null, chars.slice(k, k + 8192));
  }
  return res;
}

function bytesToBase64Pii_(bytes) {
  let out = '';
  const len = bytes.length;
  const mainLen = len - (len % 3);
  for (let i = 0; i < mainLen; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_ALPHABET_PII_[(n >> 18) & 63] + B64_ALPHABET_PII_[(n >> 12) & 63] +
           B64_ALPHABET_PII_[(n >> 6) & 63] + B64_ALPHABET_PII_[n & 63];
  }
  const rem = len - mainLen;
  if (rem === 1) {
    const n = bytes[mainLen] << 16;
    out += B64_ALPHABET_PII_[(n >> 18) & 63] + B64_ALPHABET_PII_[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[mainLen] << 16) | (bytes[mainLen + 1] << 8);
    out += B64_ALPHABET_PII_[(n >> 18) & 63] + B64_ALPHABET_PII_[(n >> 12) & 63] + B64_ALPHABET_PII_[(n >> 6) & 63] + '=';
  }
  return out;
}

let B64_DEC_MAP_PII_ = null;
function base64ToBytesPii_(b64Str) {
  if (!B64_DEC_MAP_PII_) {
    B64_DEC_MAP_PII_ = new Int16Array(128);
    B64_DEC_MAP_PII_.fill(-1);
    for (let i = 0; i < 64; i++) B64_DEC_MAP_PII_[B64_ALPHABET_PII_.charCodeAt(i)] = i;
  }
  const clean = String(b64Str || '').replace(/[\r\n\s]/g, '');
  const len = clean.length;
  if (!len || len % 4 !== 0) return new Uint8Array(0);
  const pad = (clean.charAt(len - 1) === '=' ? 1 : 0) + (clean.charAt(len - 2) === '=' ? 1 : 0);
  const out = new Uint8Array(((len * 3) >> 2) - pad);
  let outIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_DEC_MAP_PII_[clean.charCodeAt(i)];
    const c1 = B64_DEC_MAP_PII_[clean.charCodeAt(i + 1)];
    const c2 = clean.charAt(i + 2) === '=' ? 0 : B64_DEC_MAP_PII_[clean.charCodeAt(i + 2)];
    const c3 = clean.charAt(i + 3) === '=' ? 0 : B64_DEC_MAP_PII_[clean.charCodeAt(i + 3)];
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return new Uint8Array(0);
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIdx < out.length) out[outIdx++] = (n >> 16) & 255;
    if (outIdx < out.length) out[outIdx++] = (n >> 8) & 255;
    if (outIdx < out.length) out[outIdx++] = n & 255;
  }
  return out;
}

function sha256BytesPii_(msgBytes) {
  const len = msgBytes.length;
  const totalLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(msgBytes, 0);
  padded[len] = 0x80;
  const bitLenHi = Math.floor((len * 8) / 4294967296);
  const bitLenLo = (len * 8) >>> 0;
  padded[totalLen - 8] = (bitLenHi >>> 24) & 255;
  padded[totalLen - 7] = (bitLenHi >>> 16) & 255;
  padded[totalLen - 6] = (bitLenHi >>> 8) & 255;
  padded[totalLen - 5] = bitLenHi & 255;
  padded[totalLen - 4] = (bitLenLo >>> 24) & 255;
  padded[totalLen - 3] = (bitLenLo >>> 16) & 255;
  padded[totalLen - 2] = (bitLenLo >>> 8) & 255;
  padded[totalLen - 1] = bitLenLo & 255;

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + (i << 2);
      w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32Pii_(w[i - 15], 7) ^ rotr32Pii_(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32Pii_(w[i - 2], 17) ^ rotr32Pii_(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32Pii_(e, 6) ^ rotr32Pii_(e, 11) ^ rotr32Pii_(e, 25);
      const ch = ((e & f) ^ ((~e) & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA256_K_PII_[i] + w[i]) >>> 0;
      const S0 = rotr32Pii_(a, 2) ^ rotr32Pii_(a, 13) ^ rotr32Pii_(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    const v = hs[i], idx = i << 2;
    out[idx] = (v >>> 24) & 255;
    out[idx + 1] = (v >>> 16) & 255;
    out[idx + 2] = (v >>> 8) & 255;
    out[idx + 3] = v & 255;
  }
  return out;
}

function qroundChachaPii_(x, a, b, c, d) {
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl32Pii_(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl32Pii_(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl32Pii_(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl32Pii_(x[b] ^ x[c], 7);
}

function chacha20XorPii_(keyWords8, initialCounter, nonce12Bytes, inputBytes) {
  const n0 = (nonce12Bytes[0] | (nonce12Bytes[1] << 8) | (nonce12Bytes[2] << 16) | (nonce12Bytes[3] << 24)) >>> 0;
  const n1 = (nonce12Bytes[4] | (nonce12Bytes[5] << 8) | (nonce12Bytes[6] << 16) | (nonce12Bytes[7] << 24)) >>> 0;
  const n2 = (nonce12Bytes[8] | (nonce12Bytes[9] << 8) | (nonce12Bytes[10] << 16) | (nonce12Bytes[11] << 24)) >>> 0;

  const state = new Uint32Array(16);
  const work = new Uint32Array(16);
  const block = new Uint8Array(64);
  state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) state[4 + i] = keyWords8[i];
  state[13] = n0; state[14] = n1; state[15] = n2;

  const out = new Uint8Array(inputBytes.length);
  let counter = initialCounter >>> 0;

  for (let pos = 0; pos < inputBytes.length; pos += 64) {
    state[12] = counter;
    counter = (counter + 1) >>> 0;
    work.set(state);
    for (let r = 0; r < 10; r++) {
      qroundChachaPii_(work, 0, 4, 8, 12); qroundChachaPii_(work, 1, 5, 9, 13);
      qroundChachaPii_(work, 2, 6, 10, 14); qroundChachaPii_(work, 3, 7, 11, 15);
      qroundChachaPii_(work, 0, 5, 10, 15); qroundChachaPii_(work, 1, 6, 11, 12);
      qroundChachaPii_(work, 2, 7, 8, 13); qroundChachaPii_(work, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) {
      const v = (work[i] + state[i]) >>> 0, j = i << 2;
      block[j] = v & 255;
      block[j + 1] = (v >>> 8) & 255;
      block[j + 2] = (v >>> 16) & 255;
      block[j + 3] = (v >>> 24) & 255;
    }
    const take = Math.min(64, inputBytes.length - pos);
    for (let k = 0; k < take; k++) out[pos + k] = inputBytes[pos + k] ^ block[k];
  }
  return out;
}

function getPiiSubkeys_() {
  if (PII_SUBKEYS_MEMO_) return PII_SUBKEYS_MEMO_;
  const cache = CacheService.getScriptCache();
  let masterB64 = cache.get('PEA_PII_MK_CACHE_V1') || '';
  if (!masterB64) {
    try {
      const props = PropertiesService.getScriptProperties();
      masterB64 = String(props.getProperty(PII_PROP_KEY_NAME_) || '').trim();
      if (!masterB64) {
        const seedStr = ['PEA_PII_AT_REST_V1', PASSWORD_SALT, getMasterSpreadsheet_().getId()].join('|');
        const rawDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seedStr, Utilities.Charset.UTF_8);
        masterB64 = Utilities.base64Encode(rawDigest);
        props.setProperty(PII_PROP_KEY_NAME_, masterB64);
      }
      cache.put('PEA_PII_MK_CACHE_V1', masterB64, CACHE_TTL_SEC);
    } catch (e) {
      const fallbackSeed = ['PEA_PII_AT_REST_V1', PASSWORD_SALT, getMasterSpreadsheet_().getId()].join('|');
      masterB64 = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, fallbackSeed, Utilities.Charset.UTF_8));
    }
  }

  const masterBytes = base64ToBytesPii_(masterB64);
  const encKeyBytes = sha256BytesPii_(utf8EncodePii_('ENC_CHACHA20_V1|' + bytesToBase64Pii_(masterBytes)));
  const macKeyBytes = sha256BytesPii_(utf8EncodePii_('MAC_HMAC256_V1|' + bytesToBase64Pii_(masterBytes)));
  const nonceSeedBytes = sha256BytesPii_(utf8EncodePii_(Utilities.getUuid() + '|' + Date.now() + '|' + masterB64));

  const encWords = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const j = i << 2;
    encWords[i] = (encKeyBytes[j] | (encKeyBytes[j + 1] << 8) | (encKeyBytes[j + 2] << 16) | (encKeyBytes[j + 3] << 24)) >>> 0;
  }

  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const kb = i < 32 ? macKeyBytes[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }

  PII_SUBKEYS_MEMO_ = { encWords: encWords, ipad: ipad, opad: opad, nonceSeed: nonceSeedBytes };
  return PII_SUBKEYS_MEMO_;
}

function computePiiAuthTag16_(subkeys, nonce12, cipherBytes) {
  const innerIn = new Uint8Array(64 + 12 + cipherBytes.length);
  innerIn.set(subkeys.ipad, 0);
  innerIn.set(nonce12, 64);
  innerIn.set(cipherBytes, 76);
  const innerHash = sha256BytesPii_(innerIn);

  const outerIn = new Uint8Array(64 + 32);
  outerIn.set(subkeys.opad, 0);
  outerIn.set(innerHash, 64);
  return sha256BytesPii_(outerIn).subarray(0, 16);
}

function nextPiiRandomNonce12_(subkeys) {
  PII_NONCE_SEQ_ = (PII_NONCE_SEQ_ + 1) >>> 0;
  const buf = new Uint8Array(44);
  buf.set(subkeys.nonceSeed, 0);
  const now = Date.now(), r = (Math.random() * 0xffffffff) >>> 0;
  buf[32] = (now >>> 24) & 255; buf[33] = (now >>> 16) & 255; buf[34] = (now >>> 8) & 255; buf[35] = now & 255;
  buf[36] = (PII_NONCE_SEQ_ >>> 24) & 255; buf[37] = (PII_NONCE_SEQ_ >>> 16) & 255;
  buf[38] = (PII_NONCE_SEQ_ >>> 8) & 255; buf[39] = PII_NONCE_SEQ_ & 255;
  buf[40] = (r >>> 24) & 255; buf[41] = (r >>> 16) & 255; buf[42] = (r >>> 8) & 255; buf[43] = r & 255;
  return sha256BytesPii_(buf).subarray(0, 12);
}

function isPiiEncrypted_(val) {
  return typeof val === 'string' && val.indexOf(PII_ENC_PREFIX_) === 0;
}

function encryptPiiString_(plainVal) {
  if (plainVal === undefined || plainVal === null) return plainVal;
  const s = String(plainVal);
  const trimmed = s.trim();
  if (!trimmed || trimmed === '-' || isPiiEncrypted_(s)) return s;

  const subkeys = getPiiSubkeys_();
  const nonce = nextPiiRandomNonce12_(subkeys);
  const plainBytes = utf8EncodePii_(s);
  const cipherBytes = chacha20XorPii_(subkeys.encWords, 1, nonce, plainBytes);
  const tag16 = computePiiAuthTag16_(subkeys, nonce, cipherBytes);

  const packed = new Uint8Array(28 + cipherBytes.length);
  packed.set(nonce, 0);
  packed.set(tag16, 12);
  packed.set(cipherBytes, 28);
  return PII_ENC_PREFIX_ + bytesToBase64Pii_(packed);
}

function decryptPiiString_(cipherVal) {
  if (typeof cipherVal !== 'string' || !isPiiEncrypted_(cipherVal)) return cipherVal;
  const raw = base64ToBytesPii_(cipherVal.substring(PII_ENC_PREFIX_.length));
  if (raw.length <= 28) return cipherVal;

  const subkeys = getPiiSubkeys_();
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const cipherBytes = raw.subarray(28);
  const expectedTag = computePiiAuthTag16_(subkeys, nonce, cipherBytes);

  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= (tag[i] ^ expectedTag[i]);
  if (diff !== 0) return cipherVal;

  const plainBytes = chacha20XorPii_(subkeys.encWords, 1, nonce, cipherBytes);
  return utf8DecodePii_(plainBytes);
}

function transformJobPiiFields_(jobObj, isEncrypt) {
  if (!jobObj || typeof jobObj !== 'object' || jobObj.jobType === 'tech_loc' || jobObj.dateTimeSaved === 'TECH_LOC_REGISTRY') {
    return jobObj;
  }
  const fn = isEncrypt ? encryptPiiString_ : decryptPiiString_;
  const copy = Object.assign({}, jobObj);

  for (let i = 0; i < JOB_CUSTOMER_PII_FIELDS_.length; i++) {
    const f = JOB_CUSTOMER_PII_FIELDS_[i];
    if (typeof copy[f] === 'string' && copy[f]) copy[f] = fn(copy[f]);
  }

  if (copy.meterFormState && typeof copy.meterFormState === 'object') {
    const mf = Object.assign({}, copy.meterFormState);
    if (mf.fields && typeof mf.fields === 'object') {
      const nextFields = {};
      Object.keys(mf.fields).forEach(function(fk) {
        const fv = mf.fields[fk];
        nextFields[fk] = (typeof fv === 'string' && fv) ? fn(fv) : fv;
      });
      mf.fields = nextFields;
    }
    if (mf.sigs && mf.sigs.sig2 && typeof mf.sigs.sig2 === 'object') {
      const nextSig2 = Object.assign({}, mf.sigs.sig2);
      if (typeof nextSig2.src === 'string' && nextSig2.src) nextSig2.src = fn(nextSig2.src);
      if (typeof nextSig2.name === 'string' && nextSig2.name) nextSig2.name = fn(nextSig2.name);
      if (typeof nextSig2.data === 'string' && nextSig2.data) nextSig2.data = fn(nextSig2.data);
      mf.sigs = Object.assign({}, mf.sigs, { sig2: nextSig2 });
    }
    copy.meterFormState = mf;
  }
  return copy;
}

function transformBackupPiiFields_(backupObj, isEncrypt) {
  if (!backupObj || typeof backupObj !== 'object') return backupObj;
  const fn = isEncrypt ? encryptPiiString_ : decryptPiiString_;
  const copy = Object.assign({}, backupObj);

  if (Array.isArray(copy.outages)) {
    copy.outages = copy.outages.map(function(o) { return transformJobPiiFields_(o, isEncrypt); });
  }
  if (Array.isArray(copy.faults)) {
    copy.faults = copy.faults.map(function(f) { return transformJobPiiFields_(f, isEncrypt); });
  }
  if (copy.settings && typeof copy.settings === 'object') {
    const nextSettings = Object.assign({}, copy.settings);
    for (let i = 0; i < BACKUP_SETTINGS_PII_KEYS_.length; i++) {
      const sk = BACKUP_SETTINGS_PII_KEYS_[i];
      if (typeof nextSettings[sk] === 'string' && nextSettings[sk]) {
        nextSettings[sk] = fn(nextSettings[sk]);
      } else if (Array.isArray(nextSettings[sk])) {
        nextSettings[sk] = nextSettings[sk].map(function(it) {
          return typeof it === 'string' ? fn(it) : transformJobPiiFields_(it, isEncrypt);
        });
      }
    }
    copy.settings = nextSettings;
  }
  return copy;
}

function transformTxLoadPiiFields_(txObj, isEncrypt) {
  if (!txObj || typeof txObj !== 'object') return txObj;
  const fn = isEncrypt ? encryptPiiString_ : decryptPiiString_;
  const copy = Object.assign({}, txObj);
  for (let i = 0; i < TX_CUSTOMER_PII_FIELDS_.length; i++) {
    const f = TX_CUSTOMER_PII_FIELDS_[i];
    if (typeof copy[f] === 'string' && copy[f]) copy[f] = fn(copy[f]);
  }
  return copy;
}

function protectRecordPiiForSheet_(sheetName, dataObj) {
  if (sheetName === SHEET_JOBS) return transformJobPiiFields_(dataObj, true);
  if (sheetName === SHEET_BACKUPS) return transformBackupPiiFields_(dataObj, true);
  if (sheetName === SHEET_TX_LOAD) return transformTxLoadPiiFields_(dataObj, true);
  return dataObj;
}

function unprotectRecordPiiFromSheet_(sheetName, dataObj) {
  if (sheetName === SHEET_JOBS) return transformJobPiiFields_(dataObj, false);
  if (sheetName === SHEET_BACKUPS) return transformBackupPiiFields_(dataObj, false);
  if (sheetName === SHEET_TX_LOAD) return transformTxLoadPiiFields_(dataObj, false);
  return dataObj;
}

function verifyPiiCryptoSelfTest_() {
  const testMsg = 'นายสมชาย ใจดี 123/45 ม.3 ต.บึง 📞 081-234-5678 ⚡ CA: 020012345678';
  const v8HashHex = Array.from(sha256BytesPii_(utf8EncodePii_(testMsg))).map(function(b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  const gasDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, testMsg, Utilities.Charset.UTF_8);
  const gasHashHex = gasDigest.map(function(b) { const u = b < 0 ? b + 256 : b; return (u < 16 ? '0' : '') + u.toString(16); }).join('');
  if (v8HashHex !== gasHashHex) throw new Error('SHA-256 self-test mismatch');

  const enc = encryptPiiString_(testMsg);
  if (!isPiiEncrypted_(enc)) throw new Error('Encryption prefix check failed');
  const dec = decryptPiiString_(enc);
  if (dec !== testMsg) throw new Error('Round-trip decryption mismatch');
  return true;
}

// 🚀 กดปุ่ม "เรียกใช้ (Run)" ที่ฟังก์ชันนี้ 1 ครั้ง เพื่อเข้ารหัสข้อมูลลูกค้าและเบอร์โทรที่มีอยู่เดิมในทุกสาขาทันที
function encryptAllExistingCustomerData() {
  verifyPiiCryptoSelfTest_();
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const visitedSsIds = {};
    const targetSpreadsheets = [getMasterSpreadsheet_()];
    visitedSsIds[targetSpreadsheets[0].getId()] = true;

    const groups = getAllActiveSystemGroups_([]);
    groups.forEach(function(grp) {
      const ss = openGroupSpreadsheet_(grp);
      if (ss && !visitedSsIds[ss.getId()]) {
        visitedSsIds[ss.getId()] = true;
        targetSpreadsheets.push(ss);
      }
    });

    const piiTabs = [SHEET_JOBS, SHEET_BACKUPS, SHEET_TX_LOAD];
    let encryptedSheetsCount = 0;

    targetSpreadsheets.forEach(function(ss) {
      piiTabs.forEach(function(tName) {
        const sh = ss.getSheetByName(tName);
        if (!sh || sh.getLastRow() <= 1) return;
        const recs = readKeyedSheetRecords_(ss, tName, false);
        if (recs.length > 0) {
          writeKeyedSheetRecords_(ss, tName, recs);
          encryptedSheetsCount++;
        }
      });
    });

    flushDirtySheetsSafe_();
    logSystemEvent_('INFO', 'encryptExistingPii', 'ALL', 'admin', 'เข้ารหัสข้อมูลลูกค้าและเบอร์โทรใน Google Sheets เรียบร้อย', { sheetsProcessed: encryptedSheetsCount });
    Logger.log('🔒 เข้ารหัสข้อมูลลูกค้าและเบอร์โทรใน Google Sheets ครบทุกสาขาเรียบร้อยแล้ว (' + encryptedSheetsCount + ' แท็บ)');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
// ============================================================================
// 🔐🧹 ระบบลบและพรางข้อมูลส่วนบุคคลผู้ใช้ไฟอัตโนมัติประจำปี (PDPA Annual PII Purge)
// ============================================================================

const RETENTION_PII_DAYS = 365;        // ลบใบงาน Jobs / Backups และพรางชื่อลูกค้าใน TxLoad เมื่อเกิน 365 วัน (1 ปี)
const RETENTION_TX_RECORD_DAYS = 730;  // ลบแถวประวัติวัดโหลดหม้อแปลง TxLoad ทั้งแถวเมื่อเกิน 730 วัน (2 ปี พร้อม PDF)

function parseAnyRecordDateMs_(rawVal) {
  if (!rawVal || rawVal === true) return 0;
  if (typeof rawVal === 'number') return isNaN(rawVal) ? 0 : rawVal;
  const s = String(rawVal).trim();
  if (!s || s === '-') return 0;

  // รองรับรูปแบบวันที่ไทย dd/mm/2569 หรือ dd/mm/2026 (มีหรือไม่มีเวลา)
  const thMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/);
  if (thMatch) {
    let yr = parseInt(thMatch[3], 10);
    if (yr > 2400) yr -= 543;
    const ms = new Date(
      yr, (parseInt(thMatch[2], 10) || 1) - 1, parseInt(thMatch[1], 10) || 1,
      parseInt(thMatch[4] || '0', 10), parseInt(thMatch[5] || '0', 10), parseInt(thMatch[6] || '0', 10)
    ).getTime();
    if (!isNaN(ms) && ms > 0) return ms;
  }

  // รองรับรูปแบบ yyyy-mm-dd (เช่น 2026-11-23 หรือ 2569-11-23) และ ISO Timestamp
  const isoDateMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDateMatch) {
    let yr2 = parseInt(isoDateMatch[1], 10);
    if (yr2 > 2400) yr2 -= 543;
    const ms2 = new Date(yr2, parseInt(isoDateMatch[2], 10) - 1, parseInt(isoDateMatch[3], 10)).getTime();
    if (!isNaN(ms2) && ms2 > 0) return ms2;
  }

  return parseTimestampMs_(s);
}

function getJobEffectiveTimestampMs_(job) {
  if (!job || typeof job !== 'object') return 0;
  return parseJobSortTimeMs_(job) ||
         parseAnyRecordDateMs_(job.timestamp) ||
         parseAnyRecordDateMs_(job.dateTimeSaved) ||
         parseAnyRecordDateMs_(job.editedAt) ||
         parseAnyRecordDateMs_(job.techReport && job.techReport.updatedAt) || 0;
}

function getTxLoadTrueCreatedMs_(txRec) {
  if (!txRec || typeof txRec !== 'object') return 0;
  return parseAnyRecordDateMs_(txRec.originalRecordAt) ||
         parseAnyRecordDateMs_(txRec.createdAt) ||
         parseAnyRecordDateMs_(txRec.measureDate) ||
         parseAnyRecordDateMs_(txRec.recordDate) ||
         parseAnyRecordDateMs_(txRec.date) ||
         parseAnyRecordDateMs_(txRec.timestamp) ||
         parseAnyRecordDateMs_(txRec.updatedAt) || 0;
}

function filterJobArrayByCutoff_(arr, cutoffMs) {
  if (!Array.isArray(arr)) return { list: arr, removed: 0 };
  let removed = 0;
  const kept = [];
  arr.forEach(function(item) {
    if (!item || typeof item !== 'object') { kept.push(item); return; }
    const ms = getJobEffectiveTimestampMs_(item);
    if (ms > 0 && ms < cutoffMs) {
      // ถ้าเป็นใบงานเหตุฟอลต์ (fault) ให้คงข้อมูลระยะรีเลย์/กระแสฟอลต์/พิกัดไว้ ล้างเฉพาะเบอร์โทรและชื่อลูกค้าถ้ามี
      if (item.jobType === 'fault') {
        if (!item.piiAnonymized) {
          const copy = Object.assign({}, item);
          let maskedAny = false;
          ['phone', 'tel', 'mobile', 'customerName', 'custName', 'ca', 'caNo', 'caNumber'].forEach(function(f) {
            if (copy[f] && String(copy[f]).trim() && String(copy[f]).trim() !== '-') {
              copy[f] = '-';
              maskedAny = true;
            }
          });
          if (typeof copy.formattedText === 'string' && copy.formattedText) {
            const cleanTxt = copy.formattedText
              .replace(/\b0[2689]\d[\s-]*\d{3}[\s-]*\d{3,4}\b/g, '[ลบเบอร์โทร]')
              .replace(/\b\d{12}\b/g, '[ลบเลข CA]');
            if (cleanTxt !== copy.formattedText) { copy.formattedText = cleanTxt; maskedAny = true; }
          }
                    if (maskedAny) {
            copy.piiAnonymized = true;
            copy.editedAt = new Date().toISOString();
            removed++;
          }
          kept.push(copy);
        } else {
          kept.push(item);
        }
        return;
      }
      // ถ้าเป็นใบงานไฟดับผู้ใช้ไฟทั่วไป (outage) เกิน 1 ปี ลบทั้งรายการตามเกณฑ์ PDPA
      removed++;
      return;
    }
    kept.push(item);
  });
  return { list: kept, removed: removed };
}

function executeAnnualPiiCleanupCore_(isDryRun) {
  const nowMs = Date.now();
  const piiCutoffMs = nowMs - (RETENTION_PII_DAYS * 24 * 60 * 60 * 1000);
  const txDeleteCutoffMs = nowMs - (RETENTION_TX_RECORD_DAYS * 24 * 60 * 60 * 1000);
  const groups = getAllActiveSystemGroups_([]);

  let purgedJobsCount = 0;
  let anonymizedTxCount = 0;
  let deletedOldTxCount = 0;
  let purgedBackupItemsCount = 0;
  let trashedExpiredTxPdfsCount = 0;
  const expiredTxPdfQueue = [];

  groups.forEach(function(grp) {
    const cleanGrp = normalizePeaGroupNameServer_(grp) || 'กฟส.บึง';
    const lock = LockService.getScriptLock();
    if (!isDryRun && !lock.tryLock(SCRIPT_LOCK_WAIT_MS)) return;

    try {
      // 1. ล้างใบงานเก่าเกิน 1 ปีในแท็บ Jobs พร้อมส่งสัญญาณลบไปยังมือถือทุกเครื่องผ่าน deletedJobsMap
      const ss = openGroupSpreadsheet_(cleanGrp);
      const rawJobRows = readKeyedSheetRecords_(ss, SHEET_JOBS, false);
      if (rawJobRows.length > 0) {
        const rawJobs = rawJobRows.map(function(r) { return r.data; }).filter(Boolean);
        const jobRes = filterJobArrayByCutoff_(rawJobs, piiCutoffMs);
        if (jobRes.removed > 0) {
          purgedJobsCount += jobRes.removed;
          if (!isDryRun) {
            const keptKeys = new Set(jobRes.list.map(getRawJobKey_).filter(Boolean));
            const stObj = getStatePool_(cleanGrp);
            stObj.deletedJobsMap = stObj.deletedJobsMap || {};
            let addedTombstone = false;
            rawJobs.forEach(function(oldJ) {
              if (!oldJ || oldJ.jobType === 'fault') return;
              const rk = getRawJobKey_(oldJ);
              if (rk && !keptKeys.has(rk)) {
                stObj.deletedJobsMap[rk] = nowMs;
                if (stObj.closedJobsMap) delete stObj.closedJobsMap[rk];
                addedTombstone = true;
              }
            });
            if (addedTombstone) {
              stObj.deletedJobsMap = pruneAgedRegistry_(stObj.deletedJobsMap, false);
              stObj.lastSheetWriteMs = nowMs;
              saveStatePool_(cleanGrp, stObj, true);
            }
            saveJobsPool_(cleanGrp, jobRes.list, true);
          }
        }
      }

      // 2. พรางข้อมูลลูกค้าในแท็บ TxLoad ที่เกิน 1 ปี และลบทั้งแถวพร้อมคิวลบ PDF เมื่อเกิน 2 ปี
      const txList = getTxLoadPool_(cleanGrp);
      let txChanged = false;
      const nextTxList = [];

      txList.forEach(function(rec) {
        if (!rec || typeof rec !== 'object') return;
        if (rec.deleted) {
          nextTxList.push(rec);
          return;
        }
        const recMs = getTxLoadTrueCreatedMs_(rec);
        if (recMs > 0 && recMs < txDeleteCutoffMs) {
          const oldPdfRef = rec.pdfFileId || rec.pdfUrl || '';
          if (oldPdfRef) expiredTxPdfQueue.push({ ref: oldPdfRef, grp: cleanGrp });
          deletedOldTxCount++;
          txChanged = true;
          return;
        }

        if (recMs > 0 && recMs < piiCutoffMs && !rec.piiAnonymized) {
          let hasPii = false;
          const copy = Object.assign({}, rec);
          for (let i = 0; i < TX_CUSTOMER_PII_FIELDS_.length; i++) {
            const f = TX_CUSTOMER_PII_FIELDS_[i];
            if (copy[f] && String(copy[f]).trim() && String(copy[f]).trim() !== '-') {
              copy[f] = '-';
              hasPii = true;
            }
          }
          if (hasPii) {
            copy.originalRecordAt = rec.originalRecordAt || rec.createdAt || rec.measureDate || rec.date || rec.updatedAt;
            copy.piiAnonymized = true;
            copy.updatedAt = new Date(Math.max(nowMs, parseTimestampMs_(rec.updatedAt) + 1000)).toISOString();
            anonymizedTxCount++;
            txChanged = true;
            nextTxList.push(copy);
            return;
          }
        }
        nextTxList.push(rec);
      });

      if (txChanged && !isDryRun) {
        saveTxLoadPool_(cleanGrp, nextTxList, true);
      }

      // 3. ล้างประวัติใบงานและข้อมูลลูกค้าที่เกิน 1 ปีในก้อนสำรองแท็บ Backups
      const backupsMap = getBackupsPool_(cleanGrp);
      let bkChanged = false;
      const nextBackupsMap = Object.assign({}, backupsMap);

      Object.keys(nextBackupsMap).forEach(function(bkKey) {
        const bkObj = nextBackupsMap[bkKey];
        if (!bkObj || typeof bkObj !== 'object') return;
        const bkCopy = Object.assign({}, bkObj);
        let thisBkTouched = false;

        if (Array.isArray(bkCopy.outages)) {
          const rOut = filterJobArrayByCutoff_(bkCopy.outages, piiCutoffMs);
          if (rOut.removed > 0) { bkCopy.outages = rOut.list; purgedBackupItemsCount += rOut.removed; thisBkTouched = true; }
        }
        if (Array.isArray(bkCopy.faults)) {
          const rFlt = filterJobArrayByCutoff_(bkCopy.faults, piiCutoffMs);
          if (rFlt.removed > 0) { bkCopy.faults = rFlt.list; purgedBackupItemsCount += rFlt.removed; thisBkTouched = true; }
        }
        if (bkCopy.settings && typeof bkCopy.settings === 'object') {
          const nextSet = Object.assign({}, bkCopy.settings);
          const bkAgeMs = parseAnyRecordDateMs_(bkCopy.updatedAt);

          ['outageHistory', 'faultHistory', 'elecReportsComplete_all', 'fault_reports_all'].forEach(function(sk) {
            const v = nextSet[sk];
            if (Array.isArray(v)) {
              const rArr = filterJobArrayByCutoff_(v, piiCutoffMs);
              if (rArr.removed > 0) { nextSet[sk] = rArr.list; purgedBackupItemsCount += rArr.removed; thisBkTouched = true; }
            } else if (typeof v === 'string' && v.trim().charAt(0) === '[') {
              try {
                const parsedArr = JSON.parse(v);
                const rJson = filterJobArrayByCutoff_(parsedArr, piiCutoffMs);
                if (rJson.removed > 0) { nextSet[sk] = JSON.stringify(rJson.list); purgedBackupItemsCount += rJson.removed; thisBkTouched = true; }
              } catch (e) {}
            }
          });

          // ล้างรายการ CA ค้างชำระในก้อน Backup เฉพาะกรณีที่ก้อน Backup นั้นไม่มีการอัปเดตเลยเกิน 1 ปี
          if (bkAgeMs > 0 && bkAgeMs < piiCutoffMs) {
            ['overdue_ca_list', 'elec_ca_overdue_list'].forEach(function(caKey) {
              if (nextSet[caKey] && String(nextSet[caKey]) !== '[]' && String(nextSet[caKey]) !== '') {
                nextSet[caKey] = Array.isArray(nextSet[caKey]) ? [] : '';
                purgedBackupItemsCount++;
                thisBkTouched = true;
              }
            });
          }
          bkCopy.settings = nextSet;
        }

        if (thisBkTouched) {
          bkCopy.updatedAt = new Date().toISOString();
          nextBackupsMap[bkKey] = bkCopy;
          bkChanged = true;
        }
      });

      if (bkChanged && !isDryRun) {
        saveBackupsPool_(cleanGrp, nextBackupsMap, true);
      }

      if (!isDryRun) flushDirtySheetsSafe_();
    } finally {
      if (!isDryRun) {
        try { lock.releaseLock(); } catch (e) {}
      }
    }
  });

  if (!isDryRun && expiredTxPdfQueue.length > 0) {
    expiredTxPdfQueue.forEach(function(item) {
      if (trashTxPdfFileSafe_(item.ref, item.grp, { role: 'admin' }).trashed) {
        trashedExpiredTxPdfsCount++;
      }
    });
  }

  const report = {
    mode: isDryRun ? 'DRY_RUN_PREVIEW' : 'ACTUAL_PII_CLEANUP',
    retentionPiiDays: RETENTION_PII_DAYS,
    purgedJobsCount: purgedJobsCount,
    anonymizedTxCustomerCount: anonymizedTxCount,
    deletedExpiredTxCount: deletedOldTxCount,
    trashedExpiredTxPdfsCount: trashedExpiredTxPdfsCount,
    purgedBackupItemsCount: purgedBackupItemsCount
  };

  Logger.log('🔐 สรุปผลตรวจสอบ/ล้างข้อมูลผู้ใช้ไฟประจำปี (PDPA): ' + JSON.stringify(report));
  if (!isDryRun && (purgedJobsCount > 0 || anonymizedTxCount > 0 || deletedOldTxCount > 0 || purgedBackupItemsCount > 0)) {
    logSystemEvent_('INFO', 'autoPiiCleanup', 'ALL', 'SYSTEM_TRIGGER', 'ล้างและพรางข้อมูลผู้ใช้ไฟที่เกิน 1 ปีตามมาตรฐาน PDPA เรียบร้อย', report);
  }
  return report;
}

// 🔍 กด Run ตัวนี้เพื่อจำลองดูยอดข้อมูลผู้ใช้ไฟที่จะถูกล้าง (ไม่ลบข้อมูลจริง)
function previewPiiCleanupReport() {
  return executeAnnualPiiCleanupCore_(true);
}

// 🧹 กด Run ตัวนี้เพื่อสั่งล้างข้อมูลผู้ใช้ไฟที่เกิน 1 ปีทันที
function runScheduledPiiCleanup() {
  return executeAnnualPiiCleanupCore_(false);
}

// 🔄 ฟังก์ชันรวมสำหรับรันอัตโนมัติทุกวันที่ 1 ของเดือน (ล้างข้อมูลผู้ใช้ไฟ PDPA + ล้างรูปและ PDF ต่อเนื่องกัน)
function runMonthlyMasterMaintenance() {
  const piiRes = executeAnnualPiiCleanupCore_(false);
  const mediaRes = (typeof executeMediaCleanupCore_ === 'function') ? executeMediaCleanupCore_(false) : null;
  return { piiCleanup: piiRes, mediaCleanup: mediaRes };
}

// ⏰ กด Run ตัวนี้เพียง 1 ครั้ง เพื่อแยกตั้งเวลา ตี 2 (ล้างข้อมูลผู้ใช้ไฟ PDPA) และ ตี 3 (ล้างรูป/PDF) ทุกวันที่ 1 ของเดือน
function setupMonthlyMasterCleanupTrigger() {
  const handlersToReplace = ['runScheduledMediaCleanup', 'runScheduledPiiCleanup', 'runMonthlyMasterMaintenance'];
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (handlersToReplace.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('runScheduledPiiCleanup')
    .timeBased()
    .onMonthDay(1)
    .atHour(2)
    .create();

  ScriptApp.newTrigger('runScheduledMediaCleanup')
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();

  logSystemEvent_('INFO', 'setupMasterCleanup', 'MASTER', 'admin', 'เปิดทริกเกอร์แยกเวลา ตี 2 (ล้าง PII) และ ตี 3 (ล้างรูป/PDF) ทุกวันที่ 1 ของเดือน', {
    piiRetentionDays: RETENTION_PII_DAYS,
    photoMonths: RETENTION_PHOTO_MONTHS,
    pdfMonths: RETENTION_PDF_MONTHS
  });
  Logger.log('✅ ตั้งเวลาอัตโนมัติเรียบร้อย: วันที่ 1 เวลา 02:00 น. (PDPA PII) และ 03:00 น. (รูป/PDF)');
}

// ============================================================================
// 🧹 ระบบทำความสะอาดรูปถ่ายหน้างานและไฟล์ PDF บน Google Drive อัตโนมัติ (Rolling Retention)
// ============================================================================

const RETENTION_PHOTO_MONTHS = 12; // เก็บรูปถ่ายหน้างาน (.jpg/.png/.webp) ย้อนหลัง 12 เดือนเต็ม
const RETENTION_PDF_MONTHS = 24;   // เก็บใบรายงานวัดโหลด (.pdf) ย้อนหลัง 24 เดือนเต็ม
const MAX_CLEANUP_EXEC_MS = 240000; // เพดานรันปลอดภัย 4 นาที ป้องกันเกินโควตาเวลา Google Apps Script

function executeMediaCleanupCore_(isDryRun) {
  const startMs = Date.now();
  const rootFolder = findActiveFolderByName_(DriveApp, PHOTO_ROOT_FOLDER_NAME);
  if (!rootFolder) {
    Logger.log('ℹ️ ยังไม่มีโฟลเดอร์ ' + PHOTO_ROOT_FOLDER_NAME + ' ในระบบ');
    return { status: 'no_root_folder' };
  }

  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const curYearBE = nowBkk.getUTCFullYear() + 543;
  const curMonth = nowBkk.getUTCMonth() + 1;
  const minKeepMonths = Math.min(RETENTION_PHOTO_MONTHS, RETENTION_PDF_MONTHS);
  const cache = CacheService.getScriptCache();

  let trashedFolders = 0;
  let trashedPhotos = 0;
  let trashedPdfs = 0;
  let unlinkedTxRecords = 0;
  let stoppedEarly = false;

  const grpIter = rootFolder.getFolders();
  while (grpIter.hasNext() && !stoppedEarly) {
    const grpFolder = grpIter.next();
    if (grpFolder.isTrashed()) continue;
    const cleanGrp = normalizePeaGroupNameServer_(grpFolder.getName()) || grpFolder.getName();
    const expiredPdfIdsMap = {};
    let hasExpiredPdfInGroup = false;

    const ymIter = grpFolder.getFolders();
    while (ymIter.hasNext()) {
      if (Date.now() - startMs > MAX_CLEANUP_EXEC_MS) {
        stoppedEarly = true;
        break;
      }
      const ymFolder = ymIter.next();
      if (ymFolder.isTrashed()) continue;

      const ymName = String(ymFolder.getName() || '').trim();
      const m = ymName.match(/^(\d{4})-(\d{2})$/);
      if (!m) continue;

      const fYearBE = parseInt(m[1], 10);
      const fMonth = parseInt(m[2], 10);
      if (fYearBE < 2560 || fYearBE > 2700 || fMonth < 1 || fMonth > 12) continue;

      const ageMonths = (curYearBE - fYearBE) * 12 + (curMonth - fMonth);
      if (ageMonths <= minKeepMonths) continue;

      const photoExpired = (ageMonths > RETENTION_PHOTO_MONTHS);
      const pdfExpired = (ageMonths > RETENTION_PDF_MONTHS);

      if (photoExpired && pdfExpired) {
        const pdfIter = ymFolder.getFilesByType('application/pdf');
        while (pdfIter.hasNext()) {
          const pf = pdfIter.next();
          if (!pf.isTrashed()) {
            expiredPdfIdsMap[pf.getId()] = true;
            hasExpiredPdfInGroup = true;
            trashedPdfs++;
          }
        }
        if (!isDryRun) {
          ymFolder.setTrashed(true);
          try { cache.remove('PEA_PHDIR_' + computeMd5Hex_(cleanGrp + '_' + ymName).substring(0, 16)); } catch (e) {}
        }
        trashedFolders++;
        continue;
      }

      const fileIter = ymFolder.getFiles();
      let hasRemainingActiveFile = false;
      while (fileIter.hasNext()) {
        if (Date.now() - startMs > MAX_CLEANUP_EXEC_MS) {
          stoppedEarly = true;
          hasRemainingActiveFile = true;
          break;
        }
        const f = fileIter.next();
        if (f.isTrashed()) continue;
        const isPdf = (String(f.getMimeType() || '').toLowerCase() === 'application/pdf');

        if (isPdf && pdfExpired) {
          expiredPdfIdsMap[f.getId()] = true;
          hasExpiredPdfInGroup = true;
          trashedPdfs++;
          if (!isDryRun) f.setTrashed(true);
        } else if (!isPdf && photoExpired) {
          trashedPhotos++;
          if (!isDryRun) f.setTrashed(true);
        } else {
          hasRemainingActiveFile = true;
        }
      }

      if (!hasRemainingActiveFile && !stoppedEarly) {
        if (!isDryRun) {
          ymFolder.setTrashed(true);
          try { cache.remove('PEA_PHDIR_' + computeMd5Hex_(cleanGrp + '_' + ymName).substring(0, 16)); } catch (e) {}
        }
        trashedFolders++;
      }
    }

    if (!isDryRun && hasExpiredPdfInGroup) {
      const cLock = LockService.getScriptLock();
      if (cLock.tryLock(SCRIPT_LOCK_WAIT_MS)) {
        try {
          const txList = getTxLoadPool_(cleanGrp);
          let changed = false;
          const nextList = txList.map(function(item) {
            if (!item || item.deleted) return item;
            const fid = extractDriveFileIdServer_(item.pdfFileId || item.pdfUrl);
            if (fid && expiredPdfIdsMap[fid]) {
              changed = true;
              unlinkedTxRecords++;
              return Object.assign({}, item, {
                pdfUrl: '',
                pdfFileId: '',
                pdfFp: '',
                updatedAt: new Date(Math.max(Date.now(), parseTimestampMs_(item.updatedAt) + 1000)).toISOString()
              });
            }
            return item;
          });
          if (changed) {
            saveTxLoadPool_(cleanGrp, nextList, true);
            flushDirtySheetsSafe_();
          }
        } finally {
          try { cLock.releaseLock(); } catch (e) {}
        }
      }
    }
  }

  const summary = {
    mode: isDryRun ? 'DRY_RUN_PREVIEW' : 'ACTUAL_CLEANUP',
    retentionPhotoMonths: RETENTION_PHOTO_MONTHS,
    retentionPdfMonths: RETENTION_PDF_MONTHS,
    trashedMonthFolders: trashedFolders,
    trashedPhotos: trashedPhotos,
    trashedPdfs: trashedPdfs,
    unlinkedTxRecords: unlinkedTxRecords,
    stoppedByTimeLimit: stoppedEarly
  };

  Logger.log('🧹 สรุปผลตรวจสอบ/ทำความสะอาดไฟล์เก่า: ' + JSON.stringify(summary));
  if (!isDryRun && (trashedFolders > 0 || trashedPhotos > 0 || trashedPdfs > 0 || stoppedEarly)) {
    logSystemEvent_(
      stoppedEarly ? 'WARN' : 'INFO',
      'autoMediaCleanup',
      'ALL',
      'SYSTEM_TRIGGER',
      stoppedEarly ? 'ทำความสะอาดไฟล์เก่าบางส่วน (พักรอรอบถัดไปตามเพดานเวลา)' : 'ทำความสะอาดรูปและ PDF ที่เกินกำหนดเรียบร้อย',
      summary
    );
  }
  return summary;
}

// 🔍 กด Run เพื่อจำลองนับจำนวนรูปและ PDF ที่จะถูกลบ (ไม่ลบไฟล์จริง)
function previewMediaCleanupReport() {
  return executeMediaCleanupCore_(true);
}

// 🧹 กด Run เพื่อสั่งล้างรูปและ PDF ที่เกินกำหนดทันที
function runScheduledMediaCleanup() {
  return executeMediaCleanupCore_(false);
}
// ============================================================================
// 📡 Public Outage Radar API (Read-Only RAM Cache — Zero Internal Data Exposure)
// ============================================================================

const PUBLIC_OUTAGE_CACHE_SEC_ = 900; // แคชใน RAM 15 นาที (ล้างอัตโนมัติทันทีเมื่อแก้แผน PM)

function getPublicOutageCacheKey_(groupName) {
  const cleanGrp = normalizePeaGroupNameServer_(groupName) || 'กฟส.บึง';
  const todayStr = Utilities.formatDate(new Date(), 'GMT+7', 'yyyyMMdd');
  return 'PEA_PUB_OUT_' + todayStr + '_' + computeMd5Hex_(cleanGrp).substring(0, 12);
}

function invalidatePublicOutageCache_(groupName) {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(getPublicOutageCacheKey_(groupName));
  } catch (e) {}
}

function sanitizePublicZoneServer_(rawZone) {
  if (!rawZone || typeof rawZone !== 'object') return null;
  if (rawZone.t === 'c' && Array.isArray(rawZone.c) && rawZone.c.length >= 2) {
    const la = parseFloat(rawZone.c[0]), lo = parseFloat(rawZone.c[1]), r = Math.round(Number(rawZone.r) || 0);
    if (!isNaN(la) && !isNaN(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && r >= 20 && r <= 20000) {
      return { t: 'c', c: [Number(la.toFixed(5)), Number(lo.toFixed(5))], r: r };
    }
  }
  if (rawZone.t === 'p' && Array.isArray(rawZone.p)) {
    const pts = [];
    for (let i = 0; i < rawZone.p.length && pts.length < 30; i++) {
      const pt = rawZone.p[i];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const la = parseFloat(pt[0]), lo = parseFloat(pt[1]);
      if (!isNaN(la) && !isNaN(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
        pts.push([Number(la.toFixed(5)), Number(lo.toFixed(5))]);
      }
    }
    if (pts.length >= 3) return { t: 'p', p: pts };
  }
  return null;
}

function handleGetPublicOutagesFast_(e) {
  const rawGroup = cleanGroupParam_(e && e.parameter ? e.parameter.group : '');
  const targetGrp = normalizePeaGroupNameServer_(rawGroup) || 'กฟส.บึง';
  const cache = CacheService.getScriptCache();
  const cacheKey = getPublicOutageCacheKey_(targetGrp);

  const cachedJson = cache.get(cacheKey);
  if (cachedJson) {
    return ContentService.createTextOutput(cachedJson).setMimeType(ContentService.MimeType.JSON);
  }

  // ป้องกันการส่งชื่อสาขาแปลกปลอมมาบังคับสร้างไฟล์ชีตใหม่
  const nodesMap = getGroupNodesMap_();
  const knownGroups = ['กฟส.บึง'];
  Object.keys(nodesMap || {}).forEach(function(g) {
    const ng = normalizePeaGroupNameServer_(g);
    if (ng && knownGroups.indexOf(ng) === -1) knownGroups.push(ng);
  });

  if (knownGroups.indexOf(targetGrp) === -1 && !isKnownOrValidSystemGroup_(targetGrp, nodesMap, null)) {
    return buildJsonResponse_({ status: 'ok', group: targetGrp, groups: knownGroups, plans: [], updatedAt: new Date().toISOString() });
  }

  const todayIso = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
  const stateObj = getStatePool_(targetGrp);
  const pmShard = (stateObj && stateObj.techLocations && stateObj.techLocations[PM_LOC_PREFIX + targetGrp]) || null;
  const plansMap = (pmShard && pmShard.pmPlansMap) || {};
  const publicPlans = [];

  Object.keys(plansMap).forEach(function(pid) {
    const p = plansMap[pid];
    if (!p || p.pmDeleted || p.status === 'done') return;
    if (!(p.pub === 1 || p.pub === true)) return;
    const dateStr = String(p.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr < todayIso) return;
    const cleanZone = sanitizePublicZoneServer_(p.oz);
    if (!cleanZone) return;

    // ส่งออกเฉพาะข้อมูลสำหรับแจ้งประชาชน (ตัดรหัสสวิตช์ ชื่อช่าง โน้ตภายใน และรูปหน้างานออก 100%)
    publicPlans.push({
      id: String(p.id || pid),
      date: dateStr,
      timeSlot: String(p.timeSlot || '09.00-16.00'),
      category: String(p.category || 'patrol'),
      title: String(p.title || 'แผนดับไฟปฏิบัติงานปรับปรุงระบบจำหน่าย').substring(0, 160),
      detail: String(p.pbn || p.pubNote || '').substring(0, 240),
      zone: cleanZone
    });
  });

  publicPlans.sort(function(a, b) {
    return String(a.date).localeCompare(String(b.date)) || String(a.timeSlot).localeCompare(String(b.timeSlot));
  });

  const outJson = JSON.stringify({
    status: 'ok',
    group: targetGrp,
    groups: knownGroups,
    plans: publicPlans,
    updatedAt: new Date().toISOString()
  });

  try { cache.put(cacheKey, outJson, PUBLIC_OUTAGE_CACHE_SEC_); } catch (err) {}
  return ContentService.createTextOutput(outJson).setMimeType(ContentService.MimeType.JSON);
}

// ==================== จบไฟล์ Code.gs (v6.5 Final Zero-Bug Edition) ====================