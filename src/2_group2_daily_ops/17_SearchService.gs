/**
 * VERSION: 5.5.022
 * FILE: 17_SearchService.gs
 * LMDS V5.5 — Search Service (The Bridger — Group 2)
 * ===================================================
 * PURPOSE:
 *   สะพานเชื่อม Group 2 (ตารางงานประจำวัน) → Group 1 (Master Data)
 *   รับ ShipToName → ค้นหาพิกัดที่ดีที่สุด → เขียน LatLong_Actual
 *   [REDESIGN v5.4.003] ShipToName-Only Policy:
 *     - ShipToAddress ถูกลบออกจาก logic ทั้งหมด (ไม่น่าเชื่อถือ)
 *     - LatLong_SCG ถูกลบออกจาก logic ทั้งหมด (อิงจาก ShipToAddress)
 *     - AI Reasoning ถูกลบออก (ไม่เหมาะกับ production)
 *     - ถ้าหาไม่เจอ → คืน NOT_FOUND เว้นว่าง ไม่ fallback ใดๆ
 * ===================================================
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v5.5.022 (2026-06-26) — CONSISTENCY SYNC + DEEP DIVE FIX (BUG-M01/M02/M03/H02/H03/C01 + 6 cache/config fixes)
 *     v5.5.021 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 *     v5.5.020 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES (Load Order):
 *     - 01_Config.gs          (SHEET.DAILY_JOB, DATA_IDX.*, AI_CONFIG, APP_CONST)
 *     - 02_Schema.gs          (SCHEMA[SHEET.DAILY_JOB])
 *     - 05_NormalizeService.gs (normalizePersonNameFull)
 *     - 14_Utils.gs           (isValidLatLng, parseLatLng)
 *   CALLS (Invokes):
 *     - fastLookupByShipToName()          → 21_AliasService.gs (Tier 0 Fast Track)
 *     - resolvePerson()                   → 06_PersonService.gs
 *     - getDestsByPersonId()              → 09_DestinationService.gs
 *   EXPORTS TO: 
 *     - 18_ServiceSCG.gs      (findBestGeoByPersonPlace, runLookupEnrichment)
 *   SHEETS ACCESSED:
 *     - SHEET.DAILY_JOB       (Read+Write: ShipToName→LatLong_Actual + color coding)
 *     - SHEET.M_ALIAS         (Read: Tier 0 Fast Track via fastLookupByShipToName)
 * ===================================================
 * ARCHITECTURE:
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │  17_SearchService.gs                                                   │
 *   │  ├── runLookupEnrichment()   [Entry: ดึงข้อมูลจาก DAILY_JOB, loop หาพิกัด]      │
 *   │  │   └── Chunk Processing (รอบละ 500 rows) ป้องกัน GAS Time/Memory Limit   │
 *   │  ├── lookupEnrichOneRow_()   [Logic: หาสี, status, พิกัด]                 │
 *   │  │   ├── findBestGeoByPersonPlace() [ค้นหา Master DB]                      │
 *   │  │   └── lookupSingleRow()          [UI Wrapper สำหรับเรียกทีละแถว]         │
 *   │  ├── flushLookupResults_()   [Output: batch setValues กลับไปที่ DAILY_JOB] │
 *   │  │   └── ใช้ clearContent() และ setBackgrounds เฉพาะช่วง ลดการพังของ Format│
 *   │  └── getEnrichmentLock_()    [Utility: PropertiesService Lock]         │
 *   └────────────────────────────────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 1: findBestGeoByPersonPlace — ShipToName Only
// ============================================================

/**
 * findBestGeoByPersonPlace — ค้นหาพิกัดจาก ShipToName เท่านั้น
 * [REDESIGN v5.4.003] ShipToName-Only Policy:
 *   - ShipToAddress ถูกลบออกจาก logic ทั้งหมด (ไม่น่าเชื่อถือ)
 *   - LatLong_SCG ถูกลบออกจาก logic ทั้งหมด
 *   - ถ้าหาไม่เจอ → คืน NOT_FOUND เว้นว่าง ไม่ fallback ใดๆ
 *
 * [V5.5.011] Same-Clean-Process-as-Sheet1 Policy:
 *   - ก่อนหน้านี้ใช้แค่ String(rawPerson).trim() ส่งตรงเข้า lookup
 *   - ทำให้ ShipToName จาก Sheet2 ไม่ผ่านกระบวนการทำความสะอาดเหมือน Sheet1
 *   - ผลลัพธ์คือค้นไม่เจอแม้จะเป็นร้านเดียวกัน เพราะในชื่อมี "จำกัด"/"ร้าน"/เบอร์โทร ฯลฯ
 *   - ตอนนี้ผ่าน normalizePersonNameFull ก่อน → ได้ cleanName เหมือน Sheet1
 *   - แล้วลองค้นด้วย cleanName ก่อน, หากไม่เจอค่อย fallback ด้วย rawName
 *
 * Tier 0: ShipToName → normalizePersonNameFull → M_ALIAS → masterUuid → dest → lat,lng (เร็วสุด)
 * Tier 1: ShipToName → normalizePersonNameFull → resolvePerson() → getDestsByPersonId() (usage-dominant)
 * NOT_FOUND: เว้นว่าง LatLong_Actual
 *
 * @param {string} rawPerson - ShipToName จาก ตารางงานประจำวัน
 */
