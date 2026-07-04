/**
 * VERSION: 5.5.042
 * FILE: 24_PipelineManager.gs
 * LMDS V5.5 — Pipeline Manager (Standalone Module)
 * ===================================================
 * PURPOSE:
 *   จัดการการรัน runMatchEngine() แบบ batch สำหรับข้อมูลหลักหมื่นแถว
 *   โดยไม่ให้เกิน quota รายวันของ Google Apps Script (Free tier: 90 นาที/วัน)
 *
 *   ฟีเจอร์หลัก:
 *   1. Auto-run ทุก 1 ชม ตั้งแต่ 08:00-22:00 (15 รอบ/วัน)
 *   2. หยุดเองถ้า quota รายวันใกล้เต็ม (เหลือ buffer 15 นาที)
 *   3. รันต่อเองเมื่อ quota รีเซ็ต (วันใหม่)
 *   4. Circuit Breaker — หยุดถ้า error ซ้ำ 3 ครั้งติด
 *   5. Checkpoint/Resume — บันทึกตำแหน่งเสมอ รันต่อได้
 *   6. ไม่แตะไฟล์เดิม — เรียก runMatchEngine() แบบ wrapper
 *
 *   STANDALONE MODULE:
 *   - ไม่ depend บับ ฟังก์ชันอื่นในระบบ (ยกเว้น runMatchEngine ที่เรียกใช้)
 *   - ใช้ Script Properties เก็บ state ของตัวเอง (prefix: PIPELINE_*)
 *   - ไม่ import/export กับ module อื่น
 *   - copy ไฟล์นี้ไป Apps Script ได้เลย ไม่ต้องแก้ไฟล์อื่น
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v5.5.022 (2026-06-28) — Initial Pipeline Manager (standalone module)
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES:
 *     - runMatchEngine() (from 10_MatchEngine.gs) — ฟังก์ชันหลักที่จะเรียก
 *     - ScriptApp, SpreadsheetApp, PropertiesService (built-in GAS services)
 *   DEFINES:
 *     - PIPELINE_CONFIG (configuration constants)
 *     - State Management: getPipelineState_(), setPipelineState_(), etc.
 *     - Quota Tracker: checkAndResetDailyQuota_(), isQuotaAvailable_()
 *     - Circuit Breaker: recordBatchSuccess_(), recordBatchError_()
 *     - Checkpoint: saveCheckpoint_(), loadCheckpoint_()
 *     - Trigger Manager: installPipelineTriggers(), removeAllPipelineTriggers_()
 *     - Main entry: runPipelineBatch()
 *     - Admin actions: startPipeline(), pausePipeline(), resumePipeline(),
 *                      resetPipeline(), showPipelineStatus(), resetCircuitBreakerMenu()
 * ===================================================
 * ARCHITECTURE:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Layer 1: Quota Tracker (Script Properties)              │
 *   │  ├── Daily runtime: 75 min max (90 - 15 buffer)          │
 *   │  ├── Daily runs: 15 max                                  │
 *   │  └── Auto-reset at midnight                              │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Layer 2: Circuit Breaker                                │
 *   │  ├── Max 3 consecutive errors → PAUSE                    │
 *   │  └── Admin reset required to resume                      │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Layer 3: Checkpoint/Resume                              │
 *   │  ├── Save lastRunAt, runCount, totalRuntimeMs            │
 *   │  └── Resume from last state after pause/quota-stop       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Layer 4: Trigger Manager                                │
 *   │  ├── Time-based: every 1 hour, 08:00-22:00 (15 runs)     │
 *   │  ├── Auto-cleanup of MatchEngine auto-resume triggers    │
 *   │  └── Auto-remove when pipeline COMPLETED                 │
 *   └──────────────────────────────────────────────────────────┘
 * ===================================================
 * USAGE:
 *   1. ติดตั้ง triggers: เรียก installPipelineTriggers() ครั้งเดียว
 *      (หรือกดเมนู LMDS > Pipeline Manager > ติดตั้ง — ถ้าเพิ่มเมนู)
 *   2. เริ่ม pipeline: เรียก startPipeline()
 *   3. ระบบจะรันอัตโนมัติทุก 1 ชม จนกว่าจะเสร็จหรือ quota เต็ม
 *   4. ดูสถานะ: เรียก showPipelineStatus()
 *   5. หยุดชั่วคราว: เรียก pausePipeline()
 *   6. ทำต่อ: เรียก resumePipeline()
 *   7. เริ่มใหม่ทั้งหมด: เรียก resetPipeline()
 * ===================================================
 */

// ============================================================
// SECTION 1: Configuration
// ============================================================

/**
 * PIPELINE_CONFIG — ค่าคงที่สำหรับ Pipeline Manager
 *   ปรับค่าตรงนี้เพื่อเปลี่ยนพฤติกรรม
 */
const PIPELINE_CONFIG = Object.freeze({
  // === Quota Limits (Free Gmail tier: 90 min/day total runtime) ===
  //   เหลือ buffer 15 นาที → ใช้จริง 75 นาที/วัน
  MAX_RUNTIME_MS_PER_DAY:   75 * 60 * 1000,   // 4,500,000 ms = 75 นาที
  MAX_RUNTIME_MS_PER_RUN:   4 * 60 * 1000,    // 240,000 ms = 4 นาที (buffer ก่อน 6 นาที hard limit)
  MAX_RUNS_PER_DAY:         15,               // 15 รอบ/วัน (user requirement)

  // === Circuit Breaker ===
  MAX_CONSECUTIVE_ERRORS:   3,                // ถ้า error ติดๆ กัน 3 ครั้ง → PAUSE
  ERROR_COOLDOWN_MS:        60 * 60 * 1000,   // รอ 1 ชม ก่อนลองใหม่หลัง error (ถ้ายังไม่ pause)

  // === Trigger Schedule (Time-based) ===
  BATCH_RUN_INTERVAL_HOURS: 1,                // รันทุก 1 ชม
  BATCH_RUN_START_HOUR:     8,                // เริ่ม 08:00 น.
  BATCH_RUN_END_HOUR:       22,               // หยุด 22:00 น. (รวม 15 รอบ: 8,9,...,22)

  // === Behavior ===
  CLEAN_MATCH_ENGINE_TRIGGERS: true,          // ลบ auto-resume trigger ของ MatchEngine หลังรัน
  LOG_TO_SYS_LOG:               true,         // เขียน log ไป SYS_LOG (ถ้ามี logInfo)
});

