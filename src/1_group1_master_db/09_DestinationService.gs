/**
 * VERSION: 6.0.006
 * FILE: 09_DestinationService.gs
 * LMDS V5.5 — Destination Master Service
 * ===================================================
 * PURPOSE:
 *   จัดการ Master Destination — จับคู่ Person+Place+Geo เป็นจุดหมายปลายทาง
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
 *     - 01_Config (SHEET.M_DESTINATION, DEST_IDX.*, AI_CONFIG.CACHE_TTL_SEC, APP_CONST.*)
 *     - 02_Schema (SCHEMA)
 *   CALLS (Invokes):
 *     - generateShortId() → 14_Utils
 *     - logDebug/logWarn/logError() → 03_SetupSheets
 *   EXPORTS TO:
 *     - 10_MatchEngine (resolveDestination, createDestination, updateDestinationStats, loadAllDestinations_)
 *     - 17_SearchService (getDestsByPersonId, getDestsByPersonAndPlace, getDestsByPlaceId)
 *     - 21_AliasService (destination lookups)
 *   SHEETS ACCESSED:
 *     - SHEET.M_DESTINATION (Read+Write: destination master data)
 * ===================================================
 * ARCHITECTURE:
 *   ┌─────────────────────────────────────────────────┐
 *   │           Destination Master Hub                 │
 *   ├─────────────────────────────────────────────────┤
 *   │  resolveDestination                              │
 *   │    └─► Trinity check: personId+placeId+geoId     │
 *   │  createDestination                               │
 *   │  updateDestinationStats                          │
 *   │  Query Helpers:                                  │
 *   │    ├─► getDestsByPersonId                        │
 *   │    ├─► getDestsByPlaceId                         │
 *   │    ├─► getDestsByPersonAndPlace                  │
 *   │    └─► getDominantDestByGeo                      │
 *   │  Data Loader:                                    │
 *   │    └─► loadAllDestinations_ (cached)             │
 *   └─────────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 1: resolveDestination
// ============================================================

/**
 * resolveDestination — ค้นหา Destination จาก Trinity
 * [FIX v003] && → || : ถ้าขาดตัวใดตัวหนึ่งให้ reject ทันที
 *            เดิม: !personId && !placeId && !geoId (ต้องว่างทั้ง 3)
 *            ถูก:  !personId || !placeId || !geoId (ขาดตัวเดียวก็ reject)
 */
function resolveDestination(personId, placeId, geoId) {
  // [FIX v003] Trinity ต้องครบ 3 จึงจะค้นหาได้
  if (!personId || !placeId || !geoId) {
    return { destId: null, status: 'INSUFFICIENT', isNew: false };
  }

  // Normalize กัน null/'' ปน
  // [FIX CodeQL js/trivial-conditional V5.5.035] หลัง guard clause ข้างบน ตัวแปรทั้ง 3 ตัวเป็น truthy แน่นอน
  //  จึงไม่จำเป็นต้องใช้ || '' fallback
  const pId = String(personId).trim();
  const plId = String(placeId).trim();
  const gId = String(geoId).trim();

  if (!pId || !plId || !gId) {
    return { destId: null, status: 'INSUFFICIENT', isNew: false };
  }

  const allDests = loadAllDestinations_();

  // Exact Match ด้วย Trinity ทั้ง 3
  const exactMatch = allDests.find((d) => d.personId === pId && d.placeId === plId && d.geoId === gId);
  if (exactMatch) {
    return { destId: exactMatch.destId, status: 'FOUND', isNew: false };
  }

  // Partial Match (Person + Geo) — fallback กรณียังไม่รู้ Place
  const partialMatch = allDests.find((d) => d.personId === pId && d.geoId === gId);
  if (partialMatch) {
    return { destId: partialMatch.destId, status: 'PARTIAL_MATCH', isNew: false };
  }

  return { destId: null, status: 'NOT_FOUND', isNew: false };
}

// ============================================================
// SECTION 2: CRUD
// ============================================================

/**
 * createDestination — สร้าง Destination ใหม่ (Trinity)
 * [FIX v003] deliveryDate instanceof Date check
 * [FIX v003] Number() validate lat/lng
 */
