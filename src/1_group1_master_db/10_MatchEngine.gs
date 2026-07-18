/**
 * VERSION: 6.0.069
 * FILE: 10_MatchEngine.gs
 * LMDS V6.0 — Core Match & Resolution Engine
 * ===================================================
 * PURPOSE:
 *   ประมวลผลข้อมูลต้นทาง → จับคู่ Person/Place/Geo → ตัดสินใจ → บันทึกผล
 *   เป็นหัวใจหลักของ Pipeline
 *   ตั้งแต่ V6.0.030+ decision rules แยกไป 10b, test harness ไป 10d, resolve/persist ไป 10e
 *   ตั้งแต่ V6.0.050 alias enrichment แยกไป 10f, row processor แยกไป 10g, auto-resume แยกไป 10h
 *   ตั้งแต่ V6.0.051 scoring functions (calculateWeightedScore, calcDynamicWeights_,
 *   getCandidateResolvedCoords_) ย้ายไป 10b เพื่อให้ใกล้ callers ที่สุด
 *   ตอนนี้ 10_MatchEngine.gs เก็บเฉพาะ: lifecycle (runMatchEngine + 4 helpers) +
 *   makeMatchDecision + getGeoProvince_ + abstraction layer + tie-breaker
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 04_SourceRepository.gs (getUnprocessedRows, buildSourceObj_)
 *     - 05_NormalizeService.gs, 06_PersonService, 07_PlaceService, 08_GeoService, 09_DestinationService
 *     - 11_TransactionService.gs (upsertFactDelivery)
 *     - 12_ReviewService.gs (enqueueReview for ambiguous matches)
 *     - 10b_MatchDecision.gs (decision rules + scoring + geo coordinate cache)
 *     - 10d_MatchTestHarness.gs (test harness — referenced)
 *     - 10e_MatchResolvePersist.gs (resolve/persist for Q_REVIEW reprocessing)
 *     - 10f_MatchAliasEnrichment.gs (autoEnrichAliasesFromFactBatch_ — single writer for M_ALIAS)
 *     - 10g_MatchRowProcessor.gs (processOneRow + executeDecision + handle* functions)
 *     - 10h_MatchAutoResume.gs (resetProcessingState_, installAutoResume_, stop signal)
 *     - 26_AuditTrailService.gs (alias write audit)
 *   CALLS: (Invokes)
 *     - getUnprocessedRows() / buildSourceObj_() → 04_SourceRepository.gs
 *     - makeMatchDecision()                     → 10b_MatchDecision.gs (local, delegates to evaluateRule*)
 *     - processOneRow()                         → 10g_MatchRowProcessor.gs
 *     - autoEnrichAliasesFromFactBatch_()        → 10f_MatchAliasEnrichment.gs
 *     - resetProcessingState_() / installAutoResume_() / isPipelineStopRequested_()
 *       / clearPipelineStopSignal_() / removeAutoResume_()  → 10h_MatchAutoResume.gs
 *     - upsertFactDelivery()                    → 11_TransactionService.gs (via 10g.executeDecision)
 *     - enqueueReview()                         → 12_ReviewService.gs (via 10g.handleReview_)
 *     - resolveAndPersist_()                    → 10e_MatchResolvePersist.gs
 *     - recordAuditTrail()                      → 26_AuditTrailService.gs
 *   EXPORTS TO:
 *     - 00_App.gs (runMatchEngine menu)
 *     - 24_PipelineManager.gs (runMatchEngine wrapper for batched runs)
 *     - 10b/10d/10e/10f/10g/10h (split helpers)
 *   SHEETS ACCESSED:
 *     - SHEET.SOURCE             (Read — input rows via 04_SourceRepository)
 *     - SHEET.FACT_DELIVERY      (Write — upsert via 11_TransactionService, called from 10g)
 *     - SHEET.Q_REVIEW           (Write — enqueue via 12_ReviewService, called from 10g)
 *     - SHEET.M_ALIAS            (Write — via 10f.autoEnrichAliasesFromFactBatch_)
 *     - SHEET.PIPELINE_RUN_LOG   (Write — run state for resume)
 *   TRIGGERS: time-based (auto-resume managed by 10h_MatchAutoResume.gs)
 *
 * ARCHITECTURE:
 *   Group 1 — Master data building (normalize, persons, places, geo, match engine, aliases)
 * ===================================================
 */

// ============================================================
// SECTION 1: runMatchEngine
// ============================================================

// [V6.0.050] Moved to 10f/10g/10h: _ALIAS_ENRICHMENT_CONTEXT + addEntityToEnrichmentContext_ → 10f
//   See 10f_MatchAliasEnrichment.gs, 10g_MatchRowProcessor.gs, 10h_MatchAutoResume.gs