// Pipeline States
const PIPELINE_STATES = Object.freeze({
  IDLE:           'IDLE',            // ยังไม่เริ่ม
  RUNNING:        'RUNNING',         // กำลังรัน
  PAUSED_QUOTA:   'PAUSED_QUOTA',    // หยุดเพราะ quota เต็ม
  PAUSED_ERRORS:  'PAUSED_ERRORS',   // หยุดเพราะ error ซ้ำ
  PAUSED_MANUAL:  'PAUSED_MANUAL',   // หยุดโดย admin
  COMPLETED:      'COMPLETED',       // เสร็จสมบูรณ์
});

// Script Properties keys (prefix PIPELINE_ เพื่อกันชนกับ module อื่น)
const PIPELINE_PROPS = Object.freeze({
  STATE:      'PIPELINE_STATE',
  CHECKPOINT: 'PIPELINE_CHECKPOINT',
  QUOTA:      'PIPELINE_DAILY_QUOTA',
  CIRCUIT:    'PIPELINE_CIRCUIT_BREAKER',
  HISTORY:    'PIPELINE_HISTORY',
});

// ============================================================
// SECTION 2: Script Properties State Management
// ============================================================

/**
 * getPipelineState_ — อ่านสถานะปัจจุบันของ pipeline
 * @return {Object} { state, lastUpdated, message }
 * @private
 */
function getPipelineState_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PIPELINE_PROPS.STATE);
  if (raw === null || raw === '') {
    return {
      state: PIPELINE_STATES.IDLE,
      lastUpdated: null,
      message: '',
    };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // [FIX BUG-AUDIT-007 V5.5.042] log ก่อน reset เพื่อให้วินิจฉัย state corruption ได้
    logPipeline_('warn', 'getPipelineState_: JSON.parse ล้มเหลว — reset to IDLE. raw="' +
      String(raw).substring(0, 200) + '", error=' + e.message);
    return {
      state: PIPELINE_STATES.IDLE,
      lastUpdated: null,
      message: 'Invalid state JSON — reset to IDLE',
    };
  }
}

/**
 * setPipelineState_ — บันทึกสถานะ pipeline
 * @param {string} state - ค่าจาก PIPELINE_STATES
 * @param {string} message - ข้อความอธิบาย (optional)
 * @private
 */
function setPipelineState_(state, message) {
  const props = PropertiesService.getScriptProperties();
  const stateObj = {
    state: state,
    lastUpdated: new Date().toISOString(),
    message: message || '',
  };
  props.setProperty(PIPELINE_PROPS.STATE, JSON.stringify(stateObj));
  logPipeline_('info', 'State changed: ' + state + (message ? ' — ' + message : ''));
}

/**
 * getPipelineCheckpoint_ — อ่าน checkpoint ปัจจุบัน
 * @return {Object} { lastRunAt, runCount, totalRuntimeMs, lastBatchRows }
 * @private
 */
function getPipelineCheckpoint_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PIPELINE_PROPS.CHECKPOINT);
  if (raw === null || raw === '') {
    return {
      lastRunAt: null,
      runCount: 0,
      totalRuntimeMs: 0,
      lastBatchRows: 0,
      startedAt: null,
    };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // [FIX BUG-AUDIT-007 V5.5.042] log ก่อน reset checkpoint
    logPipeline_('warn', 'getPipelineCheckpoint_: JSON.parse ล้มเหลว — reset to defaults. raw="' +
      String(raw).substring(0, 200) + '", error=' + e.message);
    return {
      lastRunAt: null,
      runCount: 0,
      totalRuntimeMs: 0,
      lastBatchRows: 0,
      startedAt: null,
    };
  }
}

/**
 * setPipelineCheckpoint_ — บันทึก checkpoint
 * @param {Object} checkpoint
 * @private
 */
function setPipelineCheckpoint_(checkpoint) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PIPELINE_PROPS.CHECKPOINT, JSON.stringify(checkpoint));
}

/**
 * clearPipelineCheckpoint_ — ล้าง checkpoint (ใช้ตอน reset หรือ complete)
 * @private
 */
function clearPipelineCheckpoint_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PIPELINE_PROPS.CHECKPOINT);
}

// ============================================================
// SECTION 3: Quota Tracker
// ============================================================

/**
 * getDailyQuota_ — อ่านการใช้ quota วันนี้
 * @return {Object} { date, runtimeMs, runCount, lastResetAt }
 * @private
 */
function getDailyQuota_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PIPELINE_PROPS.QUOTA);
  const today = formatDateYMD_(new Date());

  if (raw === null || raw === '') {
    return {
      date: today,
      runtimeMs: 0,
      runCount: 0,
      lastResetAt: new Date().toISOString(),
    };
  }

  try {
    const quota = JSON.parse(raw);
    // ถ้าขึ้นวันใหม่ → รีเซ็ต
    if (quota.date !== today) {
      return {
        date: today,
        runtimeMs: 0,
        runCount: 0,
        lastResetAt: new Date().toISOString(),
      };
    }
    return quota;
  } catch (e) {
    // [FIX BUG-AUDIT-007 V5.5.042] log ก่อน reset quota
    logPipeline_('warn', 'getDailyQuota_: JSON.parse ล้มเหลว — reset to 0. raw="' +
      String(raw).substring(0, 200) + '", error=' + e.message);
    return {
      date: today,
      runtimeMs: 0,
      runCount: 0,
      lastResetAt: new Date().toISOString(),
    };
  }
}

/**
 * setDailyQuota_ — บันทึกการใช้ quota วันนี้
 * @param {Object} quota
 * @private
 */
function setDailyQuota_(quota) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PIPELINE_PROPS.QUOTA, JSON.stringify(quota));
}

