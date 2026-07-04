/**
 * VERSION: 5.5.044
 * FILE: 12_ReviewService.gs
 * LMDS V5.5 — Review Queue Service
 * [FIX BUG-B2] v5.4.003: updateReviewRowStatus_() helper — 1 setValues แทน 5× setValue
 * [FIX BUG-B2] v5.4.003: applyAllPendingDecisions — Time Guard + Batch Status
 * [FIX BUG-A2] v5.4.003: applyAllPendingDecisions — เพิ่ม try-catch outer
 * [FIX v5.5.005] แก้ Syntax Error บรรทัด 259 (try block ไม่มี catch/finally)
 * [FIX v5.5.005] เพิ่ม return statement ใน applyReviewDecision() — ทำให้ Review เขียน FACT_DELIVERY ได้
 * [FIX v5.5.005] ลบ dead code resolveGeoAndDest_() — ละเมิดกฎ Architecture
 * ===================================================
 * PURPOSE:
 * จัดการคิวรีวิว Q_REVIEW — พักข้อมูลที่ต้องให้คนตัดสินใจ
 * ===================================================
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v5.5.022 (2026-06-26) — CONSISTENCY SYNC + DEEP DIVE FIX (BUG-M01/M02/M03/H02/H03/C01 + 6 cache/config fixes)
 *     v5.5.021 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 *     v5.5.020 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 * ===================================================
 * DEPENDENCIES:
 * REQUIRES (Load Order):
 * - 01_Config (SHEET.Q_REVIEW, SHEET.SOURCE, REVIEW_IDX.*, SRC_IDX.*, APP_CONST.*)
 * - 02_Schema (SCHEMA)
 * - 10_MatchEngine (resolveAndPersist_ gateway)
 * - 07_PlaceService (getEnrichedGeoData)
 * - 11_TransactionService (upsertFactDelivery)
 * - 14_Utils (generateShortId, normalizeInvoiceNo)
 * - 03_SetupSheets (logError, logInfo, logWarn, logDebug, safeUiAlert_)
 * - 10_MatchEngine (invalidateSameDayDestCache_, autoEnrichAliasesFromFactBatch_)
 *   [V5.5.007 P0 #3]
 * CALLS (Invokes):
 * - resolveAndPersist_() → 10_MatchEngine (Gateway for Group 1 CRUD)
 * - getEnrichedGeoData() → 07_PlaceService (Optional enrichment)
 * - invalidateSameDayDestCache_() → 10_MatchEngine (called from
 *   applyAllPendingDecisions to mirror persistResult_ cache invalidation) [V5.5.007 P0 #3]
 * - autoEnrichAliasesFromFactBatch_() → 10_MatchEngine (called from
 *   applyAllPendingDecisions to enrich M_ALIAS from newly-approved FACTs) [V5.5.007 P0 #3]
 * - maskReviewerEmail_() → Local security helper
 * - logError/logInfo/logWarn/logDebug() → 03_SetupSheets
 *
 * NOTE: ไม่เรียก Group 1 CRUD functions โดยตรงอีกต่อไป
 * ใช้ resolveAndPersist_() gateway แทน (REF-001)
 * EXPORTS TO:
 * - 00_App (openReviewQueue, applyAllPendingDecisions, applyReviewDecision, highlightHighPriorityReviews)
 * - 10_MatchEngine (enqueueReview)
 * SHEETS ACCESSED:
 * - SHEET.Q_REVIEW (Read+Write: review queue entries)
 * - SHEET.SOURCE (Read: restore delivery date/time)
 * ===================================================
 * ARCHITECTURE:
 * Review Queue Manager
 * ┌──────────────────────────────────────────────┐
 * │ enqueueReview                                │
 * │ └─ add pending review to Q_REVIEW            │
 * │ applyAllPendingDecisions                     │
 * │ └─ batch process all pending decisions       │
 * │    [V5.5.007 P0 #3] now mirrors persistResult_│
 * │    cache invalidation: calls invalidateSameDay│
 * │    DestCache_ + autoEnrichAliasesFromFactBatch│
 * │    _() (was missing → stale same-day dest +  │
 * │    M_ALIAS never enriched from review path)  │
 * │ applyReviewDecision                          │
 * │ ├─ CREATE_NEW → resolve + create masters     │
 * │ ├─ MERGE_TO_CANDIDATE → merge person recs    │
 * │ ├─ ESCALATE → mark as Escalated              │
 * │ └─ IGNORE → mark as Done                     │
 * │ getReviewStats                               │
 * │ └─ queue statistics (pending/done/escalated) │
 * │ highlightHighPriorityReviews                 │
 * │ └─ visual priority marking (batch colors)    │
 * └──────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 0: Module-level Constants
// ============================================================

// [PERF-001] Checkpoint key for reprocessReviewQueue Resume mechanism
const REPROCESS_REVIEW_CHECKPOINT_KEY = 'REPROCESS_REVIEW_CHECKPOINT';

// ============================================================
// SECTION 1: enqueueReview
// ============================================================

function enqueueReview(srcObj, decision, personResult, placeResult, geoResult) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet) {
      // [FIX R13-03 REVIEW15] Rule 13: ส่ง Error object เพื่อ stack trace ชี้ตำแหน่งที่เกิด
      logError('ReviewService', 'ไม่พบชีต ' + SHEET.Q_REVIEW, new Error('SHEET_NOT_FOUND'));
      return null;
    }

    // [FIX CodeQL js/unused-local-variable V5.5.035] now ไม่ถูกใช้ในฟังก์ชันนี้ — ลบทิ้ง
    const newId = generateShortId('R');
    const candPersonIds =
      personResult && personResult.personId ? JSON.stringify([personResult.personId]) : JSON.stringify([]);
    const candPlaceIds =
      placeResult && placeResult.placeId ? JSON.stringify([placeResult.placeId]) : JSON.stringify([]);

    let candGeoIds = JSON.stringify([]);
    if (geoResult) {
      if (geoResult.candidateGeoIds && geoResult.candidateGeoIds.length > 0) {
        candGeoIds = JSON.stringify(geoResult.candidateGeoIds);
      } else if (geoResult.geoId) {
        candGeoIds = JSON.stringify([geoResult.geoId]);
      }
    }

    const newRow = new Array(SCHEMA[SHEET.Q_REVIEW].length).fill('');
    newRow[REVIEW_IDX.REVIEW_ID] = newId;
    newRow[REVIEW_IDX.ISSUE_TYPE] = decision ? decision.reason : 'UNKNOWN';
    newRow[REVIEW_IDX.PRIORITY] = decision ? decision.priority || 2 : 2;
    newRow[REVIEW_IDX.SOURCE_REC_ID] = srcObj.sourceId || '';
    newRow[REVIEW_IDX.SOURCE_ROW] = srcObj.sourceRow || 0;
    newRow[REVIEW_IDX.INVOICE_NO] = srcObj.invoiceNo || '';
    newRow[REVIEW_IDX.RAW_PERSON] = srcObj.rawPersonName || '';

    let rawPlace = srcObj.rawPlaceName || '';
    const rawAddr = srcObj.rawAddress || '';

    // [FIX v5.5.001] ทำให้ getEnrichedGeoData() เป็น optional
    // ถ้าเรียกไม่ได้ (เช่น Maps API error) ก็ข้ามไป ไม่ใช่ข้อมูลจำเป็นสำหรับ review row
    try {
      const enrich = getEnrichedGeoData(rawAddr, rawPlace);
      if (enrich && enrich.fullAddress) {
        const hasGeoInfo = /จังหวัด|อำเภอ|เขต|ตำบล|แขวง/.test(rawPlace);
        if (rawPlace.length < 10 || !hasGeoInfo) {
          rawPlace = rawPlace ? rawPlace + ' (' + enrich.fullAddress + ')' : enrich.fullAddress;
        }
      }
    } catch (enrichErr) {
      logDebug('ReviewService', 'enqueueReview: getEnrichedGeoData ข้าม — ' + enrichErr.message);
    }

    newRow[REVIEW_IDX.RAW_PLACE] = rawPlace || rawAddr;
    newRow[REVIEW_IDX.RAW_SYS_ADDR] = rawAddr;
    newRow[REVIEW_IDX.RAW_LAT] = srcObj.rawLat || 0;
    newRow[REVIEW_IDX.RAW_LNG] = srcObj.rawLng || 0;
    newRow[REVIEW_IDX.CAND_PERSONS] = candPersonIds;
    newRow[REVIEW_IDX.CAND_PLACES] = candPlaceIds;
    newRow[REVIEW_IDX.CAND_GEOS] = candGeoIds;
    newRow[REVIEW_IDX.CAND_DESTS] = JSON.stringify([]);
    newRow[REVIEW_IDX.MATCH_SCORE] = decision ? decision.confidence || 0 : 0;
    // [V5.5.011] สร้าง recommended_action ที่มี ID จริง เพื่อให้ผู้ review คลิกแล้วนำทางได้
    //   ก่อนหน้านี้ใส่ค่าคงที่ 'MANUAL_REVIEW' ทำให้ Smart Navigation ไม่สามารถ parse ID และนำทางได้
    //   ตอนนี้ระบบจะแนะนำ action ที่เหมาะสมตามข้อมูลที่มี:
    //     - มี candidate Person → "MERGE_TO_CANDIDATE:PS-XXXX" (เร็วสุด คลิกได้เลย)
    //     - มี candidate Place  → "MERGE_TO_CANDIDATE:PL-XXXX"
    //     - ไม่มี candidate     → "CREATE_NEW" (ให้ reviewer ตัดสินใจ)
    newRow[REVIEW_IDX.RECOMMEND] = buildRecommendedAction_(personResult, placeResult, geoResult, decision);
    newRow[REVIEW_IDX.STATUS] = 'Pending';
    newRow[REVIEW_IDX.REVIEWER] = '';
    newRow[REVIEW_IDX.REVIEWED_AT] = '';
    newRow[REVIEW_IDX.DECISION] = '';
    newRow[REVIEW_IDX.NOTE] = decision ? decision.reason || '' : '';

    return { reviewId: newId, rowData: newRow };
  } catch (e) {
    // [FIX R13-04 REVIEW15] Rule 13: ส่ง e เพื่อรักษา stack trace ของ error จริง
    logError('ReviewService', 'enqueueReview ล้มเหลว: ' + e.message, e);
    return null;
  }
}

// ============================================================
// SECTION 1.5: buildRecommendedAction_ [V5.5.011]
// สร้างค่า recommended_action ที่มี ID จริง เพื่อให้ Smart Navigation
// สามารถ parse ID และนำทางไปยัง Master/FACT sheet ได้เมื่อผู้ review คลิก
// ============================================================

/**
 * buildRecommendedAction_ — สร้างคำแนะนำ action พร้อม ID สำหรับคอลัมน์ recommended_action
 *
 * รูปแบบผลลัพธ์ที่เป็นไปได้:
 *   - "MERGE_TO_CANDIDATE:PS-XXXX"     มี candidate Person → แนะนำ merge
 *   - "MERGE_TO_CANDIDATE:PL-XXXX"     มี candidate Place (ไม่มี Person) → แนะนำ merge
 *   - "CREATE_NEW"                     ไม่มี candidate → แนะนำสร้างใหม่
 *   - "MANUAL_REVIEW"                  กรณีพิเศษที่ไม่สามารถตัดสินใจอัตโนมัติได้
 *
 * Smart Navigation ใน 00_App.gs จะ parse ID (PS-XXXX หรือ PL-XXXX)
 * และนำทางไปยัง M_PERSON/M_PLACE + FACT_DELIVERY เพื่อให้ reviewer ยืนยัน
 *
 * @param {Object|null} personResult - { personId, status, confidence } จาก resolvePerson
 * @param {Object|null} placeResult  - { placeId, status, confidence } จาก resolvePlace
 * @param {Object|null} geoResult    - { geoId, candidateGeoIds } จาก GeoService
 * @param {Object|null} decision     - { reason, priority, confidence } จาก MatchEngine
 * @return {string} recommended action string พร้อม ID สำหรับ navigation
 */