function runMatchEngine() {
  // [REF-004] V5.5.019: Refactored into 4 section helpers for Separation of Concerns
  //   1. acquireMatchEngineLock_   — SECTION A: Lock + AuthZ
  //   2. prepareMatchEngineContext_ — SECTION B: Initialize stats + load source rows
  //   3. runMatchEngineLoop_       — SECTION C: Main loop with Time Guard + batch flush
  //   4. finalizeMatchEngine_      — SECTION D: Final flush + cleanup + report
  // Preserve Behavior 100% — same lock, same loop order, same flush triggers, same stats

  // [V6.0.020 FIX] Clear any stale STOP SIGNAL before starting — prevents
  //   pipeline from immediately stopping at row 0 if a previous Emergency Stop
  //   signal was left behind (e.g., from a crashed or manually aborted run).
  //   This is a common issue: user clicks Emergency Stop → pipeline stops →
  //   signal stays in PropertiesService → next run stops at row 0.
  //   Note: This fix existed in commit 3eb4fc8 (branch fix/v6.0.012-phase1-matching)
  //   but was never merged to main — re-applied here.
  //   The stop signal is still functional DURING the run — if user clicks
  //   Emergency Stop during a run, the running loop checks it every 10 rows.
  if (typeof clearPipelineStopSignal_ === 'function') {
    clearPipelineStopSignal_();
  } else {
    try {
      PropertiesService.getScriptProperties().deleteProperty('PIPELINE_STOP_REQUESTED');
    } catch (e) {
      // ignore — non-fatal
    }
  }

  const setup = acquireMatchEngineLock_();
  if (!setup) return;

  // [V6.0.004] Pre-flight check
  if (typeof runPipelinePreflight === 'function') {
    const preflight = runPipelinePreflight();
    if (!preflight.ready) {
      const msg = 'Pipeline preflight failed:\n' + preflight.issues.join('\n');
      logWarn('MatchEngine', msg);
      if (typeof sendPipelineAlert_ === 'function') {
        sendPipelineAlert_('Pipeline preflight failed:\n' + preflight.issues.join('\n'), 'WARN');
      }
      safeUiAlert_('⚠️ Pipeline ไม่พร้อมรัน', msg);
      // Release lock + cleanup before returning
      cleanupMatchEngineRun_(setup.lock);
      return;
    }
  }

  const ctx = prepareMatchEngineContext_();
  if (ctx === null) {
    // Empty pendingRows path — release lock + cleanup + return
    cleanupMatchEngineRun_(setup.lock);
    return;
  }

  try {
    runMatchEngineLoop_(ctx, setup.startTime);
    finalizeMatchEngine_(ctx, setup.startTime, setup.lock);
  } catch (err) {
    logError('MatchEngine', `runMatchEngine ล้มเหลว: ${err.message}`, err);
    // [FIX CRIT-013] แจ้ง user ก่อน throw — ป้องกัน silent failure
    safeUiAlert_('❌ Match Engine ล้มเหลว:\n' + err.message + '\n\nกรุณาตรวจสอบ SYS_LOG');
    throw err;
  } finally {
    // [FIX CRIT-018] ล้าง alias enrichment context เมื่อ execution จบ
    // [PERF-012] Flush log buffer ก่อน execution จบ — ป้องกัน log entries สูญหาย
    cleanupMatchEngineRun_(setup.lock);
  }
}

/**
 * cleanupMatchEngineRun_ — [V6.0.052] Centralized cleanup for runMatchEngine
 *
 * รวม 3 cleanup steps ที่ซ้ำกันใน 3 จุด (preflight fail, empty pendingRows,
 * finally block) เป็น helper เดียว — ลด code duplication และป้องกัน
 * การแก้ไม่ครบจุดถ้า cleanup logic เปลี่ยนในอนาคต
 *
 * Steps:
 *   1. Release lock (if held)
 *   2. Reset alias enrichment context (via wrapper in 10f)
 *   3. Flush log buffer (if function exists)
 *
 * @param {object} [lock] - Lock object from acquireMatchEngineLock_
 * @private
 */
function cleanupMatchEngineRun_(lock) {
  if (lock && lock.hasLock()) lock.releaseLock();
  resetAliasEnrichmentContext_();
  if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
}

/**
 * acquireMatchEngineLock_ — [REF-004] SECTION A: Lock acquisition
 *   รักษา behavior เดิม 100% — tryLock with APP_CONST.LOCK_TIMEOUT_MS, same error messages
 * @return {{lock: object, startTime: Date}|null} null if lock cannot be acquired
 * @private
 */
function acquireMatchEngineLock_() {
  const lock = LockService.getScriptLock();
  // [FIX CRIT-009] ใช้ tryLock แทน waitLock — ไม่รอคิว แจ้ง user ทันที่ถ้า lock ไม่ได้
  // [V6.0.069] Simplified — tryLock returns boolean in GAS V8, no try-catch needed (Reviewer #2 Tip #10)
  lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS);
  if (!lock.hasLock()) {
    logWarn('MatchEngine', 'ไม่สามารถ Lock ได้ — อาจมีการรันซ้อน กรุณารันใหม่ภายหลัง');
    safeUiAlert_('⚠️ ไม่สามารถรัน Match Engine ได้ — มีการรันซ้อนอยู่\nกรุณารอให้การรันก่อนหน้าเสร็จก่อน แล้วลองใหม่');
    return null;
  }
  return { lock: lock, startTime: new Date() };
}

/**
 * prepareMatchEngineContext_ — [REF-004] SECTION B: Initialize stats + load source rows
 *   รักษา behavior เดิม 100% — resetProcessingState_, loadSourceBatch_, logInfo messages
 * @param {Date} startTime
 * @return {Object|null} context object หรือ null ถ้าไม่มี pending rows
 * @private
 */
