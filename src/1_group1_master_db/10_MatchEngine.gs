/**
 * VERSION: 6.0.001
 * FILE: 10_MatchEngine.gs
 * LMDS V5.5 — Core Match & Resolution Engine
 * ===================================================
 * PURPOSE:
 *   ประมวลผลข้อมูลต้นทาง → จับคู่ Person/Place/Geo → ตัดสินใจ → บันทึกผล
 *   เป็นหัวใจหลักของ Pipeline และเป็น Single Writer สำหรับ M_ALIAS
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
 *     - 01_Config.gs          (SHEET.*, FACT_IDX.*, ALIAS_IDX.*, AI_CONFIG)
 *     - 02_Schema.gs          (SCHEMA definitions)
 *     - 03_SetupSheets.gs     (logInfo, logWarn, logError)
 *     - 05_NormalizeService.gs (normalizeForCompare)
 *     - 14_Utils.gs           (generateShortId)
 *   CALLS (Invokes):
 *     - resolvePerson()                    → 06_PersonService.gs
 *     - resolvePlace()                     → 07_PlaceService.gs
 *     - resolveGeo()                       → 08_GeoService.gs
 *     - createPerson()                     → 06_PersonService.gs
 *     - createPlace()                      → 07_PlaceService.gs
 *     - createGeoPoint()                   → 08_GeoService.gs
 *     - resolveDestination() / createDestination() → 09_DestinationService.gs
 *     - upsertFactDelivery()               → 11_TransactionService.gs
 *     - enqueueReview()                    → 12_ReviewService.gs
 *     - loadAllPersons_()                  → 06_PersonService.gs
 *     - loadAllPlaces_()                   → 07_PlaceService.gs
 *     - loadAllAliases_()                  → 06_PersonService.gs
 *     - loadAllPlaceAliases_()             → 07_PlaceService.gs
 *     - getUnprocessedRows()               → 04_SourceRepository.gs (Group 2)
 *     - updateSyncStatus_()                → 04_SourceRepository.gs (Group 2)
 *     - toThaiDateStr()                    → 14_Utils.gs (Group 0)
 *   EXPORTS TO:
 *     - 00_App.gs             (runMatchEngine — Pipeline menu)
 *   SHEETS ACCESSED (Read + Write):
 *     - SHEET.FACT_DELIVERY   (Read: FACT_IDX, Write: batch append)
 *     - SHEET.Q_REVIEW        (Write: batch append with color)
 *     - SHEET.M_ALIAS         (Write: Single Writer — PERSON canonical/variant + PLACE canonical/variant)
 *     - SHEET.M_PERSON_ALIAS  (Write: variant names only)
 *     - SHEET.M_PLACE_ALIAS   (Write: variant addresses only)
 *   ⚠️ SINGLE WRITER RULE:
 *     - M_ALIAS ถูกเขียนที่นี่เท่านั้น (autoEnrichAliasesFromFactBatch_)
 *     - ห้ามเรียก createGlobalAlias() ใน auto pipeline
 *     - createGlobalAlias() ใช้สำหรับ Migration/Admin เท่านั้น
 * ===================================================
 * ARCHITECTURE:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  10_MatchEngine.gs (Pipeline Core + M_ALIAS Single Writer)  │
 *   │  ├── runMatchEngine()       — Main entry (Lock + Time Guard)│
 *   │  ├── processOneRow()        — Resolve → Decide → Execute    │
 *   │  ├── makeMatchDecision()    — 8 Rules (INVALID→FULL_MATCH)  │
 *   │  ├── executeDecision()      — AUTO_MATCH / CREATE_NEW / REVIEW│
 *   │  ├── flushBatches_()        — Transaction write (FACT+Alias) │
 *   │  │   └── autoEnrichAliasesFromFactBatch_()  ← SINGLE WRITER │
 *   │  │       ├── M_ALIAS (PERSON canon+variant, PLACE canon+var)│
 *   │  │       ├── M_PERSON_ALIAS (variant ≠ canonical only)      │
 *   │  │       └── M_PLACE_ALIAS  (variant ≠ canonical only)      │
 *   │  └── Auto-Resume (installAutoResume_ / removeAutoResume_)   │
 *   └─────────────────────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 1: runMatchEngine
// ============================================================

// [FIX CRIT-018] Module-level cache สำหรับ alias enrichment context
// ลดการอ่านชีตซ้ำซ้อนเมื่อ flushBatches_ เรียก autoEnrich หลายครั้งใน execution เดียวกัน
let _ALIAS_ENRICHMENT_CONTEXT = null;

/**
 * [FIX CRIT-005] เพิ่ม entity ใหม่เข้า alias enrichment context แบบ incremental
 * เรียกจาก handleCreateNew_ หลังสร้าง Person/Place สำเร็จ
 * ทำให้ entity ใหม่มี alias ทันทีใน batch flush รอบเดียวกัน
 * @param {string} entityType - 'PERSON' หรือ 'PLACE'
 * @param {string} entityId - personId หรือ placeId
 * @param {string} masterUuid - UUID v4
 * @param {string} canonical - Canonical name
 * @param {string} normalized - Normalized name
 */
function addEntityToEnrichmentContext_(entityType, entityId, masterUuid, canonical, normalized) {
  if (!_ALIAS_ENRICHMENT_CONTEXT) return;
  if (entityType === 'PERSON' && entityId) {
    _ALIAS_ENRICHMENT_CONTEXT.personMap[entityId] = {
      canonical: canonical,
      normalized: normalized,
      masterUuid: masterUuid
    };
  } else if (entityType === 'PLACE' && entityId) {
    _ALIAS_ENRICHMENT_CONTEXT.placeMap[entityId] = {
      canonical: canonical,
      normalized: normalized,
      masterUuid: masterUuid
    };
  }
}

