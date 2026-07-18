/**
 * VERSION: 6.0.069
 * FILE: 12b_ReviewReprocessor.gs
 * LMDS V6.0 — Q_REVIEW Post-Processor
 * ===================================================
 * PURPOSE:
 *   รวม reprocessReviewQueue + reproc* helpers สำหรับ batch reprocessing
 *   Q_REVIEW rows ที่มี MATCH_STATUS=MATCHED แต่ยังไม่ได้ sync ไป FACT_DELIVERY
 *   แยกออกจาก 12_ReviewService.gs เพื่อลดขนาดไฟล์ (audit 1.2)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 10_MatchEngine.gs       (handleReview_ gateway)
 *     - 10e_MatchResolvePersist.gs (resolve/persist implementation)
 *     - 11_TransactionService.gs (upsertFactDelivery)
 *     - 12_ReviewService.gs    (review state helpers)
 *   CALLS: (Invokes)
 *     - resolveAndPersist_()                    → 10e_MatchResolvePersist.gs
 *     - upsertFactDelivery()                    → 11_TransactionService.gs
 *     - logInfo() / logWarn()                   → 03_SetupSheets.gs
 *   EXPORTS TO:
 *     - 12_ReviewService.gs (applyAllPendingDecisions → reprocessReviewQueue)
 *     - 00_App.gs (applyAllPendingDecisions menu)
 *   SHEETS ACCESSED:
 *     - SHEET.Q_REVIEW          (Read/Write — re-read pending rows, mark reprocessed)
 *     - SHEET.FACT_DELIVERY     (Read — verify sync state)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 2 — Daily operations (source repo, FACT_DELIVERY, Q_REVIEW, reports, Maps, SCG)
 * ===================================================
 */

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
