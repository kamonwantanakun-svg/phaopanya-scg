/**
 * VERSION: 6.0.007
 * FILE: 00_App.gs
 * LMDS V5.5 — Application Entry Point & Menu Controller
 * ===================================================
 * PURPOSE:
 *   จุดเริ่มต้นหลักของระบบ LMDS ควบคุม Custom Menu และ Pipeline Triggers
 *   ทำหน้าที่เป็น Gateway สำหรับการเรียกใช้งานระบบทั้งหมด
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
 *     - 01_Config.gs     (Configuration & Constants)
 *     - 02_Schema.gs     (Schema Definitions)
 *   CALLS (Invokes):
 *     - runMatchEngine()                       → 10_MatchEngine.gs
 *     - runLookupEnrichment()                 → 17_SearchService.gs
 *     - buildFullQualityReport()              → 13_ReportService.gs
 *     - fetchDataFromSCGJWD()                 → 18_ServiceSCG.gs
 *     - buildGeoDictionary()                  → 16_GeoDictionaryBuilder.gs
 *     - applyMasterCoordinatesToDailyJob()    → 18_ServiceSCG.gs
 *     - MIGRATION_HybridAliasSystem()         → 21_AliasService.gs
 *     - populateAliasFromSCGRawData_()        → 21_AliasService.gs
 *     - assignMasterUuidIfMissing()           → 21_AliasService.gs
 *   EXPORTS TO:
 *     - All modules (onOpen trigger, menu system)
 *   SHEETS ACCESSED:
 *     - SHEET.SOURCE        (Read: Pipeline input)
 *     - SHEET.DAILY_JOB     (Read+Write: SCG Daily Operations)
 *     - SHEET.Q_REVIEW      (Read+Write: Review Queue, onEdit trigger)
 *   TRIGGERS:
 *     - onOpen()     → สร้าง Custom Menu inline ทุกครั้งที่เปิด Spreadsheet
 *     - onEdit()     → ดักจับการแก้ไขใน Q_REVIEW
 * ===================================================
 * ARCHITECTURE:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  00_App.gs (Entry Point / Gateway)                         │
 *   │  ├── onOpen() → builds Custom Menu inline (no createMenu_ helper) │
 *   │  └── Custom Menu → Pipeline Actions                         │
 *   │      ├── "Run Full Pipeline" → runFullPipeline()           │
 *   │      ├── "🟩 กลุ่ม 1" → runMatchEngine()                  │
 *   │      ├── "🟦 กลุ่ม 2" → fetchDataFromSCGJWD()             │
 *   │      ├── "🔧 ระบบ" → setupAllSheets / buildGeoDictionary  │
 *   │      │   ├── "Migration: Hybrid Alias" → MIGRATION_HybridAliasSystem()│
 *   │      │   ├── "ตรวจสอบ Master UUID" → assignMasterUuidIfMissing()  │
 *   │      │   └── "ดึงชื่อจาก SCG ดิบ" → populateAliasFromSCGRawData_() │
 *   │      └── "Audit" → runPreflightAudit()                      │
 *   └─────────────────────────────────────────────────────────────┘
 * ===================================================
 */

// constants are defined in 01_Config.gs

// ============================================================
// SECTION 1: onOpen Trigger
// ============================================================