function runMatchEngine() {
  // [REF-004] V5.5.019: Refactored into 4 section helpers for Separation of Concerns
  //   1. acquireMatchEngineLock_   — SECTION A: Lock + AuthZ
  //   2. prepareMatchEngineContext_ — SECTION B: Initialize stats + load source rows
  //   3. runMatchEngineLoop_       — SECTION C: Main loop with Time Guard + batch flush
  //   4. finalizeMatchEngine_      — SECTION D: Final flush + cleanup + report
  // Preserve Behavior 100% — same lock, same loop order, same flush triggers, same stats

  const setup = acquireMatchEngineLock_();
  if (!setup) return;

  const ctx = prepareMatchEngineContext_();
  if (ctx === null) {
    // Empty pendingRows path — release lock + cleanup + return
    if (setup.lock && setup.lock.hasLock()) setup.lock.releaseLock();
    _ALIAS_ENRICHMENT_CONTEXT = null;
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
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
    if (setup.lock && setup.lock.hasLock()) setup.lock.releaseLock();
    // [FIX CRIT-018] ล้าง alias enrichment context เมื่อ execution จบ
    _ALIAS_ENRICHMENT_CONTEXT = null;
    // [PERF-012] Flush log buffer ก่อน execution จบ — ป้องกัน log entries สูญหาย
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
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
  try {
    lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS);
  } catch (e) {
    logWarn('MatchEngine', 'ไม่สามารถ Lock ได้ — อาจมีการรันซ้อน กรุณารันใหม่ภายหลัง');
    safeUiAlert_('⚠️ ไม่สามารถรัน Match Engine ได้ — มีการรันซ้อนอยู่\nกรุณารอให้การรันก่อนหน้าเสร็จก่อน แล้วลองใหม่');
    return null;
  }
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

  for (let i = ctx.startIndex; i < ctx.pendingRows.length; i++) {
    if (new Date() - startTime > timeLimit) {
      logWarn('MatchEngine', `Time Guard: หยุดที่แถว ${i}/${ctx.pendingRows.length} (ติดตั้ง Auto-Trigger)`);
      // [FIX v5.2.007] ไม่บันทึก checkpoint อีกต่อไป — SYNC_STATUS ทำหน้าที่แทน
      installAutoResume_('runMatchEngine');
      return;
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

  const elapsedSec = Math.round((new Date() - startTime) / 1000);
  logInfo(
    'MatchEngine',
    `เสร็จสิ้น — รัน:${ctx.processed} Match:${ctx.autoMatched} ` +
      `สร้างใหม่:${ctx.created} Review:${ctx.queued} Error:${ctx.errorCount} (${elapsedSec}s)`
  );
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

/**
 * autoEnrichAliasesFromFactBatch_ — [REWRITE v5.4.001] Single Writer Pattern
 * ============================================================
 * 🟩 จุดเขียนเดียวสำหรับ M_ALIAS — ทุก alias เกิดที่นี่เท่านั้น
 * ============================================================
 * ทำงานอัตโนมัติเมื่อมี Fact ใหม่ → สร้าง alias ใน:
 *   1. M_ALIAS (Global) — PERSON canonical(100) + variant(95), PLACE canonical(100) + variant(90)
 *   2. M_PERSON_ALIAS  — variant name (ถ้า ≠ canonical)
 *   3. M_PLACE_ALIAS   — variant address (ถ้า ≠ canonical)
 *
 * ❌ ไม่เรียก createGlobalAlias() / syncAliasToEntityTable_()
 * ❌ ไม่เรียก createPersonAlias() / createPlaceAlias()
 * ✅ เขียน Batch ตรงทั้ง 3 ชีตเอง — เร็ว + ไม่มี circular dependency
 * ✅ รวม Canonical Name เข้า M_ALIAS ด้วย (เดิมข้าม → ทำให้ค้นไม่เจอ)
 */
function autoEnrichAliasesFromFactBatch_(factBatch) {
  if (!factBatch || factBatch.length === 0) return;

  try {
    // 1. เตรียมข้อมูล (Extract Data Loading)
    const context = prepareAliasEnrichmentData_();

    // 2. ประมวลผลหา Alias ใหม่ (Extract Processing Logic)
    const results = processFactRowsForAliases_(factBatch, context);

    // 3. บันทึกผลลงฐานข้อมูล (Extract Writing Logic)
    commitAliasChanges_(results, context);

    // 4. Log
    const totalGlobal = results.globalAliasRows.length;
    const totalPerson = results.personAliasRows.length;
    const totalPlace = results.placeAliasRows.length;

    if (totalGlobal > 0 || totalPerson > 0 || totalPlace > 0) {
      logInfo(
        'MatchEngine',
        'Auto-Enrich (Single Writer v5.4.001): ' +
          'M_ALIAS=' +
          totalGlobal +
          ' M_PERSON_ALIAS=' +
          totalPerson +
          ' M_PLACE_ALIAS=' +
          totalPlace
      );
    }
  } catch (err) {
    logError('autoEnrichAliasesFromFactBatch_', err.message, err);
    throw err;
  }
}

/**
 * [Helper 1] โหลดและเตรียม Map ข้อมูลจาก Sheets
 * @returns {Object} context object พร้อม entity maps และ alias sets
 */
function prepareAliasEnrichmentData_() {
  // [FIX CRIT-018] ใช้ cached context ถ้ามีอยู่แล้ว — ลดการอ่านชีตซ้ำซ้อน
  if (_ALIAS_ENRICHMENT_CONTEXT) return _ALIAS_ENRICHMENT_CONTEXT;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Person map: personId → { canonical, normalized, masterUuid }
  const allPersons = loadAllPersons_();
  const personMap = {};
  allPersons.forEach(function (p) {
    if (p.personId && p.masterUuid) {
      personMap[p.personId] = {
        canonical: p.canonical,
        normalized: p.normalized,
        masterUuid: p.masterUuid
      };
    }
  });

  // Place map: placeId → { canonical, normalized, masterUuid }
  const allPlaces = loadAllPlaces_();
  const placeMap = {};
  allPlaces.forEach(function (p) {
    if (p.placeId && p.masterUuid) {
      placeMap[p.placeId] = {
        canonical: p.canonical,
        normalized: p.normalized,
        masterUuid: p.masterUuid
      };
    }
  });

  // === 2. โหลด Alias ที่มีอยู่แล้ว เพื่อ Dedup ===
  const dedupSets = matchBuildDedupSets_();
  const existingPersonAliasSet = dedupSets.existingPersonAliasSet;
  const existingPlaceAliasSet = dedupSets.existingPlaceAliasSet;
  const existingGlobalAliasSet = dedupSets.existingGlobalAliasSet;
  const mAliasSheet = ss.getSheetByName(SHEET.M_ALIAS);

  const contextObj = {
    ss: ss,
    personMap: personMap,
    placeMap: placeMap,
    existingPersonAliasSet: existingPersonAliasSet,
    existingPlaceAliasSet: existingPlaceAliasSet,
    existingGlobalAliasSet: existingGlobalAliasSet,
    mAliasSheet: mAliasSheet
  };

  // [FIX CRIT-018] Cache the context for reuse within same execution
  _ALIAS_ENRICHMENT_CONTEXT = contextObj;

  return contextObj;
}

/**
 * matchBuildDedupSets_ — [F-11] สร้าง Dedup Sets สำหรับ alias enrichment
 * แยกออกจาก prepareAliasEnrichmentData_() เพื่อ SRP
 * @returns {Object} { existingPersonAliasSet, existingPlaceAliasSet, existingGlobalAliasSet }
 */
function matchBuildDedupSets_() {
  // M_PERSON_ALIAS dedup: "personId::normalized"
  const existingPersonAliasSet = new Set();
  const existingPersonAliasData = loadAllAliases_();
  existingPersonAliasData.forEach(function (r) {
    if (!r[PERSON_ALIAS_IDX.ACTIVE_FLAG]) return;
    const pId = String(r[PERSON_ALIAS_IDX.PERSON_ID] || '').trim();
    const aNorm = normalizeForCompare(r[PERSON_ALIAS_IDX.ALIAS_NAME]);
    if (pId && aNorm) existingPersonAliasSet.add(pId + '::' + aNorm);
  });

  // M_PLACE_ALIAS dedup: "placeId::normalized"
  const existingPlaceAliasSet = new Set();
  const existingPlaceAliasData = loadAllPlaceAliases_();
  existingPlaceAliasData.forEach(function (r) {
    if (!r[PLACE_ALIAS_IDX.ACTIVE_FLAG]) return;
    const plId = String(r[PLACE_ALIAS_IDX.PLACE_ID] || '').trim();
    const aNorm = normalizeForCompare(r[PLACE_ALIAS_IDX.ALIAS_NAME]);
    if (plId && aNorm) existingPlaceAliasSet.add(plId + '::' + aNorm);
  });

  // M_ALIAS dedup: "ENTITY_TYPE::masterUuid::normalized"
  // [PERF-008] ใช้ buildGlobalAliasDedupSet_() แทนการอ่าน Sheet ตรง — ใช้ cache ที่มีอยู่แล้ว
  const existingGlobalAliasSet = buildGlobalAliasDedupSet_();

  return {
    existingPersonAliasSet: existingPersonAliasSet,
    existingPlaceAliasSet: existingPlaceAliasSet,
    existingGlobalAliasSet: existingGlobalAliasSet
  };
}

/**
 * [Helper 2] วนลูปตรวจสอบ Fact Rows และสร้าง Row ใหม่
 * @param {Array} factBatch - แถวข้อมูลจาก M_FACT
 * @param {Object} context - ข้อมูลที่เตรียมจาก prepareAliasEnrichmentData_()
 * @returns {Object} results object พร้อม rows ใหม่ทั้ง 3 ประเภท
 */
function processFactRowsForAliases_(factBatch, context) {
  const personMap = context.personMap;
  const placeMap = context.placeMap;

  const newGlobalAliasRows = []; // M_ALIAS
  const newPersonAliasRows = []; // M_PERSON_ALIAS
  const newPlaceAliasRows = []; // M_PLACE_ALIAS
  const now = new Date();

  factBatch.forEach(function (r) {
    const pId = String(r[FACT_IDX.PERSON_ID] || '').trim();
    const plId = String(r[FACT_IDX.PLACE_ID] || '').trim();
    const pInfo = pId ? personMap[pId] : null;
    const plInfo = plId ? placeMap[plId] : null;

    // ─── PERSON: Canonical + Variant ───
    if (pInfo) {
      matchEnrichPersonAliases_(r, pInfo, context, newGlobalAliasRows, newPersonAliasRows, now);
    }

    // ─── PLACE: Canonical + Variant ───
    if (plInfo) {
      matchEnrichPlaceAliases_(r, plInfo, context, newGlobalAliasRows, newPlaceAliasRows, now);
    }

    // [ADD v5.5.014] ─── DRIVER VERIFIED: ชื่อจริง/ที่อยู่จริง → M_ALIAS ───
    // ถ้ามี "ชื่อจริง" (col 32) และ Person match ได้ → สร้าง alias "ชื่อจริง" → master_uuid
    // ถ้ามี "ที่อยู่จริง" (col 33) และ Place match ได้ → สร้าง alias "ที่อยู่จริง" → master_uuid
    const driverVerifiedName = String(r[FACT_IDX.DRIVER_VERIFIED_NAME] || '').trim();
    const driverVerifiedAddr = String(r[FACT_IDX.DRIVER_VERIFIED_ADDR] || '').trim();

    if (driverVerifiedName && pInfo) {
      // สร้าง alias สำหรับ "ชื่อจริง" → Person master_uuid
      matchEnrichEntityAliases_(
        'PERSON',
        pId,
        pInfo.masterUuid,
        pInfo.canonical,
        pInfo.normalized,
        driverVerifiedName,
        100, // confidence=100 เพราะคนขับยืนยันเอง
        {
          existingGlobalAliasSet: context.existingGlobalAliasSet,
          entityAliasSet: context.existingPersonAliasSet,
          source: 'DRIVER_VERIFIED'
        },
        newGlobalAliasRows,
        newPersonAliasRows,
        now
      );
    }

    if (driverVerifiedAddr && plInfo) {
      // สร้าง alias สำหรับ "ที่อยู่จริง" → Place master_uuid
      matchEnrichEntityAliases_(
        'PLACE',
        plId,
        plInfo.masterUuid,
        plInfo.canonical,
        plInfo.normalized,
        driverVerifiedAddr,
        100, // confidence=100 เพราะคนขับยืนยันเอง
        {
          existingGlobalAliasSet: context.existingGlobalAliasSet,
          entityAliasSet: context.existingPlaceAliasSet,
          source: 'DRIVER_VERIFIED'
        },
        newGlobalAliasRows,
        newPlaceAliasRows,
        now
      );
    }
  });

  return {
    globalAliasRows: newGlobalAliasRows,
    personAliasRows: newPersonAliasRows,
    placeAliasRows: newPlaceAliasRows
  };
}

/**
 * matchEnrichEntityAliases_ — [REF-015] Generic alias enricher for both Person and Place
 * Replaces duplicate logic in matchEnrichPersonAliases_ and matchEnrichPlaceAliases_.
 * @param {string} entityType - 'PERSON' or 'PLACE'
 * @param {string} entityId - person_id or place_id
 * @param {string} masterUuid - master UUID for the entity
 * @param {string} canonical - Canonical name (clean version)
 * @param {string} canonicalNorm - Normalized canonical name
 * @param {string} rawVariant - Raw variant name/address from source
 * @param {number} variantConfidence - Confidence score for variant (95 for PERSON, 90 for PLACE)
 * @param {Object} context - { existingGlobalAliasSet, entityAliasSet, source }
 * @param {Array} globalRows - M_ALIAS accumulator
 * @param {Array} entityRows - M_PERSON_ALIAS or M_PLACE_ALIAS accumulator
 * @param {Date} now - timestamp
 */
function matchEnrichEntityAliases_(
  entityType,
  entityId,
  masterUuid,
  canonical,
  canonicalNorm,
  rawVariant,
  variantConfidence,
  context,
  globalRows,
  entityRows,
  now
) {
  const entityAliasSet = context.entityAliasSet;

  // 3a/3c. Canonical Name → M_ALIAS (confidence 100)
  if (canonicalNorm && canonicalNorm.length >= 2) {
    const canonKey = entityType + '::' + masterUuid + '::' + canonicalNorm;
    if (!context.existingGlobalAliasSet.has(canonKey)) {
      context.existingGlobalAliasSet.add(canonKey);
      globalRows.push([
        generateShortId('A'),
        masterUuid,
        canonical,
        entityType,
        100,
        context.source || 'AUTO_ENRICH_FACT',
        now,
        true
      ]);
    }
  }

  // 3b/3d. Variant → M_ALIAS + Entity Alias
  if (rawVariant && rawVariant.length >= 2) {
    const rawNorm = normalizeForCompare(rawVariant);
    if (rawNorm && rawNorm.length >= 2) {
      // M_ALIAS variant
      const variantKey = entityType + '::' + masterUuid + '::' + rawNorm;
      if (!context.existingGlobalAliasSet.has(variantKey)) {
        context.existingGlobalAliasSet.add(variantKey);
        globalRows.push([
          generateShortId('A'),
          masterUuid,
          rawVariant,
          entityType,
          variantConfidence,
          context.source || 'AUTO_ENRICH_FACT',
          now,
          true
        ]);
      }

      // Entity-specific alias (เฉพาะ variant ≠ canonical)
      if (rawNorm !== canonicalNorm) {
        const eaKey = entityId + '::' + rawNorm;
        if (!entityAliasSet.has(eaKey)) {
          entityAliasSet.add(eaKey);
          const entityPrefix = entityType === 'PERSON' ? 'PA' : 'PLA';
          entityRows.push([generateShortId(entityPrefix), entityId, rawVariant, variantConfidence, now, true]);
        }
      }
    }
  }
}

/**
 * matchEnrichPersonAliases_ — [REF-015] Thin wrapper → matchEnrichEntityAliases_
 * Preserves original signature for backward compatibility.
 * @param {Array} factRow - แถวข้อมูลจาก M_FACT
 * @param {Object} pInfo - { canonical, normalized, masterUuid } จาก personMap
 * @param {Object} context - dedup sets + maps
 * @param {Array} globalRows - shared M_ALIAS accumulator (mutated in-place)
 * @param {Array} personRows - shared M_PERSON_ALIAS accumulator (mutated in-place)
 * @param {Date} now - timestamp
 */
function matchEnrichPersonAliases_(factRow, pInfo, context, globalRows, personRows, now) {
  const pId = String(factRow[FACT_IDX.PERSON_ID] || '').trim();
  const rawPersonName = String(factRow[FACT_IDX.SHIP_TO_NAME] || '').trim();
  matchEnrichEntityAliases_(
    'PERSON',
    pId,
    pInfo.masterUuid,
    pInfo.canonical,
    pInfo.normalized,
    rawPersonName,
    95,
    {
      existingGlobalAliasSet: context.existingGlobalAliasSet,
      entityAliasSet: context.existingPersonAliasSet,
      source: 'AUTO_ENRICH_FACT'
    },
    globalRows,
    personRows,
    now
  );
}

/**
 * matchEnrichPlaceAliases_ — [REF-015] Thin wrapper → matchEnrichEntityAliases_
 * Preserves original signature for backward compatibility.
 * @param {Array} factRow - แถวข้อมูลจาก M_FACT
 * @param {Object} plInfo - { canonical, normalized, masterUuid } จาก placeMap
 * @param {Object} context - dedup sets + maps
 * @param {Array} globalRows - shared M_ALIAS accumulator (mutated in-place)
 * @param {Array} placeRows - shared M_PLACE_ALIAS accumulator (mutated in-place)
 * @param {Date} now - timestamp
 */
function matchEnrichPlaceAliases_(factRow, plInfo, context, globalRows, placeRows, now) {
  const plId = String(factRow[FACT_IDX.PLACE_ID] || '').trim();
  const rawPlaceAddr = String(factRow[FACT_IDX.SHIP_TO_ADDR] || '').trim();
  matchEnrichEntityAliases_(
    'PLACE',
    plId,
    plInfo.masterUuid,
    plInfo.canonical,
    plInfo.normalized,
    rawPlaceAddr,
    90,
    {
      existingGlobalAliasSet: context.existingGlobalAliasSet,
      entityAliasSet: context.existingPlaceAliasSet,
      source: 'AUTO_ENRICH_FACT'
    },
    globalRows,
    placeRows,
    now
  );
}

/**
 * [Helper 3] บันทึกข้อมูลลง Sheet ทั้ง 3 แบบ Batch
 * [F-12] Delegates to matchCommit* helpers for SRP
 * @param {Object} results - ผลลัพธ์จาก processFactRowsForAliases_()
 * @param {Object} context - Context ที่เตรียมไว้
 */
function commitAliasChanges_(results, context) {
  matchCommitGlobalAlias_(context.mAliasSheet, results.globalAliasRows);
  matchCommitPersonAlias_(context.ss, results.personAliasRows, context);
  matchCommitPlaceAlias_(context.ss, results.placeAliasRows, context);

  // [FIX Phase-B #16] Cleanup stale canonical aliases
  //   หลังเขียน canonical alias ใหม่ → deactivate canonical alias เก่าที่ variant_name ≠ canonical ปัจจุบัน
  //   ป้องกัน stale canonical alias หลงเหลือใน M_ALIAS หลัง user แก้ canonical_name ใน M_PERSON/M_PLACE
  cleanupStaleCanonicalAliases_(results.globalAliasRows, context);
}

/**
 * cleanupStaleCanonicalAliases_ — [FIX Phase-B #16] Deactivate stale canonical aliases
 *   ปัญหา: autoEnrichAliasesFromFactBatch_ สร้าง canonical alias ทุก batch — ถ้า user แก้ canonical_name manual
 *          → alias เก่ายัง active อยู่ → ค้นเจอ alias เก่าที่ variant_name ≠ canonical ปัจจุบัน → match ผิด
 *   วิธีแก้: หลังเขียน canonical alias ใหม่ → ค้นหา alias เก่าที่ canonical ≠ ปัจจุบัน → set active_flag=false
 *   Target criteria (only these are deactivated):
 *     - Same masterUuid + entityType
 *     - confidence == 100 (canonical)
 *     - active_flag == true
 *     - source starts with 'AUTO_ENRICH' (preserve DRIVER_VERIFIED / MANUAL / MIGRATION aliases)
 *     - normalized variant_name ≠ current canonical_norm
 *   Performance: 1 read of M_ALIAS + 1 batched getRangeList().setValue(false) per batch
 * @param {Array<Array>} newGlobalAliasRows - rows being written this batch (from results.globalAliasRows)
 * @param {Object} context - context with mAliasSheet
 */
function cleanupStaleCanonicalAliases_(newGlobalAliasRows, context) {
  try {
    if (!newGlobalAliasRows || newGlobalAliasRows.length === 0) return;
    if (typeof loadGlobalAliasAll_ !== 'function') return; // guard — AliasService must be loaded

    // 1. Collect canonical aliases being written this batch
    //    globalRow format: [aliasId, masterUuid, variantName, entityType, confidence, source, createdAt, activeFlag]
    // [FIX V5.5.048] ใช้ ALIAS_IDX.* (จาก 01_Config.gs) แทน magic numbers row[1]/row[2]/row[3]/row[4] — Law 1 (No Hardcoded Index)
    const canonicalMap = {}; // key: "entityType::masterUuid" → canonicalNorm (current canonical)
    newGlobalAliasRows.forEach(function (row) {
      const confidence = Number(row[ALIAS_IDX.CONFIDENCE] || 0);
      if (confidence !== 100) return; // only canonical aliases
      const masterUuid = String(row[ALIAS_IDX.MASTER_UUID] || '').trim();
      const entityType = String(row[ALIAS_IDX.ENTITY_TYPE] || '').trim();
      const variantName = String(row[ALIAS_IDX.VARIANT_NAME] || '').trim();
      const canonicalNorm = normalizeForCompare(variantName);
      if (!masterUuid || !entityType || !canonicalNorm) return;
      const key = entityType + '::' + masterUuid;
      // Keep the last one if multiple (shouldn't happen but safe)
      canonicalMap[key] = canonicalNorm;
    });

    const keysToCheck = Object.keys(canonicalMap);
    if (keysToCheck.length === 0) return;

    // 2. Load all M_ALIAS rows (including inactive) to find stale canonical aliases
    const allAliases = loadGlobalAliasAll_();
    if (allAliases.length === 0) return;

    // 3. Find rows to deactivate
    const rowsToDeactivate = [];
    allAliases.forEach(function (alias) {
      if (!alias.activeFlag) return; // already inactive — skip
      if (Number(alias.confidence) !== 100) return; // only canonical aliases
      const source = String(alias.source || '');
      // Only deactivate AUTO_ENRICH aliases — preserve DRIVER_VERIFIED / MANUAL / MIGRATION
      if (source.indexOf('AUTO_ENRICH') !== 0) return;

      const key = alias.entityType + '::' + alias.masterUuid;
      const currentCanonicalNorm = canonicalMap[key];
      if (!currentCanonicalNorm) return; // not in this batch — skip

      const existingNorm = normalizeForCompare(alias.variantName);
      if (existingNorm === currentCanonicalNorm) return; // matches current canonical — keep

      // Stale canonical — mark for deactivation
      rowsToDeactivate.push(alias._rowNum);
    });

    if (rowsToDeactivate.length === 0) return;

    // 4. Batch deactivate: set active_flag = false สำหรับ stale rows
    const mAliasSheet = context.mAliasSheet;
    if (!mAliasSheet) return;

    const activeFlagCol = ALIAS_IDX.ACTIVE_FLAG + 1; // 1-indexed column number
    const a1Notations = rowsToDeactivate.map(function (rn) {
      // Convert column number to letter (inline — avoid cross-module dependency)
      let col = activeFlagCol;
      let letter = '';
      let temp;
      while (col > 0) {
        temp = (col - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        col = (col - temp - 1) / 26;
      }
      return letter + rn;
    });

    mAliasSheet.getRangeList(a1Notations).setValue(false);

    // 5. Invalidate cache so next read sees deactivated rows
    if (typeof invalidateChunkedCache_ === 'function') {
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_ALL);
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_REVERSE);
    } else {
      CacheService.getScriptCache().removeAll([CACHE_KEY.GLOBAL_ALIAS_ALL, CACHE_KEY.GLOBAL_ALIAS_REVERSE]);
    }

    logInfo(
      'MatchEngine',
      'cleanupStaleCanonicalAliases_: deactivated ' +
        rowsToDeactivate.length +
        ' stale canonical aliases across ' +
        keysToCheck.length +
        ' entities'
    );
  } catch (err) {
    // Non-fatal — don't break the pipeline just because cleanup failed
    logError('cleanupStaleCanonicalAliases_', err.message, err);
  }
}

/**
 * matchCommitGlobalAlias_ — [F-12] เขียน M_ALIAS + cache invalidation
 * @param {Sheet} mAliasSheet - Sheet object สำหรับ M_ALIAS
 * @param {Array} rows - Array of row arrays สำหรับ M_ALIAS
 */
function matchCommitGlobalAlias_(mAliasSheet, rows) {
  if (rows.length > 0 && mAliasSheet) {
    mAliasSheet.getRange(mAliasSheet.getLastRow() + 1, 1, rows.length, SCHEMA[SHEET.M_ALIAS].length).setValues(rows);
    // [FIX BUG-C01 V5.5.022] Use invalidateChunkedCache_ instead of removeAll
    //   เดิมใช้ removeAll เฉพาะ base keys ทำให้ chunk keys (_CHUNKS, _0, _1, ...) ตกค้าง
    //   loadGlobalAliasesMap_/loadGlobalAliasReverseIndex_ อ่านจาก chunk keys เก่า → stale alias data
    //   ทำให้ fastLookupByShipToName ไม่เจอ alias ใหม่จนกว่า TTL จะหมด
    if (typeof invalidateChunkedCache_ === 'function') {
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_ALL);
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_REVERSE);
    } else {
      CacheService.getScriptCache().removeAll([CACHE_KEY.GLOBAL_ALIAS_ALL, CACHE_KEY.GLOBAL_ALIAS_REVERSE]);
    }
  }
}