function buildRecommendedAction_(personResult, placeResult, geoResult, decision) {
  try {
    // ดึง ID จาก candidate results
    const personId = personResult && personResult.personId ? String(personResult.personId).trim() : '';
    const placeId = placeResult && placeResult.placeId ? String(placeResult.placeId).trim() : '';

    // กรณี 1: มี candidate Person → แนะนำ MERGE_TO_CANDIDATE พร้อม Person ID
    if (personId) {
      return 'MERGE_TO_CANDIDATE:' + personId;
    }

    // กรณี 2: มี candidate Place (แต่ไม่มี Person) → แนะนำ MERGE ด้วย Place ID
    if (placeId) {
      return 'MERGE_TO_CANDIDATE:' + placeId;
    }

    // กรณี 3: มี Geo candidate แต่ไม่มี Person/Place → CREATE_NEW
    // (มีพิกัด GPS ใกล้เคียง แต่เป็นร้านใหม่)
    // [FIX Static Audit Issue 2] ใช้ geoId ตรงๆ ไม่แปะ 'GP-' prefix ที่ไม่ตรง generateShortId('G')
    if (geoResult && geoResult.geoId) {
      return 'CREATE_NEW:' + String(geoResult.geoId).trim();
    }

    // กรณี 4: ไม่มี candidate ใดเลย → CREATE_NEW ล้วน
    return 'CREATE_NEW';
  } catch (e) {
    // Fallback: ใช้ค่าเดิมเพื่อไม่ให้ break review queue
    logDebug('ReviewService', 'buildRecommendedAction_ fallback: ' + e.message);
    return 'MANUAL_REVIEW';
  }
}

// ============================================================
// SECTION 2: applyAllPendingDecisions
// [FIX BUG-B2] Time Guard (ป้องกัน Timeout กับ Queue ใหญ่)
// [FIX BUG-A2] try-catch outer
// [FIX v5.5.005] แก้ Syntax Error — ลบ try block ที่ไม่มี catch/finally
// ============================================================