function onOpen() {
  // [ADD v003] ตรวจ Config ทันทีที่เปิด Spreadsheet
  try {
    validateConfig();
  } catch (cfgErr) {
    // [FIX BUG-04 v5.5.001] เปลี่ยน getUi().alert() เป็น safeUiAlert_() — trigger-safe (onOpen)
    safeUiAlert_('⚠️ Config Warning:\n' + cfgErr.message + '\n\nระบบยังใช้งานได้ แต่กรุณาตรวจสอบก่อนรัน Pipeline');
  }

  const ui = SpreadsheetApp.getUi();

  ui.createMenu(`🚚 ${APP_NAME}`)
    .addItem('🚀 Run Full Pipeline', 'runFullPipeline')
    .addItem('📍 จับคู่พิกัดวันนี้', 'applyMasterCoordinatesToDailyJob')
    .addSeparator()

    .addSubMenu(
      ui
        .createMenu('🟩 กลุ่ม 1: ล้างข้อมูล & Master')
        .addItem('▶️ รัน Full Pipeline (ทั้งหมด)', 'runFullPipeline')
        .addSeparator()
        .addItem('Step 1 — โหลดข้อมูลดิบจากแหล่ง', 'runLoadSource')
        .addItem('Step 2 — Normalize ชื่อ/ที่อยู่', 'runNormalize')
        .addItem('Step 3 — Match Engine', 'runMatchEngine')
        .addSeparator()
        .addItem('📋 เปิด Review Queue', 'openReviewQueue')
        .addItem('▶️ รันคำสั่งที่เลือกไว้ทั้งหมด', 'applyAllPendingDecisions')
        .addItem('🧹 [V6] ล้างแถวที่ Done/Escalated', 'clearDoneReviews_UI')
        .addItem('📊 รายงาน Data Quality', 'buildFullQualityReport')
    )

    .addSubMenu(
      ui
        .createMenu('🟦 กลุ่ม 2: งานประจำวัน (SCG)')
        .addItem('📥 ดึงข้อมูล SCG API', 'fetchDataFromSCGJWD')
        .addItem('📍 จับคู่พิกัด', 'applyMasterCoordinatesToDailyJob')
        .addSeparator()
        .addItem('🗑️ ล้างข้อมูลทั้งหมด', 'clearAllSCGSheets_UI')
        .addSeparator()
        .addItem('🔐 ตั้งค่า SCG Cookie', 'setSCGCookie_UI')
    )

    .addSeparator()

    .addSubMenu(
      ui
        .createMenu('🔧 ระบบ & ตั้งค่า')
        .addItem('⚙️ ตั้งค่า API Key', 'setupEnvironment')
        .addItem('🔐 ตั้งค่า SCG Cookie', 'setSCGCookie_UI')
        .addItem('👥 ตั้งค่ารายชื่อ Admin', 'setupAdminList_UI')
        .addItem('🏗️ สร้างชีตทั้งหมด', 'setupAllSheets')
        .addItem('🌍 อัปเดตฐานข้อมูลภูมิศาสตร์ (SYS_TH_GEO)', 'buildGeoDictionary')
        .addItem('🛠️ เติมข้อมูลภูมิศาสตร์ (16 คอลัมน์)', 'populateGeoMetadata')
        .addItem('🔗 สร้าง Alias อัตโนมัติจากประวัติ (FACT)', 'generatePersonAliasesFromHistory')
        .addItem('🔄 Migration: Hybrid Alias System', 'MIGRATION_HybridAliasSystem')
        .addItem('🔗 ตรวจสอบ Master UUID', 'assignMasterUuidIfMissing')
        .addItem('📥 ดึงชื่อจาก SCG ดิบ → M_ALIAS', 'populateAliasFromSCGRawData')
        .addSeparator()
        .addItem('🛡️ ป้องกันข้อมูล Sensitive', 'applySheetProtection_UI')
        .addSeparator()
        .addItem('🛡️ [PH2] Preflight Audit', 'runPreflightAudit')
        .addItem('🔍 [V6] Pipeline Preflight (Strict)', 'runPipelinePreflightStrict_UI')
        .addItem('🧹 [PH2] Detect Duplicates', 'detectDoubleProcessing')
        .addItem('✅ ตรวจสอบ System Integrity', 'checkSystemIntegrity')
        .addItem('🔍 วินิจฉัย Pipeline (Diagnostic)', 'diagnoseSystemState')
        .addSeparator()
        .addItem('🔄 รีเซ็ตสถานะ SYNC (เพื่อรันใหม่)', 'resetSourceSyncStatus')
        .addItem('🧹 ล้างความจำระบบ (Clear Cache)', 'invalidateAllGlobalCaches')
        .addSeparator()
        .addItem('🔍 [V6] Dedup Audit (Person)', 'runDedupAuditPerson_UI')
        .addItem('🔍 [V6] Dedup Audit (Place)', 'runDedupAuditPlace_UI')
        .addSeparator()
        .addItem('👥 [V6] ตั้งค่า Roles (RBAC)', 'setupRoleAssignments_UI')
        .addSeparator()
        .addItem('🧹 [V6] ลบ Trigger ค้าง (Cleanup)', 'cleanupStaleTriggers_UI')
        .addItem('🧹 [V6] Cleanup Auto-Resume Triggers', 'cleanupAutoResumeTriggers_UI')
        .addSeparator()
        .addItem('📜 [V6] Prune Audit Trail (90 วัน)', 'cleanupAuditTrail_UI')
        .addItem('📖 ดู Version Info', 'showVersionInfo')
    )

    .addToUi();
}

// ============================================================
// SECTION 2: onEdit Trigger
// ============================================================

/**
 * onEdit — ดักจับการแก้ไขใน Spreadsheet
 * [ADD v003] รองรับการเลือก Decision ใน Q_REVIEW
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const name = sheet.getName();

  // 1. ตรวจสอบว่าแก้ไขในชีต Q_REVIEW หรือไม่
  if (name === SHEET.Q_REVIEW) {
    const col = e.range.getColumn();
    const row = e.range.getRow();

    // 2. ตรวจสอบว่าแก้ในคอลัมน์ DECISION (V) หรือไม่
    if (col === REVIEW_IDX.DECISION + 1 && row > 1) {
      const decision = String(e.value || '').trim();
      if (!decision) return;

      const reviewId = String(sheet.getRange(row, REVIEW_IDX.REVIEW_ID + 1).getValue()).trim();
      if (!reviewId) return;

      try {
        // [FIX v003] ประมวลผลทันทีที่เลือก
        applyReviewDecision(reviewId, decision);

        // [PERF-006] ส่ง row เข้า highlightHighPriorityReviews → single-row update
        //   เดิม: เรียกแบบไม่ส่ง row → full-sheet refresh (44,000 cell ops/click)
        //   ใหม่: ส่ง row → single-row update (22 cell ops/click, ลด ~95%)
        //   ถ้าเป็น bulk paste (multi-row) → fallback ไป full refresh อัตโนมัติ
        if (e.range.getNumRows() > 1) {
          highlightHighPriorityReviews(); // multi-row edit → full refresh
        } else {
          highlightHighPriorityReviews(row); // single-row edit → targeted update
        }

        sheet.getParent().toast(`✅ ประมวลผล ${reviewId} สำเร็จ`, APP_NAME, 3);
      } catch (err) {
        logError('App_onEdit', `reviewId ${reviewId} ล้มเหลว: ${err.message}`, err);
        // [FIX BUG-04 v5.5.001] เปลี่ยน getUi().alert() เป็น safeUiAlert_() — trigger-safe (onEdit)
        safeUiAlert_(`❌ ประมวลผลล้มเหลว: ${err.message}`);
      }
    }
  }
}

// ============================================================
// SECTION 3: safeRun — Global Error Handler
// ============================================================

function safeRun(funcName, fn) {
  try {
    fn();
  } catch (err) {
    logError(funcName, err.message || String(err), err);
    // [FIX BUG-04 v5.5.001] เปลี่ยน getUi().alert() เป็น safeUiAlert_()
    safeUiAlert_(`❌ ${funcName} ล้มเหลว:\n${err.message}`);
  }
}

// ============================================================
// SECTION 4: Full Pipeline
// ============================================================

function runFullPipeline() {
  // [FIX CodeQL js/unused-local-variable V5.5.035] ui ไม่ถูกใช้ — ใช้ safeUiAlert_() แทน

  // [ADD v003] LockService กัน double-click
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
    safeUiAlert_('⚠️ มี Pipeline กำลังทำงานอยู่\nกรุณารอให้เสร็จก่อน');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const startTime = new Date();

    logInfo('App', `Full Pipeline เริ่มต้น — v${APP_VERSION}`);
    ss.toast('🚀 เริ่มต้นรัน Full Pipeline (ทำงานเบื้องหลัง)...', APP_NAME, 5);

    // [FIX v5.4.001] ล้าง Cache ทั้งหมดก่อนเริ่ม Pipeline เพื่อให้อ่านข้อมูลใหม่จากชีต
    invalidateAllGlobalCaches();

    safeRun('runFullPipeline', () => {
      ss.toast('Step 1/3: กำลังโหลดข้อมูลดิบ...', APP_NAME, 10);
      runLoadSource();

      ss.toast('Step 2/3: กำลัง Normalize...', APP_NAME, 10);
      runNormalize();

      ss.toast('Step 3/3: กำลัง Match Engine...', APP_NAME, 10);
      runMatchEngine();

      const elapsedSec = Math.round((new Date() - startTime) / 1000);
      logInfo('App', `Full Pipeline สำเร็จ — ${elapsedSec} วินาที`);

      // [FIX v5.4.001] แสดงสรุปผลลัพธ์แบบละเอียด พร้อมตรวจเตือนถ้ามีปัญหา
      const diagResult = getPipelineDiagnosticSummary_();
      let alertMsg = `✅ Full Pipeline สำเร็จ!\nใช้เวลา: ${elapsedSec} วินาที\n\n` + diagResult.summary;
      if (diagResult.warnings.length > 0) {
        alertMsg += '\n\n⚠️ คำเตือน:\n' + diagResult.warnings.join('\n');
      }
      // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
      safeUiAlert_(alertMsg);
    });
    // [FIX V5.5.048] เดิมมีเพียง try/finally ไม่มี catch — ทำให้ error ภายใน safeRun ไม่ถูก log/alert ที่ระดับนี้
    // (safeRun จับ error ภายในตัวเองแล้ว แต่ outer try ก็ควรมี catch เผื่อกรณี exception เกิดนอก safeRun
    //  เช่น invalidateAllGlobalCaches(), getPipelineDiagnosticSummary_())
  } catch (e) {
    logError('App', 'runFullPipeline failed: ' + e.message, e);
    safeUiAlert_('❌ Pipeline ล้มเหลว:\n' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
    // [PERF-012] Flush log buffer ก่อน execution จบ — ป้องกัน log entries สูญหาย
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}

/**
 * getPipelineDiagnosticSummary_ — [NEW v5.4.001] สรุปสถานะหลัง Pipeline รันเสร็จ
 * ตรวจสอบจำนวนข้อมูลในแต่ละชีต และแจ้งเตือนถ้าชีตว่าง
 * @return {{ summary: string, warnings: string[] }}
 */