/**
 * incrementQuotaUsage_ — เพิ่มการใช้ quota หลังรัน batch
 * @param {number} runtimeMs - เวลาที่ใช้ (millisecond)
 * @private
 */
function incrementQuotaUsage_(runtimeMs) {
  const quota = getDailyQuota_();
  quota.runtimeMs = (quota.runtimeMs || 0) + runtimeMs;
  quota.runCount = (quota.runCount || 0) + 1;
  setDailyQuota_(quota);
}

/**
 * isQuotaAvailable_ — ตรวจว่ายังมี quota เหลือพอสำหรับรัน batch ถัดไปไหม
 * @return {Object} { available, reason, remainingMs, remainingRuns }
 * @private
 */
function isQuotaAvailable_() {
  const quota = getDailyQuota_();
  const remainingMs = PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_DAY - (quota.runtimeMs || 0);
  const remainingRuns = PIPELINE_CONFIG.MAX_RUNS_PER_DAY - (quota.runCount || 0);

  // ตรวจ runtime
  if (remainingMs < PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_RUN) {
    return {
      available: false,
      reason: 'RUNTIME_LIMIT',
      remainingMs: remainingMs,
      remainingRuns: remainingRuns,
    };
  }

  // ตรวจ run count
  if (remainingRuns <= 0) {
    return {
      available: false,
      reason: 'RUN_COUNT_LIMIT',
      remainingMs: remainingMs,
      remainingRuns: 0,
    };
  }

  return {
    available: true,
    reason: 'OK',
    remainingMs: remainingMs,
    remainingRuns: remainingRuns,
  };
}

// ============================================================
// SECTION 4: Circuit Breaker
// ============================================================

/**
 * getCircuitBreaker_ — อ่านสถานะ circuit breaker
 * @return {Object} { consecutiveErrors, lastError, lastErrorAt, pausedAt }
 * @private
 */
function getCircuitBreaker_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PIPELINE_PROPS.CIRCUIT);
  if (raw === null || raw === '') {
    return {
      consecutiveErrors: 0,
      lastError: '',
      lastErrorAt: null,
      pausedAt: null,
    };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // [FIX BUG-AUDIT-007 V5.5.042] log ก่อน reset circuit breaker
    logPipeline_('warn', 'getCircuitBreaker_: JSON.parse ล้มเหลว — reset to 0 errors. raw="' +
      String(raw).substring(0, 200) + '", error=' + e.message);
    return {
      consecutiveErrors: 0,
      lastError: '',
      lastErrorAt: null,
      pausedAt: null,
    };
  }
}

/**
 * setCircuitBreaker_ — บันทึกสถานะ circuit breaker
 * @param {Object} cb
 * @private
 */
function setCircuitBreaker_(cb) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PIPELINE_PROPS.CIRCUIT, JSON.stringify(cb));
}

/**
 * recordBatchSuccess_ — รีเซ็ต error count เมื่อ batch สำเร็จ
 * @private
 */
function recordBatchSuccess_() {
  const cb = getCircuitBreaker_();
  cb.consecutiveErrors = 0;
  cb.lastError = '';
  cb.lastErrorAt = null;
  setCircuitBreaker_(cb);
}

/**
 * recordBatchError_ — บันทึก error และตรวจ circuit breaker
 * @param {string} errorMsg - ข้อความ error
 * @return {boolean} true ถ้า circuit breaker ถูก trigger (ควรหยุด pipeline)
 * @private
 */
function recordBatchError_(errorMsg) {
  const cb = getCircuitBreaker_();
  cb.consecutiveErrors = (cb.consecutiveErrors || 0) + 1;
  cb.lastError = errorMsg;
  cb.lastErrorAt = new Date().toISOString();

  if (cb.consecutiveErrors >= PIPELINE_CONFIG.MAX_CONSECUTIVE_ERRORS) {
    cb.pausedAt = new Date().toISOString();
    setCircuitBreaker_(cb);
    logPipeline_('error', 'Circuit Breaker TRIGGERED — ' + cb.consecutiveErrors +
      ' consecutive errors. Last: ' + errorMsg);
    return true; // ถูก trigger — ควรหยุด
  }

  setCircuitBreaker_(cb);
  logPipeline_('warn', 'Batch error ' + cb.consecutiveErrors + '/' +
    PIPELINE_CONFIG.MAX_CONSECUTIVE_ERRORS + ': ' + errorMsg);
  return false;
}

/**
 * isCircuitBreakerTripped_ — ตรวจว่า circuit breaker ถูก trigger อยู่ไหม
 * @return {boolean}
 * @private
 */
function isCircuitBreakerTripped_() {
  const cb = getCircuitBreaker_();
  return cb.pausedAt !== null && cb.pausedAt !== undefined;
}

/**
 * resetCircuitBreaker_ — รีเซ็ต circuit breaker (admin action)
 * @private
 */
function resetCircuitBreaker_() {
  setCircuitBreaker_({
    consecutiveErrors: 0,
    lastError: '',
    lastErrorAt: null,
    pausedAt: null,
  });
  logPipeline_('info', 'Circuit Breaker reset by admin');
}

// ============================================================
// SECTION 5: Trigger Manager
// ============================================================

/**
 * installPipelineTriggers — ติดตั้ง time-based triggers สำหรับ Pipeline Manager
 *   รันทุก 1 ชม ตั้งแต่ 08:00 ถึง 22:00 (15 รอบ/วัน)
 *   เรียกครั้งเดียว — trigger จะอยู่ถาวรจนกว่าจะลบ
 *
 *   หากมี trigger เดิมอยู่แล้ว → ลบก่อนแล้วสร้างใหม่ (idempotent)
 *
 * @return {Object} { installed, count }
 */