function applyAllPendingDecisions() {
  // [PERF-008] Idiomatic LockService pattern (เหมือน fetchDataFromSCGJWD)
  //   เดิมใช้ try-catch + hasLock แยก 2 step + ข้อความ error ซ้ำซ้อน 2 อัน
  //   ตอนนี้ใช้ if (!lock.tryLock(...)) แบบ idiomatic — ลด 13 บรรทัด → 5 บรรทัด + 1 ข้อความชัดเจน
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS)) {
    safeUiAlert_('⚠️ ระบบกำลังประมวลผล Review อยู่ กรุณารอสักครู่แล้วลองใหม่');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet || sheet.getLastRow() < 2) return;

    // [FIX BUG-B2] Time Guard
    const startTime = new Date();
    const timeLimit = AI_CONFIG.TIME_LIMIT_MS || 5 * 60 * 1000;

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, SCHEMA[SHEET.Q_REVIEW].length).getValues();

    let processed = 0;
    let timedOut = false;

    // [PERF-006] Batch status updates for IGNORE/ESCALATE (no side effects)
    const pendingStatusUpdates = [];
    const pendingFactRows = []; // [PERF-002] สะสม FACT_DELIVERY rows
    const batchNow = new Date();
    // [FIX CodeQL js/useless-assignment-to-local V5.5.035] ไม่กำหนดค่าเริ่มต้น — try/catch จะกำหนดให้แน่
    let reviewer;
    try {
      // [SEC-007] Mask reviewer email สำหรับ Audit Trail
      const rawEmail = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'Admin';
      reviewer = maskReviewerEmail_(rawEmail);
    } catch (e) {
      reviewer = 'Admin (Auto)';
    }

    for (let i = 0; i < data.length; i++) {
      // [FIX BUG-B2] Time Guard ทุก 20 แถว
      if (i % 20 === 0 && i > 0 && new Date() - startTime > timeLimit) {
        logWarn('ReviewService', 'applyAllPendingDecisions: Time Guard หยุดที่แถว ' + i + '/' + data.length);
        timedOut = true;
        break;
      }

      const rowResult = reviewProcessOneRow_(data[i], i + 2, reviewer, batchNow);
      if (rowResult.statusUpdate) pendingStatusUpdates.push(rowResult.statusUpdate);
      if (rowResult.factRow) pendingFactRows.push(rowResult.factRow);
      processed += rowResult.processed;
    }

    // [PERF-006] Flush batch status updates
    if (pendingStatusUpdates.length > 0) {
      batchUpdateReviewStatus_(sheet, pendingStatusUpdates);
    }

    // [PERF-002] Flush batch FACT_DELIVERY writes — เขียนทั้งหมดครั้งเดียวหลังลูป
    if (pendingFactRows.length > 0) {
      const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
      if (factSheet) {
        // [FIX BUG-PM-004 V5.5.041] เพิ่ม Math.min guard สำหรับ INSERT path
        //   mirror BUG-M03 fix ใน 11_TransactionService.upsertFactDelivery (UPDATE path)
        //   สาเหตุ: pendingFactRows[0].length = SCHEMA.length (34) แต่ถ้าชีตจริงมีคอลัมน์
        //   น้อยกว่า (เช่น pre-V5.5.014 ที่ยังไม่มี DRIVER_VERIFIED cols) getRange จะ throw
        //   "The coordinates or dimensions of the range are invalid"
        //   แนวทาง: ใช้คอลัมน์ที่น้อยกว่า + trim แต่ละ row ให้ตรง
        const factSchemaLen = SCHEMA[SHEET.FACT_DELIVERY].length;
        const factSheetCols = Math.min(factSchemaLen, factSheet.getLastColumn());
        const rowsToWrite =
          factSheetCols === factSchemaLen
            ? pendingFactRows
            : pendingFactRows.map(function (row) {
                return row.slice(0, factSheetCols);
              });
        factSheet.getRange(factSheet.getLastRow() + 1, 1, rowsToWrite.length, factSheetCols).setValues(rowsToWrite);
        if (typeof invalidateFactInvoiceCache_ === 'function') invalidateFactInvoiceCache_();
        // [REMOVED V5.5.044] invalidateSameDayDestCache_ — ลบ dead code (ดู comment ใน 10_MatchEngine SECTION 5)
        // [FIX v5.5.007 P0 #3] alias enrichment สำหรับ Review-approved FACT rows
        try {
          if (typeof autoEnrichAliasesFromFactBatch_ === 'function') {
            autoEnrichAliasesFromFactBatch_(pendingFactRows);
          }
        } catch (enrichErr) {
          logError(
            'ReviewService',
            'autoEnrichAliasesFromFactBatch_ ล้มเหลว (ไม่บล็อกการทำงานหลัก): ' + enrichErr.message,
            enrichErr
          );
        }
      }
    }

    logInfo(
      'ReviewService',
      'applyAllPendingDecisions: ประมวลผล ' +
        processed +
        ' รายการ' +
        ' (batch status: ' +
        pendingStatusUpdates.length +
        ')' +
        (timedOut ? ' (หยุดก่อนครบ — Time Guard)' : '')
    );

    if (timedOut) {
      safeUiAlert_('⚠️ ประมวลผลไป ' + processed + ' รายการ แต่หยุดกลางคันเพราะใกล้ Timeout\nกรุณารันอีกครั้ง');
    }

    return processed;
  } catch (err) {
    logError('ReviewService', 'applyAllPendingDecisions: ' + err.message, err);
    safeUiAlert_('❌ เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    // [FIX CRIT-006] ปล่อย Lock เสมอ แม้เกิด error
    lock.releaseLock();
    // [PERF-012] Flush log buffer ก่อน execution จบ — ป้องกัน log entries สูญหาย
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}

/**
 * reviewProcessOneRow_ — processes 1 review row for applyAllPendingDecisions
 * Checks status/decision, handles IGNORE/ESCALATE batch paths and CREATE_NEW/MERGE side effects
 * @param {Array} rowData - single row from Q_REVIEW data
 * @param {number} rowIndex - 1-based row number in sheet (i + 2)
 * @param {string} reviewer - masked reviewer email
 * @param {Date} batchNow - timestamp for batch operations
 * @return {{ statusUpdate: Object|null, factRow: Array|null, processed: number, error: Error|null }}
 */
function reviewProcessOneRow_(rowData, rowIndex, reviewer, batchNow) {
  const status = String(rowData[REVIEW_IDX.STATUS] || '').trim();
  const decision = String(rowData[REVIEW_IDX.DECISION] || '').trim();
  const reviewId = String(rowData[REVIEW_IDX.REVIEW_ID] || '').trim();

  if (status === 'Done' || !decision) {
    return { statusUpdate: null, factRow: null, processed: 0, error: null };
  }

  try {
    // [PERF-006] IGNORE/ESCALATE don't have side effects → batch update
    if (decision === 'IGNORE') {
      return {
        statusUpdate: {
          targetRow: rowIndex,
          status: 'Done',
          reviewer: reviewer,
          now: batchNow,
          decisionVal: decision,
          note: ''
        },
        factRow: null,
        processed: 1,
        error: null
      };
    } else if (decision === 'ESCALATE') {
      return {
        statusUpdate: {
          targetRow: rowIndex,
          status: 'Escalated',
          reviewer: reviewer,
          now: batchNow,
          decisionVal: decision,
          note: ''
        },
        factRow: null,
        processed: 1,
        error: null
      };
    } else {
      // CREATE_NEW / MERGE_TO_CANDIDATE — have side effects, call normally
      // [PERF-002] เก็บ factData ที่ส่งคืนมาเพื่อเขียน batch ทีเดียวหลังลูป
      const reviewResult = applyReviewDecision(reviewId, decision, rowData, rowIndex);
      const factRow = reviewResult && reviewResult.factRowData ? reviewResult.factRowData : null;
      return {
        statusUpdate: null,
        factRow: factRow,
        processed: 1,
        error: null
      };
    }
  } catch (err) {
    logError('ReviewService', 'applyAllPendingDecisions row ' + reviewId + ': ' + err.message, err);
    return { statusUpdate: null, factRow: null, processed: 0, error: err };
  }
}

/**
 * batchUpdateReviewStatus_ — [PERF-006] Batch update status columns for multiple rows
 * Instead of updateReviewRowStatus_ per row (2N API calls),
 * read range once → modify in RAM → write once (2 API calls total)
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array} updates - [{ targetRow, status, reviewer, now, decisionVal, note }]
 */
function batchUpdateReviewStatus_(sheet, updates) {
  if (!updates || updates.length === 0) return;

  const minCol =
    Math.min(REVIEW_IDX.STATUS, REVIEW_IDX.REVIEWER, REVIEW_IDX.REVIEWED_AT, REVIEW_IDX.DECISION, REVIEW_IDX.NOTE) + 1;

  const maxCol =
    Math.max(REVIEW_IDX.STATUS, REVIEW_IDX.REVIEWER, REVIEW_IDX.REVIEWED_AT, REVIEW_IDX.DECISION, REVIEW_IDX.NOTE) + 1;

  const numCols = maxCol - minCol + 1;
  const minRow = Math.min(...updates.map((u) => u.targetRow));
  const maxRow = Math.max(...updates.map((u) => u.targetRow));
  const rowCount = maxRow - minRow + 1;

  const range = sheet.getRange(minRow, minCol, rowCount, numCols);
  const allVals = range.getValues();

  updates.forEach(function (u) {
    const rowIdx = u.targetRow - minRow;
    if (rowIdx < 0 || rowIdx >= rowCount) return;
    allVals[rowIdx][REVIEW_IDX.STATUS - (minCol - 1)] = u.status;
    allVals[rowIdx][REVIEW_IDX.REVIEWER - (minCol - 1)] = u.reviewer;
    allVals[rowIdx][REVIEW_IDX.REVIEWED_AT - (minCol - 1)] = u.now;
    allVals[rowIdx][REVIEW_IDX.DECISION - (minCol - 1)] = u.decisionVal;
    allVals[rowIdx][REVIEW_IDX.NOTE - (minCol - 1)] = u.note || '';
  });

  range.setValues(allVals);
}

// ============================================================
// SECTION 3: applyReviewDecision
// [FIX BUG-B2] ใช้ updateReviewRowStatus_() แทน 5× setValue
// [REF-004] Refactored to Decision Router (~30 lines) + helper functions
// [REF-013] buildSrcObjFromReview_ extracted for srcObj construction
// [FIX v5.5.005] เพิ่ม return statement — ทำให้ Review เขียน FACT_DELIVERY ได้
// ============================================================

/**
 * applyReviewDecision — [REF-004] Decision Router
 * Delegates to step-specific helpers for each decision type.
 * Preserves all existing behavior.
 * [FIX v5.5.005] เพิ่ม return statement เพื่อส่ง factRowData กลับไป caller
 */
function applyReviewDecision(reviewId, decisionVal, rowData, optTargetRow) {
  // [FIX B1 v5.5.002] เพิ่ม try-catch outer — menu entry point ต้องมี error handling
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet) return null;

    const now = new Date();
    // [FIX CodeQL js/useless-assignment-to-local V5.5.035] ไม่กำหนดค่าเริ่มต้น — try/catch จะกำหนดให้แน่
    let reviewer;
    try {
      const rawEmail = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'Admin';
      reviewer = maskReviewerEmail_(rawEmail);
    } catch (e) {
      reviewer = 'Admin (Auto)';
    }

    // [FIX B2] ใช้ optTargetRow จาก caller ถ้ามี → ไม่ต้องอ่าน sheet ซ้ำ
    let targetRow = optTargetRow || -1;
    let rowArr = rowData;

    if (targetRow === -1 || !rowArr) {
      const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, SCHEMA[SHEET.Q_REVIEW].length).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][REVIEW_IDX.REVIEW_ID]).trim() === reviewId) {
          targetRow = i + 2;
          if (!rowArr) rowArr = data[i];
          break;
        }
      }
    }

    if (targetRow === -1 || !rowArr) {
      logWarn('ReviewService', 'applyReviewDecision: ไม่พบ reviewId ' + reviewId);
      return null;
    }

    // [REF-004] Decision Router — delegates to helpers
    // [FIX v5.5.005] เก็บ result จาก helper เพื่อ return กลับไป caller
    let result = null;

    switch (decisionVal) {
      case 'CREATE_NEW':
        result = executeReviewCreateNew_(ss, sheet, targetRow, rowArr, reviewer, now, decisionVal);
        break;
      case 'MERGE_TO_CANDIDATE':
        result = executeMergeDecision_(ss, sheet, targetRow, rowArr, reviewer, now, decisionVal);
        break;
      case 'ESCALATE':
        updateReviewRowStatus_(sheet, targetRow, 'Escalated', reviewer, now, decisionVal, '');
        break;
      case 'IGNORE':
        updateReviewRowStatus_(sheet, targetRow, 'Done', reviewer, now, decisionVal, '');
        break;
      default:
        logWarn('ReviewService', 'applyReviewDecision: Unknown decision ' + decisionVal);
        break;
    }

    logInfo('ReviewService', 'applyReviewDecision: ' + reviewId + ' → ' + decisionVal + ' โดย ' + reviewer);

    // [FIX v5.5.005] return result เพื่อให้ caller ได้ factRowData
    return result;
  } catch (e) {
    logError('ReviewService', 'applyReviewDecision ล้มเหลว: ' + e.message, e);
    safeUiAlert_('เกิดข้อผิดพลาดในการประมวลผล Review: ' + e.message);
    return null;
  }
}

// ============================================================
// SECTION 3a: Review Helper Functions [REF-004 + REF-013]
// ============================================================

/**
 * parseCandidatesFromReview_ — [REF-004] Parse candidate JSON from review row
 * Safely parses CAND_PERSONS and CAND_PLACES JSON strings
 * @param {Array} rowData - Review row data array
 * @return {{ candPersonIds: Array, candPlaceIds: Array }}
 */
function parseCandidatesFromReview_(rowData) {
  const candPersonStr = String(rowData[REVIEW_IDX.CAND_PERSONS] || '[]').trim();
  const candPlaceStr = String(rowData[REVIEW_IDX.CAND_PLACES] || '[]').trim();

  let candPersonIds = [];
  let candPlaceIds = [];

  // [FIX BUG-H03 V5.5.022] เพิ่ม logWarn ใน catch — ละเมิด Rule 12 (No Silent Fail)
  try {
    candPersonIds = JSON.parse(candPersonStr);
  } catch (e) {
    logWarn(
      'ReviewService',
      'parseCandidatesFromReview_: candPersonIds JSON.parse ล้มเหลว — ' + candPersonStr.substring(0, 100)
    );
  }
  try {
    candPlaceIds = JSON.parse(candPlaceStr);
  } catch (e) {
    logWarn(
      'ReviewService',
      'parseCandidatesFromReview_: candPlaceIds JSON.parse ล้มเหลว — ' + candPlaceStr.substring(0, 100)
    );
  }

  return { candPersonIds: candPersonIds, candPlaceIds: candPlaceIds };
}

/**
 * buildSrcObjFromReview_ — [REF-004 + REF-013] Construct srcObj from review row data
 * Reads delivery date/time from SOURCE sheet if available.
 * @param {Spreadsheet} ss - Active spreadsheet
 * @param {Array} rowData - Review row data array
 * @return {Object} srcObj literal for upsertFactDelivery
 */