function getPipelineDiagnosticSummary_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const checks = [
    { name: SHEET.M_PERSON, label: 'M_PERSON' },
    { name: SHEET.M_PERSON_ALIAS, label: 'M_PERSON_ALIAS' },
    { name: SHEET.M_PLACE, label: 'M_PLACE' },
    { name: SHEET.M_PLACE_ALIAS, label: 'M_PLACE_ALIAS' },
    { name: SHEET.M_GEO_POINT, label: 'M_GEO_POINT' },
    { name: SHEET.M_ALIAS, label: 'M_ALIAS' },
    { name: SHEET.FACT_DELIVERY, label: 'FACT_DELIVERY' },
    { name: SHEET.Q_REVIEW, label: 'Q_REVIEW' }
  ];

  const warnings = [];
  const lines = [];

  checks.forEach((c) => {
    const sheet = ss.getSheetByName(c.name);
    const dataRows = sheet ? Math.max(0, sheet.getLastRow() - 1) : -1;
    if (dataRows === -1) {
      lines.push(`  ❌ ${c.label}: ไม่พบชีต`);
      warnings.push(`ไม่พบชีต ${c.label} — รัน "สร้างชีตทั้งหมด" ก่อน`);
    } else if (dataRows === 0) {
      lines.push(`  ⚠️ ${c.label}: 0 แถว (ว่าง)`);
    } else {
      lines.push(`  ✅ ${c.label}: ${dataRows} แถว`);
    }
  });

  // ตรวจสอบ Source Sheet
  const srcSheet = ss.getSheetByName(SHEET.SOURCE);
  if (srcSheet && srcSheet.getLastRow() > 1) {
    const srcTotal = srcSheet.getLastRow() - 1;
    // นับแถวที่ SYNC_STATUS = 'SUCCESS'
    const syncCol = SRC_IDX.SYNC_STATUS + 1;
    const syncData = srcSheet.getRange(2, syncCol, srcTotal, 1).getValues();
    const doneCount = syncData.filter((r) => String(r[0]).trim() === SCG_CONFIG.SYNC_DONE_VALUE).length;
    const pendingCount = srcTotal - doneCount;
    lines.push(`\n  📊 Source: ${srcTotal} แถว (ประมวลผลแล้ว: ${doneCount}, ค้างอยู่: ${pendingCount})`);
    if (pendingCount === 0 && srcTotal > 0) {
      warnings.push(
        'Source ทั้งหมดถูกประมวลผลแล้ว (SYNC_STATUS=SUCCESS) — ถ้าต้องการรันใหม่ กดเมนู "รีเซ็ตสถานะ SYNC"'
      );
    }
  } else {
    warnings.push('ไม่พบข้อมูลในชีต Source — ตรวจสอบชื่อชีต: ' + SHEET.SOURCE);
  }

  // ตรวจสอบ column mismatch
  [SHEET.M_PERSON, SHEET.M_PLACE].forEach((sn) => {
    const sheet = ss.getSheetByName(sn);
    if (sheet) {
      const actualCols = sheet.getLastColumn();
      const schemaCols = SCHEMA[sn] ? SCHEMA[sn].length : 0;
      if (schemaCols > 0 && actualCols < schemaCols) {
        warnings.push(
          `${sn}: ชีตมี ${actualCols} คอลัมน์ แต่ SCHEMA ต้องการ ${schemaCols} — รัน "สร้างชีตทั้งหมด" เพื่อเพิ่มคอลัมน์ที่ขาด`
        );
      }
    }
  });

  return { summary: lines.join('\n'), warnings: warnings };
}