function installPipelineTriggers() {
  // ลบ trigger เดิมของ Pipeline Manager ก่อน
  removeAllPipelineTriggers_();

  // สร้าง trigger ใหม่ — รันทุก 1 ชม
  //  ใช้ nearMinute เพื่อกระจาย load (ไม่ใช่ 00 นาทีพอดี)
  ScriptApp.newTrigger('runPipelineBatch')
    .timeBased()
    .everyHours(PIPELINE_CONFIG.BATCH_RUN_INTERVAL_HOURS)
    .atHour(PIPELINE_CONFIG.BATCH_RUN_START_HOUR)
    .nearMinute(15)  // 08:15, 09:15, 10:15, ... (avoid 00:00 congestion)
    .create();

  // สร้าง trigger รีเซ็ต quota รายวัน — 00:05 น. ทุกวัน
  ScriptApp.newTrigger('resetDailyQuotaJob')
    .timeBased()
    .atHour(0)
    .nearMinute(5)
    .everyDays(1)
    .create();

  logPipeline_('info', 'Pipeline triggers installed — every ' +
    PIPELINE_CONFIG.BATCH_RUN_INTERVAL_HOURS + 'h, ' +
    PIPELINE_CONFIG.BATCH_RUN_START_HOUR + ':00-' +
    PIPELINE_CONFIG.BATCH_RUN_END_HOUR + ':00');

  return { installed: true, count: 2 };
}

/**
 * removeAllPipelineTriggers_ — ลบ trigger ทั้งหมดของ Pipeline Manager
 *   (ไม่ลบ trigger ของ module อื่น)
 * @return {number} จำนวน trigger ที่ลบ
 * @private
 */
function removeAllPipelineTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  let deleted = 0;
  const pipelineHandlers = ['runPipelineBatch', 'resetDailyQuotaJob'];

  triggers.forEach(function(t) {
    if (pipelineHandlers.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      deleted++;
    }
  });

  if (deleted > 0) {
    logPipeline_('info', 'Removed ' + deleted + ' pipeline trigger(s)');
  }
  return deleted;
}

/**
 * removeMatchEngineAutoResumeTriggers_ — ลบ auto-resume trigger ที่ MatchEngine ติดตั้ง
 *   ป้องกัน run ซ้อนกันระหว่าง Pipeline Manager กับ MatchEngine's auto-resume
 * @return {number} จำนวน trigger ที่ลบ
 * @private
 */
function removeMatchEngineAutoResumeTriggers_() {
  if (PIPELINE_CONFIG.CLEAN_MATCH_ENGINE_TRIGGERS === false) return 0;

  const triggers = ScriptApp.getProjectTriggers();
  let deleted = 0;
  // MatchEngine ใช้ handler ชื่อ 'runMatchEngine' สำหรับ auto-resume
  const matchEngineHandlers = ['runMatchEngine'];

  triggers.forEach(function(t) {
    if (matchEngineHandlers.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      deleted++;
    }
  });

  if (deleted > 0) {
    logPipeline_('info', 'Removed ' + deleted + ' MatchEngine auto-resume trigger(s)');
  }
  return deleted;
}

/**
 * getPipelineTriggerCount_ — นับ trigger ของ Pipeline Manager ที่ติดตั้งอยู่
 * @return {Object} { pipelineTriggers, matchEngineTriggers, total }
 * @private
 */
function getPipelineTriggerCount_() {
  const triggers = ScriptApp.getProjectTriggers();
  const pipelineHandlers = ['runPipelineBatch', 'resetDailyQuotaJob'];
  const matchEngineHandlers = ['runMatchEngine'];

  let pipelineCount = 0;
  let matchEngineCount = 0;

  triggers.forEach(function(t) {
    const handler = t.getHandlerFunction();
    if (pipelineHandlers.indexOf(handler) !== -1) {
      pipelineCount++;
    } else if (matchEngineHandlers.indexOf(handler) !== -1) {
      matchEngineCount++;
    }
  });

  return {
    pipelineTriggers: pipelineCount,
    matchEngineTriggers: matchEngineCount,
    total: triggers.length,
  };
}

// ============================================================
// SECTION 6: Main Pipeline Functions
// ============================================================

/**
 * runPipelineBatch — MAIN ENTRY POINT (เรียกโดย time-based trigger)
 *
 *   Flow:
 *   1. ตรวจ pipeline state — ถ้า PAUSED หรือ COMPLETED → return
 *   2. ตรวจ quota — ถ้าเต็ม → set state PAUSED_QUOTA + return
 *   3. ตรวจ circuit breaker — ถ้า tripped → set state PAUSED_ERRORS + return
 *   4. ลบ MatchEngine auto-resume triggers (กัน run ซ้อน)
 *   5. ตรวจ Lock — ถ้ามีคนรันอยู่ → return (skip รอบนี้)
 *   6. เรียก runMatchEngine() — รันจนกว่าจะหมดเวลา (~4-5 นาที)
 *   7. บันทึก quota + checkpoint
 *   8. ตรวจผล: สำเร็จ? error? ครบแล้ว?
 *   9. อัปเดต state ตามผล
 */