function buildSrcObjFromReview_(ss, rowData) {
  const rawPerson = String(rowData[REVIEW_IDX.RAW_PERSON] || '').trim();
  const rawPlace = String(rowData[REVIEW_IDX.RAW_PLACE] || '').trim();
  const rawAddr = String(rowData[REVIEW_IDX.RAW_SYS_ADDR] || '').trim();
  const rawLat = Number(rowData[REVIEW_IDX.RAW_LAT] || 0);
  const rawLng = Number(rowData[REVIEW_IDX.RAW_LNG] || 0);
  const sourceRowIdx = Number(rowData[REVIEW_IDX.SOURCE_ROW] || 0);

  let deliveryDate = '',
    deliveryTime = '';
  let driverVerifiedName = '',
    driverVerifiedAddr = ''; // [FIX CRIT-002]

  if (sourceRowIdx > 1) {
    const srcSheet = ss.getSheetByName(SHEET.SOURCE);
    if (srcSheet) {
      const srcData = srcSheet.getRange(sourceRowIdx, 1, 1, srcSheet.getLastColumn()).getValues()[0];
      if (srcData[SRC_IDX.DELIVERY_DATE]) {
        try {
          deliveryDate = new Date(srcData[SRC_IDX.DELIVERY_DATE]).toISOString();
        } catch (e) {
          deliveryDate = String(srcData[SRC_IDX.DELIVERY_DATE]);
        }
      }
      deliveryTime = srcData[SRC_IDX.DELIVERY_TIME];
      // [FIX CRIT-002] อ่าน DRIVER_VERIFIED จาก Source sheet
      driverVerifiedName = String(srcData[SRC_IDX.DRIVER_VERIFIED_NAME] || '').trim();
      driverVerifiedAddr = String(srcData[SRC_IDX.DRIVER_VERIFIED_ADDR] || '').trim();
    }
  }

  return {
    invoiceNo: normalizeInvoiceNo(rowData[REVIEW_IDX.INVOICE_NO]),
    sourceRow: sourceRowIdx,
    sourceId: String(rowData[REVIEW_IDX.SOURCE_REC_ID] || '').trim(),
    rawPersonName: rawPerson,
    rawPlaceName: rawPlace,
    rawAddress: rawAddr,
    rawLat: rawLat,
    rawLng: rawLng,
    hasGeo: !isNaN(rawLat) && !isNaN(rawLng) && rawLat !== 0 && rawLng !== 0,
    province: '',
    warehouse: '',
    driverName: '',
    truckLicense: '',
    soldToCode: '',
    soldToName: '',
    carrierCode: '',
    carrierName: '',
    shipmentNo: '',
    deliveryDate: deliveryDate,
    deliveryTime: deliveryTime,
    sourceSheet: SHEET.Q_REVIEW,
    // [FIX CRIT-002] ส่ง DRIVER_VERIFIED ไปยัง upsertFactDelivery
    driverVerifiedName: driverVerifiedName,
    driverVerifiedAddr: driverVerifiedAddr
  };
}

/**
 * executeMergeDecision_ — [REF-004] Handle MERGE_TO_CANDIDATE decision
 * [REF-001] Now delegates to resolveAndPersist_() instead of calling Group 1 CRUD directly
 * Extracted from applyReviewDecision MERGE_TO_CANDIDATE case.
 * @param {Spreadsheet} ss
 * @param {Sheet} sheet - Q_REVIEW sheet
 * @param {number} targetRow - 1-based row number
 * @param {Array} rowArr - row data array
 * @param {string} reviewer
 * @param {Date} now
 * @param {string} decisionVal
 */
function executeMergeDecision_(ss, sheet, targetRow, rowArr, reviewer, now, decisionVal) {
  // [REF-004] Parse candidates via helper
  const candidates = parseCandidatesFromReview_(rowArr);

  // [REF-004 + REF-013] Build srcObj via helper
  const srcObj = buildSrcObjFromReview_(ss, rowArr);

  // [REF-001] Delegate to resolveAndPersist_ gateway — no direct Group 1 CRUD calls
  const result = resolveAndPersist_(srcObj, 'MERGE_TO_CANDIDATE', candidates);

  // [PERF-002] สะสม factData ส่งคืนแทนการเขียนทันที — ลดจาก N API calls เหลือ 1 batch write
  if (result && result.factRowData) {
    return { factRowData: result.factRowData };
  }

  // [FIX BUG-B2] 1 setValues
  updateReviewRowStatus_(sheet, targetRow, 'Done', reviewer, now, decisionVal, '');
  return null;
}

// ============================================================
// SECTION 3.5: updateReviewRowStatus_ [NEW BUG-B2 Helper]
// รวม 5× getRange().setValue() → 1× getRange().setValues()
// ลด 5 API calls → 1 API call ต่อ decision
// ============================================================

/**
 * updateReviewRowStatus_ — Batch update status columns ใน Q_REVIEW
 * [NEW v5.4.003] แทนที่ 5× setValue ที่กระจายใน applyReviewDecision()
 */
function updateReviewRowStatus_(sheet, targetRow, status, reviewer, now, decisionVal, note) {
  // อ่าน block คอลัมน์ที่ต้องอัปเดต (STATUS ถึง NOTE เป็น consecutive range)
  const minCol =
    Math.min(REVIEW_IDX.STATUS, REVIEW_IDX.REVIEWER, REVIEW_IDX.REVIEWED_AT, REVIEW_IDX.DECISION, REVIEW_IDX.NOTE) + 1; // 1-based

  const maxCol =
    Math.max(REVIEW_IDX.STATUS, REVIEW_IDX.REVIEWER, REVIEW_IDX.REVIEWED_AT, REVIEW_IDX.DECISION, REVIEW_IDX.NOTE) + 1; // 1-based

  const numCols = maxCol - minCol + 1;
  const range = sheet.getRange(targetRow, minCol, 1, numCols);
  const vals = range.getValues()[0]; // อ่าน 1 ครั้ง

  // แก้ค่าใน RAM (0-based relative offset)
  vals[REVIEW_IDX.STATUS - (minCol - 1)] = status;
  vals[REVIEW_IDX.REVIEWER - (minCol - 1)] = reviewer;
  vals[REVIEW_IDX.REVIEWED_AT - (minCol - 1)] = now;
  vals[REVIEW_IDX.DECISION - (minCol - 1)] = decisionVal;
  vals[REVIEW_IDX.NOTE - (minCol - 1)] = note || '';

  range.setValues([vals]); // ✅ 1 write API call
}

// ============================================================
// SECTION 3.6: executeReviewCreateNew_ [RF-02 Extracted from applyReviewDecision]
// แยก CREATE_NEW case ออกจาก applyReviewDecision เพื่อลด cognitive load
// [REF-004 + REF-013] Uses buildSrcObjFromReview_ for srcObj construction
// Logic เดิมทั้งหมด ไม่เปลี่ยน behavior
// ============================================================

/**
 * executeReviewCreateNew_ — ดำเนินการ CREATE_NEW decision
 * [RF-02] แยกจาก applyReviewDecision CREATE_NEW case (~80 บรรทัด)
 * [REF-013] Uses buildSrcObjFromReview_ for srcObj construction
 * [REF-001] Now delegates to resolveAndPersist_() instead of calling Group 1 CRUD directly
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Q_REVIEW sheet
 * @param {number} targetRow - 1-based row number
 * @param {Array} rowArr - row data array
 * @param {string} reviewer - reviewer name
 * @param {Date} now - current timestamp
 * @param {string} decisionVal - decision value ('CREATE_NEW')
 */
function executeReviewCreateNew_(ss, sheet, targetRow, rowArr, reviewer, now, decisionVal) {
  // [REF-013] Build srcObj via shared helper instead of inline construction
  const srcObj = buildSrcObjFromReview_(ss, rowArr);

  // [REF-001] Delegate to resolveAndPersist_ gateway — no direct Group 1 CRUD calls
  const result = resolveAndPersist_(srcObj, 'CREATE_NEW', null);

  // [PERF-002] สะสม factData ส่งคืนแทนการเขียนทันที — ลดจาก N API calls เหลือ 1 batch write
  // caller (applyAllPendingDecisions) จะเขียน batch หลังลูปจบ
  if (result && result.factRowData) {
    return { factRowData: result.factRowData };
  }

  updateReviewRowStatus_(sheet, targetRow, 'Done', reviewer, now, decisionVal, 'Resolved (Created New)');
  return null;
}

// ============================================================
// SECTION 4: Stats & Report (ไม่เปลี่ยน)
// ============================================================

function getReviewStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
  const stats = { pending: 0, done: 0, escalated: 0, total: 0 };

  if (!sheet || sheet.getLastRow() < 2) return stats;

  const statusCol = REVIEW_IDX.STATUS + 1;
  const totalRows = sheet.getLastRow() - 1;
  const statusData = sheet.getRange(2, statusCol, totalRows, 1).getValues();

  statusData.forEach((r) => {
    const s = String(r[0] || '').trim();
    stats.total++;
    if (s === 'Done') stats.done++;
    else if (s === 'Escalated') stats.escalated++;
    else stats.pending++;
  });

  return stats;
}

/**
 * highlightHighPriorityReviews — ทาสี Q_REVIEW ตาม priority/status
 * [PERF-006] รองรับ single-row update สำหรับ onEdit (ลด 44,000 → 22 cell ops ต่อคลิก)
 *   - onEdit caller ส่ง optTargetRow → ทาสีเฉพาะแถวนั้น (1 read + 1 write, 22 cells)
 *   - bulk ops caller (reprocessReviewQueue, applyAllPendingDecisions) ไม่ส่ง → full refresh
 *
 * @param {number} [optTargetRow] - 1-based row number (สำหรับ onEdit single-row update)
 *                                   ถ้าไม่ระบุ → full-sheet refresh (สำหรับ bulk ops)
 */