// ============================================================
// SECTION 5: Navigation Helpers
// ============================================================

function openReviewQueue() {
  // [FIX S1 v5.5.002] เพิ่ม try-catch ครอบทั้งฟังก์ชัน — Rule 12
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (sheet) {
      ss.setActiveSheet(sheet);
      ss.toast('กำลังแสดง Review Queue', APP_NAME, 3);
    } else {
      // [FIX BUG-04 v5.5.001] เปลี่ยน getUi().alert() เป็น safeUiAlert_()
      safeUiAlert_('❌ ไม่พบชีต Q_REVIEW\nกรุณารัน "สร้างชีตทั้งหมด" ก่อน');
    }
  } catch (err) {
    logError('App', 'openReviewQueue: ' + err.message, err);
    safeUiAlert_('❌ เปิด Review Queue ล้มเหลว: ' + err.message);
  }
}

// ============================================================
// SECTION 6: System Tools
// ============================================================

// [FIX BUG-A2] v5.4.003: เพิ่ม try-catch outer
function checkSystemIntegrity() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const errors = [];
    const warns = [];

    const requiredSheets = [
      SHEET.M_PERSON,
      SHEET.M_PERSON_ALIAS,
      SHEET.M_PLACE,
      SHEET.M_PLACE_ALIAS,
      SHEET.M_ALIAS,
      SHEET.M_GEO_POINT,
      SHEET.M_DESTINATION,
      SHEET.FACT_DELIVERY,
      SHEET.Q_REVIEW,
      SHEET.SYS_LOG,
      SHEET.SYS_CONFIG,
      SHEET.SYS_TH_GEO,
      SHEET.RPT_QUALITY,
      SHEET.DAILY_JOB,
      SHEET.INPUT,
      SHEET.EMPLOYEE,
      SHEET.SOURCE
    ];

    requiredSheets.forEach((name) => {
      if (!ss.getSheetByName(name)) errors.push('ไม่พบชีต: ' + name);
    });

    try {
      const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
      if (!apiKey) warns.push('GEMINI_API_KEY ยังไม่ได้ตั้งค่า');
      else if (apiKey.length < 20) warns.push('GEMINI_API_KEY อาจไม่ถูกต้อง');
    } catch (e) {
      warns.push('ไม่สามารถอ่าน GEMINI_API_KEY: ' + e.message);
    }

    if (errors.length === 0 && warns.length === 0) {
      // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
      safeUiAlert_('✅ System Integrity: ปกติทุกอย่าง!\nVersion: ' + APP_VERSION);
      return;
    }

    let msg = '';
    if (errors.length > 0) {
      msg += '❌ พบ Error ' + errors.length + ' รายการ:\n';
      msg += errors.map((e) => '  • ' + e).join('\n') + '\n\n💡 รัน สร้างชีตทั้งหมด\n\n';
    }
    if (warns.length > 0) {
      msg += '⚠️ พบ Warning ' + warns.length + ' รายการ:\n';
      msg += warns.map((w) => '  • ' + w).join('\n');
    }
    // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
    safeUiAlert_(msg);
  } catch (err) {
    logError('App', 'checkSystemIntegrity: ' + err.message, err);
    safeUiAlert_('❌ checkSystemIntegrity ล้มเหลว: ' + err.message);
  }
}

function setupEnvironment() {
  // [SEC-002 FIX] Authorization Guard — เฉพาะ Admin เท่านั้นที่ตั้งค่า API Key ได้
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ตั้งค่า API Key\nกรุณาติดต่อ Admin');
    return;
  }
  // [FIX S1 v5.5.002] เพิ่ม try-catch ครอบทั้งฟังก์ชัน — Rule 12
  try {
    const ui = SpreadsheetApp.getUi();

    const result = ui.prompt(
      '⚙️ ตั้งค่า Gemini API Key',
      'กรุณาใส่ Gemini API Key:\n(ได้จาก https://aistudio.google.com/app/apikey)\n\n' +
        'รองรับทั้งรูปแบบเก่า (AIza...) และรูปแบบใหม่ (AQ...)',
      ui.ButtonSet.OK_CANCEL
    );

    if (result.getSelectedButton() !== ui.Button.OK) return;

    const inputKey = result.getResponseText().trim();

    // [FIX v5.5.006] รองรับ Gemini API Key ทั้ง 2 รูปแบบ:
    // - Legacy (v1): ขึ้นต้นด้วย "AIza" + 35 ตัวอักษร (รวม 39 ตัว)
    // - New (v2):    ขึ้นต้นด้วย "AQ."   + Base64URL chars (40-80 ตัว)
    // Charset ที่อนุญาต: A-Z, a-z, 0-9, -, _ (Base64 URL-safe)
    const legacyPattern = /^AIza[0-9A-Za-z\-_]{35}$/;
    const newPattern = /^AQ\.[0-9A-Za-z\-_]{30,80}$/;
    const isValidKey = legacyPattern.test(inputKey) || newPattern.test(inputKey);

    if (!inputKey || !isValidKey) {
      // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
      safeUiAlert_(
        '❌ API Key ไม่ถูกต้อง\n\n' +
          'รูปแบบที่รองรับ:\n' +
          '• รูปแบบเก่า: ขึ้นต้นด้วย "AIza" ยาว 39 ตัวอักษร\n' +
          '• รูปแบบใหม่: ขึ้นต้นด้วย "AQ."   ยาว 33-83 ตัวอักษร\n\n' +
          'กรุณาตรวจสอบคีย์อีกครั้ง หรือขอคีย์ใหม่จาก\n' +
          'https://aistudio.google.com/app/apikey'
      );
      return;
    }

    PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', inputKey);
    logInfo('App', 'ตั้งค่า GEMINI_API_KEY สำเร็จ (รูปแบบ: ' + (inputKey.startsWith('AQ.') ? 'v2' : 'v1') + ')');
    // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
    safeUiAlert_('✅ บันทึก API Key เรียบร้อยแล้วครับ!');
  } catch (err) {
    logError('App', 'setupEnvironment: ' + err.message, err);
    safeUiAlert_('❌ ตั้งค่า API Key ล้มเหลว: ' + err.message);
  }
}