function runPipelineBatch() {
  const batchStart = new Date();

  // [FIX BUG-PM-005 V5.5.041] Enforce BATCH_RUN_END_HOUR at runtime
  //   สาเหตุ: GAS .everyHours(1).atHour(8) จะ trigger ทุกชม ไม่หยุดที่ 22:00
  //   → ถ้า quota ถูกรีเซ็ตที่ 00:05 แล้ว trigger 01:15, 02:15, ... จะรันต่อ
  //   แม้ quota cap (15 runs/day) จะช่วยกัน cross-day run แต่ก็ยังมี window
  //   23:15 ที่รันได้ (หลัง 22:00) ก่อน reset 00:05
  //   ป้องกันโดยตรวจชั่วโมงปัจจุบันที่ runtime — ถ้านอกช่วง 08:00-22:59 ให้ SKIP
  const currentHour = batchStart.getHours();
  if (currentHour < PIPELINE_CONFIG.BATCH_RUN_START_HOUR ||
      currentHour > PIPELINE_CONFIG.BATCH_RUN_END_HOUR) {
    logPipeline_('info', 'Outside business hours (' + currentHour +
      ':00) — skip (window: ' + PIPELINE_CONFIG.BATCH_RUN_START_HOUR +
      ':00-' + PIPELINE_CONFIG.BATCH_RUN_END_HOUR + ':59)');
    return { action: 'SKIP', reason: 'OUTSIDE_BUSINESS_HOURS' };
  }

  logPipeline_('info', '=== Pipeline Batch START ===');

  // ─── Step 1: ตรวจ state ───
  const state = getPipelineState_();
  if (state.state === PIPELINE_STATES.COMPLETED) {
    logPipeline_('info', 'Pipeline already COMPLETED — skip');
    return { action: 'SKIP', reason: 'COMPLETED' };
  }
  if (state.state === PIPELINE_STATES.PAUSED_MANUAL) {
    logPipeline_('info', 'Pipeline PAUSED by admin — skip');
    return { action: 'SKIP', reason: 'PAUSED_MANUAL' };
  }
  if (state.state === PIPELINE_STATES.PAUSED_QUOTA) {
    // อาจจะขึ้นวันใหม่ → ตรวจ quota ใหม่
    const quotaCheck = isQuotaAvailable_();
    if (quotaCheck.available === false) {
      logPipeline_('info', 'Still quota-limited — skip (reason: ' + quotaCheck.reason + ')');
      return { action: 'SKIP', reason: 'PAUSED_QUOTA' };
    }
    logPipeline_('info', 'Quota reset — resuming pipeline');
    setPipelineState_(PIPELINE_STATES.RUNNING, 'Resumed after quota reset');
  }
  if (state.state === PIPELINE_STATES.PAUSED_ERRORS) {
    // ต้องรอ admin reset circuit breaker
    logPipeline_('info', 'Pipeline PAUSED due to errors — admin reset required');
    return { action: 'SKIP', reason: 'PAUSED_ERRORS' };
  }

  // ─── Step 2: ตรวจ quota ───
  const quotaCheck = isQuotaAvailable_();
  if (quotaCheck.available === false) {
    setPipelineState_(PIPELINE_STATES.PAUSED_QUOTA, quotaCheck.reason);
    logPipeline_('warn', 'Quota limit reached — pausing (reason: ' + quotaCheck.reason +
      ', remaining: ' + quotaCheck.remainingMs + 'ms, ' + quotaCheck.remainingRuns + ' runs)');
    return { action: 'PAUSE', reason: 'QUOTA_' + quotaCheck.reason };
  }

  // ─── Step 3: ตรวจ circuit breaker ───
  if (isCircuitBreakerTripped_()) {
    setPipelineState_(PIPELINE_STATES.PAUSED_ERRORS, 'Circuit breaker tripped');
    logPipeline_('error', 'Circuit breaker tripped — pausing');
    return { action: 'PAUSE', reason: 'CIRCUIT_BREAKER' };
  }

  // ─── Step 4: ลบ MatchEngine auto-resume triggers (กัน run ซ้อน) ───
  removeMatchEngineAutoResumeTriggers_();

  // ─── Step 5: Lock (กัน concurrent runs) ───
  const lock = LockService.getScriptLock();
  const lockAcquired = lock.tryLock(30000); // รอ 30 วิ
  if (lockAcquired === false) {
    logPipeline_('warn', 'Cannot acquire lock — another batch running, skip');
    return { action: 'SKIP', reason: 'LOCK_BUSY' };
  }

  try {
    // ─── Step 6: เรียก runMatchEngine ───
    setPipelineState_(PIPELINE_STATES.RUNNING, 'Batch started');

    // [FIX CodeQL js/useless-assignment-to-local V5.5.035] ไม่กำหนดค่าเริ่มต้น — try/catch จะกำหนดให้แน่
    // [FIX V5.5.036] ลบ batchResult ออก — runMatchEngine() ไม่ return ค่าที่ใช้
    let batchError;
    try {
      // runMatchEngine มี Time Guard ในตัว (5 นาที) + มี auto-resume trigger ของมันเอง
      // Pipeline Manager จะคุม schedule เอง จึงลบ auto-resume ทิ้งหลังรัน
      runMatchEngine();
    } catch (err) {
      batchError = err;
      logPipeline_('error', 'runMatchEngine threw: ' + err.message);
    }

    const batchEnd = new Date();
    const runtimeMs = batchEnd.getTime() - batchStart.getTime();

    // ─── Step 7: บันทึก quota + checkpoint ───
    incrementQuotaUsage_(runtimeMs);

    const checkpoint = getPipelineCheckpoint_();
    if (checkpoint.startedAt === null) {
      checkpoint.startedAt = batchStart.toISOString();
    }
    checkpoint.lastRunAt = batchEnd.toISOString();
    checkpoint.runCount = (checkpoint.runCount || 0) + 1;
    checkpoint.totalRuntimeMs = (checkpoint.totalRuntimeMs || 0) + runtimeMs;
    setPipelineCheckpoint_(checkpoint);

    // ─── Step 8: ลบ MatchEngine auto-resume trigger ที่อาจจะติดตั้งระหว่างรัน ───
    removeMatchEngineAutoResumeTriggers_();

    // ─── Step 9: ตรวจผล ───
    // [FIX BUG-PM-001 V5.5.041] เปลี่ยนจาก !== null เป็น truthy check
    //   สาเหตุ: V5.5.035 ลบ `let batchError = null;` ออกตามคำแนะนำ CodeQL
    //   js/useless-assignment-to-local ทำให้ batchError เริ่มเป็น undefined
    //   แต่ check `!== null` ของ undefined คืน true → เรียก recordBatchError_
    //   ทุกครั้งที่ batch สำเร็จ → TypeError ใน logs + state machine พัง
    if (batchError) {
      const tripped = recordBatchError_(batchError.message);
      if (tripped) {
        setPipelineState_(PIPELINE_STATES.PAUSED_ERRORS, 'Circuit breaker tripped');
        logPipeline_('error', '=== Pipeline Batch END (PAUSED_ERRORS) — ' +
          formatDuration_(runtimeMs) + ' ===');
        return { action: 'PAUSE', reason: 'CIRCUIT_BREAKER', error: batchError.message };
      }
      setPipelineState_(PIPELINE_STATES.RUNNING, 'Batch error but continuing');
      logPipeline_('warn', '=== Pipeline Batch END (ERROR but continuing) — ' +
        formatDuration_(runtimeMs) + ' ===');
      return { action: 'CONTINUE', reason: 'ERROR_RECOVERED', error: batchError.message };
    }

    // สำเร็จ — reset error count
    recordBatchSuccess_();

    // ตรวจว่ายังมีงานเหลือไหม (ถ้า Source sheet ไม่มี SYNC_STATUS ที่ != SUCCESS → เสร็จ)
    const hasMoreWork = checkHasMoreWork_();

    if (hasMoreWork === false) {
      completePipeline_();
      logPipeline_('info', '=== Pipeline Batch END (COMPLETED) — ' +
        formatDuration_(runtimeMs) + ' ===');
      return { action: 'COMPLETE', reason: 'NO_MORE_WORK' };
    }

    setPipelineState_(PIPELINE_STATES.RUNNING, 'Batch completed, more work remaining');
    logPipeline_('info', '=== Pipeline Batch END (CONTINUE) — ' +
      formatDuration_(runtimeMs) + ' ===');
    return { action: 'CONTINUE', reason: 'MORE_WORK' };

  } finally {
    lock.releaseLock();
  }
}