/**
 * matchCommitPersonAlias_ — [F-12] เขียน M_PERSON_ALIAS + cache + dedup update
 * @param {Spreadsheet} ss - Active spreadsheet
 * @param {Array} rows - Array of row arrays สำหรับ M_PERSON_ALIAS
 * @param {Object} context - Context สำหรับ dedup set update
 */
function matchCommitPersonAlias_(ss, rows, context) {
  if (rows.length > 0) {
    const paSheet = ss.getSheetByName(SHEET.M_PERSON_ALIAS);
    if (paSheet) {
      paSheet.getRange(paSheet.getLastRow() + 1, 1, rows.length, SCHEMA[SHEET.M_PERSON_ALIAS].length).setValues(rows);
      invalidateAliasCache_();
      // [FIX CRIT-018] Update in-memory dedup sets incrementally
      if (_ALIAS_ENRICHMENT_CONTEXT) {
        rows.forEach(function (paRow) {
          const pId = String(paRow[PERSON_ALIAS_IDX.PERSON_ID] || '').trim();
          const aNorm = normalizeForCompare(paRow[PERSON_ALIAS_IDX.ALIAS_NAME]);
          if (pId && aNorm) _ALIAS_ENRICHMENT_CONTEXT.existingPersonAliasSet.add(pId + '::' + aNorm);
        });
      }
    }
  }
}