function createDestination(personId, placeId, geoId, lat, lng, deliveryDate) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_DESTINATION);
    const now = new Date();
    const newId = generateShortId('D');

    // [FIX v003] Validate lat/lng เป็น Number
    const numLat = Number(lat);
    const numLng = Number(lng);
    // [FIX v5.5.001] เก็บ '' แทน 0,0 เมื่อพิกัดไม่ถูกต้อง — 0,0 เป็นพิกัดที่ทำให้เสียใจ
    const safeLat = !isNaN(numLat) && numLat !== 0 ? numLat : '';
    const safeLng = !isNaN(numLng) && numLng !== 0 ? numLng : '';

    // [FIX v003] deliveryDate instanceof Date check แทน || now
    let safeDate = now;
    if (deliveryDate instanceof Date && !isNaN(deliveryDate.getTime())) {
      safeDate = deliveryDate;
    } else if (deliveryDate) {
      const parsed = new Date(deliveryDate);
      safeDate = !isNaN(parsed.getTime()) ? parsed : now;
    }

    const newRow = [
      newId,
      personId || '',
      placeId || '',
      geoId || '',
      safeLat,
      safeLng,
      '',
      safeDate,
      1,
      now,
      APP_CONST.STATUS_ACTIVE
    ];

    // [FIX-05 v5.4.003] ใช้ getRange+setValues แทน appendRow เพื่อความเสถียร
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, newRow.length).setValues([newRow]);
    invalidateDestCache_();
    logDebug('DestinationService', `createDestination: ${newId} P:${personId} PL:${placeId} G:${geoId}`);
    return newId;
  } catch (err) {
    // [FIX B3 v5.5.002] เพิ่ม try-catch ตาม Rule 12
    logError('DestinationService', `createDestination ล้มเหลว: ${err.message}`, err);
    return null;
  }
}

/**
 * updateDestinationStats
 * [FIX v003] โหลดเฉพาะ dest_id + ใช้ DEST_IDX + guard + const now
 * [FIX v5.4.002] เปลี่ยนจาก row-by-row setValue เป็น batch setValues (Performance)
 */
function updateDestinationStats(destId, deliveryDate) {
  if (!destId) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_DESTINATION);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const idCol = DEST_IDX.DEST_ID + 1;
    const idData = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    let targetRow = -1;

    for (let i = 0; i < idData.length; i++) {
      if (String(idData[i][0]).trim() === destId) {
        targetRow = i + 2;
        break;
      }
    }

    if (targetRow === -1) {
      logWarn('DestinationService', `updateDestinationStats: ไม่พบ destId ${destId}`);
      return;
    }

    // [FIX v5.4.002] Batch write — อ่าน 3 คอลัมน์ แก้ 3 คอลัมน์ ในครั้งเดียว
    const lastSeenCol = DEST_IDX.LAST_SEEN + 1;
    const usageCountCol = DEST_IDX.USAGE_COUNT + 1;
    const delivDateCol = DEST_IDX.DELIVERY_DATE + 1;

    const now = new Date();

    // สร้าง Array สำหรับ Batch Write (3 คอลัมน์ติดกัน: LAST_SEEN, USAGE_COUNT, DELIVERY_DATE)
    const minCol = Math.min(lastSeenCol, usageCountCol, delivDateCol);
    const maxCol = Math.max(lastSeenCol, usageCountCol, delivDateCol);
    const numCols = maxCol - minCol + 1;

    // [FIX v5.5.001] อ่านแถวปัจจุบันครั้งเดียว + ดึง usageCount จาก rowData แทน getValue() แยก
    const rowData = sheet.getRange(targetRow, minCol, 1, numCols).getValues()[0];
    const currUsageCount = Number(rowData[usageCountCol - minCol]) || 0;

    // แก้ไขค่าที่ต้องการ
    rowData[lastSeenCol - minCol] = now;
    rowData[usageCountCol - minCol] = currUsageCount + 1;

    if (deliveryDate) {
      const safeDate = deliveryDate instanceof Date ? deliveryDate : new Date(deliveryDate);
      if (!isNaN(safeDate.getTime())) {
        rowData[delivDateCol - minCol] = safeDate;
      }
    }

    // Batch Write ทีเดียว
    sheet.getRange(targetRow, minCol, 1, numCols).setValues([rowData]);

    invalidateDestCache_();
  } catch (err) {
    // [FIX LAW-13 v5.4.003] ส่ง err object เพื่อให้ stack trace เข้า SYS_LOG
    logError('DestinationService', `updateDestinationStats ล้มเหลว: ${err.message}`, err);
  }
}

