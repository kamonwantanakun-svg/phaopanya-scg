/**
 * VERSION: 6.0.069
 * FILE: 12_ReviewService.gs
 * LMDS V6.0 — Review Queue Service
 * ===================================================
 * PURPOSE:
 *   จัดการคิวรีวิว Q_REVIEW — พักข้อมูลที่ต้องให้คนตัดสินใจ
 *   รวม enqueueReview, applyReviewDecision, applyAllPendingDecisions
 *   ตั้งแต่ V6.0.034 post-processor แยกไป 12b_ReviewReprocessor
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 10_MatchEngine.gs       (resolveAndPersist_ gateway)
 *     - 10e_MatchResolvePersist.gs (resolve/persist implementation)
 *     - 07_PlaceService.gs     (getEnrichedGeoData for review detail)
 *     - 11_TransactionService.gs (upsertFactDelivery on decision)
 *     - 12b_ReviewReprocessor.gs (reprocessReviewQueue)
 *     - 26_AuditTrailService.gs (audit on decision)
 *     - 27_RbacService.gs      (reviewer role check)
 *   CALLS: (Invokes)
 *     - resolveAndPersist_()                    → 10e_MatchResolvePersist.gs
 *     - getEnrichedGeoData()                    → 07_PlaceService.gs
 *     - upsertFactDelivery()                    → 11_TransactionService.gs
 *     - reprocessReviewQueue()                  → 12b_ReviewReprocessor.gs
 *     - recordAuditTrail()                      → 26_AuditTrailService.gs
 *     - isAuthorizedUser_()                     → 27_RbacService.gs
 *   EXPORTS TO:
 *     - 00_App.gs (openReviewQueue, applyAllPendingDecisions menus)
 *     - 10_MatchEngine.gs (enqueueReview)
 *     - 22c_WebAppActions.gs (submitReviewDecision, getReviewDetail)
 *     - 22b_WebAppViews.gs (Q_REVIEW view)
 *   SHEETS ACCESSED:
 *     - SHEET.Q_REVIEW          (Read/Write — enqueue + apply decision + list)
 *     - SHEET.SOURCE            (Read — review detail enrichment)
 *     - SHEET.FACT_DELIVERY     (Read — review detail)
 *     - SHEET.SYS_NEGATIVE_SAMPLES (Write — record rejected matches as negative learning)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 2 — Daily operations (source repo, FACT_DELIVERY, Q_REVIEW, reports, Maps, SCG)
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
  // [V6.0.010 P3.16] RBAC: require reviewer/admin to batch-apply decisions
  if (typeof requirePermission_ === 'function') requirePermission_('action:approve_review');

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
        // [V6.0.003] Mark as negative sample to prevent future wrong alias creation
        //   เมื่อ Admin IGNORE = "นี่ไม่ใช่ match ที่ถูกต้อง" → เก็บเป็น negative sample
        //   ป้องกัน autoEnrichAliasesFromFactBatch_ สร้าง alias ผิดในรอบถัดไป
        markAsNegativeSample_(rowArr);
        break;
      default:
        logWarn('ReviewService', 'applyReviewDecision: Unknown decision ' + decisionVal);
        break;
    }

    logInfo('ReviewService', 'applyReviewDecision: ' + reviewId + ' → ' + decisionVal + ' โดย ' + reviewer);

    // [V6.0.007] Audit Trail — record review decision (Critical-Only scope)
    //   Map decision → AUDIT_ACTIONS:
    //     CREATE_NEW          → CREATE
    //     MERGE_TO_CANDIDATE  → MERGE
    //     ESCALATE            → UPDATE (status change only)
    //     IGNORE              → DELETE (effectively discards the review)
    //   Failsafe: logAuditTrail never throws — wrapped in its own try/catch
    if (typeof logAuditTrail === 'function' && typeof AUDIT_ENTITY_TYPES !== 'undefined') {
      const auditActionMap = {
        CREATE_NEW: 'CREATE',
        MERGE_TO_CANDIDATE: 'MERGE',
        ESCALATE: 'UPDATE',
        IGNORE: 'DELETE'
      };
      const auditAction = auditActionMap[decisionVal] || 'UPDATE';
      logAuditTrail(
        AUDIT_ENTITY_TYPES.Q_REVIEW,
        reviewId,
        auditAction,
        'review_status',
        String(rowArr[REVIEW_IDX.STATUS] || 'PENDING'),
        decisionVal + ' by ' + reviewer,
        'Q_REVIEW decision'
      );
    }

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

  // [V6.0.007] Extract review_id from rowArr — wire through to createGlobalAlias
  //   so M_ALIAS.verified_by/review_id/verified_at are populated for HUMAN aliases.
  //   Previously: review_id was always '' because executeMergeDecision_ didn't
  //   pass it down the chain (resolveAndPersist_ → resolveAndPersistMerge_ →
  //   createGlobalAlias). This caused M_ALIAS cols 8-10 to be empty even for
  //   human-verified aliases created via Q_REVIEW MERGE.
  const reviewId = String(rowArr[REVIEW_IDX.REVIEW_ID] || '').trim();

  // [REF-001] Delegate to resolveAndPersist_ gateway — no direct Group 1 CRUD calls
  const result = resolveAndPersist_(srcObj, 'MERGE_TO_CANDIDATE', candidates, reviewId);

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
// SECTION 5b: [V6.0.003] System Learning — Negative Samples
//   เมื่อ Admin เลือก IGNORE ใน Q_REVIEW → เก็บ raw name/address เป็น
//   negative sample ใน SYS_NEGATIVE_SAMPLES เพื่อป้องกัน autoEnrich
//   สร้าง alias ผิดในรอบ Match Engine ถัดไป (negative learning feedback loop)
// ============================================================

/**
 * markAsNegativeSample_ — [V6.0.003] Mark a review as negative sample
 *   Used when Admin selects IGNORE — prevents autoEnrich from creating wrong alias
 * @param {Array} rowData - Q_REVIEW row data array (REVIEW_IDX order)
 * @private
 */