function findBestGeoByPersonPlace(rawPerson) {
  // Guard: ชื่อว่างหรือสั้นเกิน → NOT_FOUND ทันที
  if (!rawPerson || String(rawPerson).trim().length < 2) {
    return buildSearchResult_(null, null, 'NOT_FOUND', 0, null,
      'ShipToName ว่างหรือสั้นเกิน');
  }

  const rawName = String(rawPerson).trim();

  // [V5.5.011] ทำความสะอาดชื่อแบบเดียวกับ Sheet1 ก่อนนำไปค้นหา
  // normalizePersonNameFull จะ:
  //   1. ดึงเบอร์โทรออก
  //   2. ดึงเลขเอกสารออก
  //   3. ดึง Delivery Notes (ฝากยาม, COD, ด่วน ฯลฯ) ออก
  //   4. ตัด Company Suffix (จำกัด, บจก., หจก. ฯลฯ) และ Chain Store (ร้าน, ร้านค้า)
  //   5. ตัดคำนำหน้า (นาย, นาง, บริษัท ฯลฯ)
  //   6. ล้างช่องว่างและอักขระพิเศษ
  // ทำให้ cleanName สามารถจับคู่กับ M_ALIAS/M_PERSON ที่บันทึกจาก Sheet1 ได้แม่นยำขึ้น
  let cleanName = rawName;
  let normResult = null;
  try {
    if (typeof normalizePersonNameFull === 'function') {
      normResult = normalizePersonNameFull(rawName);
      if (normResult && normResult.cleanName && normResult.cleanName.length >= 2) {
        cleanName = normResult.cleanName;
      }
    }
  } catch (normErr) {
    // ถ้า normalize ล้มเหลว ใช้ rawName ต่อไป
    logDebug('SearchService', 'normalizePersonNameFull ล้มเหลว ใช้ rawName: ' + normErr.message);
  }

  // ─── Tier 0: M_ALIAS Fast Track ───────────────────────────────────
  // [FIX v5.5.021 C1] ส่ง cleanName เข้าไปเลย เพื่อลดการทำ Normalization ซ้ำซ้อน
  if (typeof fastLookupByShipToName === 'function') {
    let fastResult = fastLookupByShipToName(cleanName, normResult);
    if (!fastResult && cleanName !== rawName) {
      // Fallback: ลองด้วย rawName เผื่อ M_ALIAS เก็บ variant แบบ raw ไว้
      fastResult = fastLookupByShipToName(rawName, null);
    }
    if (fastResult && fastResult.lat != null && fastResult.lng != null) {
      // [FIX v5.5.021 M1/M2] Mask rawName เพื่อป้องกัน PII Leak ใน SYS_LOG
      const reason = cleanName !== rawName
        ? `M_ALIAS Fast Track (cleaned) → "${cleanName}"`
        : `M_ALIAS Fast Track: "${cleanName}"`;
      return buildSearchResult_(
        fastResult.lat, fastResult.lng,
        'FOUND_ALIAS_FAST', fastResult.confidence, fastResult.destId,
        reason
      );
    }
  }

  // ─── Tier 1: resolvePerson → M_DESTINATION ────────────────────────
  // [FIX v5.5.012 Anti-pattern #3] ส่ง normResult เข้า resolvePerson เพื่อหลีกเลี่ยง double normalization
  //   เดิมส่ง cleanName เข้า resolvePerson ซึ่งจะ normalize ซ้ำอีกครั้ง (safe but wasteful)
  //   ตอนนี้ส่ง rawName + preNormResult ให้ resolvePerson ใช้ normResult ที่เราคำนวณแล้ว
  const personResult = resolvePerson(rawName, normResult);
  const personId     = personResult ? personResult.personId : null;

  if (personId) {
    const dests = getDestsByPersonId(personId)
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

    if (dests.length > 0) {
      const top = dests[0];
      // [FIX v5.5.021 M1/M2] Mask rawName
      const reason = cleanName !== rawName
        ? `Person match (cleaned) → "${cleanName}" → usageCount:${top.usageCount}`
        : `Person match: "${cleanName}" → usageCount:${top.usageCount}`;
      return buildSearchResult_(
        top.lat, top.lng,
        'FOUND_DOMINANT', 90, top.destId,
        reason
      );
    }
  }

  // ไม่พบ — เว้นว่าง LatLong_Actual
  const reason = cleanName !== rawName
    ? `ไม่พบข้อมูล (cleaned: "${cleanName}")`
    : `ไม่พบข้อมูล — ShipToName:"${cleanName}"`;
  return buildSearchResult_(
    null, null,
    'NOT_FOUND', 0, null,
    reason
  );
}