/**
 * checkHasMoreWork_ — ตรวจว่ายังมีแถวที่ต้องประมวลผลหรือไม่
 *   อ่าน Source sheet แล้วนับแถวที่ SYNC_STATUS != SUCCESS
 * @return {boolean} true ถ้ายังมีงานเหลือ
 * @private
 */
function checkHasMoreWork_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss === null) return false;

    // ใช้ SHEET constant จาก 01_Config ถ้ามี — ไม่งั้น hardcode
    const sourceSheetName = (typeof SHEET !== 'undefined' && SHEET.SOURCE)
      ? SHEET.SOURCE
      : 'SCGนครหลวงJWDภูมิภาค';

    const sheet = ss.getSheetByName(sourceSheetName);
    if (sheet === null) {
      logPipeline_('warn', 'Source sheet not found: ' + sourceSheetName);
      return false;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return false; // มีแค่ header

    // [FIX Static Audit Issue 3] ใช้ SRC_IDX.SYNC_STATUS แทน hardcoded 37
    //   กรณี standalone (ไม่มี SRC_IDX) ใช้ fallback 37 (1-based, index 36)
    const syncStatusCol = (typeof SRC_IDX !== 'undefined' && typeof SRC_IDX.SYNC_STATUS === 'number')
      ? SRC_IDX.SYNC_STATUS + 1
      : 37;
    const data = sheet.getRange(2, syncStatusCol, lastRow - 1, 1).getValues();

    // นับแถวที่ SYNC_STATUS != SUCCESS
    let pendingCount = 0;
    for (let i = 0; i < data.length; i++) {
      const status = String(data[i][0] || '').toUpperCase();
      if (status !== 'SUCCESS') {
        pendingCount++;
      }
    }

    logPipeline_('info', 'checkHasMoreWork: ' + pendingCount + ' pending rows');
    return pendingCount > 0;

  } catch (e) {
    logPipeline_('warn', 'checkHasMoreWork_ error: ' + e.message + ' — assume yes');
    return true; // ถ้าตรวจไม่ได้ → assume ยังมีงาน (ปลอดภัยกว่า)
  }
}

/**
 * completePipeline_ — finalize pipeline เมื่อเสร็จสมบูรณ์
 *   ไม่ลบ triggers (รอข้อมูลใหม่เข้ามาในวันถัดไป)
 * @private
 */
function completePipeline_() {
  setPipelineState_(PIPELINE_STATES.COMPLETED, 'All pending rows processed');

  // ล้าง checkpoint (แต่เก็บ history)
  const checkpoint = getPipelineCheckpoint_();
  savePipelineHistory_(checkpoint);
  clearPipelineCheckpoint_();

  logPipeline_('info', '✅ Pipeline COMPLETED — waiting for new data');
}

/**
 * resetDailyQuotaJob — trigger รายวัน 00:05 น. สำหรับรีเซ็ต quota
 *   ถ้า pipeline อยู่ในสถานะ PAUSED_QUOTA → เปลี่ยนเป็น IDLE เพื่อรอรอบใหม่
 */
function resetDailyQuotaJob() {
  logPipeline_('info', '=== Daily Quota Reset Job ===');

  // บังคับรีเซ็ต quota
  const today = formatDateYMD_(new Date());
  setDailyQuota_({
    date: today,
    runtimeMs: 0,
    runCount: 0,
    lastResetAt: new Date().toISOString(),
  });

  // ถ้า pipeline อยู่ในสถานะ PAUSED_QUOTA → เปลี่ยนเป็น IDLE
  const state = getPipelineState_();
  if (state.state === PIPELINE_STATES.PAUSED_QUOTA) {
    setPipelineState_(PIPELINE_STATES.IDLE, 'Daily quota reset — ready to resume');
    logPipeline_('info', 'Pipeline unpaused from PAUSED_QUOTA');
  }

  // ลบ MatchEngine auto-resume triggers ที่ค้างจากเมื่อวาน
  removeMatchEngineAutoResumeTriggers_();

  logPipeline_('info', 'Daily quota reset complete');
}

// ============================================================
// SECTION 7: Admin Menu Actions
// ============================================================

/**
 * startPipeline — Admin action: เริ่ม pipeline ใหม่
 *   - รีเซ็ต state + checkpoint + circuit breaker
 *   - ติดตั้ง triggers ถ้ายังไม่มี
 *   - รัน batch แรกทันที
 */