/**
 * matchCommitPlaceAlias_ — [F-12] เขียน M_PLACE_ALIAS + cache + dedup update
 * @param {Spreadsheet} ss - Active spreadsheet
 * @param {Array} rows - Array of row arrays สำหรับ M_PLACE_ALIAS
 * @param {Object} context - Context สำหรับ dedup set update
 */
function matchCommitPlaceAlias_(ss, rows, context) {
  if (rows.length > 0) {
    const plaSheet = ss.getSheetByName(SHEET.M_PLACE_ALIAS);
    if (plaSheet) {
      plaSheet.getRange(plaSheet.getLastRow() + 1, 1, rows.length, SCHEMA[SHEET.M_PLACE_ALIAS].length).setValues(rows);
      invalidatePlaceAliasCache_();
      // [FIX CRIT-018] Update in-memory dedup sets incrementally
      if (_ALIAS_ENRICHMENT_CONTEXT) {
        rows.forEach(function (plaRow) {
          const plId = String(plaRow[PLACE_ALIAS_IDX.PLACE_ID] || '').trim();
          const aNorm = normalizeForCompare(plaRow[PLACE_ALIAS_IDX.ALIAS_NAME]);
          if (plId && aNorm) _ALIAS_ENRICHMENT_CONTEXT.existingPlaceAliasSet.add(plId + '::' + aNorm);
        });
      }
    }
  }
}
// ============================================================
// SECTION 2: processOneRow
// ============================================================

/**
 * processOneRow — ประมวลผล 1 Source Record
 * [FIX v003] resolvePlace ส่ง rawPlaceName + province
 * [FIX P1 Static Audit] ส่ง rawAddress (ที่อยู่เต็ม) แทน province เพื่อให้
 *   tryMatchBranch → extractProvince_ สามารถ fallback หารหัสไปรษณีย์ได้
 *   เดิมส่งแค่ province (สตริงสั้น) ทำให้ extractProvince_ หา postcode ไม่เจอ
 */
function processOneRow(srcObj) {
  // [UPGRADE v5.5.047] ส่ง contextHint (soldToName) เพื่อ Contextual Disambiguation (2.1)
  //   ถ้าชื่อซ้ำ + คะแนนใกล้กัน → ใช้ SoldToName เป็น tie-breaker
  const personResult = resolvePerson(srcObj.rawPersonName, null, { soldToName: srcObj.soldToName });

  // [FIX P1] ส่ง rawAddress (ที่อยู่เต็ม) เข้า arg ที่ 2 เพื่อให้ tryMatchBranch
  //   สามารถใช้ extractProvince_ หาจังหวัด + รหัสไปรษณีย์ได้ครบ
  const placeResult = resolvePlace(srcObj.rawPlaceName || srcObj.rawAddress, srcObj.rawAddress || '');

  const geoResult = resolveGeo(srcObj.rawLat, srcObj.rawLng);

  const decision = makeMatchDecision(srcObj, personResult, placeResult, geoResult);
  const result = executeDecision(srcObj, decision, personResult, placeResult, geoResult);

  // [PERF-001] ส่ง statsToDefer กลับให้ runMatchEngine เก็บรวมใน Set
  return {
    action: decision.action,
    txId: result.txId,
    factData: result.factData,
    reviewData: result.reviewData,
    statsToDefer: result.statsToDefer || null // [PERF-001]
  };
}

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
  const isGeoInMaster = geoResult.status === 'FOUND';
  const isPersonInMaster = personResult.status === 'FOUND';
  const isPlaceInMaster = placeResult.status === 'FOUND' || placeResult.status === 'BRANCH_MATCH';

  // [FIX v003] เรียก getGeoProvince_ ครั้งเดียวก่อนเข้า Rule
  const geoProvince = isGeoInMaster ? getGeoProvince_(geoResult.geoId) : '';

  // [UPGRADE v5.2.003] ใช้สถานะจาก Source Sheet ประกอบการตัดสินใจ
  const hasGeoInSource = srcObj.hasGeo;

  // Rule 1: ไม่มีพิกัดใน Source Sheet เลย (พิกัดเป็น 0,0 หรือว่าง)
  if (!hasGeoInSource) {
    return {
      action: 'REVIEW',
      reason: 'INVALID_LATLNG',
      confidence: 0,
      priority: 1
    };
  }

  // Rule 2: ชื่อคุณภาพต่ำ (สั้นเกินไปหรือมั่ว)
  if (personResult.status === 'LOW_QUALITY' || placeResult.status === 'LOW_QUALITY') {
    return {
      action: 'REVIEW',
      reason: 'LOW_QUALITY_DATA',
      confidence: 0,
      priority: 2
    };
  }

  // Rule 3: ตรวจสอบเรื่องจังหวัดข้ามโซน (ถ้าพิกัดอยู่ใน Master แล้ว)
  // [FIX Phase-B #14] ใช้ normalizeProvinceForCompare_() แทน string compare ตรง
  //   เดิม: "กรุงเทพมหานคร" !== "กทม" → REVIEW ผิด (alias ถือว่าตรงกัน)
  //   ตอนนี้: normalize ทั้งสองค่าผ่าน TH_PROVINCES aliases แล้วค่อยเทียบ
  //   เก็บ original values ไว้ใน evidence เพื่อ debug
  if (isGeoInMaster && geoProvince && srcObj.province) {
    const normalizedGeoProvince =
      typeof normalizeProvinceForCompare_ === 'function' ? normalizeProvinceForCompare_(geoProvince) : geoProvince;
    const normalizedSrcProvince =
      typeof normalizeProvinceForCompare_ === 'function'
        ? normalizeProvinceForCompare_(srcObj.province)
        : srcObj.province;
    if (normalizedGeoProvince !== normalizedSrcProvince) {
      return {
        action: 'REVIEW',
        reason: 'GEO_PROVINCE_CONFLICT',
        confidence: 50,
        priority: 2,
        // [FIX Phase-B #14] เก็บ original values ไว้ใน evidence เพื่อ debug
        evidence: `geoProvince="${geoProvince}"|srcProvince="${srcObj.province}"|normalizedGeo="${normalizedGeoProvince}"|normalizedSrc="${normalizedSrcProvince}"`
      };
    }
  }

  // [UPGRADE v5.2.005] Rule 3.5: Tiered Spatial Fuzzy Matching (รอคนตรวจตัดสินใจรวมพิกัด)
  if (geoResult.status === 'NEARBY_PENDING') {
    return {
      action: 'REVIEW',
      reason: geoResult.issue_type, // 'GEO_NEARBY_YELLOW' or 'GEO_NEARBY_ORANGE'
      confidence: 50,
      priority: 1 // สำคัญระดับ 1 เพราะต้องให้คนตัดสินใจว่าพิกัดเดียวกันไหม
    };
  }

  // Rule 4: พบครบทั้ง 3 อย่างใน Master -> AUTO_MATCH (Full)
  if (isGeoInMaster && isPersonInMaster && isPlaceInMaster) {
    const confidence = matchCalcFullScore_(
      geoResult.confidence,
      personResult.confidence,
      placeResult.confidence,
      srcObj,
      personResult
    );
    return {
      action: 'AUTO_MATCH',
      reason: APP_CONST.MATCH_FULL,
      confidence,
      priority: 0,
      evidence: 'name|place|geo' // [NEW v5.2.008]
    };
  }

  // Rule 5: พบพิกัดใน Master + อย่างใดอย่างหนึ่ง (คน หรือ สถานที่) -> AUTO_MATCH (Partial)
  if (isGeoInMaster && (isPersonInMaster || isPlaceInMaster)) {
    const confidence = matchCalcGeoAnchorScore_(
      geoResult.confidence,
      personResult.confidence,
      placeResult.confidence,
      isPersonInMaster
    );
    const evidence = isPersonInMaster ? 'name|geo' : 'place|geo';
    return {
      action: 'AUTO_MATCH',
      reason: APP_CONST.MATCH_GEO,
      confidence,
      priority: 0,
      evidence: evidence // [NEW v5.2.008]
    };
  }

  // Rule 6: มีความกำกวม (Fuzzy Match / Needs Review)
  if (personResult.status === 'NEEDS_REVIEW' || placeResult.status === 'NEEDS_REVIEW') {
    const confidence = Math.max(personResult.confidence, placeResult.confidence);
    return {
      action: 'REVIEW',
      reason: APP_CONST.MATCH_FUZZY,
      confidence,
      priority: 2
    };
  }

  // Rule 7: ทุกอย่างใหม่หมด แต่ Driver ส่งพิกัดมาให้ -> CREATE_NEW
  if (hasGeoInSource && !isGeoInMaster && !isPersonInMaster && !isPlaceInMaster) {
    return {
      action: 'CREATE_NEW',
      reason: 'ALL_NEW_WITH_GEO',
      confidence: geoResult.confidence || 100,
      priority: 0
    };
  }

  // Rule 8: Default
  return {
    action: 'REVIEW',
    reason: 'NEW_RECORD_PENDING',
    confidence: 0,
    priority: 3
  };
}