function prepareMatchEngineContext_(startTime) {
  logInfo('MatchEngine', 'เริ่ม Match Engine');

  // [FIX v5.2.007] ลบ Checkpoint Index — เริ่มจาก 0 เสมอ
  // เหตุผล: getAllSourceRows() กรอง SUCCESS ออกอยู่แล้ว ดังนั้น Array ที่ได้จะมีเฉพาะแถวที่ยังไม่ได้ทำ
  //   Checkpoint เดิมเก็บ "ตำแหน่ง" ใน Array แต่ Array หดเล็กลงทุกรอบ ทำให้ตำแหน่งชี้ผิด → ข้อมูลถูกข้ามไป (BUG)
  resetProcessingState_(); // [REF-018] renamed from clearCheckpoint_ — ล้าง stale processing state
  const startIndex = 0;
  const pendingRows = loadSourceBatch_(); // [REF-002] Abstraction layer

  if (pendingRows.length === 0) {
    logInfo('MatchEngine', 'ไม่มีแถวที่ต้องประมวลผล');
    removeAutoResume_(); // ลบ trigger ที่ค้างอยู่ด้วย
    return null;
  }

  logInfo('MatchEngine', `ประมวลผล ${pendingRows.length} แถว (เริ่มจาก index ${startIndex})`);

  return {
    pendingRows: pendingRows,
    startIndex: startIndex,
    processed: 0,
    autoMatched: 0,
    created: 0,
    queued: 0,
    errorCount: 0,
    factBatch: [],
    reviewBatch: [],
    successRows: [],
    failedRows: [],
    personIdsToStats: new Set(),
    placeIdsToStats: new Set(),
    geoIdsToStats: new Set(),
    destStatsQueue: []
  };
}

/**
 * runMatchEngineLoop_ — [REF-004] SECTION C: Main processing loop with Time Guard + batch flush
 *   รักษา behavior เดิม 100% — same iteration order, same Time Guard (ทุก iteration), same BATCH_SIZE modulo
 * @param {Object} ctx - context from prepareMatchEngineContext_
 * @param {Date} startTime
 * @private
 */
function runMatchEngineLoop_(ctx, startTime) {
  const timeLimit = AI_CONFIG.TIME_LIMIT_MS || 5 * 60 * 1000;

  // [V6.0.007] Emergency Stop Signal Check
  //   User can request stop via menu "🛑 หยุด Pipeline (Emergency Stop)".
  //   We check every STOP_CHECK_INTERVAL rows (10) to balance responsiveness
  //   with PropertiesService read latency (~5-10ms per call).
  //   On stop: flush current batch via finalizeMatchEngine_ + clear signal +
  //   set ctx.stoppedByUser = true so finalizeMatchEngine_ removes any
  //   existing auto-resume trigger (don't want it to fire after user stop).
  const STOP_CHECK_INTERVAL = 10;
  let lastStopCheck = -STOP_CHECK_INTERVAL; // force first check at i=0

  for (let i = ctx.startIndex; i < ctx.pendingRows.length; i++) {
    if (new Date() - startTime > timeLimit) {
      logWarn('MatchEngine', `Time Guard: หยุดที่แถว ${i}/${ctx.pendingRows.length} (ติดตั้ง Auto-Trigger)`);
      // [FIX v5.2.007] ไม่บันทึก checkpoint อีกต่อไป — SYNC_STATUS ทำหน้าที่แทน
      installAutoResume_('runMatchEngine');
      return;
    }

    // [V6.0.007] Stop Signal Check — user requested emergency stop
    if (i - lastStopCheck >= STOP_CHECK_INTERVAL) {
      lastStopCheck = i;
      if (isPipelineStopRequested_()) {
        ctx.stoppedByUser = true;
        logWarn(
          'MatchEngine',
          '🛑 STOP SIGNAL: หยุดที่แถว ' +
            i +
            '/' +
            ctx.pendingRows.length +
            ' (user requested via menu) — กำลัง flush batch และปิด gracefully...'
        );
        // Clear the stop signal so the next manual run starts clean
        clearPipelineStopSignal_();
        // Return — finalizeMatchEngine_ will flush the current batch
        // and remove auto-resume trigger (because ctx.stoppedByUser = true)
        return;
      }
    }

    const srcObj = ctx.pendingRows[i];
    try {
      const result = processOneRow(srcObj);
      ctx.processed++;

      if (result.action === 'AUTO_MATCH') ctx.autoMatched++;
      if (result.action === 'CREATE_NEW') ctx.created++;
      if (result.action === 'REVIEW') ctx.queued++;

      if (result.factData) ctx.factBatch.push(result.factData);
      if (result.reviewData) ctx.reviewBatch.push(result.reviewData);

      // [PERF-001] เก็บ stats IDs ไว้อัปเดตเป็น batch ใน flushBatches_
      if (result.statsToDefer) {
        result.statsToDefer.personIds.forEach(function (id) {
          ctx.personIdsToStats.add(id);
        });
        result.statsToDefer.placeIds.forEach(function (id) {
          ctx.placeIdsToStats.add(id);
        });
        result.statsToDefer.geoIds.forEach(function (id) {
          ctx.geoIdsToStats.add(id);
        });
        result.statsToDefer.destStats.forEach(function (item) {
          ctx.destStatsQueue.push(item);
        });
      }

      ctx.successRows.push(srcObj);
    } catch (rowErr) {
      ctx.errorCount++;
      ctx.failedRows.push(srcObj);
      logError(
        'MatchEngine',
        `แถว ${srcObj.sourceRow} (Invoice hash: ${generateMd5Hash(String(srcObj.invoiceNo || '')).substring(0, 8)}): ${rowErr.message}`,
        rowErr
      );
    }

    // Batch Write & Sync Status every BATCH_SIZE
    if (ctx.processed % AI_CONFIG.BATCH_SIZE === 0 && ctx.processed > 0) {
      flushBatches_(
        ctx.factBatch,
        ctx.reviewBatch,
        ctx.successRows,
        ctx.failedRows,
        ctx.personIdsToStats,
        ctx.placeIdsToStats,
        ctx.geoIdsToStats,
        ctx.destStatsQueue
      );
      ctx.factBatch = [];
      ctx.reviewBatch = [];
      ctx.successRows = [];
      ctx.failedRows = [];
      ctx.personIdsToStats = new Set();
      ctx.placeIdsToStats = new Set();
      ctx.geoIdsToStats = new Set();
      ctx.destStatsQueue = [];
    }
  }
}