/**
 * populateAliasFromSCGRawData — [FIX-01 v5.4.003] Public wrapper สำหรับเรียกจาก Menu
 * GAS Menu ไม่สามารถเรียกฟังก์ชัน private (ขึ้นต้นด้วย _) ได้
 * จึงต้องมี public wrapper เพื่อให้ Menu เรียกได้
 */
function populateAliasFromSCGRawData() {
  // [SEC-002 FIX] Authorization Guard — bulk write M_ALIAS ต้องเป็น Admin เท่านั้น
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์รัน Alias Enrichment\nกรุณาติดต่อ Admin');
    return 0;
  }
  return populateAliasFromSCGRawData_();
}

function showVersionInfo() {
  const msg =
    `🚚 ${APP_NAME}\n` +
    `Version: ${APP_VERSION}\n` +
    `Schema: v${SCHEMA_VERSION}\n` +
    'Audit Cycles: 18 (CRITICAL → PERF → SECURITY → REVIEW15 → REFACTOR → SYNC → CACHE-FIX → CACHE-CLEANUP → DOC-SYNC → GOOGLE-MAPS-REFACTOR → DRIVER-VERIFIED → CRITICAL-FIX → PERFORMANCE-FIX → SECURITY-POSTFIX → REVIEW15-CLEAN-CODE-FIX → REFACTOR_CYCLE6 → REFACTOR_CYCLE6_RESIDUAL → DEEP-DIVE-AUDIT → CONSISTENCY-SYNC)\n\n' +
    '📦 Modules (22 files):\n' +
    '  00_App.gs                v5.5.022\n' +
    '  01_Config.gs             v5.5.022\n' +
    '  02_Schema.gs             v5.5.022\n' +
    '  03_SetupSheets.gs        v5.5.022\n' +
    '  04_SourceRepository.gs   v5.5.022\n' +
    '  05_NormalizeService.gs   v5.5.022\n' +
    '  06_PersonService.gs      v5.5.022\n' +
    '  07_PlaceService.gs       v5.5.022\n' +
    '  08_GeoService.gs         v5.5.022\n' +
    '  09_DestinationService.gs v5.5.022\n' +
    '  10_MatchEngine.gs        v5.5.022\n' +
    '  11_TransactionService.gs v5.5.022\n' +
    '  12_ReviewService.gs      v5.5.022\n' +
    '  13_ReportService.gs      v5.5.022\n' +
    '  14_Utils.gs              v5.5.022\n' +
    '  15_GoogleMapsAPI.gs      v5.5.022\n' +
    '  16_GeoDictionaryBuilder.gs     v5.5.022\n' +
    '  17_SearchService.gs      v5.5.022\n' +
    '  18_ServiceSCG.gs         v5.5.022\n' +
    '  19_Hardening.gs          v5.5.022\n' +
    '  20_ThGeoService.gs       v5.5.022\n' +
    '  21_AliasService.gs       v5.5.022\n\n' +
    '⚙️ Core System (Group 0): App, Config, Schema, Setup, Utils, Hardening\n' +
    '🟩 Group 1 — Master DB: Normalize, Person, Place, Geo, Dest, Match, GeoDict, ThGeo, Alias\n' +
    '🟦 Group 2 — Daily Ops: SourceRepo, Transaction, Review, Report, Maps, Search, SCG';

  // [FIX BUG-04 v5.5.001] เปลี่ยน ui.alert() เป็น safeUiAlert_()
  safeUiAlert_(msg);
}

// ============================================================
// SECTION 7: Diagnostic Tool — [NEW v5.4.001]
// ============================================================

/**
 * diagnoseSystemState — วินิจฉัยปัญหา Pipeline แบบครบวงจร
 * [REFACTOR v5.5.001] แยกเป็น 4 sub-functions เพื่อลดความยาว (145→28 บรรทัด) — กฎข้อ 1.1
 * ตรวจสอบ: ชีตมีอยู่ไหม, คอลัมน์ครบไหม, ข้อมูลว่างไหม, SYNC_STATUS, Cache, ฯลฯ
 * เรียกจากเมนู: 🔧 ระบบ > 🔍 วินิจฉัย Pipeline (Diagnostic)
 */
function diagnoseSystemState() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const lines = [];
    const fixes = [];

    lines.push('=== 🔍 LMDS Pipeline Diagnostic ===');
    lines.push(`Version: ${APP_VERSION} | Schema: v${SCHEMA_VERSION}`);

    diagnoseRequiredSheets_(ss, lines, fixes);
    diagnoseColumnMismatch_(ss, lines, fixes);
    diagnoseSourceData_(ss, lines, fixes);
    diagnoseRecentErrors_(ss, lines, fixes);

    if (fixes.length > 0) {
      lines.push('');
      lines.push('🔧 วิธีแก้ปัญหา:');
      fixes.forEach((f, i) => {
        lines.push(`  ${i + 1}. ${f}`);
      });
    } else {
      lines.push('');
      lines.push('✅ ไม่พบปัญหาที่ชัดเจน — ระบบน่าจะทำงานปกติ');
    }
    safeUiAlert_(lines.join('\n'));
  } catch (err) {
    logError('App', 'diagnoseSystemState: ' + err.message, err);
    safeUiAlert_('❌ Diagnostic ล้มเหลว: ' + err.message);
  }
}