// [REMOVED v5.4.003] callGeminiReasoning_ — ลบแล้วตาม ShipToName-Only Policy
// AI Reasoning ไม่เหมาะกับ production — พิกัดที่ AI คาดเดาไม่น่าเชื่อถือ

/**
 * buildSearchResult_ — สร้าง Object ผลลัพธ์มาตรฐาน
 * [FIX v003] NOT_FOUND คืน lat:null, lng:null แทน 0,0
 */
function buildSearchResult_(lat, lng, status, confidence, destId, reason) {
  return {
    lat:        lat,        // null เมื่อ NOT_FOUND
    lng:        lng,        // null เมื่อ NOT_FOUND
    status:     status,
    confidence: confidence,
    destId:     destId,    // null ถ้าไม่มี Dest
    reason:     reason,
  };
}

// ============================================================
// SECTION 2: runLookupEnrichment — Batch Process (ShipToName Only)
// ============================================================

/**
 * runLookupEnrichment — วนทุกแถวใน ตารางงานประจำวัน
 * [REDESIGN v5.4.003] ShipToName-Only Policy:
 *   - อ่านเฉพาะ ShipToName เป็นหลักในการค้นหาพิกัด
 *   - ShipToAddress และ LatLong_SCG ถูกลบออกทั้งหมด
 *   - ผลลัพธ์: เจอ (เขียว) / ไม่เจอ (แดง) เท่านั้น
 *
 * [FIX v003] setBackground loop → setBackgrounds() Batch ทีเดียว
 * [FIX v003] existingLL check → parseLatLng + isValidLatLng
 * [ADD v003] Time Guard ป้องกัน Timeout
 */
