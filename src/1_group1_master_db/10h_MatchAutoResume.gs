/**
 * VERSION: 6.0.069
 * FILE: 10h_MatchAutoResume.gs
 * LMDS V6.0 — Match Auto-Resume + Emergency Stop Signal
 * ===================================================
 * PURPOSE:
 *   Extracted from 10_MatchEngine.gs in V6.0.050 for SRP + maintainability.
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *   CALLS: (Invokes)
 *     - logInfo() / logWarn()                     → 03_SetupSheets.gs
 *     - PropertiesService.getScriptProperties() (GAS native)
 *     - ScriptApp.getProjectTriggers() / deleteTrigger() (GAS native)
 *   EXPORTS TO:
 *     - 10_MatchEngine.gs (prepareMatchEngineContext_ calls resetProcessingState_;
 *         runMatchEngineLoop_ calls isPipelineStopRequested_ + clearPipelineStopSignal_)
 *     - 17_SearchService.gs (runLookupEnrichment calls installAutoResume_)
 *     - 21_AliasService.gs (populateAliasFromSCGRawData / populateAliasFromFactDelivery
 *         call installAutoResume_ + removeAutoResume_)
 *     - 28_WebAppActions.gs (clearPipelineStopSignal_Web calls clearPipelineStopSignal_)
 *     - 00_App.gs (clearPipelineStopSignal_UI calls clearPipelineStopSignal_)
 *   SHEETS ACCESSED:
 *     - (none — uses PropertiesService for state, ScriptApp for triggers)
 *   TRIGGERS: Time-based (managed via ScriptApp.newTrigger — created by installAutoResume_,
         removed by removeAutoResume_ + cleanupOrphanAutoResumeTriggers_)
 *
 * ARCHITECTURE:
 *   Group 1 — Master data building (normalize, persons, places, geo, match engine, aliases)
 * ===================================================
 */

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
 * [FIX V6.0.007] Resilient trigger creation:
 *   - 3 retries with exponential backoff (2s, 4s, 8s) for transient GAS server errors
 *   - Quota check before create (warn if >15 time-based triggers exist)
 *   - Non-fatal: if all retries fail, log warning + alert user but DON'T throw
 *     Reason: pipeline has already done useful work in this batch — losing it
 *     because trigger creation failed would be worse than just asking user
 *     to manually re-run via menu.
 */
function installAutoResume_(funcName) {
  removeAutoResume_(); // ลบของเก่าก่อนถ้ามี

  // [V6.0.007] Pre-check: count existing triggers + cleanup orphans if approaching quota
  //   GAS limit: 20 time-based triggers per user per script
  //   If we have >15, try to cleanup any orphans (auto-resume triggers that lost their property mapping)
  try {
    const triggers = ScriptApp.getProjectTriggers();
    if (triggers.length > 15) {
      logWarn(
        'MatchEngine',
        'installAutoResume_: trigger count = ' +
          triggers.length +
          ' (approaching GAS quota of 20) — cleaning up orphans'
      );
      cleanupOrphanAutoResumeTriggers_();
    }
  } catch (quotaErr) {
    // Non-fatal — log and continue with trigger creation attempt
    logWarn('MatchEngine', 'installAutoResume_: quota pre-check failed (non-fatal): ' + quotaErr.message);
  }

  // [V6.0.007] Retry loop with exponential backoff for transient GAS server errors
  //   Common error: "ขออภัย มีข้อผิดพลาดของเซิร์ฟเวอร์เกิดขึ้น โปรดรอสักครู่แล้วลองอีกครั้ง"
  //   This is a Google-side transient error — retry usually succeeds within 2-3 attempts.
  const maxRetries = 3;
  const backoffMs = [2000, 4000, 8000]; // 2s, 4s, 8s
  let lastError = null;
  let trigger = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      trigger = ScriptApp.newTrigger(funcName)
        .timeBased()
        .after(60 * 1000) // ให้รันต่อในอีก 1 นาที (หลบ Timeout)
        .create();
      break; // success — exit retry loop
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        logError(
          'MatchEngine',
          'installAutoResume_: trigger creation failed after ' + maxRetries + ' attempts — ' + err.message,
          err
        );
      } else {
        logWarn(
          'MatchEngine',
          'installAutoResume_: attempt ' +
            attempt +
            '/' +
            maxRetries +
            ' failed — ' +
            err.message +
            ' — retrying in ' +
            backoffMs[attempt - 1] / 1000 +
            's...'
        );
        Utilities.sleep(backoffMs[attempt - 1]);
      }
    }
  }

  // [V6.0.007] Non-fatal failure handling
  //   If all retries failed, don't throw — just log + alert user
  //   Pipeline has already done useful work (e.g., processed 72/650 rows)
  //   Throwing here would discard that work AND make the next manual run harder
  //   because SYNC_STATUS would still show in-flight.
  if (!trigger) {
    const errMsg = lastError ? lastError.message : 'unknown error';
    logError(
      'MatchEngine',
      'installAutoResume_: ALL RETRIES FAILED — trigger NOT created. ' +
        'Pipeline will NOT auto-resume. User must manually re-run via menu "🔄 รัน Pipeline (Match Engine)". ' +
        'Last error: ' +
        errMsg
    );
    // Alert user (non-blocking — safeUiAlert_ handles trigger context)
    if (typeof safeUiAlert_ === 'function') {
      try {
        safeUiAlert_(
          '⚠️ Auto-Resume ล้มเหลว',
          'ไม่สามารถติดตั้ง trigger สำหรับรันต่อได้หลังจากลอง 3 ครั้ง\n\n' +
            'Pipeline หยุดที่แถวปัจจุบัน — ข้อมูลที่ประมวลผลแล้วยังถูกบันทึก\n\n' +
            'กรุณารันต่อด้วยตนเอง:\n' +
            'เมนู LMDS > Pipeline > 🔄 รัน Pipeline (Match Engine)\n\n' +
            'Error: ' +
            errMsg
        );
      } catch (alertErr) {
        // ignore — alert is best-effort
      }
    }
    // Send Telegram alert if available (for visibility)
    if (typeof sendPipelineAlert_ === 'function') {
      try {
        sendPipelineAlert_(
          '⚠️ Auto-Resume ล้มเหลว — กรุณารัน Pipeline ต่อด้วยตนเอง (last error: ' + errMsg + ')',
          'WARN'
        );
      } catch (alertErr) {
        // ignore
      }
    }
    return; // exit without throwing
  }

  const triggerId = trigger.getUniqueId();
  PropertiesService.getScriptProperties().setProperty('AUTO_RESUME_TRIGGER_ID', triggerId);
  logInfo('MatchEngine', `ติดตั้ง Auto-Trigger: ${funcName} (ID: ${triggerId}) จะทำงานต่อใน 1 นาที`);
}