/**
 * diagnoseRequiredSheets_ — [REFACTOR v5.5.001] ตรวจชีตที่จำเป็น
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string[]} lines - output lines array
 * @param {string[]} fixes - output fixes array
 */
function diagnoseRequiredSheets_(ss, lines, fixes) {
  lines.push('');
  lines.push('📋 ชีตที่จำเป็น:');
  const requiredSheets = [
    SHEET.SOURCE,
    SHEET.M_PERSON,
    SHEET.M_PERSON_ALIAS,
    SHEET.M_PLACE,
    SHEET.M_PLACE_ALIAS,
    SHEET.M_ALIAS,
    SHEET.M_GEO_POINT,
    SHEET.M_DESTINATION,
    SHEET.FACT_DELIVERY,
    SHEET.Q_REVIEW,
    SHEET.SYS_LOG,
    SHEET.SYS_TH_GEO
  ];
  requiredSheets.forEach((name) => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      lines.push(`  ❌ ${name}: ไม่พบชีต`);
      fixes.push(`สร้างชีต ${name} — รัน "สร้างชีตทั้งหมด"`);
    } else {
      lines.push(`  ✅ ${name}: ${Math.max(0, sheet.getLastRow() - 1)} แถวข้อมูล`);
    }
  });
}

/**
 * diagnoseColumnMismatch_ — [REFACTOR v5.5.001] ตรวจ Column Mismatch
 */
function diagnoseColumnMismatch_(ss, lines, fixes) {
  lines.push('');
  lines.push('📐 ตรวจสอบคอลัมน์ (SCHEMA vs ชีตจริง):');
  const schemaChecks = [
    { name: SHEET.M_PERSON, label: 'M_PERSON' },
    { name: SHEET.M_PLACE, label: 'M_PLACE' },
    { name: SHEET.M_GEO_POINT, label: 'M_GEO_POINT' },
    { name: SHEET.M_ALIAS, label: 'M_ALIAS' },
    { name: SHEET.FACT_DELIVERY, label: 'FACT_DELIVERY' }
  ];
  schemaChecks.forEach((c) => {
    const sheet = ss.getSheetByName(c.name);
    const schema = SCHEMA[c.name];
    if (!sheet || !schema) return;
    const actualCols = sheet.getLastColumn();
    const schemaCols = schema.length;
    if (actualCols < schemaCols) {
      lines.push(`  ❌ ${c.label}: ชีตมี ${actualCols} คอลัมน์ แต่ SCHEMA ต้องการ ${schemaCols}`);
      fixes.push(`เพิ่มคอลัมน์ใน ${c.label} — รัน "สร้างชีตทั้งหมด" (Auto-Repair)`);
    } else {
      lines.push(`  ✅ ${c.label}: ${actualCols}/${schemaCols} คอลัมน์`);
    }
  });
}

/**
 * diagnoseSourceData_ — [REFACTOR v5.5.001] ตรวจข้อมูลต้นทาง (Source)
 */
function diagnoseSourceData_(ss, lines, fixes) {
  lines.push('');
  lines.push('📊 ข้อมูลต้นทาง (Source):');
  const srcSheet = ss.getSheetByName(SHEET.SOURCE);
  if (!srcSheet || srcSheet.getLastRow() <= 1) {
    lines.push(`  ❌ ไม่พบข้อมูลในชีต: ${SHEET.SOURCE}`);
    fixes.push(`ตรวจสอบชื่อชีต Source: "${SHEET.SOURCE}"`);
    return;
  }
  const srcTotal = srcSheet.getLastRow() - 1;
  const srcCols = srcSheet.getLastColumn();
  lines.push(`  แถวทั้งหมด: ${srcTotal} | คอลัมน์: ${srcCols}`);

  const sampleMax = Math.min(srcTotal, 500);

  // ตรวจ SYNC_STATUS
  const syncCol = SRC_IDX.SYNC_STATUS + 1;
  if (srcCols >= syncCol) {
    const syncData = srcSheet.getRange(2, syncCol, sampleMax, 1).getValues();
    const doneCount = syncData.filter((r) => String(r[0]).trim() === SCG_CONFIG.SYNC_DONE_VALUE).length;
    const pendingCount = srcTotal - doneCount;
    lines.push(`  SYNC_STATUS: ประมวลผลแล้ว=${doneCount} ค้างอยู่=${pendingCount}`);
    if (pendingCount === 0) {
      lines.push('  ⚠️ ทุกแถวถูกประมวลผลแล้ว — Pipeline จะไม่สร้างข้อมูลใหม่');
      fixes.push('รีเซ็ต SYNC_STATUS — รัน "รีเซ็ตสถานะ SYNC (เพื่อรันใหม่)"');
    }
  } else {
    lines.push(`  ⚠️ ชีต Source ไม่มีคอลัมน์ SYNC_STATUS (col ${syncCol}) แต่มีแค่ ${srcCols} คอลัมน์`);
  }

  // ตรวจ INVOICE_NO
  const invCol = SRC_IDX.INVOICE_NO + 1;
  if (srcCols >= invCol) {
    const invData = srcSheet.getRange(2, invCol, sampleMax, 1).getValues();
    const hasInvCount = invData.filter((r) => String(r[0]).trim()).length;
    lines.push(`  INVOICE_NO: ${hasInvCount}/${sampleMax} แถวมีค่า`);
    if (hasInvCount === 0) fixes.push('ชีต Source ไม่มี Invoice No — ตรวจสอบโครงสร้างชีต');
  }

  // ตรวจ LAT/LNG
  const latCol = SRC_IDX.LAT + 1;
  const lngCol = SRC_IDX.LNG + 1;
  if (srcCols >= lngCol) {
    const latLngData = srcSheet.getRange(2, latCol, sampleMax, 2).getValues();
    const hasGeoCount = latLngData.filter(
      (r) => Number(r[0]) !== 0 && Number(r[1]) !== 0 && !isNaN(Number(r[0])) && !isNaN(Number(r[1]))
    ).length;
    lines.push(`  LAT/LNG: ${hasGeoCount}/${sampleMax} แถวมีพิกัด`);
    if (hasGeoCount === 0) {
      lines.push('  ⚠️ ไม่มีพิกัดเลย — ทุกแถวจะเข้า REVIEW (INVALID_LATLNG)');
      fixes.push('ข้อมูล Source ไม่มีพิกัด — ตรวจสอบคอลัมน์ LAT/LNG');
    }
  }
}