/**
 * calcDynamicWeights_ — [NEW v5.5.046 Dynamic Weighting 2.2]
 * ปรับน้ำหนัก geo/person/place ตามความสมบูรณ์ของข้อมูล
 *   - ที่อยู่ดิบสั้นมาก (< 10 ตัวอักษร = สัญญาณรบกวนสูง) → ลด weight place, เพิ่ม weight person
 *   - เบอร์โทรตรงเป๊ะ (personResult.confidence >= 95) → เพิ่ม weight person อีกเล็กน้อย
 * Backward compatible: ไม่ส่ง srcObj มา → คืน baseWeights เดิมทุกประการ
 * @param {{geo:number, person:number, place:number}} baseWeights
 * @param {Object} [srcObj] - source row object (optional — backward compatible)
 * @param {Object} [personResult] - resolvePerson result (optional)
 * @return {{geo:number, person:number, place:number}}
 * @private
 */
function calcDynamicWeights_(baseWeights, srcObj, personResult) {
  const geo = baseWeights.geo;
  let person = baseWeights.person;
  let place = baseWeights.place;
  if (!srcObj) return { geo, person, place };

  const SHIFT = 0.08;
  const rawAddrLen = String(srcObj.rawAddress || '').trim().length;
  const addressIsThin = rawAddrLen > 0 && rawAddrLen < 10;
  const personIsStrongPhoneMatch = !!(personResult && personResult.confidence >= 95);

  if (addressIsThin && place > SHIFT) {
    place -= SHIFT;
    person += SHIFT;
  } else if (personIsStrongPhoneMatch && place > SHIFT / 2) {
    const bump = SHIFT / 2;
    place -= bump;
    person += bump;
  }
  return { geo, person, place };
}

/**
 * matchCalcFullScore_ — [F-8] Confidence for Rule 4 (Full Match: geo + person + place)
 * [UPGRADE v5.5.046] รับ srcObj/personResult เพิ่มเติมเพื่อ Dynamic Weighting (2.2) — optional, backward compatible
 * Base Weight: geo=0.5, person=0.3, place=0.2
 * @param {number} geoConf - geoResult.confidence
 * @param {number} personConf - personResult.confidence
 * @param {number} placeConf - placeResult.confidence
 * @param {Object} [srcObj] - source row (optional — for dynamic weighting)
 * @param {Object} [personResult] - resolvePerson result (optional)
 * @returns {number} confidence (0-100)
 */
function matchCalcFullScore_(geoConf, personConf, placeConf, srcObj, personResult) {
  const w = calcDynamicWeights_({ geo: 0.5, person: 0.3, place: 0.2 }, srcObj, personResult);
  return Math.round(geoConf * w.geo + personConf * w.person + placeConf * w.place);
}

/**
 * matchCalcGeoAnchorScore_ — [F-8] Confidence for Rule 5 (Geo Anchor: geo + one of person/place)
 * Weight: geo=0.60, person=0.25, place=0.15 (capped at 95)
 * @param {number} geoConf - geoResult.confidence
 * @param {number} personConf - personResult.confidence (0 if not found)
 * @param {number} placeConf - placeResult.confidence (0 if not found)
 * @param {boolean} hasPerson - true if person matched, false if place matched
 * @returns {number} confidence (0-95)
 */
function matchCalcGeoAnchorScore_(geoConf, personConf, placeConf, hasPerson) {
  return Math.min(
    95,
    Math.round(geoConf * 0.6 + (hasPerson ? personConf : 0) * 0.25 + (hasPerson ? 0 : placeConf) * 0.15)
  );
}

// ============================================================
// SECTION 4: executeDecision — [REFACTOR-04] Dispatcher Pattern
// แยก AUTO_MATCH / CREATE_NEW / REVIEW ออกเป็น handler แยก
// ============================================================

/**
 * executeDecision — [REFACTOR-04] Dispatcher: เรียก handler ตาม action
 * REVIEW ไม่สร้าง FACT row — ป้องกัน null-FK garbage rows
 */
function executeDecision(srcObj, decision, personResult, placeResult, geoResult) {
  const personId = personResult ? personResult.personId : null;
  const placeId = placeResult ? placeResult.placeId : null;
  let geoId = geoResult ? geoResult.geoId : null;

  // [FIX v5.5.001] Only call getEnrichedGeoData() for AUTO_MATCH and CREATE_NEW
  // REVIEW rows don't need expensive geo enrichment
  let geoEnrich = null;
  const needsGeoEnrich = decision.action === 'AUTO_MATCH' || decision.action === 'CREATE_NEW';

  if (needsGeoEnrich) {
    geoEnrich = getEnrichedGeoData(srcObj.rawAddress, srcObj.rawPlaceName);

    // [FIX v5.5.001] Only create GeoPoint for AUTO_MATCH and CREATE_NEW, not REVIEW
    // REVIEW rows should not create GeoPoints — they need human review first
    if (!geoId && srcObj.hasGeo && geoResult && geoResult.status !== 'NEARBY_PENDING') {
      geoId = createGeoPoint(
        srcObj.rawLat,
        srcObj.rawLng,
        'driver',
        geoEnrich.fullAddress || srcObj.rawAddress,
        geoEnrich.province || srcObj.province,
        geoEnrich.district || srcObj.district,
        placeId
      );
      // [FIX CodeQL js/trivial-conditional V5.5.035] outer if บนบรรทัด 1080 ตรวจ geoResult แล้ว จึงไม่จำเป็นต้องเช็คซ้ำ
      geoResult.geoId = geoId;
    }
  }

  // ─── Dispatch to handler ───────────────────────────────────
  switch (decision.action) {
    case 'AUTO_MATCH':
      return handleAutoMatch_(srcObj, decision, personId, placeId, geoId);
    case 'CREATE_NEW':
      return handleCreateNew_(srcObj, decision, personResult, placeResult, geoId, geoEnrich);
    case 'REVIEW':
      return handleReview_(srcObj, decision, personResult, placeResult, geoResult);
    default:
      logError(
        'MatchEngine',
        `executeDecision: Unknown action: ${decision.action}`,
        new Error('UNKNOWN_ACTION:' + decision.action)
      );
      return { txId: null, factData: null, reviewData: null };
  }
}