/**
 * finalizeMatchEngine_ — [REF-004] SECTION D: Final flush + cleanup + report
 *   รักษา behavior เดิม 100% — same final flush, same removeAutoResume_ condition, same log format
 * @param {Object} ctx
 * @param {Date} startTime
 * @param {object} lock
 * @private
 */
function finalizeMatchEngine_(ctx, startTime, lock) {
  // Final Flush
  flushBatches_(
    ctx.factBatch,
    ctx.reviewBatch,
    ctx.successRows,
    ctx.failedRows,
    ctx.personIdsToStats,
    ctx.placeIdsToStats,
    ctx.geoIdsToStats,
    ctx.destStatsQueue
  );

  // [FIX v5.2.007] ถ้าประมวลผลครบทุกแถว → ลบ Auto-Trigger
  if (ctx.processed + ctx.errorCount >= ctx.pendingRows.length) {
    removeAutoResume_();
  }

  // [V6.0.007] Emergency Stop — remove auto-resume trigger so it doesn't fire
  //   after user explicitly stopped. Also clear any stop signal that might
  //   have been set after the loop's last check (defensive).
  if (ctx.stoppedByUser) {
    removeAutoResume_();
    clearPipelineStopSignal_();
    logInfo('MatchEngine', '🛑 Pipeline หยุดโดย user — ลบ Auto-Resume trigger + clear stop signal เรียบร้อย');
  }

  const elapsedSec = Math.round((new Date() - startTime) / 1000);
  logInfo(
    'MatchEngine',
    `เสร็จสิ้น — รัน:${ctx.processed} Match:${ctx.autoMatched} ` +
      `สร้างใหม่:${ctx.created} Review:${ctx.queued} Error:${ctx.errorCount} (${elapsedSec}s)`
  );

  // [V6.0.012 P1.6] Log run stats to PIPELINE_RUN_LOG sheet for before/after comparison
  //   Non-fatal: ถ้า logging ล้มเหลว ไม่กระทบ pipeline result
  logPipelineRun_(ctx, startTime);
}

/**
 * logPipelineRun_ — [V6.0.012 P1.6] Append run stats to PIPELINE_RUN_LOG sheet
 *   ใช้สำหรับ before/after comparison เมื่อปรับ matching algorithm
 *   Append-only: เพิ่ม row ใหม่เสมอ ไม่ update row เดิม
 *   Non-fatal: ถ้า sheet ไม่มีหรือ write ล้มเหลว จะ log warn แล้วข้ามไป
 * @param {Object} ctx - pipeline context (pendingRows, processed, autoMatched, created, queued, errorCount)
 * @param {Date} startTime - pipeline start time
 * @private
 */
function logPipelineRun_(ctx, startTime) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.PIPELINE_RUN_LOG);
    if (!sheet) {
      logDebug('MatchEngine', 'logPipelineRun_: PIPELINE_RUN_LOG sheet not found — skipping');
      return;
    }
    const elapsedSec = Math.round((new Date() - startTime) / 1000);
    const matchRate = ctx.processed > 0 ? Math.round((ctx.autoMatched / ctx.processed) * 100) : 0;
    const row = [
      new Date().getTime(), // run_id (timestamp-based millis)
      new Date(), // run_at
      APP_VERSION, // app_version
      ctx.pendingRows.length, // total_rows
      ctx.processed, // processed
      ctx.autoMatched, // auto_matched
      ctx.created, // created_new
      ctx.queued, // queued_review
      ctx.errorCount, // errors
      matchRate, // match_rate (%)
      elapsedSec, // elapsed_sec
      '' // notes (empty for auto runs)
    ];
    sheet.appendRow(row);
    logInfo(
      'MatchEngine',
      'Pipeline run logged: match_rate=' +
        matchRate +
        '%, processed=' +
        ctx.processed +
        ', auto_matched=' +
        ctx.autoMatched +
        ', elapsed=' +
        elapsedSec +
        's'
    );
  } catch (e) {
    logWarn('MatchEngine', 'logPipelineRun_ failed (non-fatal): ' + e.message);
  }
}

/**
 * [NEW v5.2.001] flushBatches_ — Internal helper for transaction writing
 * [PERF-001] เพิ่ม batch stats update parameters เพื่อลด API calls จาก O(N) เหลือ O(1) per entity type
 * [REF-002] Delegates fact+review persistence to persistResult_()
 * [FIX Phase-B #11] เพิ่มการเรียก flushGeoCacheIfDirty_() เพื่อ flush deferred geo cache invalidation
 *   ที่สะสมไว้จาก createGeoPoint ในระหว่าง batch — ลด API calls จาก N (N = createGeoPoint count)
 *   เหลือ 1 ต่อ batch
 */