/**
 * diagnoseRecentErrors_ — [REFACTOR v5.5.001] ตรวจ Error ล่าสุดใน SYS_LOG
 */
function diagnoseRecentErrors_(ss, lines, fixes) {
  lines.push('');
  lines.push('⚠️ Error ล่าสุดใน SYS_LOG:');
  const logSheet = ss.getSheetByName(SHEET.SYS_LOG);
  if (!logSheet || logSheet.getLastRow() <= 1) return;

  const logRows = Math.min(20, logSheet.getLastRow() - 1);
  const logData = logSheet.getRange(logSheet.getLastRow() - logRows + 1, 1, logRows, 6).getValues();
  const errors = logData.filter((r) => String(r[SYS_LOG_IDX.LEVEL]).trim() === 'ERROR').slice(-5);
  if (errors.length === 0) {
    lines.push('  ✅ ไม่มี Error ใน 20 แถวล่าสุด');
  } else {
    errors.forEach((e) => {
      const mod = String(e[SYS_LOG_IDX.MODULE] || '').substring(0, 20);
      const msg = String(e[SYS_LOG_IDX.MESSAGE] || '').substring(0, 80);
      lines.push(`  ❌ [${mod}] ${msg}`);
    });
    fixes.push('ตรวจสอบ Error ใน SYS_LOG — อาจเป็นสาเหตุที่ชีตว่าง');
  }
}

// ============================================================
// SECTION 5: [V6.0.006] Trigger Cleanup
// ============================================================

/**
 * cleanupStaleTriggers_UI — [V6.0.006] ลบ trigger ที่ค้างอยู่ (handler function ไม่มีแล้ว)
 *   ใช้หลังจากลบ Smart Navigation — trigger เก่าที่เรียก handleSelectionChange_
 *   ยังค้างอยู่ทำให้เกิด error "Script function not found"
 */
function cleanupStaleTriggers_UI() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const staleHandlers = [
      'handleSelectionChange_',
      'onSelectionChange',
      'installSmartNavTrigger',
      'autoInstallSmartNav_'
    ];
    let deleted = 0;
    const details = [];

    for (let i = 0; i < triggers.length; i++) {
      const handler = triggers[i].getHandlerFunction();
      if (staleHandlers.indexOf(handler) !== -1) {
        details.push('  • ' + handler + ' (ID: ' + triggers[i].getUniqueId() + ')');
        ScriptApp.deleteTrigger(triggers[i]);
        deleted++;
      }
    }

    if (deleted === 0) {
      safeUiAlert_('✅ ไม่พบ trigger ค้าง — ทุก trigger ใช้งานได้ปกติ');
    } else {
      logInfo('App', 'cleanupStaleTriggers_UI: ลบ trigger ค้าง ' + deleted + ' ตัว:\n' + details.join('\n'));
      safeUiAlert_('✅ ลบ trigger ค้าง ' + deleted + ' ตัว:\n\n' + details.join('\n'));
    }
  } catch (e) {
    logError('App', 'cleanupStaleTriggers_UI failed: ' + e.message, e);
    safeUiAlert_('❌ ล้มเหลว: ' + e.message);
  }
}

/**
 * cleanupAutoResumeTriggers_UI — [V6.0.007] Menu wrapper to cleanup orphan
 *   time-based triggers that call runMatchEngine. These orphans accumulate
 *   when installAutoResume_ fails mid-way (e.g., trigger created but property
 *   not set, or property cleared but trigger not deleted).
 *
 *   Workflow:
 *     1. Scan all project triggers
 *     2. Filter to those with handler='runMatchEngine'
 *     3. Read AUTO_RESUME_TRIGGER_ID property — that's the "current" one (keep)
 *     4. Everything else is an orphan (delete candidate)
 *     5. Show detailed report (current vs orphans) + ask for confirmation
 *     6. On YES → delete orphans + clear stale property if no current trigger remains
 *     7. On NO → exit without changes
 *
 *   Safety:
 *     - Only deletes time-based triggers with handler='runMatchEngine'
 *     - Preserves any user-created triggers for other functions
 *     - Confirmation dialog before any deletion
 *     - Wrapped in try/catch — non-fatal on any error
 */