/**
 * cleanupOrphanAutoResumeTriggers_ — [V6.0.007] Remove orphan time-based triggers
 *   that call runMatchEngine but have no matching AUTO_RESUME_TRIGGER_ID property.
 *   These orphans accumulate when removeAutoResume_ fails (e.g., property was
 *   cleared but trigger wasn't deleted, or vice versa).
 * @private
 */
function cleanupOrphanAutoResumeTriggers_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const knownTriggerId = props.getProperty('AUTO_RESUME_TRIGGER_ID');
    const triggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;

    for (const trigger of triggers) {
      const handler = trigger.getHandlerFunction();
      const triggerId = trigger.getUniqueId();
      // Only delete time-based triggers that call runMatchEngine AND are not the known one
      // (preserve any user-created triggers for other functions)
      if (handler === 'runMatchEngine' && triggerId !== knownTriggerId) {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logInfo(
        'MatchEngine',
        'cleanupOrphanAutoResumeTriggers_: deleted ' + deletedCount + ' orphan runMatchEngine triggers'
      );
    }
  } catch (err) {
    logWarn('MatchEngine', 'cleanupOrphanAutoResumeTriggers_ failed (non-fatal): ' + err.message);
  }
}

// ============================================================
// SECTION: [V6.0.007] Emergency Stop Signal
//   User can request pipeline stop via menu "🛑 หยุด Pipeline (Emergency Stop)".
//   The running pipeline checks isPipelineStopRequested_() every 10 rows
//   and exits gracefully if true (flushes current batch + removes auto-resume
//   trigger so it doesn't fire after user stop).
//
//   Communication channel: PropertiesService script property 'PIPELINE_STOP_REQUESTED'
//   - "true" = stop requested
//   - absent/other = no stop requested (default)
//
//   Why PropertiesService instead of LockService?
//   - PropertiesService is readable from any execution context (menu UI vs
//     pipeline execution run in different processes)
//   - LockService is for mutual exclusion, not signaling
//   - CacheService would also work but has TTL (we want the signal to persist
//     until the pipeline sees it)
// ============================================================

const PIPELINE_STOP_KEY = 'PIPELINE_STOP_REQUESTED';

/**
 * isPipelineStopRequested_ — [V6.0.007] Check if user requested emergency stop
 *   Called every 10 rows from runMatchEngineLoop_. Returns true if the
 *   PIPELINE_STOP_REQUESTED property is set to 'true'.
 *   Failsafe: returns false on any error (don't break pipeline just because
 *   PropertiesService had a hiccup).
 * @return {boolean}
 * @private
 */
function isPipelineStopRequested_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(PIPELINE_STOP_KEY) === 'true';
  } catch (e) {
    // Non-fatal — don't break pipeline just because stop check failed
    return false;
  }
}

/**
 * clearPipelineStopSignal_ — [V6.0.007] Clear the stop signal
 *   Called by finalizeMatchEngine_ after a graceful stop, OR by the
 *   "🟢 ยกเลิก Stop Signal" menu if user wants to manually clear.
 *   Failsafe: silently ignores errors.
 * @private
 */
function clearPipelineStopSignal_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(PIPELINE_STOP_KEY);
  } catch (e) {
    // ignore
  }
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