function flushBatches_(
  factBatch,
  reviewBatch,
  successRows,
  failedRows,
  personIdsToStats,
  placeIdsToStats,
  geoIdsToStats,
  destStatsQueue
) {
  // [REF-002] Persist fact + review data via abstraction layer
  persistResult_(factBatch, reviewBatch);

  // [PERF-001] Batch stats updates — อ่านทั้ง column 1 ครั้ง แก้ใน RAM ทั้งหมด เขียนทีเดียว
  // ลดจาก O(N × 4 entity types × 2-3 API calls) → O(4 entity types × 2 API calls) = ~8 calls
  if (personIdsToStats && personIdsToStats.size > 0) {
    batchUpdatePersonStats_(personIdsToStats);
  }
  if (placeIdsToStats && placeIdsToStats.size > 0) {
    batchUpdatePlaceStats_(placeIdsToStats);
  }
  if (geoIdsToStats && geoIdsToStats.size > 0) {
    batchUpdateGeoStats_(geoIdsToStats);
  }
  if (destStatsQueue && destStatsQueue.length > 0) {
    batchUpdateDestinationStats_(destStatsQueue);
  }

  if (successRows.length > 0) {
    updateSyncStatus_(successRows, 'SUCCESS');
  }

  if (failedRows.length > 0) {
    updateSyncStatus_(failedRows, 'ERROR');
  }

  // [FIX Phase-B #11] Flush deferred geo cache invalidation
  //   createGeoPoint ในระหว่าง batch จะ set _GEO_CACHE_DIRTY = true แทนการ invalidate ทันที
  //   ตอนนี้ batch เสร็จแล้ว → flush ครั้งเดียวเพื่อให้ batch ถัดไปเห็นข้อมูลใหม่
  //   ใช้ typeof guard เพื่อป้องกัน error ถ้า 08_GeoService.gs ยังไม่ได้ load
  if (typeof flushGeoCacheIfDirty_ === 'function') {
    flushGeoCacheIfDirty_();
  }
}

// [V6.0.050] Moved to 10f/10g/10h: autoEnrichAliasesFromFactBatch_ + 11 helpers → 10f
//   See 10f_MatchAliasEnrichment.gs, 10g_MatchRowProcessor.gs, 10h_MatchAutoResume.gs

// [V6.0.050] Moved to 10f/10g/10h: processOneRow (SECTION 2) → 10g
//   See 10f_MatchAliasEnrichment.gs, 10g_MatchRowProcessor.gs, 10h_MatchAutoResume.gs

// ============================================================
// SECTION 3: makeMatchDecision — 8 Rules
// ============================================================

/**
 * makeMatchDecision
 * [FIX v003] Rule 1: !hasGeo (เดิม Logic ผิด)
 * [FIX v003] Rule 3: ใช้ srcObj.province แทน placeResult.normResult.province
 * [FIX v003] Rule 5: Weight รวม = 1.0 (เดิม 1.2)
 * [FIX v003] Rule 7: !isPersonOk && !isPlaceOk (เดิม hasPerson ผิด)
 */
function makeMatchDecision(srcObj, personResult, placeResult, geoResult) {
  // [V6.0.030] Refactored — extracted rules to 10b_MatchDecision.gs
  //   Audit finding 1.2: was 267 lines (single point of fragility)
  //   Now: dispatcher that tries each rule in order, returns first non-null
  //   BACKWARD COMPATIBLE: same signature, same return shape, same decisions
  //   Verified by snapshot test (V6.0.028) — 0 differences expected

  const isGeoInMaster = geoResult.status === 'FOUND';
  const isPersonInMaster = personResult.status === 'FOUND';
  const isPlaceInMaster = placeResult.status === 'FOUND' || placeResult.status === 'BRANCH_MATCH';
  const geoProvince = isGeoInMaster ? getGeoProvince_(geoResult.geoId) : '';
  const hasGeoInSource = srcObj.hasGeo;

  // Try rules in order — first non-null wins
  // Rule 1: ไม่มีพิกัดใน Source Sheet
  let decision = evaluateRule1_NoGeoInSource_(srcObj);
  if (decision) return decision;

  // Rule 2: ชื่อคุณภาพต่ำ
  decision = evaluateRule2_LowQualityData_(personResult, placeResult);
  if (decision) return decision;

  // Rule 3: จังหวัดข้ามโซน
  decision = evaluateRule3_GeoProvinceConflict_(isGeoInMaster, geoProvince, srcObj.province);
  if (decision) return decision;

  // Rule 3.5: NEARBY_PENDING (tiered spatial fuzzy)
  decision = evaluateRule3_5_NearbyPending_(geoResult);
  if (decision) return decision;

  // Rule 4: พบครบทั้ง 3 อย่าง → AUTO_MATCH (Full)
  decision = evaluateRule4_FullMatch_(
    srcObj,
    personResult,
    placeResult,
    geoResult,
    isGeoInMaster,
    isPersonInMaster,
    isPlaceInMaster
  );
  if (decision) return decision;

  // Rule 5: geo + person → AUTO_MATCH (Geo Anchor) [V6.0.016]
  decision = evaluateRule5_GeoPersonAnchor_(
    srcObj,
    personResult,
    placeResult,
    geoResult,
    isGeoInMaster,
    isPersonInMaster
  );
  if (decision) return decision;

  // Rule 5b: geo + place only → REVIEW [V6.0.016]
  decision = evaluateRule5b_GeoPlaceOnlyNoName_(
    srcObj,
    personResult,
    placeResult,
    geoResult,
    isGeoInMaster,
    isPlaceInMaster,
    isPersonInMaster
  );
  if (decision) return decision;

  // Rule 6: Fuzzy Match / Needs Review
  decision = evaluateRule6_FuzzyMatch_(srcObj, personResult, placeResult);
  if (decision) return decision;

  // Rule 7: GPS จริง + ไม่มี geo ใน master → CREATE_NEW
  decision = evaluateRule7_NewGeoWithGPS_(hasGeoInSource, isGeoInMaster);
  if (decision) return decision;

  // Rule 8: GPS จริง (default CREATE_NEW)
  decision = evaluateRule8_NewGeoFromGPS_(hasGeoInSource);
  if (decision) return decision;

  // Default fallback
  return {
    action: 'REVIEW',
    reason: 'NEW_RECORD_PENDING',
    confidence: 0,
    priority: 3
  };
}