// ============================================================
// SECTION 3: Query Functions
// ============================================================

/**
 * getDestsByPersonId
 * [FIX v003] !== ARCHIVED → === ACTIVE
 */
function getDestsByPersonId(personId) {
  const allDests = loadAllDestinations_();
  return allDests
    .filter((d) => d.personId === personId && d.status === APP_CONST.STATUS_ACTIVE)
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
}

function getDestsByPlaceId(placeId) {
  const allDests = loadAllDestinations_();
  return allDests
    .filter((d) => d.placeId === placeId && d.status === APP_CONST.STATUS_ACTIVE)
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
}

// [REMOVED V5.5.044] getDestsByPersonAndPlace — dead code (mark @deprecated ใน V5.5.043, ไม่มี caller ใน .gs ใด)
// [REMOVED V5.5.044] getDominantDestByGeo — dead code (mark @deprecated ใน V5.5.043, ไม่มี caller ใน .gs ใด)
//   หากมี external caller ที่ต้องการ restore → ดู git history ของ commit นี้

// ============================================================
// SECTION 4: Data Loaders
// ============================================================

function loadAllDestinations_() {
  const cacheKey = 'M_DEST_ALL';
  const cache = CacheService.getScriptCache();
  // [PERF-004] [REF-010] ใช้ centralized loadChunkedCache_ จาก 14_Utils.gs
  const cachedData = loadChunkedCache_(cache, cacheKey);
  if (cachedData) return cachedData;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.M_DESTINATION);
  if (!sheet || sheet.getLastRow() < 2) return [];

  // [FIX v5.5.001] Math.min guard: ป้องกัน Range error ถ้า sheet มีคอลัมน์น้อยกว่า SCHEMA
  const sheetCols = sheet.getLastColumn();
  const schemaCols = SCHEMA[SHEET.M_DESTINATION].length;
  const colsToRead = Math.min(sheetCols, schemaCols);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, colsToRead).getValues();

  const result = rows
    .filter((r) => r[DEST_IDX.DEST_ID])
    // [FIX v003] filter ก่อน map — กรอง ARCHIVED และ MERGED
    .filter((r) => r[DEST_IDX.STATUS] !== APP_CONST.STATUS_ARCHIVED && r[DEST_IDX.STATUS] !== APP_CONST.STATUS_MERGED)
    .map((r) => ({
      destId: String(r[DEST_IDX.DEST_ID] || ''),
      personId: String(r[DEST_IDX.PERSON_ID] || ''),
      placeId: String(r[DEST_IDX.PLACE_ID] || ''),
      geoId: String(r[DEST_IDX.GEO_ID] || ''),
      // [FIX Phase-B #12] lat/lng: '' / null / undefined → null (NOT 0)
      //   เดิม: Number(r[DEST_IDX.LAT] || 0) → Number('' || 0) → Number(0) → 0 → marker ตก (0,0) ที่อ่าวเบนิน
      //   ตอนนี้: invalid lat/lng → null → consumer จะได้รู้ว่าไม่มีพิกัด และ skip marker / show warning
      lat: _safeParseLatLng_(r[DEST_IDX.LAT]),
      lng: _safeParseLatLng_(r[DEST_IDX.LNG]),
      routeLabel: String(r[DEST_IDX.ROUTE_LABEL] || ''), // [FIX v003] เพิ่ม
      usageCount: Number(r[DEST_IDX.USAGE_COUNT] || 0),
      lastSeen: r[DEST_IDX.LAST_SEEN] || '',
      status: String(r[DEST_IDX.STATUS] || '')
    }));

  // [PERF-004] [REF-010] ใช้ centralized saveChunkedCache_ จาก 14_Utils.gs
  saveChunkedCache_(cache, cacheKey, result);
  return result;
}

/**
 * batchUpdateDestinationStats_ — [PERF-001] Batch stats update สำหรับ Destination
 * [REF-009 NOTE] Destination is a special case with extra deliveryDate + multi-count logic,
 * so it does NOT use batchUpdateEntityStats_() like Person/Place/Geo.
 * The Person/Place/Geo batch update pattern is deduplicated via batchUpdateEntityStats_ in 14_Utils.gs.
 * อ่านข้อมูลทั้ง column 1 ครั้ง แก้ใน RAM ทั้งหมด แล้วเขียนทีเดียว
 * ลดจาก N × 2 API calls เหลือ 2 API calls (getValues + setValues)
 * @param {Array} destStatsQueue - Array of {destId, deliveryDate} objects
 */