function startPipeline() {
  logPipeline_('info', '=== Admin: START PIPELINE ===');

  // รีเซ็ต state
  setPipelineState_(PIPELINE_STATES.RUNNING, 'Started by admin');
  clearPipelineCheckpoint_();
  resetCircuitBreaker_();

  // รีเซ็ต quota ของวันนี้ด้วย (เริ่มนับใหม่)
  const today = formatDateYMD_(new Date());
  setDailyQuota_({
    date: today,
    runtimeMs: 0,
    runCount: 0,
    lastResetAt: new Date().toISOString(),
  });

  // ติดตั้ง triggers ถ้ายังไม่มี
  const triggerInfo = getPipelineTriggerCount_();
  if (triggerInfo.pipelineTriggers === 0) {
    installPipelineTriggers();
  }

  // ลบ MatchEngine auto-resume triggers ที่ค้าง
  removeMatchEngineAutoResumeTriggers_();

  // รัน batch แรกทันที
  const result = runPipelineBatch();

  return {
    action: 'STARTED',
    result: result,
    message: 'Pipeline started — will run every ' +
      PIPELINE_CONFIG.BATCH_RUN_INTERVAL_HOURS + 'h, ' +
      PIPELINE_CONFIG.BATCH_RUN_START_HOUR + ':00-' +
      PIPELINE_CONFIG.BATCH_RUN_END_HOUR + ':00',
  };
}

/**
 * pausePipeline — Admin action: หยุด pipeline ชั่วคราว
 *   - หยุดรับ batch ใหม่ (batch ที่รันอยู่จะรันจนจบ)
 *   - ไม่ลบ triggers (รอ resume)
 */
function pausePipeline() {
  logPipeline_('info', '=== Admin: PAUSE PIPELINE ===');
  setPipelineState_(PIPELINE_STATES.PAUSED_MANUAL, 'Paused by admin');
  removeMatchEngineAutoResumeTriggers_();
  return {
    action: 'PAUSED',
    message: 'Pipeline paused — current batch will finish, no new batches will start',
  };
}

/**
 * resumePipeline — Admin action: ทำต่อหลัง pause
 *   - ใช้หลังจาก pausePipeline() หรือหลัง reset Circuit Breaker
 */
function resumePipeline() {
  logPipeline_('info', '=== Admin: RESUME PIPELINE ===');

  const state = getPipelineState_();

  // ถ้า PAUSED_ERRORS → ต้อง reset circuit breaker ก่อน
  if (state.state === PIPELINE_STATES.PAUSED_ERRORS) {
    resetCircuitBreaker_();
  }

  setPipelineState_(PIPELINE_STATES.RUNNING, 'Resumed by admin');

  // รัน batch ทันที
  const result = runPipelineBatch();

  return {
    action: 'RESUMED',
    result: result,
    message: 'Pipeline resumed',
  };
}

/**
 * resetPipeline — Admin action: รีเซ็ต pipeline ทั้งหมด
 *   - ลบ state + checkpoint + circuit breaker + quota
 *   - ไม่ลบ triggers (คงไว้สำหรับการรันในอนาคต)
 *   - ไม่รัน batch ทันที (ให้ admin เรียก startPipeline เอง)
 */
function resetPipeline() {
  logPipeline_('info', '=== Admin: RESET PIPELINE ===');

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PIPELINE_PROPS.STATE);
  props.deleteProperty(PIPELINE_PROPS.CHECKPOINT);
  props.deleteProperty(PIPELINE_PROPS.CIRCUIT);
  props.deleteProperty(PIPELINE_PROPS.QUOTA);

  removeMatchEngineAutoResumeTriggers_();

  return {
    action: 'RESET',
    message: 'Pipeline reset complete — call startPipeline() to begin fresh',
  };
}

/**
 * showPipelineStatus — Admin action: แสดงสถานะปัจจุบัน
 *   ใช้ Log หรือ Execution console ดูผล
 * @return {Object} status object
 */
function showPipelineStatus() {
  const state = getPipelineState_();
  const checkpoint = getPipelineCheckpoint_();
  const quota = getDailyQuota_();
  const cb = getCircuitBreaker_();
  const triggers = getPipelineTriggerCount_();

  const status = {
    timestamp: new Date().toISOString(),
    state: state,
    checkpoint: {
      runCount: checkpoint.runCount || 0,
      totalRuntimeMs: checkpoint.totalRuntimeMs || 0,
      totalRuntimeFormatted: formatDuration_(checkpoint.totalRuntimeMs || 0),
      startedAt: checkpoint.startedAt,
      lastRunAt: checkpoint.lastRunAt,
    },
    quota: {
      date: quota.date,
      runtimeMs: quota.runtimeMs || 0,
      runtimeFormatted: formatDuration_(quota.runtimeMs || 0),
      runCount: quota.runCount || 0,
      remainingMs: PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_DAY - (quota.runtimeMs || 0),
      remainingRuns: PIPELINE_CONFIG.MAX_RUNS_PER_DAY - (quota.runCount || 0),
      limitMs: PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_DAY,
      limitRuns: PIPELINE_CONFIG.MAX_RUNS_PER_DAY,
    },
    circuitBreaker: {
      consecutiveErrors: cb.consecutiveErrors || 0,
      lastError: cb.lastError || '',
      lastErrorAt: cb.lastErrorAt,
      pausedAt: cb.pausedAt,
      isTripped: cb.pausedAt !== null && cb.pausedAt !== undefined,
    },
    triggers: triggers,
    config: {
      maxRuntimePerDay: formatDuration_(PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_DAY),
      maxRuntimePerRun: formatDuration_(PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_RUN),
      maxRunsPerDay: PIPELINE_CONFIG.MAX_RUNS_PER_DAY,
      scheduleHours: PIPELINE_CONFIG.BATCH_RUN_START_HOUR + ':00-' +
        PIPELINE_CONFIG.BATCH_RUN_END_HOUR + ':00 every ' +
        PIPELINE_CONFIG.BATCH_RUN_INTERVAL_HOURS + 'h',
      maxConsecutiveErrors: PIPELINE_CONFIG.MAX_CONSECUTIVE_ERRORS,
    },
  };

  // Log สรุปสถานะ
  logPipeline_('info', '=== PIPELINE STATUS ===');
  logPipeline_('info', 'State: ' + state.state + (state.message ? ' — ' + state.message : ''));
  logPipeline_('info', 'Runs today: ' + quota.runCount + '/' + PIPELINE_CONFIG.MAX_RUNS_PER_DAY);
  logPipeline_('info', 'Runtime today: ' + formatDuration_(quota.runtimeMs || 0) +
    ' / ' + formatDuration_(PIPELINE_CONFIG.MAX_RUNTIME_MS_PER_DAY));
  logPipeline_('info', 'Total runs: ' + checkpoint.runCount +
    ' (total time: ' + formatDuration_(checkpoint.totalRuntimeMs || 0) + ')');
  logPipeline_('info', 'Circuit breaker errors: ' + cb.consecutiveErrors +
    '/' + PIPELINE_CONFIG.MAX_CONSECUTIVE_ERRORS +
    (cb.pausedAt ? ' [TRIPPED]' : ''));
  logPipeline_('info', 'Triggers: pipeline=' + triggers.pipelineTriggers +
    ', matchEngine=' + triggers.matchEngineTriggers +
    ', total=' + triggers.total);

  return status;
}