// [V6.0.051] Moved to 10b: calcDynamicWeights_ + calculateWeightedScore + dead code comment → 10b
//   See 10b_MatchDecision.gs (SECTION: Scoring + Geo Helpers)

// [V6.0.050] Moved to 10f/10g/10h: executeDecision + handle* (SECTION 4) → 10g
//   See 10f_MatchAliasEnrichment.gs, 10g_MatchRowProcessor.gs, 10h_MatchAutoResume.gs

// ============================================================
// SECTION 5: Helper Functions
// ============================================================

// [REMOVED V5.5.044] getSameDayDestinations + _SAME_DAY_DEST_CACHE + invalidateSameDayDestCache_
//   ทั้ง 3 อย่างเป็น dead code — mark @deprecated ใน V5.5.043
//   - getSameDayDestinations: ไม่มี caller ใน .gs ใด (ตรวจด้วย grep)
//   - _SAME_DAY_DEST_CACHE: ใช้เฉพาะใน getSameDayDestinations
//   - invalidateSameDayDestCache_: ถูกเรียกใน 10_MatchEngine:1459, 12_ReviewService:319, 01_Config:106
//     แต่ทั้ง 3 caller ใช้ `typeof === 'function'` guard → จะ skip อัตโนมัติ
//   Caller cleanup:
//   - 10_MatchEngine.gs:1459 — ลบบรรทัด invalidateSameDayDestCache_()
//   - 12_ReviewService.gs:319 — ลบบรรทัด invalidateSameDayDestCache_()
//   - 01_Config.gs:106 — ลบบรรทัด invalidateSameDayDestCache_()
//   หากต้องการ restore → ดู git history ของ commit นี้

// [REMOVED V6.0.007] detectSameGeoMultiPerson — dead code since v5.4
//   ฟังก์ชันนี้ถูก implement สมบูรณ์ตั้งแต่ v5.4 แต่ไม่เคยถูก wire เข้า makeMatchDecision()
//   หรือ flow อื่นใดใน pipeline ทำให้เป็น dead code มาตลอด
//   ตั้งแต่ V5.5.042 ถูก mark เป็น "DEAD CODE — ไม่ถูกเรียกใช้ใน production"
//   ใน V6.0.007 ลบทิ้งสุดท้ายเพื่อลดความสับสน + ลด code maintenance burden
//
//   หากต้องการ restore → ดู git history ของ commit V6.0.007 (Feature 4: Dead Code Cleanup)
//   หากต้องการฟีเจอร์ "ตรวจจับหลายบุคคลใช้พิกัดเดียวกัน" → สร้างใหม่แบบ wire เข้า
//   makeMatchDecision() Rule 3.5 (NEARBY_PENDING) ตั้งแต่ต้น อย่า restore แบบเดิม
//
//   Original signature (for reference):
//   function detectSameGeoMultiPerson(geoId, currentPersonId) { ... }
//   - Returns true ถ้ามี person อื่นใช้ geoId เดียวกัน (ใน M_DESTINATION)
//   - ใช้ loadAllDestinations_() + .some() check
//
//   Reason for removal:
//   - ไม่มี caller ใน .gs ใด (ตรวจด้วย grep "detectSameGeoMultiPerson" src/ → 0 ผลลัพธ์)
//   - ฟังก์ชัน log warning ทุกครั้งที่ถูกเรียก = wasted log space
//   - BLUEPRINT.md (current version) ไม่ได้อ้างถึงฟีเจอร์นี้อีกแล้ว (V6.0 doc sync)

function getGeoProvince_(geoId) {
  if (!geoId) return '';
  const allGeos = loadAllGeos_();
  const geo = allGeos.find((g) => g.geoId === geoId);
  return geo ? geo.province || '' : '';
}

// [V6.0.051] Moved to 10b: _CANDIDATE_COORDS_CACHE_ + getCandidateResolvedCoords_ → 10b
//   See 10b_MatchDecision.gs (SECTION: Scoring + Geo Helpers)

// [V6.0.050] Moved to 10f/10g/10h: resetProcessingState_ + installAutoResume_ + stop signal (SECTION 6) → 10h
//   See 10f_MatchAliasEnrichment.gs, 10g_MatchRowProcessor.gs, 10h_MatchAutoResume.gs

// ============================================================
// SECTION 6: Abstraction Layer [REF-002]
// Thin wrappers around Group 2 calls for decoupling
// ============================================================

/**
 * loadSourceBatch_ — [REF-002] Load unprocessed rows from source
 * Thin wrapper around getUnprocessedRows() from 04_SourceRepository
 * @return {Array} Array of source objects to process
 */
function loadSourceBatch_() {
  return getUnprocessedRows();
}

/**
 * persistResult_ — [V6.0.031 REFACTOR] Wrapper สำหรับ backward compatibility
 *   ถูกแยกเป็น persistFactRows_() + persistReviewRows_() เพื่อ SRP
 *   (Audit finding 4: persistResult_ ทำ 2 หน้าที่ในฟังก์ชันเดียว)
 *
 *   Wrapper นี้คงไว้เพื่อไม่ให้ break existing callers — signature เหมือนเดิม
 *
 * @param {Array} factData - Array of fact row arrays to write to FACT_DELIVERY
 * @param {Array} reviewData - Array of review row arrays to write to Q_REVIEW
 */
function persistResult_(factData, reviewData) {
  persistFactRows_(factData);
  persistReviewRows_(reviewData);
}