function highlightHighPriorityReviews(optTargetRow) {
  // [FIX B2 v5.5.002] เพิ่ม try-catch — menu entry point ต้องมี error handling
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet || sheet.getLastRow() < 2) return;

    const totalCols = SCHEMA[SHEET.Q_REVIEW].length;

    // ─── [PERF-006] Single-row mode สำหรับ onEdit ───
    //   เดิม: ทุก onEdit ทำ full-sheet refresh (read + write ~22,000 cells)
    //   ใหม่: ถ้าส่ง optTargetRow → ทำเฉพาะ row นั้น (read + write ~22 cells)
    //   ลดจาก 44,000 cell ops → 22 cell ops ต่อ onEdit click (ลด ~95%)
    if (optTargetRow && optTargetRow >= 2) {
      const rowData = sheet.getRange(optTargetRow, 1, 1, totalCols).getValues()[0];
      const priority = Number(rowData[REVIEW_IDX.PRIORITY] || 0);
      const status = String(rowData[REVIEW_IDX.STATUS] || '').trim();

      let color = null;
      if (status === 'Done') color = '#d9ead3';
      else if (priority >= 3) color = '#f4cccc';
      else if (priority === 2) color = '#fff2cc';

      sheet.getRange(optTargetRow, 1, 1, totalCols).setBackground(color);
      logDebug('ReviewService', 'highlightHighPriorityReviews: single-row ' + optTargetRow);
      return;
    }

    // ─── Full-sheet refresh (existing — สำหรับ bulk ops เช่น reprocessReviewQueue) ───
    const totalRows = sheet.getLastRow() - 1;
    const data = sheet.getRange(2, 1, totalRows, totalCols).getValues();

    const bgColors = [];
    data.forEach((row) => {
      const priority = Number(row[REVIEW_IDX.PRIORITY] || 0);
      const status = String(row[REVIEW_IDX.STATUS] || '').trim();
      let color = null;

      if (status === 'Done') color = '#d9ead3';
      else if (priority >= 3) color = '#f4cccc';
      else if (priority === 2) color = '#fff2cc';

      bgColors.push(Array(totalCols).fill(color));
    });

    sheet.getRange(2, 1, totalRows, totalCols).setBackgrounds(bgColors);
    logDebug('ReviewService', 'highlightHighPriorityReviews: full-sheet ' + totalRows + ' แถว');
  } catch (e) {
    logError('ReviewService', 'highlightHighPriorityReviews ล้มเหลว: ' + e.message, e);
  }
}

// ============================================================
// SECTION 5: Security Helpers (SEC-007 Fix)
// ============================================================

/**
 * maskReviewerEmail_ — [SEC-007] ปกปิด Email ผู้ Review สำหรับ Audit Trail
 * แสดงเฉพาะส่วนต้น + @ + domain ไม่แสดงชื่อเต็ม
 * ตัวอย่าง: "somchai@company.com" → "s***i@company.com"
 * @param {string} email
 * @return {string}
 */
function maskReviewerEmail_(email) {
  if (!email || email === 'Admin' || email === 'Admin (Auto)' || email === 'System') return email;

  const parts = String(email).split('@');
  if (parts.length !== 2) return email;

  const local = parts[0];
  const domain = parts[1];

  if (local.length <= 2) return local[0] + '***@' + domain;
  return local[0] + '***' + local[local.length - 1] + '@' + domain;
}

// ============================================================
// SECTION 6: [ADD v5.5.010] Q_REVIEW Post-Processor
// ย้ายมาจากไฟล์ 22_AccuracyPatch.gs (V5.5.005b) — รวมเข้า codebase หลัก
// Auto-resolve รายการ Q_REVIEW ที่ปลอดภัย 3 กลุ่ม เพื่อลดงาน manual review
// ============================================================

/**
 * extractFirstId_ — [V5.5.010] ดึง ID แรกจาก JSON array string
 * ตัวอย่าง: '["P8EB059B4B35E","P1234567890AB"]' → 'P8EB059B4B35E'
 * @param {string} jsonStr
 * @return {string|null}
 */