function batchUpdateDestinationStats_(destStatsQueue) {
  if (!destStatsQueue || destStatsQueue.length === 0) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_DESTINATION);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const idCol = DEST_IDX.DEST_ID + 1;
    const lastSeenCol = DEST_IDX.LAST_SEEN + 1;
    const usageCountCol = DEST_IDX.USAGE_COUNT + 1;
    const delivDateCol = DEST_IDX.DELIVERY_DATE + 1;
    const minCol = Math.min(idCol, lastSeenCol, usageCountCol, delivDateCol);
    const maxCol = Math.max(idCol, lastSeenCol, usageCountCol, delivDateCol);
    const numCols = maxCol - minCol + 1;

    const allData = sheet.getRange(2, minCol, lastRow - 1, numCols).getValues();

    // Build a map from destId to {index, deliveryDate} for efficient lookup
    const destIdMap = {};
    destStatsQueue.forEach(function (item) {
      const did = String(item.destId || '').trim();
      if (did) {
        // Keep the latest deliveryDate per destId
        if (!destIdMap[did]) {
          destIdMap[did] = { count: 0, deliveryDate: item.deliveryDate };
        }
        destIdMap[did].count++;
      }
    });

    const now = new Date();
    let updated = 0;

    for (let i = 0; i < allData.length; i++) {
      const did = String(allData[i][idCol - minCol] || '').trim();
      if (destIdMap[did]) {
        allData[i][lastSeenCol - minCol] = now;
        const currCount = Number(allData[i][usageCountCol - minCol]) || 0;
        allData[i][usageCountCol - minCol] = currCount + destIdMap[did].count;
        if (destIdMap[did].deliveryDate) {
          const safeDate =
            destIdMap[did].deliveryDate instanceof Date
              ? destIdMap[did].deliveryDate
              : new Date(destIdMap[did].deliveryDate);
          if (!isNaN(safeDate.getTime())) {
            allData[i][delivDateCol - minCol] = safeDate;
          }
        }
        updated++;
        delete destIdMap[did]; // Prevent double-update
      }
    }

    if (updated > 0) {
      sheet.getRange(2, minCol, lastRow - 1, numCols).setValues(allData);
      invalidateDestCache_();
    }
  } catch (err) {
    logError('DestinationService', 'batchUpdateDestinationStats_ ล้มเหลว: ' + err.message, err);
  }
}

/**
 * invalidateDestCache_ — [REF-011] Uses centralized invalidateChunkedCache_
 */
function invalidateDestCache_() {
  invalidateChunkedCache_('M_DEST_ALL', null);
}

/**
 * _safeParseLatLng_ — [FIX Phase-B #12] Parse lat/lng cell value safely
 *   Returns null for '', null, undefined, NaN — instead of 0 (which maps to (0,0) in Gulf of Guinea)
 *   Returns Number value for valid numeric input (0 only if explicitly passed, which is itself invalid for TH geo)
 * @param {*} rawVal - raw cell value from sheet
 * @return {number|null}
 */
function _safeParseLatLng_(rawVal) {
  if (rawVal === '' || rawVal === null || rawVal === undefined) return null;
  const num = Number(rawVal);
  if (isNaN(num)) return null;
  // 0,0 is invalid for Thai geo — treat as null (consistent with createDestination which writes '' for 0)
  if (num === 0) return null;
  return num;
}

/**
 * DEPRECATED FUNCTIONS — MOVED to 99_Legacy.gs in V5.5.034
 * ==================================================
 * The following convenience wrappers were deprecated in REF-020 and have been
 * moved to src/O_core_system/99_Legacy.gs to separate legacy code from the
 * main codebase:
 *
 *   - getDestinationsByPerson(personId)  → Use getDestsByPersonId() directly
 *   - getDestinationsByPlace(placeId)    → Use getDestsByPlaceId() directly
 *
 * Backward compatibility: callers from external scripts will still work —
 * the wrappers in 99_Legacy.gs will log a deprecation warning and forward
 * the call to the new API.
 *
 * @see 99_Legacy.gs for the deprecated implementations
 */