/**
 * persistFactRows_ — [V6.0.031 EXTRACTED] เขียน FACT_DELIVERY rows + auto-enrich aliases
 *   แยกจาก persistResult_ เพื่อ Single Responsibility
 * @param {Array} factData - Array of fact row arrays (empty array = no-op)
 * @private
 */
function persistFactRows_(factData) {
  if (!factData || factData.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  factSheet.getRange(factSheet.getLastRow() + 1, 1, factData.length, factData[0].length).setValues(factData);

  // [FIX CRIT-003] ล้าง FACT invoice RAM cache เพราะมีแถวใหม่ถูกเขียน
  if (typeof invalidateFactInvoiceCache_ === 'function') invalidateFactInvoiceCache_();
  // [REMOVED V5.5.044] invalidateSameDayDestCache_ — ลบ dead code (ดู comment ใน SECTION 5)

  // [UPGRADE v5.2.010] สร้าง Alias อัตโนมัติแบบ Real-time ทันทีที่บันทึก FACT สำเร็จ
  // [FIX v5.4.001] ห่อด้วย try-catch เพื่อป้องกัน alias error ทำให้ SYNC_STATUS ไม่ถูกอัปเดต
  try {
    autoEnrichAliasesFromFactBatch_(factData);
  } catch (aliasErr) {
    // [SEC-006 FIX] Mask invoice numbers — log เฉพาะจำนวน + ตัวอย่างแรก (3 ตัวแรก + ***)
    const failedInvoices = factData
      .map(function (r) {
        return normalizeInvoiceNo(r[FACT_IDX.INVOICE_NO]);
      })
      .filter(Boolean);
    const sampleMasked = failedInvoices[0] ? String(failedInvoices[0]).substring(0, 3) + '***' : 'n/a';
    logError(
      'MatchEngine',
      'autoEnrichAliases ล้มเหลว — M_ALIAS ขาดสำหรับ ' +
        failedInvoices.length +
        ' invoices ' +
        '(ตัวอย่างแรก: ' +
        sampleMasked +
        '). ' +
        'กรุณารัน generatePersonAliasesFromHistory เพื่อซ่อมแซม: ' +
        aliasErr.message,
      aliasErr
    );
  }
}

/**
 * persistReviewRows_ — [V6.0.031 EXTRACTED] เขียน Q_REVIEW rows + ระบายสีตาม issue_type
 *   แยกจาก persistResult_ เพื่อ Single Responsibility
 * @param {Array} reviewData - Array of review row arrays (empty array = no-op)
 * @private
 */
function persistReviewRows_(reviewData) {
  if (!reviewData || reviewData.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const reviewSheet = ss.getSheetByName(SHEET.Q_REVIEW);
  const startRow = reviewSheet.getLastRow() + 1;
  const numCols = reviewData[0].length;
  reviewSheet.getRange(startRow, 1, reviewData.length, numCols).setValues(reviewData);

  // [UPGRADE v5.2.005] ระบายสีแถว Q_REVIEW ตาม issue_type
  const backgrounds = reviewData.map((row) => {
    const issueType = String(row[REVIEW_IDX.ISSUE_TYPE] || '').trim();
    let color = null;
    if (issueType === 'GEO_NEARBY_YELLOW') color = '#fff2cc';
    else if (issueType === 'GEO_NEARBY_ORANGE') color = '#fce5cd';
    return new Array(numCols).fill(color);
  });
  reviewSheet.getRange(startRow, 1, reviewData.length, numCols).setBackgrounds(backgrounds);
}

// ============================================================
// SECTION 7: Group 1 Gateway [REF-001]
// resolveAndPersist_ — Encapsulates resolve-create-enrich-upsert sequence
// so Group 2 (ReviewService) doesn't call Group 1 CRUD directly
// ============================================================

// ============================================================
// SECTION 8: Tie-breaker — Geofencing Multi-Candidate [V6.0.002]
//   Resolve ties between candidates with similar scores using
//   driver history + street distance as secondary signals.
//   Invoked from processOneRow when personResult.status === 'NEEDS_REVIEW'.
// ============================================================

/**
 * breakTieAmongCandidates — [V6.0.002] Resolve tie between candidates with similar scores
 *   When top candidates have score within ±2, use driver history + street distance as tie-breaker
 * @param {Array} candidates - array of { personId, placeId, geoId, destId, score, resolvedLat, resolvedLng }
 * @param {Object} srcObj - source row
 * @return {Object} chosen candidate (mutated with tiebreaker info)
 */
function breakTieAmongCandidates(candidates, srcObj) {
  if (!candidates || candidates.length <= 1) return candidates ? candidates[0] : null;

  // Filter to top candidates within ±2 score
  const topScore = candidates[0].score;
  const tied = candidates.filter((c) => topScore - c.score <= 2);
  if (tied.length === 1) return tied[0];

  // Tie-breaker 1: Driver history (same driver visited this destination before)
  if (srcObj.driverName) {
    const driverHistory = getDriverHistory_(srcObj.driverName);
    if (driverHistory.length > 0) {
      for (const c of tied) {
        if (c.destId && driverHistory.some((h) => h.destId === c.destId)) {
          c.score += 5;
          c.tiebreaker = 'driver_history';
        }
      }
    }
  }

  // Tie-breaker 2: Street distance (if scores still tied)
  const stillTied = tied.filter((c) => c.score === Math.max(...tied.map((t) => t.score)));
  if (stillTied.length > 1 && srcObj.rawLat && srcObj.rawLng) {
    for (const c of stillTied) {
      if (c.resolvedLat && c.resolvedLng) {
        const streetDist = getStreetDistance_(srcObj.rawLat, srcObj.rawLng, c.resolvedLat, c.resolvedLng);
        if (streetDist !== null) {
          c.streetDistM = streetDist;
        }
      }
    }
    const withDist = stillTied.filter((c) => c.streetDistM !== undefined);
    if (withDist.length > 1) {
      withDist.sort((a, b) => a.streetDistM - b.streetDistM);
      withDist[0].score += 3;
      withDist[0].tiebreaker = (withDist[0].tiebreaker || '') + '+street_dist';
    }
  }

  // Sort and return top
  tied.sort((a, b) => b.score - a.score);
  return tied[0];
}

/**
 * getDriverHistory_ — [V6.0.002] Query FACT_DELIVERY for driver's past destinations
 * @param {string} driverName
 * @return {Array} array of { destId, personId, deliveryDate }
 * @private
 */
function getDriverHistory_(driverName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
    if (!sheet || sheet.getLastRow() < 2) return [];

    const cols = Math.min(SCHEMA[SHEET.FACT_DELIVERY].length, sheet.getLastColumn());
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols).getValues();
    const history = [];

    for (let i = 0; i < data.length; i++) {
      const rowDriver = String(data[i][FACT_IDX.DRIVER_NAME] || '').trim();
      if (rowDriver !== driverName) continue;
      const destId = String(data[i][FACT_IDX.DEST_ID] || '').trim();
      const personId = String(data[i][FACT_IDX.PERSON_ID] || '').trim();
      if (destId) {
        history.push({ destId: destId, personId: personId, deliveryDate: data[i][FACT_IDX.DELIVERY_DATE] });
      }
    }
    return history;
  } catch (e) {
    logError('MatchEngine', 'getDriverHistory_ failed: ' + e.message, e);
    return [];
  }
}