function markAsNegativeSample_(rowData) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_NEGATIVE_SAMPLES);
    if (!sheet) {
      logWarn('ReviewService', 'markAsNegativeSample_: SYS_NEGATIVE_SAMPLES sheet not found');
      return;
    }

    const rawPerson = String(rowData[REVIEW_IDX.RAW_PERSON] || '').trim();
    const rawPlace = String(rowData[REVIEW_IDX.RAW_PLACE] || '').trim();
    const candPersonStr = String(rowData[REVIEW_IDX.CAND_PERSONS] || '[]').trim();
    const candPlaceStr = String(rowData[REVIEW_IDX.CAND_PLACES] || '[]').trim();

    let candPersonId = '';
    let candPlaceId = '';
    try {
      const personIds = JSON.parse(candPersonStr);
      if (Array.isArray(personIds) && personIds.length > 0) candPersonId = personIds[0];
    } catch (e) {
      /* ignore — candidate JSON may be empty/malformed */
    }
    try {
      const placeIds = JSON.parse(candPlaceStr);
      if (Array.isArray(placeIds) && placeIds.length > 0) candPlaceId = placeIds[0];
    } catch (e) {
      /* ignore */
    }

    let markedBy = 'Admin';
    try {
      markedBy = maskReviewerEmail_(
        Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'Admin'
      );
    } catch (e) {
      /* ignore — WebApp context may not expose email */
    }

    // [V6.0.003] Default reason 'WRONG_MATCH' — Admin ปฏิเสธ match ที่ระบบเสนอ
    //   สามารถขยายภายหลังเป็น 'DIFFERENT_PERSON' / 'DATA_QUALITY' ถ้ามี UI ให้เลือก
    const newRow = [
      generateShortId('NS'),
      rawPerson,
      rawPlace,
      candPersonId,
      candPlaceId,
      'WRONG_MATCH',
      markedBy,
      new Date()
    ];

    sheet.getRange(sheet.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
    logInfo('ReviewService', 'markAsNegativeSample_: stored negative sample for rawPerson="' + rawPerson + '"');
  } catch (e) {
    logError('ReviewService', 'markAsNegativeSample_ failed: ' + e.message, e);
  }
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