function runLookupEnrichment() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const sheet     = ss.getSheetByName(SHEET.DAILY_JOB);

  if (!sheet || sheet.getLastRow() < 2) {
    logWarn('SearchService', 'ตารางงานประจำวัน ว่างอยู่');
    return;
  }

  const startTime   = new Date();
  const timeLimit   = AI_CONFIG.TIME_LIMIT_MS || (5 * 60 * 1000);
  const totalRows   = sheet.getLastRow() - 1;
  const schemaLen   = SCHEMA[SHEET.DAILY_JOB].length;
  
  // [FIX v5.5.021 H1] เพิ่ม Chunk Processing ป้องกัน Memory Spike
  const CHUNK_SIZE  = 500;
  let countFound    = 0;
  let countNotFound = 0;
  let countSkipped  = 0;
  let timedOut      = false;

  try {
    for (let startRow = 2; startRow <= sheet.getLastRow(); startRow += CHUNK_SIZE) {
      if (new Date() - startTime > timeLimit) {
        logWarn('SearchService', `runLookupEnrichment: Time Guard หยุดที่แถว ${startRow - 1}/${totalRows}`);
        timedOut = true;
        break;
      }

      const numRows = Math.min(CHUNK_SIZE, sheet.getLastRow() - startRow + 1);
      const chunkData = sheet.getRange(startRow, 1, numRows, schemaLen).getValues();
      const latActualArr = [];
      const bgColorArr   = [];

      chunkData.forEach((row, i) => {
        const r = lookupEnrichOneRow_(row);
        latActualArr.push(r.latActual);
        bgColorArr.push(r.bgColor);
        countFound    += r.found;
        countNotFound += r.notFound;
        countSkipped  += r.skipped;
      });

      // Flush ทีละ Chunk ลดการบริโภค Memory (ใช้ startRow)
      flushLookupResults_(sheet, latActualArr, bgColorArr, schemaLen, startRow, 'batch-write');
    }
  } catch (err) {
    logError('SearchService', `runLookupEnrichment error: ${err.message}`, err);
    throw err; // re-throw ให้ caller จัดการต่อ
  }

  const msg =
    `✅ จับคู่พิกัดเสร็จ\n` +
    `เจอ: ${countFound} | ไม่พบ: ${countNotFound} | ข้าม: ${countSkipped}` +
    (timedOut ? '\n⚠️ หยุดก่อนครบเพราะใกล้ Timeout — รันอีกครั้งเพื่อดำเนินการต่อ' : '');

  logInfo('SearchService', msg.replace(/\n/g, ' '));
  ss.toast(msg, APP_NAME, 8);

  // [FIX LAW-05 v5.4.003] ติดตั้ง auto-resume เมื่อ timeout เพื่อให้รันต่ออัตโนมัติ
  if (timedOut && typeof installAutoResume_ === 'function') {
    installAutoResume_('runLookupEnrichment');
  }
}

/**
 * lookupEnrichOneRow_ — processes 1 row for runLookupEnrichment
 * Extracts ShipToName, checks existing coords, calls findBestGeoByPersonPlace
 * @param {Array} row - single row from DAILY_JOB data
 * @return {{ latActual: Array, bgColor: Array, found: number, notFound: number, skipped: number }}
 */
function lookupEnrichOneRow_(row) {
  // [REDESIGN v5.4.003] อ่านเฉพาะ ShipToName — ShipToAddress/LatLong_SCG ไม่ใช้แล้ว
  const rawPerson  = String(row[DATA_IDX.SHIP_TO_NAME]  || '').trim();
  const existingLL = String(row[DATA_IDX.LATLNG_ACTUAL] || '').trim();

  // ตรวจ existingLL — ข้ามแถวที่มีพิกัดดีอยู่แล้ว
  if (existingLL) {
    const parsed = parseLatLng(existingLL);
    if (parsed && isValidLatLng(parsed.lat, parsed.lng)) {
      return { latActual: [existingLL], bgColor: [null], found: 0, notFound: 0, skipped: 1 };
    }
  }

  // ค้นหาพิกัดจาก ShipToName เท่านั้น
  const result   = findBestGeoByPersonPlace(rawPerson);

  // [FIX v5.5.021 C2] รวบ switch case ป้องกัน silent fallback
  if (['FOUND', 'FOUND_DOMINANT', 'FOUND_ALIAS_FAST'].includes(result.status) && result.lat != null && result.lng != null) {
    return {
      latActual: [`${result.lat},${result.lng}`],
      bgColor:   [APP_CONST.COLOR_FOUND],
      found: 1, notFound: 0, skipped: 0
    };
  }

  // ถ้า status ไม่รู้จัก ให้ log warning แจ้งเตือน
  if (result.status !== 'NOT_FOUND') {
    logWarn('SearchService', `Unknown status "${result.status}" for "${rawPerson}" — treated as NOT_FOUND`);
  }
  
  return { latActual: [''], bgColor: [APP_CONST.COLOR_NOT_FOUND], found: 0, notFound: 1, skipped: 0 };
}