/**
 * resetCircuitBreakerMenu — Admin action: รีเซ็ต circuit breaker
 *   ใช้หลังจากแก้ปัญหาที่ทำให้ error ซ้ำ แล้วต้องการรันต่อ
 */
function resetCircuitBreakerMenu() {
  logPipeline_('info', '=== Admin: RESET CIRCUIT BREAKER ===');
  resetCircuitBreaker_();

  // ถ้า state เป็น PAUSED_ERRORS → เปลี่ยนเป็น IDLE
  const state = getPipelineState_();
  if (state.state === PIPELINE_STATES.PAUSED_ERRORS) {
    setPipelineState_(PIPELINE_STATES.IDLE, 'Circuit breaker reset by admin');
  }

  return {
    action: 'CIRCUIT_BREAKER_RESET',
    message: 'Circuit breaker reset — call resumePipeline() to continue',
  };
}

/**
 * uninstallPipelineTriggers — Admin action: ลบ triggers ทั้งหมดของ Pipeline Manager
 *   ใช้เมื่อต้องการหยุดใช้ Pipeline Manager โดยสมบูรณ์
 */
function uninstallPipelineTriggers() {
  logPipeline_('info', '=== Admin: UNINSTALL PIPELINE TRIGGERS ===');
  const deleted = removeAllPipelineTriggers_();
  removeMatchEngineAutoResumeTriggers_();
  return {
    action: 'UNINSTALLED',
    deleted: deleted,
    message: 'Removed ' + deleted + ' pipeline trigger(s)',
  };
}

// ============================================================
// SECTION 8: Helpers
// ============================================================

/**
 * savePipelineHistory_ — บันทึกประวัติการรันล่าสุด (keep last 7)
 * @param {Object} checkpoint
 * @private
 */
function savePipelineHistory_(checkpoint) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PIPELINE_PROPS.HISTORY);
  let history = [];
  try {
    if (raw) history = JSON.parse(raw) || [];
  } catch (e) {
    // [FIX BUG-AUDIT-007 V5.5.042] log ก่อน reset history
    logPipeline_('warn', 'savePipelineHistory_: JSON.parse ล้มเหลว — reset to []. raw="' +
      String(raw).substring(0, 200) + '", error=' + e.message);
    history = [];
  }

  // เพิ่ม entry ใหม่
  history.unshift({
    completedAt: new Date().toISOString(),
    runCount: checkpoint.runCount,
    totalRuntimeMs: checkpoint.totalRuntimeMs,
    startedAt: checkpoint.startedAt,
    lastRunAt: checkpoint.lastRunAt,
  });

  // เก็บแค่ 7 รายการล่าสุด
  if (history.length > 7) {
    history = history.slice(0, 7);
  }

  props.setProperty(PIPELINE_PROPS.HISTORY, JSON.stringify(history));
}

/**
 * getPipelineHistory — อ่านประวัติการรัน (last 7 completed pipelines)
 * @return {Array}
 */
function getPipelineHistory() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PIPELINE_PROPS.HISTORY);
  if (raw === null || raw === '') return [];
  try {
    return JSON.parse(raw) || [];
  } catch (e) {
    // [FIX BUG-AUDIT-007 V5.5.042] log ก่อน return empty
    logPipeline_('warn', 'getPipelineHistory: JSON.parse ล้มเหลว — return []. raw="' +
      String(raw).substring(0, 200) + '", error=' + e.message);
    return [];
  }
}

/**
 * logPipeline_ — เขียน log (ใช้ logInfo ถ้ามี, ไม่งั้น console.log)
 * @param {string} level - 'info' | 'warn' | 'error'
 * @param {string} message
 * @private
 */
function logPipeline_(level, message) {
  const prefix = '[PipelineManager] ';

  // ใช้ logInfo/logWarn/logError ของระบบถ้ามี
  if (PIPELINE_CONFIG.LOG_TO_SYS_LOG === true) {
    if (level === 'info' && typeof logInfo === 'function') {
      logInfo('PipelineManager', message);
      return;
    }
    if (level === 'warn' && typeof logWarn === 'function') {
      logWarn('PipelineManager', message);
      return;
    }
    if (level === 'error' && typeof logError === 'function') {
      logError('PipelineManager', message);
      return;
    }
  }

  // Fallback: console.log (จะเห็นใน Stackdriver Logs)
  if (level === 'error') {
    console.error(prefix + message);
  } else if (level === 'warn') {
    console.warn(prefix + message);
  } else {
    console.log(prefix + message);
  }
}

/**
 * formatDateYMD_ — format date เป็น YYYY-MM-DD (สำหรับเทียบวัน)
 * @param {Date} date
 * @return {string}
 * @private
 */
function formatDateYMD_(date) {
  if (date === null || date === undefined) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/**
 * formatDuration_ — format millisecond เป็น "Xm Ys" หรือ "Xs"
 * @param {number} ms
 * @return {string}
 * @private
 */
function formatDuration_(ms) {
  if (ms === null || ms === undefined || ms === 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return minutes + 'm ' + remainingSeconds + 's';
  }
  return seconds + 's';
}