/**
 * getStreetDistance_ — [V6.0.002] Get street distance via Google Maps API
 *   Uses cache (6h TTL) to reduce API calls.
 *   NOTE: GOOGLEMAPS_DISTANCE returns a string like "15.2 km" — we parse it
 *   to meters; if parsing fails we fall back to Haversine (always available).
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @return {number|null} distance in meters, or null if unavailable
 * @private
 */
function getStreetDistance_(lat1, lng1, lat2, lng2) {
  const cacheKey = 'street_dist_' + lat1 + '_' + lng1 + '_' + lat2 + '_' + lng2;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return Number(cached);

  try {
    // Use existing GOOGLEMAPS_DISTANCE custom function from 15_GoogleMapsAPI.gs
    if (typeof GOOGLEMAPS_DISTANCE === 'function') {
      const dist = GOOGLEMAPS_DISTANCE(lat1 + ',' + lng1, lat2 + ',' + lng2, 'driving');
      // [V6.0.002] GOOGLEMAPS_DISTANCE returns a string like "15.2 km" or "850 m".
      //   Parse to meters so the cache + tie-breaker logic can use a numeric value.
      const meters = parseDistanceStringToMeters_(dist);
      if (meters !== null) {
        cache.put(cacheKey, String(meters), 6 * 60 * 60); // 6h TTL
        return meters;
      }
    }
  } catch (e) {
    logDebug('MatchEngine', 'getStreetDistance_ failed (fallback to Haversine): ' + e.message);
  }

  // Fallback: Haversine distance (less accurate but always available)
  const havDist = haversineDistanceM(lat1, lng1, lat2, lng2);
  return havDist;
}

/**
 * parseDistanceStringToMeters_ — [V6.0.002] Parse GOOGLEMAPS_DISTANCE output to meters
 *   Handles formats: "15.2 km", "850 m", "1,200 m", "0.5 km"
 * @param {string} distStr - distance string from GOOGLEMAPS_DISTANCE
 * @return {number|null} meters, or null if parsing fails
 * @private
 */
function parseDistanceStringToMeters_(distStr) {
  if (!distStr || typeof distStr !== 'string') return null;
  const s = distStr.trim().toLowerCase();
  // km match — e.g. "15.2 km"
  const kmMatch = s.match(/^([\d.]+)\s*km$/);
  if (kmMatch) {
    const val = Number(kmMatch[1]);
    if (!isNaN(val)) return Math.round(val * 1000);
  }
  // m match — e.g. "850 m" or "1,200 m"
  const mMatch = s.match(/^([\d,.]+)\s*m$/);
  if (mMatch) {
    const val = Number(mMatch[1].replace(/,/g, ''));
    if (!isNaN(val)) return Math.round(val);
  }
  return null;
}

// ============================================================
// SECTION: [REF-001] Group 1 Public Helpers for Reproc Flow
//   expose resolve-or-create operations โดยไม่ upsert FACT_DELIVERY
//   เพื่อให้ Group 2 (12_ReviewService.reprocessReviewQueue) เรียกผ่าน public interface
//   แทนการเรียก createPerson/createPlace/createDestination โดยตรง (Module Boundary)
//   Preserve Behavior 100% — เรียก create* ภายในเหมือนเดิม แค่ผ่าน wrapper
// ============================================================

// ============================================================
// SECTION: [V6.0.012 P1.7] Test Match Dry Run
//   รัน matching algorithm บน SOURCE data โดยไม่บันทึกผลลัพธ์ลง master sheets
//   ใช้สำหรับ comparison ก่อน/หลังเปลี่ยน matching algorithm
//   ⚠️ ไม่เรียก executeDecision() หรือ flushBatches_() — ไม่เขียน master sheets
// ============================================================