/**
 * handleAutoMatch_ — [REFACTOR-04] AUTO_MATCH handler
 * [PERF-001] เปลี่ยนจากเรียก stats update ทันที → ส่ง ID กลับให้ caller เก็บไว้ batch
 * เหตุผล: เดิมเรียก updatePersonStats/PlaceStats/GeoStats/DestStats ทุกแถว
 *         แต่ละฟังก์ชันใช้ 2-3 API calls (getValues+setValues+cache invalidate)
 *         ทำให้ N แถว = N×4×2-3 = 8-12N API calls เฉพาะ stats
 *         แก้แล้ว: เก็บ ID ใน Set/Array → flush ทีเดียวใน flushBatches_()
 *         ใช้ Set เพื่อ dedup: ถ้า personId เดียวกันโดนหลายแถว → อัปเดตครั้งเดียว
 */
function handleAutoMatch_(srcObj, decision, personId, placeId, geoId) {
  // [PERF-001] Defer stats updates — collect IDs instead of calling immediately
  // Stats updates will be done in flushBatches_() via processOneRow() return values
  const statsToDefer = {
    personIds: [],
    placeIds: [],
    geoIds: [],
    destStats: []
  };

  if (personId) statsToDefer.personIds.push(personId);
  if (placeId) statsToDefer.placeIds.push(placeId);
  if (geoId) statsToDefer.geoIds.push(geoId);

  // [FIX Phase-B #13] Flag incomplete destination for Rule 5 (geo + one of person/place)
  //   Rule 5 (geo+person only OR geo+place only) สร้าง destination ที่ placeId='' หรือ personId='' (by design)
  //   เดิม: ไม่มี flag บอกว่า incomplete → reviewer เห็น GEO_ANCHOR ธรรมดา ไม่รู้ว่าขาด place หรือ person
  //   ตอนนี้: enrich reason/evidence ด้วย PARTIAL_MATCH_NO_PLACE / PARTIAL_MATCH_NO_PERSON
  //   ไม่เปลี่ยน logic การทำงาน — แค่เพิ่ม flag ใน MATCH_REASON column ของ FACT_DELIVERY เพื่อ audit
  let enrichedDecision = decision;
  const hasPerson = !!personId;
  const hasPlace = !!placeId;
  if (hasPerson !== hasPlace) {
    // XOR — only one of person/place present (Rule 5 partial)
    enrichedDecision = Object.assign({}, decision);
    const flagStr = hasPerson ? 'PARTIAL_MATCH_NO_PLACE' : 'PARTIAL_MATCH_NO_PERSON';
    enrichedDecision.reason = (decision.reason || '') + '|' + flagStr;
    enrichedDecision.evidence = (decision.evidence || '') + '|' + flagStr;
  }

  const destResult = resolveDestination(personId, placeId, geoId);
  let destId = null;
  if (destResult.status === 'FOUND' || destResult.status === 'PARTIAL_MATCH') {
    destId = destResult.destId;
    if (destId) statsToDefer.destStats.push({ destId: destId, deliveryDate: srcObj.deliveryDate });
  } else {
    destId = createDestination(personId, placeId, geoId, srcObj.rawLat, srcObj.rawLng, srcObj.deliveryDate);
  }

  const txRes = upsertFactDelivery(srcObj, personId, placeId, geoId, destId, enrichedDecision);
  return {
    txId: txRes ? txRes.txId : null,
    factData: txRes && txRes.isNew ? txRes.rowData : null,
    reviewData: null,
    statsToDefer: statsToDefer // [PERF-001] ส่งกลับให้ caller
  };
}

/**
 * handleCreateNew_ — [REFACTOR-04] CREATE_NEW handler
 * Create Person/Place/Geo/Dest → write FACT
 * [PERF-001] NOTE: CREATE_NEW intentionally does NOT return statsToDefer because
 *   createPerson()/createPlace()/createGeoPoint()/createDestination() already set
 *   initial usage_count = 1 and last_seen = now. Deferring stats would double-count.
 *   Only handleAutoMatch_ (which reuses existing entities) needs deferred stats.
 */
function handleCreateNew_(srcObj, decision, personResult, placeResult, geoId, geoEnrich) {
  let personId = personResult ? personResult.personId : null;
  let placeId = placeResult ? placeResult.placeId : null;
  let destId = null;

  if (!personId && personResult.normResult) {
    personId = createPerson(personResult.normResult);
    // [FIX CRIT-005] เพิ่ม Person ใหม่เข้า alias enrichment context — ป้องกัน stale cache
    if (personId) {
      const pUuid = typeof convertPersonIdToUuid === 'function' ? convertPersonIdToUuid(personId) : null;
      addEntityToEnrichmentContext_(
        'PERSON',
        personId,
        pUuid,
        personResult.canonical || '',
        personResult.normalized || ''
      );
    }
  }
  if (!placeId && placeResult.normResult) {
    const placeNorm = placeResult.normResult || {};
    placeNorm.fullAddress = srcObj.rawAddress || srcObj.rawPlaceName || geoEnrich.fullAddress;
    placeId = createPlace(placeNorm, geoEnrich.province, geoEnrich.district, geoEnrich.subDistrict, geoEnrich.postcode);
    // [FIX CRIT-005] เพิ่ม Place ใหม่เข้า alias enrichment context — ป้องกัน stale cache
    if (placeId) {
      const plUuid = typeof convertPlaceIdToUuid === 'function' ? convertPlaceIdToUuid(placeId) : null;
      addEntityToEnrichmentContext_('PLACE', placeId, plUuid, placeNorm.canonical || '', placeNorm.normalized || '');
    }
  }
  // geoId created before switch (v5.2.003)

  if (geoId && (personId || placeId)) {
    destId = createDestination(personId, placeId, geoId, srcObj.rawLat, srcObj.rawLng, srcObj.deliveryDate);
  }

  const txRes = upsertFactDelivery(srcObj, personId, placeId, geoId, destId, decision);
  return {
    txId: txRes ? txRes.txId : null,
    factData: txRes && txRes.isNew ? txRes.rowData : null,
    reviewData: null
  };
}

/**
 * handleReview_ — [REFACTOR-04] REVIEW handler
 * ❌ ไม่สร้าง FACT row — REVIEW ไม่มี personId/placeId/geoId/destId ครบ
 * REVIEW ถูกบันทึกใน Q_REVIEW แทน
 */
function handleReview_(srcObj, decision, personResult, placeResult, geoResult) {
  const qRes = enqueueReview(srcObj, decision, personResult, placeResult, geoResult);
  if (qRes && qRes.rowData) {
    // [FIX CRIT-006] ใช้ 'REVIEW' แทน 'SUCCESS' — แถวยังไม่ได้ประมวลผลจริง แค่อยู่ในคิวรอตรวจ
    updateSyncStatus_([srcObj], 'REVIEW');
  }
  return {
    txId: null,
    factData: null,
    reviewData: qRes ? qRes.rowData : null
  };
}

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

/**
 * detectSameGeoMultiPerson — [AUDIT-002 V5.5.042] ⚠️ DEAD CODE — ไม่ถูกเรียกใช้ใน production
 *
 *   ฟังก์ชันนี้ถูก implement สมบูรณ์ตั้งแต่ v5.4 แต่ไม่ได้ถูก wire เข้า makeMatchDecision()
 *   หรือ flow อื่นใดใน pipeline ทำให้ฟีเจอร์ "ตรวจจับหลายบุคคลใช้พิกัดเดียวกัน"
 *   ที่ BLUEPRINT.md §6 อ้างว่ามี — จริงๆ แล้วไม่เคยทำงาน
 *
 *   ผู้ดูแลควรตัดสินใจ:
 *   - ถ้าต้องการฟีเจอร์นี้ → wire เข้า makeMatchDecision() ใน Rule 3.5 (NEARBY_PENDING)
 *     โดยเรียก detectSameGeoMultiPerson(geoId, currentPersonId) แล้วส่งเข้า Q_REVIEW
 *     ถ้าพบ conflict (return true)
 *   - ถ้าไม่ต้องการ → ลบฟังก์ชันนี้ทิ้ง + แก้ BLUEPRINT.md §6 ให้ตรงกับโค้ด
 *
 *   ตอนนี้คงไว้เป็น utility function สำหรับ admin เรียกดูด้วยตนเองผ่าน Apps Script Editor
 *
 * @param {string} geoId
 * @param {string} currentPersonId
 * @return {boolean} true ถ้ามี person อื่นใช้ geoId เดียวกัน
 */
function detectSameGeoMultiPerson(geoId, currentPersonId) {
  // [AUDIT-002 V5.5.042] Log warning ถ้าถูกเรียก เพื่อให้ผู้ดูแลสังเกตเห็นว่า
  //   ฟังก์ชันนี้ยังไม่ได้ wire เข้า production pipeline
  if (typeof logWarn === 'function') {
    logWarn(
      'MatchEngine',
      'detectSameGeoMultiPerson() ถูกเรียก — หมายเหตุ: ฟังก์ชันนี้ไม่ได้ wire เข้า makeMatchDecision ' +
        '(dead code ตั้งแต่ v5.4) ตรวจสอบ BLUEPRINT.md §6 สำหรับการ wire ที่ถูกต้อง'
    );
  }
  const allDests = loadAllDestinations_();
  return allDests.some(
    (d) => d.geoId === geoId && d.personId !== currentPersonId && d.status === APP_CONST.STATUS_ACTIVE
  );
}

function getGeoProvince_(geoId) {
  if (!geoId) return '';
  const allGeos = loadAllGeos_();
  const geo = allGeos.find((g) => g.geoId === geoId);
  return geo ? geo.province || '' : '';
}

// ============================================================
// SECTION 6: Processing State Reset + Auto-Resume
// [REF-018] ลบ saveCheckpoint_, loadCheckpoint_ (dead code)
// เปลี่ยนชื่อ clearCheckpoint_ → resetProcessingState_ (ชัดเจนขึ้น)
// ============================================================