function extractFirstId_(jsonStr) {
  if (!jsonStr) return null;
  jsonStr = String(jsonStr).trim();
  if (jsonStr === '[]' || jsonStr === '') return null;
  try {
    const arr = JSON.parse(jsonStr);
    if (arr && arr.length > 0) return String(arr[0]).replace(/"/g, '');
  } catch (e) {
    const m = jsonStr.match(/["']([A-Za-z0-9]+)["']/);
    if (m) return m[1];
  }
  return null;
}

/**
 * safeExtractArr_ — [V5.5.010] ดึงค่าจาก array อย่างปลอดภัย
 * @param {Array} arr
 * @param {number} idx
 * @return {*}
 */
function safeExtractArr_(arr, idx) {
  if (!arr || idx < 0 || idx >= arr.length) return '';
  return arr[idx];
}

/**
 * reprocessReviewQueue — [V5.5.010] ลด Q_REVIEW โดย auto-resolve รายการที่ปลอดภัย
 *   [REF-R2-01 REVIEW15] Rule 2 (SRP): แยก orchestrator + 6 helpers (จาก 432 → ~80 บรรทัด)
 *   รักษาพฤติกรรม 100% — เพียงแยก logic ออกเป็น testable units
 *
 * รันหลัง runMatchEngine() เสร็จ จะอ่าน Q_REVIEW ที่ Pending
 * แล้วจัดการ 3 กลุ่ม:
 *   A. GEO_NEARBY_YELLOW + มีชื่อตรง → AUTO_MATCH (GPS ใกล้เคียง 50-200m + Person/Place ตรง)
 *   B. NEW_RECORD_PENDING + มี Geo candidate → CREATE_NEW (GPS ตรงจุดเดิม แต่ชื่อใหม่)
 *   C. FUZZY_MATCH score >= 85 → AUTO_MATCH (ชื่อคล้ายกันมาก 85%+)
 *
 * วิธีรัน: เลือกฟังก์ชันนี้ใน dropdown → กด ▶ Run
 */
function reprocessReviewQueue() {
  // [FIX BUG-M01 V5.5.022] เพิ่ม AuthZ Guard — destructive op ที่เขียน Q_REVIEW + FACT_DELIVERY + SOURCE
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์รัน Reprocess Review Queue\nกรุณาติดต่อ Admin');
    return;
  }

  // [PERF-001] BLOCKING FIX — เพิ่ม LockService + Time Guard + Checkpoint/Resume + flushLogBuffer_
  //   ปัญหาเดิม: ไม่มี guards ใดๆ → Q_REVIEW 200+ rows เสี่ยง Timeout แน่นอน
  //     - LockService: กัน concurrent writes (2 users พร้อมกัน → duplicate FACT rows)
  //     - Time Guard: หยุดที่ 5 นาที + บันทึก checkpoint → resume รอบถัดไป
  //     - Checkpoint: กัน CPU waste (เริ่มจาก 0 ใหม่ทุกครั้ง → ~30-60s waste/รอบ)
  //     - flushLogBuffer_: กัน log entries สูญหายเมื่อ Timeout

  // ─── STEP 1: LockService (idiomatic pattern เหมือน applyAllPendingDecisions) ───
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS)) {
    safeUiAlert_('⚠️ ระบบกำลังประมวลผล Review อยู่ กรุณารอสักครู่แล้วลองใหม่');
    return;
  }

  const startTime = Date.now();
  const timeLimit = AI_CONFIG.TIME_LIMIT_MS || 5 * 60 * 1000;

  try {
    // PHASE 1+2: Prepare context (read sheets + checkpoint + build RI/FI maps + factLookup)
    const ctx = reprocPrepareContext_(startTime, timeLimit);
    if (!ctx) return; // empty Q_REVIEW or sheet missing

    // PHASE 3: Loop through review rows, dispatch to group handlers
    const stats = reprocProcessAllRows_(ctx, startTime, timeLimit);

    // PHASE 4+5: Batch write + report message + log summary
    reprocBatchWriteAndReport_(ctx, stats, startTime);
  } catch (err) {
    logError('ReviewService', 'reprocessReviewQueue: ' + err.message, err);
    safeUiAlert_('❌ เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    // ─── STEP 1: ปล่อย Lock เสมอ แม้เกิด error ───
    lock.releaseLock();
    // ─── STEP 4: Flush log buffer ก่อน execution จบ ───
    //   ป้องกัน log entries ที่สะสมใน _LOG_BUFFER หายเมื่อ Timeout (P2 #11 V5.5.008)
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}

/**
 * reprocPrepareContext_ — [REF-R2-01 REVIEW15] Phase 1+2: Read sheets, load checkpoint, build RI/FI maps
 *   ย้ายมาจากบรรทัด 1010-1102 (เดิม) — รักษา logic 100%
 * @param {number} startTime - timestamp เริ่มต้น (สำหรับ toast/log)
 * @param {number} timeLimit - ms limit (unused ณ นี้ แต่เก็บไว้เพื่อ compatibility)
 * @return {Object|null} ctx — {reviewSheet, factSheet, reviewData, factData, factLookup, RI, FI, startIdx, reviewCols, factCols, reviewLastRow}
 *                           คืน null ถ้า Q_REVIEW ว่าง หรือ FACT_DELIVERY ไม่พบ
 */
function reprocPrepareContext_(startTime, timeLimit) {
  // [REF-008] V5.5.019: Refactored into helpers for Separation of Concerns
  //   1. validateReprocSheets_       — Sheet validation + early return
  //   2. loadReprocSheetData_        — Read Q_REVIEW + FACT_DELIVERY into memory
  //   3. buildReprocColumnMaps_      — Build RI (REVIEW_IDX) + FI (FACT_IDX) maps
  //   4. buildFactLookup_            — Build source_record_id → factIdx lookup
  //   Preserve Behavior 100% — same validation, same data, same checkpoint, same maps

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // STEP 1: Validate sheets
  const sheets = validateReprocSheets_(ss);
  if (!sheets) return null;
  const reviewSheet = sheets.reviewSheet;
  const factSheet = sheets.factSheet;

  // STEP 2: Read sheet data into memory
  const sheetData = loadReprocSheetData_(reviewSheet, factSheet);

  // STEP 3: Load checkpoint
  const checkpoint = loadReprocessCheckpoint_();
  const startIdx = checkpoint.startIdx || 0;

  if (startIdx > 0) {
    ss.toast('🔄 Resume จากแถว ' + (startIdx + 1) + '...', APP_NAME, 5);
    logInfo('ReviewService', 'reprocessReviewQueue: resume จาก idx ' + startIdx);
  }

  // STEP 4: Build column index maps
  const maps = buildReprocColumnMaps_();

  // STEP 5: Build FACT_DELIVERY lookup
  const factLookup = buildFactLookup_(sheetData.factData, maps.FI);

  return {
    ss: ss,
    reviewSheet: reviewSheet,
    factSheet: factSheet,
    reviewData: sheetData.reviewData,
    factData: sheetData.factData,
    factLookup: factLookup,
    RI: maps.RI,
    FI: maps.FI,
    startIdx: startIdx,
    reviewCols: sheetData.reviewCols,
    factCols: sheetData.factCols,
    reviewLastRow: sheetData.reviewLastRow
  };
}

/**
 * validateReprocSheets_ — [REF-008] Validate Q_REVIEW + FACT_DELIVERY sheets exist
 *   รักษา behavior เดิม 100% — same validation messages, same early return
 * @param {object} ss
 * @return {{reviewSheet: object, factSheet: object}|null} null ถ้า validation fail
 * @private
 */
function validateReprocSheets_(ss) {
  const reviewSheet = ss.getSheetByName(SHEET.Q_REVIEW);
  const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);

  if (!reviewSheet || reviewSheet.getLastRow() < 2) {
    safeUiAlert_('Q_REVIEW ว่าง — ไม่มีข้อมูลจัดการ');
    return null;
  }
  if (!factSheet) {
    safeUiAlert_('ไม่พบชีต FACT_DELIVERY');
    return null;
  }
  return { reviewSheet: reviewSheet, factSheet: factSheet };
}

/**
 * loadReprocSheetData_ — [REF-008] Read Q_REVIEW + FACT_DELIVERY data into memory
 *   รักษา behavior เดิม 100% — same getRange, same getLastRow/Column
 * @param {object} reviewSheet
 * @param {object} factSheet
 * @return {{reviewData: Array, factData: Array, reviewCols: number, factCols: number, reviewLastRow: number}}
 * @private
 */
function loadReprocSheetData_(reviewSheet, factSheet) {
  const reviewLastRow = reviewSheet.getLastRow();
  const reviewCols = reviewSheet.getLastColumn();
  const reviewData = reviewSheet.getRange(2, 1, reviewLastRow - 1, reviewCols).getValues();

  const factLastRow = factSheet.getLastRow();
  const factCols = factSheet.getLastColumn();
  const factData = factLastRow > 1 ? factSheet.getRange(2, 1, factLastRow - 1, factCols).getValues() : [];

  return {
    reviewData: reviewData,
    factData: factData,
    reviewCols: reviewCols,
    factCols: factCols,
    reviewLastRow: reviewLastRow
  };
}

/**
 * buildReprocColumnMaps_ — [REF-008] Build RI + FI column index maps from REVIEW_IDX/FACT_IDX
 *   รักษา behavior เดิม 100% — same fields, same constants
 *   [FIX v5.5.012 Anti-pattern #4] ใช้ REVIEW_IDX.* / FACT_IDX.* แทน headers.indexOf()
 * @return {{RI: Object, FI: Object}}
 * @private
 */
function buildReprocColumnMaps_() {
  const RI = {
    issueType: REVIEW_IDX.ISSUE_TYPE,
    srcRecId: REVIEW_IDX.SOURCE_REC_ID,
    invoiceNo: REVIEW_IDX.INVOICE_NO,
    rawPerson: REVIEW_IDX.RAW_PERSON,
    rawPlace: REVIEW_IDX.RAW_PLACE,
    rawAddr: REVIEW_IDX.RAW_SYS_ADDR,
    rawLat: REVIEW_IDX.RAW_LAT,
    rawLng: REVIEW_IDX.RAW_LNG,
    candPerson: REVIEW_IDX.CAND_PERSONS,
    candPlace: REVIEW_IDX.CAND_PLACES,
    candGeo: REVIEW_IDX.CAND_GEOS,
    candDest: REVIEW_IDX.CAND_DESTS,
    score: REVIEW_IDX.MATCH_SCORE,
    status: REVIEW_IDX.STATUS,
    reviewer: REVIEW_IDX.REVIEWER,
    reviewedAt: REVIEW_IDX.REVIEWED_AT,
    decision: REVIEW_IDX.DECISION,
    note: REVIEW_IDX.NOTE
  };

  const FI = {
    srcRecId: FACT_IDX.SOURCE_REC_ID,
    deliveryDate: FACT_IDX.DELIVERY_DATE,
    personId: FACT_IDX.PERSON_ID,
    placeId: FACT_IDX.PLACE_ID,
    geoId: FACT_IDX.GEO_ID,
    destId: FACT_IDX.DEST_ID,
    matchStatus: FACT_IDX.MATCH_STATUS,
    matchConfidence: FACT_IDX.MATCH_CONF,
    matchReason: FACT_IDX.MATCH_REASON,
    matchAction: FACT_IDX.MATCH_ACTION,
    matchEvidence: FACT_IDX.EVIDENCE,
    updatedAt: FACT_IDX.UPDATED_AT,
    rawLat: FACT_IDX.RAW_LAT,
    rawLng: FACT_IDX.RAW_LNG
  };

  return { RI: RI, FI: FI };
}

/**
 * buildFactLookup_ — [REF-008] Build FACT_DELIVERY lookup: source_record_id → factIdx
 *   รักษา behavior เดิม 100% — same loop, same safeExtractArr_ usage
 * @param {Array} factData
 * @param {Object} FI - FACT_IDX map
 * @return {Object} factLookup map
 * @private
 */
function buildFactLookup_(factData, FI) {
  const factLookup = {};
  for (let fi = 0; fi < factData.length; fi++) {
    const sid = String(safeExtractArr_(factData[fi], FI.srcRecId)).trim();
    if (sid) factLookup[sid] = fi;
  }
  return factLookup;
}

/**
 * reprocProcessAllRows_ — [REF-R2-01 REVIEW15] Phase 3: Loop และ dispatch ไปกลุ่มต่างๆ
 *   ย้ายมาจากบรรทัด 1104-1336 (เดิม) — รักษา Time Guard + skip logic + dispatch 100%
 *   Mutate ctx.reviewData[i] และ ctx.factData[factIdx] ผ่านการส่ง reference ให้ group helpers
 * @param {Object} ctx - context จาก reprocPrepareContext_
 * @param {number} startTime
 * @param {number} timeLimit
 * @return {Object} stats - {groupA, groupB, groupC, destCreated, skipped, notFound, errors, errorList, timedOut, lastIdx}
 */
function reprocProcessAllRows_(ctx, startTime, timeLimit) {
  // ═══════════════════════════════════════
  // PHASE 3: ประมวลผลทีละรายการ
  // ═══════════════════════════════════════
  const stats = {
    groupA: 0, // GEO_NEARBY_YELLOW + name → AUTO_MATCH
    groupB: 0, // NEW_RECORD_PENDING + geo → CREATE_NEW
    groupC: 0, // FUZZY_MATCH 85+ → AUTO_MATCH
    destCreated: 0, // จำนวน Destination ที่สร้าง
    skipped: 0,
    notFound: 0,
    errors: 0,
    errorList: [],
    timedOut: false,
    lastIdx: 0
  };

  const now = new Date();
  const RI = ctx.RI;
  const FI = ctx.FI;
  const reviewData = ctx.reviewData;
  const factData = ctx.factData;
  const factLookup = ctx.factLookup;
  const startIdx = ctx.startIdx;

  // [PERF-001] เริ่มลูปจาก startIdx (จาก checkpoint) แทน 0
  // NOTE: ประกาศ `var i` นอกลูปเพื่อให้ reference ใช้ใน finally/report ได้ (preserves var-scope semantics)
  let i;
  for (i = startIdx; i < reviewData.length; i++) {
    const r = reviewData[i];

    // ─── STEP 2: Time Guard ทุก 20 แถว (เหมือน applyAllPendingDecisions) ───
    //   ใช้ hasTimePassed_() จาก 14_Utils.gs — ลดความเสี่ยง GAS Timeout 6 นาที
    //   บันทึก checkpoint ก่อน break → resume รอบถัดไปไม่ต้องเริ่มจาก 0
    if (i > startIdx && (i - startIdx) % 20 === 0 && hasTimePassed_(startTime, timeLimit)) {
      logWarn('ReviewService', 'reprocessReviewQueue: Time Guard หยุดที่แถว ' + i + '/' + reviewData.length);
      saveReprocessCheckpoint_(i); // STEP 3: save checkpoint ก่อน break
      stats.timedOut = true;
      stats.lastIdx = i;
      break;
    }

    // Skip non-pending
    if (String(safeExtractArr_(r, RI.status)).trim() !== 'Pending') continue;

    const issueType = String(safeExtractArr_(r, RI.issueType)).trim();
    const score = parseInt(safeExtractArr_(r, RI.score)) || 0;
    const srcRecId = String(safeExtractArr_(r, RI.srcRecId)).trim();
    const rawPerson = String(safeExtractArr_(r, RI.rawPerson)).trim();
    const rawPlace = String(safeExtractArr_(r, RI.rawPlace)).trim();
    const rawAddr = String(safeExtractArr_(r, RI.rawAddr)).trim();
    const rawLat = parseFloat(safeExtractArr_(r, RI.rawLat)) || 0;
    const rawLng = parseFloat(safeExtractArr_(r, RI.rawLng)) || 0;
    const candPerson = String(safeExtractArr_(r, RI.candPerson) || '[]').trim();
    const candPlace = String(safeExtractArr_(r, RI.candPlace) || '[]').trim();
    const candGeo = String(safeExtractArr_(r, RI.candGeo) || '[]').trim();

    // หา FACT_DELIVERY row
    const factIdx = factLookup[srcRecId];
    if (factIdx === undefined) {
      stats.notFound++;
      continue;
    }

    // Package rowData เพื่อส่งให้ group helpers
    const rowData = {
      issueType: issueType,
      score: score,
      srcRecId: srcRecId,
      rawPerson: rawPerson,
      rawPlace: rawPlace,
      rawAddr: rawAddr,
      rawLat: rawLat,
      rawLng: rawLng,
      candPerson: candPerson,
      candPlace: candPlace,
      candGeo: candGeo
    };

    // ─────────────────────────────────────────
    // GROUP A: GEO_NEARBY_YELLOW + ชื่อตรง → AUTO_MATCH
    // ─────────────────────────────────────────
    if (issueType === 'GEO_NEARBY_YELLOW' && (candPerson !== '[]' || candPlace !== '[]')) {
      reprocGroupA_YellowWithName_(r, factData, factIdx, rowData, RI, FI, now, stats);
      continue;
    }

    // ─────────────────────────────────────────
    // GROUP B: NEW_RECORD_PENDING + มี Geo → CREATE_NEW
    // ─────────────────────────────────────────
    if (issueType === 'NEW_RECORD_PENDING' && candGeo !== '[]') {
      reprocGroupB_NewRecordWithGeo_(r, factData, factIdx, rowData, RI, FI, now, stats);
      continue;
    }

    // ─────────────────────────────────────────
    // GROUP C: FUZZY_MATCH score >= 85 → AUTO_MATCH
    // ─────────────────────────────────────────
    if (issueType === 'FUZZY_MATCH' && score >= 85) {
      reprocGroupC_FuzzyHighScore_(r, factData, factIdx, rowData, RI, FI, now, stats);
      continue;
    }

    stats.skipped++;
  }

  // กรณีไม่ timeout (ลูปจบปกติ) → lastIdx = reviewData.length เพื่อใช้ใน report
  if (!stats.timedOut) {
    stats.lastIdx = reviewData.length;
  }

  return stats;
}

/**
 * reprocApplyFactUpdate_ — [REF-002] Shared FACT_DELIVERY row mutator
 *   แทนที่ pattern ซ้ำ 30 บรรทัดใน Group A/B/C — ลด code duplication
 * @param {Array} factData - reference ของ factData array (mutate โดยตรง)
 * @param {number} factIdx - index ใน factData
 * @param {Object} FI - FACT_IDX map
 * @param {Object} fields - {personId, placeId, geoId, destId, matchStatus, matchConfidence, matchReason, matchAction, evidence}
 * @param {Date} now - timestamp
 * @private
 */
function reprocApplyFactUpdate_(factData, factIdx, FI, fields, now) {
  const row = factData[factIdx];
  if (fields.personId && FI.personId >= 0) row[FI.personId] = fields.personId;
  if (fields.placeId && FI.placeId >= 0) row[FI.placeId] = fields.placeId;
  if (fields.geoId && FI.geoId >= 0) row[FI.geoId] = fields.geoId;
  if (fields.destId && FI.destId >= 0) row[FI.destId] = fields.destId;
  if (FI.matchStatus >= 0) row[FI.matchStatus] = fields.matchStatus;
  if (FI.matchConfidence >= 0) row[FI.matchConfidence] = fields.matchConfidence;
  if (FI.matchReason >= 0) row[FI.matchReason] = fields.matchReason;
  if (FI.matchAction >= 0) row[FI.matchAction] = fields.matchAction;
  if (FI.matchEvidence >= 0 && fields.evidence) row[FI.matchEvidence] = fields.evidence;
  if (FI.updatedAt >= 0) row[FI.updatedAt] = now;
}

/**
 * reprocApplyReviewUpdate_ — [REF-002] Shared Q_REVIEW row mutator
 * @param {Array} r - reference ของ reviewData[i] (mutate โดยตรง)
 * @param {Object} RI - REVIEW_IDX map
 * @param {string} decision - 'AUTO_MATCH' or 'CREATE_NEW'
 * @param {string} note - note string
 * @param {Date} now - timestamp
 * @private
 */
function reprocApplyReviewUpdate_(r, RI, decision, note, now) {
  if (RI.status >= 0) r[RI.status] = 'Auto_Resolved';
  if (RI.reviewer >= 0) r[RI.reviewer] = 'SYSTEM_V55';
  if (RI.reviewedAt >= 0) r[RI.reviewedAt] = now;
  if (RI.decision >= 0) r[RI.decision] = decision;
  if (RI.note >= 0) r[RI.note] = note;
}

/**
 * reprocCreateDestinationViaGateway_ — [REF-001] Delegate createDestination through Group 1 public helper
 *   แทนการเรียก createDestination() โดยตรงจาก Group 2 (Module Boundary violation)
 *   เรียกผ่าน reprocCreateDestinationForReview_ ใน 10_MatchEngine (Group 1)
 *   Preserve Behavior 100% — same createDestination call, just through wrapper
 * @param {Object} rowData - review row data (สำหรับ rawLat/rawLng และ error logging)
 * @param {string|null} personId
 * @param {string|null} placeId
 * @param {string} geoId
 * @param {Object} stats - stats accumulator (mutated: destCreated++, errorList.push)
 * @param {string} groupId - 'A' | 'B' | 'C' for error logging
 * @return {string|null} destId or null
 * @private
 */
function reprocCreateDestinationViaGateway_(rowData, personId, placeId, geoId, stats, groupId) {
  if (!((personId || placeId) && geoId)) return null;
  const result = reprocCreateDestinationForReview_(personId, placeId, geoId, rowData.rawLat, rowData.rawLng);
  if (result.destId) {
    stats.destCreated++;
    return result.destId;
  }
  if (result.error) {
    stats.errorList.push('Dest-' + groupId + ': ' + rowData.srcRecId + ' - ' + result.error);
  }
  return null;
}

/**
 * reprocGroupA_YellowWithName_ — [REF-001 + REF-002] Group A: GEO_NEARBY_YELLOW + name → AUTO_MATCH
 *   Refactored: ใช้ shared mutators (reprocApplyFactUpdate_/reprocApplyReviewUpdate_)
 *   + delegate createDestination via reprocCreateDestinationViaGateway_ (Module Boundary)
 *   ลดจาก 46 → ~25 บรรทัด — Preserve Behavior 100% (same field values, same order)
 * @param {Array} r - reference ของ reviewData[i] (mutate โดยตรง)
 * @param {Array} factData - reference ของ ctx.factData (mutate โดยตรง)
 * @param {number} factIdx - index ใน factData
 * @param {Object} rowData - {issueType, score, srcRecId, rawPerson, rawPlace, rawAddr, rawLat, rawLng, candPerson, candPlace, candGeo}
 * @param {Object} RI - REVIEW_IDX map
 * @param {Object} FI - FACT_IDX map
 * @param {Date} now - timestamp ปัจจุบัน
 * @param {Object} stats - stats object ที่จะ mutate
 */
function reprocGroupA_YellowWithName_(r, factData, factIdx, rowData, RI, FI, now, stats) {
  try {
    const personId = extractFirstId_(rowData.candPerson);
    const placeId = extractFirstId_(rowData.candPlace);
    const geoId = extractFirstId_(rowData.candGeo);

    const destId = reprocCreateDestinationViaGateway_(rowData, personId, placeId, geoId, stats, 'A');

    let ev = 'geo_nearby_50_200m';
    if (personId) ev += '|person_match';
    if (placeId) ev += '|place_match';
    ev += '|post_process_v55';

    reprocApplyFactUpdate_(
      factData,
      factIdx,
      FI,
      {
        personId: personId,
        placeId: placeId,
        geoId: geoId,
        destId: destId,
        matchStatus: 'AUTO_MATCHED',
        matchConfidence: 82,
        matchReason: 'GEO_ANCHOR_AUTO',
        matchAction: 'AUTO_MATCH',
        evidence: ev
      },
      now
    );
    reprocApplyReviewUpdate_(r, RI, 'AUTO_MATCH', 'GEO_NEARBY_YELLOW + name match → auto-resolved by v5.5.010', now);

    stats.groupA++;
  } catch (e) {
    stats.errors++;
    stats.errorList.push('GroupA: ' + rowData.srcRecId + ' - ' + e.message);
  }
}

/**
 * reprocGroupB_NewRecordWithGeo_ — [REF-001 + REF-002] Group B: NEW_RECORD_PENDING + Geo → CREATE_NEW
 *   Refactored: ใช้ Group 1 public helpers (reprocResolveOrCreatePersonForReview_,
 *   reprocResolveOrCreatePlaceForReview_, reprocCreateDestinationForReview_) แทน direct CRUD
 *   + shared mutators — Preserve Behavior 100% (same createPerson/createPlace/createDestination calls)
 *   ลดจาก 71 → ~40 บรรทัด
 */
function reprocGroupB_NewRecordWithGeo_(r, factData, factIdx, rowData, RI, FI, now, stats) {
  try {
    const geoId = extractFirstId_(rowData.candGeo);
    let personId = null;
    let placeId = null;
    let destId = null;

    // [REF-001] Person: resolve-or-create via Group 1 public helper (no direct createPerson)
    if (rowData.rawPerson) {
      const pResult = reprocResolveOrCreatePersonForReview_(rowData.rawPerson);
      personId = pResult.personId;
      if (pResult.error) stats.errorList.push('Person-B: ' + rowData.srcRecId + ' - ' + pResult.error);
    }

    // [REF-001] Place: resolve-or-create via Group 1 public helper (no direct createPlace)
    const placeInput = rowData.rawPlace || rowData.rawAddr || '';
    if (placeInput) {
      const plResult = reprocResolveOrCreatePlaceForReview_(rowData.rawPlace, rowData.rawAddr);
      placeId = plResult.placeId;
      if (plResult.error) stats.errorList.push('Place-B: ' + rowData.srcRecId + ' - ' + plResult.error);
    }

    // [REF-001] Destination: create via Group 1 public helper (no direct createDestination)
    if ((personId || placeId) && geoId) {
      const dResult = reprocCreateDestinationForReview_(personId, placeId, geoId, rowData.rawLat, rowData.rawLng);
      destId = dResult.destId;
      if (dResult.destId) stats.destCreated++;
      if (dResult.error) stats.errorList.push('Dest-B: ' + rowData.srcRecId + ' - ' + dResult.error);
    }

    reprocApplyFactUpdate_(
      factData,
      factIdx,
      FI,
      {
        personId: personId,
        placeId: placeId,
        geoId: geoId,
        destId: destId,
        matchStatus: 'CREATED',
        matchConfidence: 75,
        matchReason: 'GEO_ANCHOR_NEW',
        matchAction: 'CREATE_NEW',
        evidence:
          'geo_existing' +
          (personId ? '|person_new' : '|person_na') +
          (placeId ? '|place_new' : '|place_na') +
          '|post_process_v55'
      },
      now
    );
    reprocApplyReviewUpdate_(r, RI, 'CREATE_NEW', 'NEW_RECORD_PENDING + Geo match → auto-create by v5.5.010', now);

    stats.groupB++;
  } catch (e) {
    stats.errors++;
    stats.errorList.push('GroupB: ' + rowData.srcRecId + ' - ' + e.message);
  }
}

/**
 * reprocGroupC_FuzzyHighScore_ — [REF-001 + REF-002] Group C: FUZZY_MATCH 85+ → AUTO_MATCH
 *   Refactored: ใช้ shared mutators + delegate createDestination via gateway
 *   ลดจาก 49 → ~25 บรรทัด — Preserve Behavior 100%
 */
function reprocGroupC_FuzzyHighScore_(r, factData, factIdx, rowData, RI, FI, now, stats) {
  try {
    const personId = extractFirstId_(rowData.candPerson);
    const placeId = extractFirstId_(rowData.candPlace);
    const geoId = extractFirstId_(rowData.candGeo);

    const destId = reprocCreateDestinationViaGateway_(rowData, personId, placeId, geoId, stats, 'C');

    let ev = 'fuzzy_score_' + rowData.score;
    if (geoId) ev += '|geo_confirm';
    ev += '|post_process_v55';

    reprocApplyFactUpdate_(
      factData,
      factIdx,
      FI,
      {
        personId: personId,
        placeId: placeId,
        geoId: geoId,
        destId: destId,
        matchStatus: 'AUTO_MATCHED',
        matchConfidence: rowData.score,
        matchReason: 'FUZZY_HIGH_SCORE_AUTO',
        matchAction: 'AUTO_MATCH',
        evidence: ev
      },
      now
    );
    reprocApplyReviewUpdate_(
      r,
      RI,
      'AUTO_MATCH',
      'FUZZY_MATCH score ' + rowData.score + ' → auto-resolved by v5.5.010',
      now
    );

    stats.groupC++;
  } catch (e) {
    stats.errors++;
    stats.errorList.push('GroupC: ' + rowData.srcRecId + ' - ' + e.message);
  }
}

/**
 * reprocBatchWriteAndReport_ — [REF-R2-01 REVIEW15] Phase 4+5: Batch write + Report
 *   ย้ายมาจากบรรทัด 1338-1400 (เดิม) — รักษา batch write + clear checkpoint + report message 100%
 * @param {Object} ctx - context จาก reprocPrepareContext_
 * @param {Object} stats - stats จาก reprocProcessAllRows_
 * @param {number} startTime - timestamp เริ่มต้น (สำหรับ elapsed calculation)
 */
function reprocBatchWriteAndReport_(ctx, stats, startTime) {
  const reviewSheet = ctx.reviewSheet;
  const factSheet = ctx.factSheet;
  const reviewData = ctx.reviewData;
  const factData = ctx.factData;
  const reviewCols = ctx.reviewCols;
  const factCols = ctx.factCols;
  const reviewLastRow = ctx.reviewLastRow;
  const startIdx = ctx.startIdx;

  // ═══════════════════════════════════════
  // PHASE 4: เขียนข้อมูลกลับ (Batch Write)
  // ═══════════════════════════════════════
  try {
    if (factData.length > 0) {
      factSheet.getRange(2, 1, factData.length, factCols).setValues(factData);
    }
    reviewSheet.getRange(2, 1, reviewData.length, reviewCols).setValues(reviewData);
  } catch (e) {
    logError('ReviewService', 'reprocessReviewQueue batch write ล้มเหลว: ' + e.message, e);
    safeUiAlert_('บันทึกข้อมูลล้มเหลว: ' + e.message + '\nดู log ใน SYS_LOG');
    return;
  }

  // ─── STEP 3: ล้าง Checkpoint เมื่อเสร็จสมบูรณ์ ───
  //   ถ้าไม่ Timeout → ประมวลผลครบแล้ว → ล้าง checkpoint
  //   ถ้า Timeout → เก็บ checkpoint ไว้ให้ resume รอบถัดไป
  if (!stats.timedOut) {
    clearReprocessCheckpoint_();
  }

  // ═══════════════════════════════════════
  // PHASE 5: รายงานผล
  // ═══════════════════════════════════════
  const totalResolved = stats.groupA + stats.groupB + stats.groupC;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const remaining = reviewLastRow - 1 - totalResolved - startIdx;

  let msg =
    '✅ Post-Processor ' +
    (stats.timedOut ? 'หยุดกลางคัน (Time Guard)' : 'เสร็จสมบูรณ์') +
    ' (' +
    elapsed +
    ' วินาที)\n\n' +
    (startIdx > 0 ? '🔄 Resume จากแถว ' + (startIdx + 1) + '\n\n' : '') +
    '━━━ ผลลัพธ์ ━━━\n' +
    '🟢 GEO_NEARBY_YELLOW + name → AUTO_MATCH: ' +
    stats.groupA +
    ' รายการ\n' +
    '🔵 NEW_RECORD_PENDING + Geo → CREATE_NEW: ' +
    stats.groupB +
    ' รายการ\n' +
    '🟡 FUZZY_MATCH 85+ → AUTO_MATCH: ' +
    stats.groupC +
    ' รายการ\n' +
    '🔗 Destination สร้างใหม่: ' +
    stats.destCreated +
    ' รายการ\n\n' +
    '⏭️ ข้าม (ต้อง Review ต่อ): ' +
    stats.skipped +
    ' รายการ\n' +
    '❌ ไม่พบใน FACT: ' +
    stats.notFound +
    ' รายการ\n' +
    '⚠️ Errors: ' +
    stats.errors +
    ' รายการ\n\n' +
    '━━━ สรุป ━━━\n' +
    'ลด Q_REVIEW: ' +
    totalResolved +
    ' → คงเหลือ: ~' +
    Math.max(0, remaining) +
    ' รายการ\n';

  if (stats.timedOut) {
    msg += '\n💾 บันทึกตำแหน่งไว้แล้ว กด Run อีกครั้งจะทำต่อจากแถวที่ ' + (stats.lastIdx + 1);
  }

  if (stats.errorList.length > 0) {
    const showErrors = stats.errorList.slice(0, 5);
    msg += '\n\n⚠️ Error ตัวอย่าง:\n' + showErrors.join('\n');
    if (stats.errorList.length > 5) {
      msg += '\n... และอีก ' + (stats.errorList.length - 5) + ' errors (ดูใน SYS_LOG)';
    }
  }

  safeUiAlert_(msg);
  logInfo(
    'ReviewService',
    'reprocessReviewQueue ' +
      (stats.timedOut ? 'หยุดกลางคัน' : 'เสร็จ') +
      ' ' +
      elapsed +
      's | A=' +
      stats.groupA +
      ' B=' +
      stats.groupB +
      ' C=' +
      stats.groupC +
      ' Skip=' +
      stats.skipped +
      ' Err=' +
      stats.errors +
      ' Dest=' +
      stats.destCreated +
      (stats.timedOut ? ' (checkpoint@' + stats.lastIdx + ')' : '')
  );
}

// ============================================================
// SECTION 6b: [PERF-001] reprocessReviewQueue Checkpoint Helpers
//   ใช้ PropertiesService เก็บตำแหน่ง idx ปัจจุบัน — เหมือน MIGRATION_HybridAliasSystem pattern
// ============================================================

/**
 * saveReprocessCheckpoint_ — [PERF-001] บันทึกตำแหน่ง reprocessReviewQueue ปัจจุบัน
 *   เรียกเมื่อ Time Guard หยุดกลางคัน → resume รอบถัดไปเริ่มจาก idx นี้
 * @param {number} idx - ตำแหน่ง array index ปัจจุบัน (0-based)
 */
function saveReprocessCheckpoint_(idx) {
  PropertiesService.getScriptProperties().setProperty(
    REPROCESS_REVIEW_CHECKPOINT_KEY,
    JSON.stringify({ startIdx: idx, timestamp: Date.now() })
  );
}

/**
 * loadReprocessCheckpoint_ — [PERF-001] โหลดตำแหน่ง reprocessReviewQueue ที่บันทึกไว้
 *   Stale protection: checkpoint เก่ากว่า 24 ชม. → auto clear (กัน garbage)
 * @return {{ startIdx: number, timestamp: number }}
 */
function loadReprocessCheckpoint_() {
  const raw = PropertiesService.getScriptProperties().getProperty(REPROCESS_REVIEW_CHECKPOINT_KEY);
  if (!raw) return { startIdx: 0 };
  try {
    const cp = JSON.parse(raw);
    // Stale protection: เก่ากว่า 24 ชม. → clear
    if (cp.timestamp && Date.now() - cp.timestamp > 24 * 60 * 60 * 1000) {
      clearReprocessCheckpoint_();
      return { startIdx: 0 };
    }
    return cp;
  } catch (e) {
    // [FIX BUG-AUDIT-013 V5.5.043] log ก่อน reset checkpoint เพื่อให้วินิจฉัย corruption ได้
    logWarn(
      'ReviewService',
      'loadReprocessCheckpoint_: JSON.parse ล้มเหลว — reset to startIdx=0. ' +
        'raw="' +
        String(raw).substring(0, 200) +
        '", error=' +
        e.message
    );
    return { startIdx: 0 };
  }
}

/**
 * clearReprocessCheckpoint_ — [PERF-001] ล้าง checkpoint หลัง reprocessReviewQueue เสร็จสมบูรณ์
 */
function clearReprocessCheckpoint_() {
  PropertiesService.getScriptProperties().deleteProperty(REPROCESS_REVIEW_CHECKPOINT_KEY);
}

// [REMOVED V5.5.044] analyzeReviewPatterns — dead code (mark @deprecated ใน V5.5.043, ไม่มี caller ใน .gs ใด)
//   หากมี external caller ที่ต้องการ restore → ดู git history ของ commit นี้