// ============================================================
// SECTION 6b: [PERF-001] reprocessReviewQueue Checkpoint Helpers
//   ใช้ PropertiesService เก็บตำแหน่ง idx ปัจจุบัน — เหมือน MIGRATION_HybridAliasSystem pattern
// ============================================================

// [REMOVED V5.5.044] analyzeReviewPatterns — dead code (mark @deprecated ใน V5.5.043, ไม่มี caller ใน .gs ใด)
//   หากมี external caller ที่ต้องการ restore → ดู git history ของ commit นี้

// ============================================================
// SECTION 7: [V6.0.005] Q_REVIEW Cleanup
// ============================================================

/**
 * clearDoneReviews_UI — [V6.0.005] ลบแถวที่ status=Done หรือ Escalated ออกจาก Q_REVIEW
 *   ใช้หลังจาก Admin อนุมัติ/ปฏิเสธครบแล้ว — ลบเพื่อให้เหลือเฉพาะ Pending
 *   ข้อมูลที่ถูกประมวลผลแล้วจะอยู่ใน FACT_DELIVERY (audit trail ครบ)
 */
function clearDoneReviews_UI() {
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ล้าง Q_REVIEW\nกรุณาติดต่อ Admin');
    return;
  }
  // [V6.0.010 P3.2] LockService guard — prevent concurrent clear operations
  const lock = acquireScriptLockOrWarn_(5000, '⚠️ clearDoneReviews_UI กำลังรันอยู่ กรุณารอให้เสร็จก่อน');
  if (!lock) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet || sheet.getLastRow() < 2) {
      safeUiAlert_('Q_REVIEW ว่าง — ไม่มีข้อมูลจัดการ');
      return;
    }

    const totalRows = sheet.getLastRow() - 1;
    const allData = sheet.getRange(2, 1, totalRows, SCHEMA[SHEET.Q_REVIEW].length).getValues();

    // แยกแถวที่จะเก็บ (Pending) กับแถวที่จะลบ (Done/Escalated)
    const keepRows = [];
    let removedCount = 0;

    for (let i = 0; i < allData.length; i++) {
      const status = String(allData[i][REVIEW_IDX.STATUS] || '').trim();
      if (status === 'Done' || status === 'Escalated') {
        removedCount++;
      } else {
        keepRows.push(allData[i]);
      }
    }

    if (removedCount === 0) {
      safeUiAlert_('ไม่มีแถวที่ Done/Escalated ให้ลบ — ทุกแถวยังเป็น Pending');
      return;
    }

    // ล้างข้อมูลเดิมทั้งหมด แล้วเขียนเฉพาะที่จะเก็บ
    sheet.getRange(2, 1, totalRows, SCHEMA[SHEET.Q_REVIEW].length).clearContent();
    if (keepRows.length > 0) {
      sheet.getRange(2, 1, keepRows.length, SCHEMA[SHEET.Q_REVIEW].length).setValues(keepRows);
    }

    logInfo(
      'ReviewService',
      'clearDoneReviews_UI: ลบ ' + removedCount + ' แถว (Done/Escalated), เหลือ ' + keepRows.length + ' แถว (Pending)'
    );
    safeUiAlert_(
      '✅ ล้าง Q_REVIEW เรียบร้อย\n\n' +
        'ลบ: ' +
        removedCount +
        ' แถว (Done/Escalated)\n' +
        'เหลือ: ' +
        keepRows.length +
        ' แถว (Pending)\n\n' +
        'หมายเหตุ: ข้อมูลที่ประมวลผลแล้วยังอยู่ใน FACT_DELIVERY'
    );
  } catch (e) {
    logError('ReviewService', 'clearDoneReviews_UI ล้มเหลว: ' + e.message, e);
    safeUiAlert_('❌ ล้มเหลว: ' + e.message);
  } finally {
    releaseScriptLock_(lock);
  }
}