/**
 * resetProcessingState_ — [REF-018] ล้าง stale processing state จาก PropertiesService
 * เดิมชื่อ clearCheckpoint_ — เปลี่ยนชื่อเพื่อให้ชัดเจนว่าคือ reset state ไม่ใช่ checkpoint
 * รักษาพฤติกรรมเดิม 100% — ลบ MATCH_CHECKPOINT_INDEX และ MATCH_CHECKPOINT_ROW
 */
function resetProcessingState_() {
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('MATCH_CHECKPOINT_INDEX');
    props.deleteProperty('MATCH_CHECKPOINT_ROW');
  } catch (e) {
    /* ignore — cleanup only */
  }
  logInfo('MatchEngine', 'ล้าง Processing State เรียบร้อย');
}

// [REF-018] DELETED: saveCheckpoint_ — ไม่ถูกเรียกใช้แล้ว (SYNC_STATUS ทำหน้าที่แทน)
// [REF-018] DELETED: loadCheckpoint_ — ไม่ถูกเรียกใช้แล้ว (SYNC_STATUS ทำหน้าที่แทน)

/**
 * [NEW v5.2.003] Auto-Trigger System
 * [FIX v5.2.015] ป้องกันการลบทริกเกอร์ตั้งเวลาถาวรของผู้ใช้โดยการจำ ID
 */
function installAutoResume_(funcName) {
  removeAutoResume_(); // ลบของเก่าก่อนถ้ามี
  const trigger = ScriptApp.newTrigger(funcName)
    .timeBased()
    .after(60 * 1000) // ให้รันต่อในอีก 1 นาที (หลบ Timeout)
    .create();
  const triggerId = trigger.getUniqueId();
  PropertiesService.getScriptProperties().setProperty('AUTO_RESUME_TRIGGER_ID', triggerId);
  logInfo('MatchEngine', `ติดตั้ง Auto-Trigger: ${funcName} (ID: ${triggerId}) จะทำงานต่อใน 1 นาที`);
}