// ============================================================
// SECTION 2b: flushLookupResults_ — [REF-007] Unified Flush Helper
// ============================================================

/**
 * flushLookupResults_ — [REF-007] เขียน latActual + backgroundColor ลงชีต
 * ทั้ง success path และ error path ใช้ helper นี้ร่วมกัน
 * ลด duplicate flush logic ที่เคยมีใน 2 ที่ (error catch + normal batch write)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - DAILY_JOB sheet
 * @param {Array[]} latActualArr - array of [['lat,lng'], [''], ...]
 * @param {Array[]} bgColorArr - array of [['#color'], [null], ...]
 * @param {number} schemaLen - total columns in schema (for bgMatrix width)
 * @param {number} startRow - row to start writing
 * @param {string} context - 'batch-write' (normal) or 'error-flush' (catch path)
 */
function flushLookupResults_(sheet, latActualArr, bgColorArr, schemaLen, startRow, context) {
  const processedCount = latActualArr.length;
  if (processedCount === 0) return;

  try {
    // Batch Write LatLong_Actual
    const latActualCol = DATA_IDX.LATLNG_ACTUAL + 1;
    sheet.getRange(startRow, latActualCol, processedCount, 1)
         .setValues(latActualArr.slice(0, processedCount));

    // [FIX v5.5.021 C3] Batch setBackgrounds เฉพาะคอลัมน์ LATLNG_ACTUAL เพื่อไม่ให้ทับสีคอลัมน์อื่น
    const targetColors = bgColorArr.slice(0, processedCount).map(row => row[0] ? [row[0]] : [null]);
    sheet.getRange(startRow, latActualCol, processedCount, 1).setBackgrounds(targetColors);

    if (context === 'error-flush') {
      logInfo('SearchService', `Flushed ${processedCount} rows before re-throw`);
    }
  } catch (flushErr) {
    const label = context === 'error-flush' ? 'Flush ล้มเหลว' : 'batch write ล้มเหลว';
    logError('SearchService', `runLookupEnrichment ${label}: ${flushErr.message}`, flushErr);
  }
}

// ============================================================
// SECTION 3: lookupSingleRow — Debug Helper (ShipToName Only)
// ============================================================

/**
 * lookupSingleRow — ค้นหาพิกัดสำหรับ 1 แถว (ทดสอบ)
 * [REDESIGN v5.4.003] ShipToName-Only: ลบ rawPlace, scgLatLng params
 */
function lookupSingleRow(rowNumber) {
  // [FIX R12] เพิ่ม try-catch — entry point ต้องมี error handling
  try {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.DAILY_JOB);
  if (!sheet || rowNumber < 2) return null;

  const rowData   = sheet.getRange(rowNumber, 1, 1,
                     SCHEMA[SHEET.DAILY_JOB].length).getValues()[0];
  const rawPerson = String(rowData[DATA_IDX.SHIP_TO_NAME] || '').trim();
  // ShipToAddress และ LatLong_SCG ถูกลบออกตาม ShipToName-Only Policy

  const result = findBestGeoByPersonPlace(rawPerson);

  logDebug('SearchService',
    `Row ${rowNumber} → Status:${result.status} ` +
    `(${result.confidence}%) lat:${result.lat} lng:${result.lng} — ` +
    `Reason: ${result.reason}`
  );

  return result;

  } catch (e) {
    logError('SearchService', 'lookupSingleRow ล้มเหลว: ' + e.message, e);
    // [FIX v5.5.021 H2] แจ้งเตือนผู้ใช้ ไม่เงียบ
    if (typeof safeUiAlert_ === 'function') {
      safeUiAlert_('❌ lookupSingleRow ล้มเหลว: ' + e.message);
    }
    return null;
  }
}