function cleanupAutoResumeTriggers_UI() {
  try {
    const ui = SpreadsheetApp.getUi();
    const triggers = ScriptApp.getProjectTriggers();
    const props = PropertiesService.getScriptProperties();
    const knownTriggerId = props.getProperty('AUTO_RESUME_TRIGGER_ID');

    // Filter to runMatchEngine triggers only
    const runMatchEngineTriggers = [];
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'runMatchEngine') {
        runMatchEngineTriggers.push(triggers[i]);
      }
    }

    if (runMatchEngineTriggers.length === 0) {
      safeUiAlert_(
        '✅ ไม่พบ runMatchEngine triggers',
        'ไม่มี time-based trigger ใดที่เรียก runMatchEngine\n' + 'ระบบสะอาด — ไม่จำเป็นต้อง cleanup'
      );
      return;
    }

    // Classify each as "current" (matches known ID) or "orphan"
    const current = [];
    const orphans = [];
    runMatchEngineTriggers.forEach(function (t) {
      const tid = t.getUniqueId();
      const info = {
        id: tid,
        type: t.getEventType(),
        handler: t.getHandlerFunction(),
        createdAt: t.getTriggerSourceId() || 'n/a'
      };
      if (knownTriggerId && tid === knownTriggerId) {
        current.push(info);
      } else {
        orphans.push(info);
      }
    });

    // Build report
    const lines = [];
    lines.push('📊 Auto-Resume Trigger Report\n');
    lines.push('รวม runMatchEngine triggers: ' + runMatchEngineTriggers.length + ' ตัว');
    lines.push('  • Current (active): ' + current.length);
    lines.push('  • Orphan (stale): ' + orphans.length + '\n');

    if (current.length > 0) {
      lines.push('─── ✅ Current (จะ KEPT) ───');
      current.forEach(function (c) {
        lines.push('• ID: ' + c.id);
      });
    }

    if (orphans.length > 0) {
      lines.push('\n─── ❌ Orphan (จะ DELETED) ───');
      orphans.forEach(function (o) {
        lines.push('• ID: ' + o.id);
      });
    }

    if (orphans.length === 0) {
      safeUiAlert_(
        '✅ ไม่มี orphan triggers',
        lines.join('\n') + '\n\nทุก trigger เป็น current — ไม่จำเป็นต้อง cleanup'
      );
      return;
    }

    // Ask for confirmation
    const confirm = ui.alert(
      '🧹 Cleanup Auto-Resume Triggers',
      lines.join('\n') + '\n\nยืนยันการลบ ' + orphans.length + ' orphan trigger(s)?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) {
      safeUiAlert_('ℹ️ ยกเลิก — ไม่มีการลบ trigger');
      return;
    }

    // Delete orphans
    let deletedCount = 0;
    const deletedIds = [];
    orphans.forEach(function (o) {
      // Find the original trigger object by ID (need to re-fetch because we
      // can't store the trigger object across the forEach above reliably)
      for (let i = 0; i < triggers.length; i++) {
        if (triggers[i].getUniqueId() === o.id) {
          ScriptApp.deleteTrigger(triggers[i]);
          deletedCount++;
          deletedIds.push(o.id);
          break;
        }
      }
    });

    // If no current trigger remains, clear the stale property
    if (current.length === 0 && deletedCount === runMatchEngineTriggers.length) {
      props.deleteProperty('AUTO_RESUME_TRIGGER_ID');
      logInfo(
        'App',
        'cleanupAutoResumeTriggers_UI: cleared stale AUTO_RESUME_TRIGGER_ID property (no current trigger remains)'
      );
    }

    logInfo('App', 'cleanupAutoResumeTriggers_UI: deleted ' + deletedCount + ' orphan runMatchEngine triggers');

    safeUiAlert_(
      '✅ ลบ orphan triggers เรียบร้อย',
      'ลบทั้งหมด ' +
        deletedCount +
        ' ตัว:\n\n' +
        deletedIds
          .map(function (id) {
            return '• ' + id;
          })
          .join('\n') +
        '\n\nCurrent triggers ที่เหลือ: ' +
        current.length +
        ' ตัว'
    );
  } catch (e) {
    logError('App', 'cleanupAutoResumeTriggers_UI failed: ' + e.message, e);
    safeUiAlert_('❌ ล้มเหลว: ' + e.message);
  }
}

// ============================================================
// SECTION 6: [V6.0.007] Pipeline Preflight (Strict Mode UI)
// ============================================================

/**
 * runPipelinePreflightStrict_UI — [V6.0.007] Menu wrapper to run pipeline preflight
 *   in non-strict mode (display result) + offer strict-mode option (throw on issue).
 *   Calls runPipelinePreflight() from 24_PipelineManager.gs which now supports:
 *     - 6 dependency-aware checks (was 3)
 *     - Structured report: { ready, issues, warnings, checks }
 *     - Optional strict mode (throw on any issue)
 *
 *   This UI wrapper:
 *     1. Runs preflight (non-strict) to display the report
 *     2. Shows pass/fail/warn counts in alert
 *     3. If issues exist, asks user if they want to abort (don't run pipeline)
 */
function runPipelinePreflightStrict_UI() {
  try {
    if (typeof runPipelinePreflight !== 'function') {
      safeUiAlert_('❌ ไม่พบฟังก์ชัน runPipelinePreflight — ตรวจสอบว่า 24_PipelineManager.gs โหลดแล้ว');
      return;
    }

    const result = runPipelinePreflight({ strict: false });

    // Build report text
    const lines = [];
    lines.push('📊 Pipeline Preflight Report (V6.0.007)\n');
    lines.push('Overall: ' + (result.ready ? '✅ READY' : '❌ NOT READY') + '\n');
    lines.push(
      'Checks: ' +
        result.checks.length +
        ' total | ' +
        result.issues.length +
        ' fail | ' +
        result.warnings.length +
        ' warn\n'
    );

    // Detail per check
    lines.push('─── Detail ───');
    result.checks.forEach(function (c) {
      let icon = '⏭️'; // SKIP default
      if (c.status === 'PASS') icon = '✅';
      else if (c.status === 'FAIL') icon = '❌';
      else if (c.status === 'WARN') icon = '⚠️';
      lines.push(icon + ' ' + c.name + ': ' + c.detail);
    });

    // Issues (blocking)
    if (result.issues.length > 0) {
      lines.push('\n─── ❌ Blocking Issues (' + result.issues.length + ') ───');
      result.issues.forEach(function (i) {
        lines.push('• ' + i);
      });
    }

    // Warnings (advisory)
    if (result.warnings.length > 0) {
      lines.push('\n─── ⚠️ Warnings (' + result.warnings.length + ') ───');
      result.warnings.forEach(function (w) {
        lines.push('• ' + w);
      });
    }

    safeUiAlert_(lines.join('\n'));

    // If not ready, log a warning (don't auto-abort — user may want to investigate)
    if (!result.ready) {
      logWarn(
        'App',
        'runPipelinePreflightStrict_UI: pipeline NOT READY — ' + result.issues.length + ' blocking issues'
      );
    }
  } catch (e) {
    logError('App', 'runPipelinePreflightStrict_UI failed: ' + e.message, e);
    safeUiAlert_('❌ ล้มเหลว: ' + e.message);
  }
}