function removeAutoResume_() {
  const props = PropertiesService.getScriptProperties();
  const autoResumeTriggerId = props.getProperty('AUTO_RESUME_TRIGGER_ID');
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;

  for (const trigger of triggers) {
    const triggerId = trigger.getUniqueId();
    if (autoResumeTriggerId && triggerId === autoResumeTriggerId) {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  }

  props.deleteProperty('AUTO_RESUME_TRIGGER_ID');

  if (deletedCount > 0) {
    logInfo('MatchEngine', `ลบ Auto-Trigger ที่ค้างอยู่ (${deletedCount} รายการ)`);
  }
}

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
 * persistResult_ — [REF-002] Persist fact delivery + review data to sheets
 * Encapsulates the write logic for FACT_DELIVERY and Q_REVIEW sheets,
 * including alias enrichment and color coding.
 * @param {Array} factData - Array of fact row arrays to write to FACT_DELIVERY
 * @param {Array} reviewData - Array of review row arrays to write to Q_REVIEW
 */
function persistResult_(factData, reviewData) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (factData.length > 0) {
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

  if (reviewData.length > 0) {
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
}

// ============================================================
// SECTION 7: Group 1 Gateway [REF-001]
// resolveAndPersist_ — Encapsulates resolve-create-enrich-upsert sequence
// so Group 2 (ReviewService) doesn't call Group 1 CRUD directly
// ============================================================

/**
 * resolveAndPersist_ — [REF-001] Gateway function for Group 1 CRUD operations
 * Encapsulates the full resolve-create-enrich-upsert sequence.
 * Used by ReviewService to avoid direct Group 1 CRUD calls.
 *
 * For MERGE_TO_CANDIDATE:
 *   - Resolves person, merges if needed
 *   - Resolves geo and destination
 *   - Calls upsertFactDelivery
 *
 * For CREATE_NEW:
 *   - Resolves/creates person, place, geo, destination
 *   - Enriches geo data
 *   - Calls upsertFactDelivery
 *
 * @param {Object} srcObj - Source object with raw data
 * @param {string} decisionType - 'MERGE_TO_CANDIDATE' or 'CREATE_NEW'
 * @param {Object} candidates - { candPersonIds: [], candPlaceIds: [] } for MERGE
 * @return {Object|null} { factRowData } or null
 */
function resolveAndPersist_(srcObj, decisionType, candidates) {
  if (decisionType === 'MERGE_TO_CANDIDATE') {
    return resolveAndPersistMerge_(srcObj, candidates);
  } else if (decisionType === 'CREATE_NEW') {
    return resolveAndPersistCreate_(srcObj);
  }
  logWarn('MatchEngine', 'resolveAndPersist_: Unknown decisionType ' + decisionType);
  return null;
}

/**
 * resolveAndPersistMerge_ — [REF-001] MERGE path within resolveAndPersist_
 * @param {Object} srcObj
 * @param {Object} candidates - { candPersonIds: [], candPlaceIds: [] }
 * @return {Object|null} { factRowData } or null
 */
function resolveAndPersistMerge_(srcObj, candidates) {
  let targetPersonId = null;
  if (candidates && candidates.candPersonIds && candidates.candPersonIds.length > 0) {
    const personResult = resolvePerson(srcObj.rawPersonName);
    if (personResult.personId && personResult.personId !== candidates.candPersonIds[0]) {
      mergePersonRecords(personResult.personId, candidates.candPersonIds[0]);
    }
    targetPersonId = candidates.candPersonIds[0];
  }

  let targetPlaceId =
    candidates && candidates.candPlaceIds && candidates.candPlaceIds.length > 0 ? candidates.candPlaceIds[0] : null;

  // [FIX V5.5.050 BUG-QREVIEW-MPERSON] ถ้าไม่มี candidate เลย → fallback เป็น CREATE_NEW
  //   ปัญหา: MERGE_TO_CANDIDATE แต่ candPersonIds=[] และ candPlaceIds=[]
  //   → targetPersonId=null, targetPlaceId=null → ไม่สร้างอะไรเลยใน M_PERSON/M_PLACE
  //   แก้: ถ้าไม่มี candidate ทั้งคู่ → เรียก resolveAndPersistCreate_ แทน
  if (!targetPersonId && !targetPlaceId) {
    logInfo(
      'MatchEngine',
      'resolveAndPersistMerge_: ไม่มี candidate — fallback เป็น CREATE_NEW (person="' + srcObj.rawPersonName + '")'
    );
    return resolveAndPersistCreate_(srcObj);
  }

  // [FIX V5.5.050 BUG-QREVIEW-MPERSON] ถ้ามี place candidate แต่ไม่มี person candidate
  //   → สร้าง person ใหม่ (เพราะ MERGE หมายถึง merge เข้า candidate ที่มี
  //   แต่ถ้าไม่มี person candidate เลย ต้องสร้างใหม่)
  if (!targetPersonId && srcObj.rawPersonName) {
    const personResult = resolvePerson(srcObj.rawPersonName);
    targetPersonId = personResult.personId;
    if (!targetPersonId) {
      targetPersonId = createPerson(personResult.normResult);
      logInfo('MatchEngine', 'resolveAndPersistMerge_: สร้าง Person ใหม่ — ' + targetPersonId);
    }
  }

  // [FIX V5.5.050 BUG-QREVIEW-MPERSON] ถ้ามี person candidate แต่ไม่มี place candidate
  //   → สร้าง place ใหม่
  if (!targetPlaceId && (srcObj.rawPlaceName || srcObj.rawAddress)) {
    const rawPlace = srcObj.rawPlaceName || srcObj.rawAddress;
    const rawAddr = srcObj.rawAddress || '';
    const placeResult = resolvePlace(rawPlace, rawAddr);
    let newPlaceId = placeResult.placeId;
    if (!newPlaceId) {
      let geoEnrich = null;
      try {
        geoEnrich = getEnrichedGeoData(rawAddr, rawPlace);
      } catch (e) {
        logDebug('MatchEngine', 'resolveAndPersistMerge_: getEnrichedGeoData skipped — ' + e.message);
      }
      const safeGeoEnrich = geoEnrich || {};
      const placeNorm = placeResult.normResult || {};
      if (safeGeoEnrich.fullAddress) placeNorm.fullAddress = safeGeoEnrich.fullAddress;
      newPlaceId = createPlace(
        placeNorm,
        safeGeoEnrich.province || '',
        safeGeoEnrich.district || '',
        safeGeoEnrich.subDistrict || '',
        safeGeoEnrich.postcode || ''
      );
      targetPlaceId = newPlaceId;
      logInfo('MatchEngine', 'resolveAndPersistMerge_: สร้าง Place ใหม่ — ' + newPlaceId);
    }
  }

  // [NEW v5.5.046 — Self-Healing Alias 3.1]
  //   Admin ยืนยัน MERGE_TO_CANDIDATE = Human-in-the-loop ที่แม่นยำที่สุด
  //   เรียนรู้ typo pattern โดยสร้าง Global Alias จากชื่อดิบ → masterUuid ทันที
  //   รอบ Match Engine ถัดไปจะจับคู่ได้เองโดยไม่ต้องเข้า Q_REVIEW ซ้ำ
  //   [Rule 12] ห้ามให้ alias-learning ทำให้ MERGE decision ล้มเหลว
  try {
    if (targetPersonId && srcObj.rawPersonName) {
      const personUuid = getPersonMasterUuid_(targetPersonId);
      if (personUuid) {
        const newAliasId = createGlobalAlias(personUuid, srcObj.rawPersonName, 'PERSON', 100, 'HUMAN');
        if (newAliasId) {
          logInfo('MatchEngine', 'Self-Healing Alias: PERSON "' + srcObj.rawPersonName + '" → ' + targetPersonId);
        }
      }
    }
    if (targetPlaceId && srcObj.rawPlaceName) {
      const placeUuid = getPlaceMasterUuid_(targetPlaceId);
      if (placeUuid) {
        const newAliasId = createGlobalAlias(placeUuid, srcObj.rawPlaceName, 'PLACE', 100, 'HUMAN');
        if (newAliasId) {
          logInfo('MatchEngine', 'Self-Healing Alias: PLACE "' + srcObj.rawPlaceName + '" → ' + targetPlaceId);
        }
      }
    }
  } catch (aliasErr) {
    logError('MatchEngine', 'Self-Healing Alias ล้มเหลว (ไม่กระทบ MERGE): ' + aliasErr.message, aliasErr);
  }

  // Geo + Dest resolution
  let targetGeoId = null;
  let targetDestId = null;
  if (srcObj.hasGeo) {
    const geoResult = resolveGeo(srcObj.rawLat, srcObj.rawLng);
    targetGeoId = geoResult ? geoResult.geoId : null;
  }
  if (targetPersonId || targetPlaceId) {
    const destResult = resolveDestination(targetPersonId, targetPlaceId, targetGeoId);
    if (destResult && (destResult.status === 'FOUND' || destResult.status === 'PARTIAL_MATCH')) {
      targetDestId = destResult.destId;
    }
  }

  const factResult = upsertFactDelivery(srcObj, targetPersonId, targetPlaceId, targetGeoId, targetDestId, {
    action: 'MERGE_TO_CANDIDATE',
    reason: 'REVIEW_MERGE_APPROVED',
    confidence: 90,
    priority: 0
  });

  if (factResult && factResult.isNew && factResult.rowData) {
    return { factRowData: factResult.rowData };
  }
  return null;
}

/**
 * resolveAndPersistCreate_ — [REF-001] CREATE_NEW path within resolveAndPersist_
 * @param {Object} srcObj
 * @return {Object|null} { factRowData } or null
 */
function resolveAndPersistCreate_(srcObj) {
  const rawPerson = srcObj.rawPersonName || '';
  const rawPlace = srcObj.rawPlaceName || '';
  const rawAddr = srcObj.rawAddress || '';

  // Geo enrichment
  let geoEnrich = null;
  try {
    geoEnrich = getEnrichedGeoData(rawAddr, rawPlace);
  } catch (geoErr) {
    logDebug('MatchEngine', 'resolveAndPersistCreate_: getEnrichedGeoData ข้าม — ' + geoErr.message);
  }
  const safeGeoEnrich = geoEnrich || {};

  // Person
  const personResult = resolvePerson(rawPerson);
  let personId = personResult.personId;
  if (!personId) personId = createPerson(personResult.normResult);

  // Place
  const placeResult = resolvePlace(rawPlace, rawAddr);
  let placeId = placeResult.placeId;
  if (!placeId) {
    const placeNorm = placeResult.normResult || {};
    if (safeGeoEnrich.fullAddress) placeNorm.fullAddress = safeGeoEnrich.fullAddress;
    placeId = createPlace(
      placeNorm,
      safeGeoEnrich.province,
      safeGeoEnrich.district,
      safeGeoEnrich.subDistrict,
      safeGeoEnrich.postcode
    );
  }

  // Geo
  let geoId = null;
  if (srcObj.hasGeo) {
    const geoRes = resolveGeo(srcObj.rawLat, srcObj.rawLng);
    geoId = geoRes.geoId;
    if (!geoId) {
      geoId = createGeoPoint(
        srcObj.rawLat,
        srcObj.rawLng,
        'manual',
        safeGeoEnrich.fullAddress || rawAddr,
        safeGeoEnrich.province,
        safeGeoEnrich.district,
        placeId
      );
    }
  }

  // Destination
  let destId = null;
  if (geoId && (personId || placeId)) {
    destId = createDestination(personId, placeId, geoId, srcObj.rawLat, srcObj.rawLng, null);
  }

  const factResult = upsertFactDelivery(srcObj, personId, placeId, geoId, destId, {
    action: 'CREATE_NEW',
    reason: 'REVIEW_APPROVED',
    confidence: 95,
    priority: 0
  });

  if (factResult && factResult.isNew && factResult.rowData) {
    return { factRowData: factResult.rowData };
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

/**
 * reprocResolveOrCreatePersonForReview_ — [REF-001] Resolve-or-create Person สำหรับ reproc flow
 *   ไม่ upsert FACT_DELIVERY — คืนเฉพาะ personId ให้ caller ใช้ mutate factData ภายหลัง
 *   Behavior mirror ของ Group B inline logic (12_ReviewService.gs:1361-1372)
 * @param {string} rawPerson - raw person name from review row
 * @return {{personId: string|null, error: string|null}}
 */
function reprocResolveOrCreatePersonForReview_(rawPerson) {
  if (!rawPerson) return { personId: null, error: null };
  try {
    const pRes = resolvePerson(rawPerson);
    if (pRes && pRes.status === 'FOUND' && pRes.personId) {
      return { personId: pRes.personId, error: null };
    }
    if (pRes && pRes.normResult) {
      const newPersonId = createPerson(pRes.normResult);
      return { personId: newPersonId, error: null };
    }
    return { personId: null, error: null };
  } catch (e) {
    return { personId: null, error: e.message };
  }
}

/**
 * reprocResolveOrCreatePlaceForReview_ — [REF-001] Resolve-or-create Place สำหรับ reproc flow
 *   Behavior mirror ของ Group B inline logic (12_ReviewService.gs:1374-1386)
 *
 *   [FIX V5.5.045 Issue #26] เพิ่ม geo enrichment ก่อน createPlace
 *     เดิมส่ง '' ทั้ง 4 fields → place ใหม่ไม่มี province/district/postcode
 *     ทำให้ Match Engine Rule 3 (GEO_PROVINCE_CONFLICT) ไม่ทำงาน + reporting ไม่ครบ
 *     ตอนนี้ใช้ getEnrichedGeoData() เหมือน flow หลัก (executeDecision บรรทัด 1193)
 *
 * @param {string} rawPlace - raw place name
 * @param {string} rawAddr - raw address (fallback, ใช้สำหรับ geo enrichment)
 * @return {{placeId: string|null, error: string|null}}
 */
function reprocResolveOrCreatePlaceForReview_(rawPlace, rawAddr) {
  const placeInput = rawPlace || rawAddr || '';
  if (!placeInput) return { placeId: null, error: null };
  try {
    // [FIX BUG-AUDIT-003 V5.5.042] ส่ง rawAddr ต่อให้ resolvePlace แทนการทิ้งเป็น ''
    //   เหตุผล: resolvePlace ใช้ rawAddress ใน extractProvince_() + findPlaceCandidates()
    //   เพื่อกรอง candidate ตามจังหวัด — ถ้าส่ง '' ระบบจะเลือก place ผิดจังหวัดแบบเงียบ
    //   กระทบ flow: Reprocess Review Queue (Group A/B/C ใน reprocessReviewQueue)
    const plRes = resolvePlace(placeInput, rawAddr || '');
    if (plRes && plRes.status === 'FOUND' && plRes.placeId) {
      return { placeId: plRes.placeId, error: null };
    }
    if (plRes && plRes.normResult) {
      // [FIX V5.5.045 Issue #26] เพิ่ม geo enrichment เหมือน flow หลัก (executeDecision)
      //   เดิม: createPlace(plRes.normResult, '', '', '', '') → place ใหม่ไม่มี province/district/postcode
      //   ใหม่: ดึง enrichment จาก rawAddr ผ่าน getEnrichedGeoData() (ใช้ RAM cache)
      //   Trade-off: +50-100ms per call (acceptable เพราะใช้ loadCachedGeoRowsForPlace_ cache)
      //   Fallback: ถ้า getEnrichedGeoData fail → ใช้ค่าว่าง (preserve old behavior) + log warn
      const geoEnrich = { province: '', district: '', subDistrict: '', postcode: '' };
      if (typeof getEnrichedGeoData === 'function' && rawAddr) {
        try {
          const enrichResult = getEnrichedGeoData(rawAddr);
          if (enrichResult) {
            geoEnrich.province = enrichResult.province || '';
            geoEnrich.district = enrichResult.district || '';
            geoEnrich.subDistrict = enrichResult.subDistrict || '';
            geoEnrich.postcode = enrichResult.postcode || '';
          }
        } catch (enrichErr) {
          // ไม่ block flow — ใช้ค่าว่าง + log warn เพื่อให้วินิจฉัยได้
          logWarn(
            'MatchEngine',
            'reprocResolveOrCreatePlaceForReview_: getEnrichedGeoData failed - ' +
              enrichErr.message +
              ' (continuing with empty geoEnrich)'
          );
        }
      }
      const newPlaceId = createPlace(
        plRes.normResult,
        geoEnrich.province,
        geoEnrich.district,
        geoEnrich.subDistrict,
        geoEnrich.postcode
      );
      return { placeId: newPlaceId, error: null };
    }
    return { placeId: null, error: null };
  } catch (e) {
    return { placeId: null, error: e.message };
  }
}

/**
 * reprocCreateDestinationForReview_ — [REF-001] Create Destination สำหรับ reproc flow
 *   Behavior mirror ของ createDestination() calls ใน Group A/B/C
 *   ไม่ upsert FACT_DELIVERY — คืนเฉพาะ destId
 * @param {string|null} personId
 * @param {string|null} placeId
 * @param {string} geoId
 * @param {number} rawLat
 * @param {number} rawLng
 * @return {{destId: string|null, error: string|null}}
 */
function reprocCreateDestinationForReview_(personId, placeId, geoId, rawLat, rawLng) {
  if (!((personId || placeId) && geoId)) return { destId: null, error: null };
  try {
    const newDestId = createDestination(personId, placeId, geoId, rawLat, rawLng, '');
    return { destId: newDestId, error: null };
  } catch (e) {
    return { destId: null, error: e.message };
  }
}
