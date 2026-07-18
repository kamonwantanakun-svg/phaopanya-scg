/**
 * VERSION: 6.0.069
 * FILE: 28_WebAppActions.gs
 * LMDS V6.0 — Web App Actions Server (Mobile Menu)
 * ===================================================
 * PURPOSE:
 *   ให้บริการ action dispatcher สำหรับ WebApp mobile menu
 *   ทำหน้าที่เป็น bridge ระหว่าง frontend (MobileActions view) กับ backend functions
 *   Pattern: runWebAppAction(actionId, params) → registry → _Web variant (no UI alerts)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 14_Utils.gs (core)
 *     - 22_WebApp.gs            (doGet context, session)
 *     - 10d_MatchTestHarness.gs (dry run actions)
 *     - 19_Hardening.gs         (preflight action)
 *     - 12_ReviewService.gs     (review actions)
 *   CALLS: (Invokes)
 *     - runTestMatchDryRun_UI()                → 10d_MatchTestHarness.gs
 *     - runPreflightAudit()                    → 19_Hardening.gs
 *     - applyAllPendingDecisions()             → 12_ReviewService.gs / 12b_ReviewReprocessor.gs
 *     - logInfo()                              → 03_SetupSheets.gs
 *   EXPORTS TO:
 *     - 22_WebApp.gs (action dispatcher)
 *     - Frontend (MobileActions view via google.script.run)
 *   SHEETS ACCESSED:
 *     - SHEET.TEST_MATCH_RESULTS (Read — action status)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 3 — Web frontend server (dashboard, views, actions, mobile menu)
 * ===================================================
 */

// ============================================================
// SECTION 1: Action Registry — single source of truth
// ============================================================

/**
 * WEB_APP_ACTION_REGISTRY — รายการ action ทั้งหมดที่ใช้ได้จาก WebApp
 *
 * โครงสร้างแต่ละ entry:
 *   id            — unique identifier (ใช้เรียกผ่าน dispatcher)
 *   label         — ข้อความปุ่ม (emoji + ชื่อ)
 *   group         — กลุ่ม: 'group1' | 'group2' | 'system' | 'top'
 *   danger        — 'safe' | 'warning' | 'danger'
 *                   safe = อ่านอย่างเดียว, ไม่ confirm
 *                   warning = แก้ข้อมูล, confirm 2 ครั้ง
 *                   danger = ทำลายล้าง, confirm 2 ครั้ง + warning text
 *   confirmMsg    — ข้อความยืนยัน (แสดงตอนกดครั้งที่ 1)
 *   description   — คำอธิบายสั้น ๆ (แสดงใต้ปุ่ม)
 *   serverFn      — ชื่อ server function ที่จะเรียก (ต้องเป็น _Web variant)
 *   icon          — ชื่อ Lucide icon (ใช้ใน frontend)
 *
 * @type {Array<Object>}
 */
const WEB_APP_ACTION_REGISTRY = [
  // ─── TOP (เมนูหลักด้านบน) ───
  {
    id: 'runFullPipeline',
    label: '🚀 Run Full Pipeline',
    group: 'top',
    danger: 'danger',
    confirmMsg: 'จะรัน pipeline ทั้งหมด — เขียน master sheets (M_PERSON, M_PLACE, FACT_DELIVERY)',
    description: 'รัน Step 1+2+3 ต่อเนื่อง',
    serverFn: 'runFullPipeline_Web',
    icon: 'play'
  },
  {
    id: 'applyMasterCoordinatesToDailyJob',
    label: '📍 จับคู่พิกัดวันนี้',
    group: 'top',
    danger: 'warning',
    confirmMsg: 'จะอัปเดต LatLong_Actual ใน DAILY_JOB sheet',
    description: 'เอาพิกัดจาก Master ไปเติมในงานประจำวัน',
    serverFn: 'applyMasterCoordinatesToDailyJob_Web',
    icon: 'map-pin'
  },

  // ─── GROUP 1: ล้างข้อมูล & Master ───
  {
    id: 'runLoadSource',
    label: 'Step 1 — โหลดข้อมูลดิบ',
    group: 'group1',
    danger: 'warning',
    confirmMsg: 'จะโหลดข้อมูลจาก SOURCE sheet',
    description: 'โหลด + reset cache',
    serverFn: 'runLoadSource_Web',
    icon: 'download'
  },
  {
    id: 'runNormalize',
    label: 'Step 2 — Normalize ชื่อ/ที่อยู่',
    group: 'group1',
    danger: 'safe',
    confirmMsg: '',
    description: 'ทำงานใน processOneRow() อัตโนมัติ',
    serverFn: 'runNormalize_Web',
    icon: 'sparkles'
  },
  {
    id: 'runMatchEngine',
    label: 'Step 3 — Match Engine',
    group: 'group1',
    danger: 'danger',
    confirmMsg: 'จะรัน Match Engine — เขียน master sheets',
    description: 'ประมวลผล matching + create master entries',
    serverFn: 'runMatchEngine_Web',
    icon: 'git-merge'
  },
  {
    id: 'runTestMatchDryRun',
    label: '🧪 [V6] Test Match (Dry Run)',
    group: 'group1',
    danger: 'safe',
    confirmMsg: '',
    description: 'ทดสอบ 100 unprocessed rows',
    serverFn: 'runTestMatchDryRun_Web',
    icon: 'flask-conical'
  },
  {
    id: 'runTestMatchDryRunForceAll',
    label: '🧪 [V6.0.017] Dry Run — Force All Rows',
    group: 'group1',
    danger: 'safe',
    confirmMsg: 'ทดสอบทุกแถวที่มี INVOICE_NO (ข้าม SYNC_STATUS)',
    description: 'ทดสอบ algorithm ซ้ำกับข้อมูลเก่า',
    serverFn: 'runTestMatchDryRunForceAll_Web',
    icon: 'flask-conical'
  },
  {
    id: 'analyzeRule5PlaceOnlyImpact',
    label: '🔍 [V6.0.016] วิเคราะห์ Rule 5 Impact',
    group: 'group1',
    danger: 'safe',
    confirmMsg: '',
    description: 'นับแถวที่ V6.0.016 downgrade',
    serverFn: 'analyzeRule5PlaceOnlyImpact_Web',
    icon: 'search'
  },
  {
    id: 'requestPipelineStop',
    label: '🛑 [V6] Emergency Stop',
    group: 'group1',
    danger: 'danger',
    confirmMsg: 'จะสั่งหยุด pipeline ทันที (ภายใน 10 แถว)',
    description: 'หยุด pipeline กลางทาง',
    serverFn: 'requestPipelineStop_Web',
    icon: 'octagon-x'
  },
  {
    id: 'clearPipelineStopSignal',
    label: '🟢 [V6] ยกเลิก Stop Signal',
    group: 'group1',
    danger: 'safe',
    confirmMsg: '',
    description: 'เคลียร์ stop signal ที่ค้าง',
    serverFn: 'clearPipelineStopSignal_Web',
    icon: 'circle-check'
  },
  {
    id: 'backfillAliasAuditFields',
    label: '🔄 [V6] Backfill Alias Audit',
    group: 'group1',
    danger: 'warning',
    confirmMsg: 'จะอัปเดต verified_at ใน M_ALIAS',
    description: 'เติม audit fields ที่หายไป',
    serverFn: 'backfillAliasAuditFields_Web',
    icon: 'refresh-cw'
  },
  {
    id: 'safeResetTransactional',
    label: '🧹 [V6] Safe Reset (Transactional)',
    group: 'group1',
    danger: 'danger',
    confirmMsg: 'จะล้าง FACT_DELIVERY + Q_REVIEW + SYNC_STATUS — ไม่ลบ Master',
    description: 'ล้าง transactional data (เก็บ Master ไว้)',
    serverFn: 'safeResetTransactional_Web',
    icon: 'eraser'
  },
  {
    id: 'clearDoneReviews',
    label: '🧹 [V6] ล้างแถว Done/Escalated',
    group: 'group1',
    danger: 'warning',
    confirmMsg: 'จะลบ Q_REVIEW rows ที่ Done/Escalated',
    description: 'ล้างประวัติ review เก่า',
    serverFn: 'clearDoneReviews_Web',
    icon: 'trash-2'
  },
  {
    id: 'buildFullQualityReport',
    label: '📊 รายงาน Data Quality',
    group: 'group1',
    danger: 'safe',
    confirmMsg: '',
    description: 'สร้างรายงานคุณภาพข้อมูล',
    serverFn: 'buildFullQualityReport_Web',
    icon: 'bar-chart-3'
  },

  // ─── GROUP 2: งานประจำวัน SCG ───
  {
    id: 'fetchDataFromSCGJWD',
    label: '📥 ดึงข้อมูล SCG API',
    group: 'group2',
    danger: 'warning',
    confirmMsg: 'จะดึงข้อมูลจาก SCG API มาใส่ DAILY_JOB sheet',
    description: 'ดึงงานประจำวันจาก SCG',
    serverFn: 'fetchDataFromSCGJWD_Web',
    icon: 'cloud-download'
  },
  {
    id: 'clearAllSCGSheets',
    label: '🗑️ ล้างข้อมูล SCG ทั้งหมด',
    group: 'group2',
    danger: 'danger',
    confirmMsg: 'จะล้างข้อมูล SCG ทั้งหมด — ไม่สามารถย้อนกลับได้',
    description: 'ล้าง DAILY_JOB + SCG sheets',
    serverFn: 'clearAllSCGSheets_Web',
    icon: 'trash-2'
  },

  // ─── SYSTEM & SETTINGS ───
  {
    id: 'setupAllSheets',
    label: '🏗️ สร้างชีตทั้งหมด',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะสร้างชีตที่ยังไม่มี + ตรวจ schema',
    description: 'Setup sheets ครั้งแรก',
    serverFn: 'setupAllSheets_Web',
    icon: 'table'
  },
  {
    id: 'buildGeoDictionary',
    label: '🌍 อัปเดตฐานข้อมูลภูมิศาสตร์',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะ rebuild SYS_TH_GEO dictionary',
    description: 'อัปเดต Thai geo data',
    serverFn: 'buildGeoDictionary_Web',
    icon: 'globe'
  },
  {
    id: 'populateGeoMetadata',
    label: '🛠️ เติมข้อมูลภูมิศาสตร์ (16 คอลัมน์)',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะเติม geo metadata ในชีตต่าง ๆ',
    description: 'Enrich geo columns',
    serverFn: 'populateGeoMetadata_Web',
    icon: 'wrench'
  },
  {
    id: 'generatePersonAliasesFromHistory',
    label: '🔗 สร้าง Alias จากประวัติ',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะสร้าง M_ALIAS จาก FACT_DELIVERY history',
    description: 'Auto-generate aliases',
    serverFn: 'generatePersonAliasesFromHistory_Web',
    icon: 'link'
  },
  {
    id: 'assignMasterUuidIfMissing',
    label: '🔗 ตรวจสอบ Master UUID',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะตรวจ + assign Master UUID ที่หายไป',
    description: 'Fill missing UUIDs',
    serverFn: 'assignMasterUuidIfMissing_Web',
    icon: 'link'
  },
  {
    id: 'populateAliasFromSCGRawData',
    label: '📥 ดึงชื่อจาก SCG → M_ALIAS',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะ populate aliases จาก SCG raw data',
    description: 'Extract aliases from SCG',
    serverFn: 'populateAliasFromSCGRawData_Web',
    icon: 'download'
  },
  {
    id: 'runPreflightAudit',
    label: '🛡️ [PH2] Preflight Audit',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'ตรวจสอบก่อนรัน pipeline',
    serverFn: 'runPreflightAudit_Web',
    icon: 'shield-check'
  },
  {
    id: 'runPipelinePreflightStrict',
    label: '🔍 [V6] Pipeline Preflight (Strict)',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: '6 checks ก่อนรัน pipeline',
    serverFn: 'runPipelinePreflightStrict_Web',
    icon: 'search-check'
  },
  {
    id: 'detectDoubleProcessing',
    label: '🧹 [PH2] Detect Duplicates',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'ตรวจแถว duplicate',
    serverFn: 'detectDoubleProcessing_Web',
    icon: 'copy'
  },
  {
    id: 'checkSystemIntegrity',
    label: '✅ ตรวจ System Integrity',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'ตรวจความสมบูรณ์ของระบบ',
    serverFn: 'checkSystemIntegrity_Web',
    icon: 'check-circle'
  },
  {
    id: 'diagnoseSystemState',
    label: '🔍 วินิจฉัย Pipeline',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'Diagnostic report',
    serverFn: 'diagnoseSystemState_Web',
    icon: 'stethoscope'
  },
  {
    id: 'resetSourceSyncStatus',
    label: '🔄 รีเซ็ต SYNC_STATUS',
    group: 'system',
    danger: 'danger',
    confirmMsg: 'จะรีเซ็ต SYNC_STATUS ทั้งหมด — ทำให้ pipeline รันใหม่ทั้งหมด',
    description: 'Reset เพื่อรัน pipeline ใหม่',
    serverFn: 'resetSourceSyncStatus_Web',
    icon: 'rotate-ccw'
  },
  {
    id: 'invalidateAllGlobalCaches',
    label: '🧹 ล้างความจำระบบ (Clear Cache)',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'Clear 10 RAM + 13 CacheService keys',
    serverFn: 'invalidateAllGlobalCaches_Web',
    icon: 'broom'
  },
  {
    id: 'runDedupAuditPerson',
    label: '🔍 [V6] Dedup Audit (Person)',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'ตรวจ person duplicates',
    serverFn: 'runDedupAuditPerson_Web',
    icon: 'users'
  },
  {
    id: 'runDedupAuditPlace',
    label: '🔍 [V6] Dedup Audit (Place)',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'ตรวจ place duplicates',
    serverFn: 'runDedupAuditPlace_Web',
    icon: 'map'
  },
  {
    id: 'cleanupStaleTriggers',
    label: '🧹 [V6] ลบ Trigger ค้าง',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะลบ trigger ที่ stale',
    description: 'Cleanup old triggers',
    serverFn: 'cleanupStaleTriggers_Web',
    icon: 'trash-2'
  },
  {
    id: 'cleanupAutoResumeTriggers',
    label: '🧹 [V6] Cleanup Auto-Resume Triggers',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะลบ auto-resume triggers',
    description: 'Cleanup resume triggers',
    serverFn: 'cleanupAutoResumeTriggers_Web',
    icon: 'trash-2'
  },
  {
    id: 'cleanupAuditTrail',
    label: '📜 [V6] Prune Audit Trail (90 วัน)',
    group: 'system',
    danger: 'warning',
    confirmMsg: 'จะลบ audit trail เก่ากว่า 90 วัน',
    description: 'Cleanup old audit logs',
    serverFn: 'cleanupAuditTrail_Web',
    icon: 'scroll'
  },
  {
    id: 'showVersionInfo',
    label: '📖 ดู Version Info',
    group: 'system',
    danger: 'safe',
    confirmMsg: '',
    description: 'แสดง version + schema',
    serverFn: 'showVersionInfo_Web',
    icon: 'info'
  }
];

// ============================================================
// SECTION 2: Dispatcher
// ============================================================

/**
 * getWebAppActionRegistry — ส่ง registry ไปให้ frontend
 *   Frontend ใช้สำหรับ render ปุ่ม + แสดง confirm message
 *   กรองเฉพาะ actions ที่ user มี permission ใช้ได้
 * @return {Array<Object>} filtered registry
 */
function getWebAppActionRegistry() {
  try {
    // [V6.0.021] กรองตาม permission — admin เห็นทั้งหมด, user ทั่วไปเห็นเฉพาะ safe
    const isAdmin =
      typeof isCurrentUserAdmin_ === 'function'
        ? isCurrentUserAdmin_()
        : typeof isAuthorizedUser_ === 'function' && isAuthorizedUser_();
    if (isAdmin) {
      return WEB_APP_ACTION_REGISTRY;
    }
    // Non-admin: เฉพาะ safe actions
    return WEB_APP_ACTION_REGISTRY.filter(function (a) {
      return a.danger === 'safe';
    });
  } catch (e) {
    logError('WebAppActions', 'getWebAppActionRegistry ล้มเหลว: ' + e.message, e);
    return [];
  }
}

/**
 * runWebAppAction — Dispatcher หลัก
 *   Frontend เรียกผ่าน google.script.run ด้วย actionId + params
 *   Dispatcher ค้น registry → เรียก _Web variant → return JSON result
 *
 * @param {string} actionId — id จาก registry (e.g., 'runFullPipeline')
 * @param {Object} [params] — optional parameters (e.g., { maxRows: 100 } for Dry Run)
 * @return {{ ok: boolean, actionId: string, result: any, message: string, elapsedMs: number }}
 */
function runWebAppAction(actionId, params) {
  const startTime = new Date();
  params = params || {};

  try {
    // 1. ค้น registry
    const action = WEB_APP_ACTION_REGISTRY.find(function (a) {
      return a.id === actionId;
    });

    if (!action) {
      return {
        ok: false,
        actionId: actionId,
        result: null,
        message: 'ไม่พบ action "' + actionId + '" ใน registry',
        elapsedMs: 0
      };
    }

    // 2. Permission check
    //   safe = ทุกคนใช้ได้, warning/danger = admin เท่านั้น
    if (action.danger !== 'safe') {
      const isAdmin =
        typeof isCurrentUserAdmin_ === 'function'
          ? isCurrentUserAdmin_()
          : typeof isAuthorizedUser_ === 'function' && isAuthorizedUser_();
      if (!isAdmin) {
        return {
          ok: false,
          actionId: actionId,
          result: null,
          message: 'ไม่มีสิทธิ์ — action นี้ต้องการ admin',
          elapsedMs: 0
        };
      }
    }

    // 3. เรียก server function
    const fn = globalThis[action.serverFn];
    if (typeof fn !== 'function') {
      return {
        ok: false,
        actionId: actionId,
        result: null,
        message: 'Server function "' + action.serverFn + '" ไม่พร้อม — ตรวจโหลด 28_WebAppActions.gs',
        elapsedMs: 0
      };
    }

    logInfo('WebAppActions', '▶️ ' + actionId + ' (danger=' + action.danger + ')');

    const result = fn(params);

    const elapsedMs = new Date() - startTime;
    logInfo('WebAppActions', '✅ ' + actionId + ' สำเร็จ (' + elapsedMs + 'ms)');

    return {
      ok: true,
      actionId: actionId,
      result: result,
      message: result && result.message ? result.message : 'สำเร็จ',
      elapsedMs: elapsedMs
    };
  } catch (e) {
    const elapsedMs = new Date() - startTime;
    logError('WebAppActions', 'runWebAppAction(' + actionId + ') ล้มเหลว: ' + e.message, e);
    return {
      ok: false,
      actionId: actionId,
      result: null,
      message: e.message,
      elapsedMs: elapsedMs
    };
  }
}

// ============================================================
// SECTION 3: _Web Variants — one per action
//   แต่ละฟังก์ชัน:
//     - skip SpreadsheetApp.getUi() confirmation (client ทำเอง)
//     - call underlying function
//     - return { ok, message, ... } JSON
// ============================================================

// ─── TOP ───

function runFullPipeline_Web(params) {
  if (typeof runFullPipeline !== 'function') {
    return { ok: false, message: 'runFullPipeline ไม่พร้อม' };
  }
  runFullPipeline();
  return { ok: true, message: 'Full Pipeline เสร็จสิ้น — ตรวจ SYS_LOG สำหรับรายละเอียด' };
}

function applyMasterCoordinatesToDailyJob_Web(params) {
  if (typeof applyMasterCoordinatesToDailyJob !== 'function') {
    return { ok: false, message: 'applyMasterCoordinatesToDailyJob ไม่พร้อม' };
  }
  applyMasterCoordinatesToDailyJob();
  return { ok: true, message: 'จับคู่พิกัดเสร็จ — ตรวจ DAILY_JOB sheet' };
}

// ─── GROUP 1 ───

function runLoadSource_Web(params) {
  if (typeof runLoadSource !== 'function') {
    return { ok: false, message: 'runLoadSource ไม่พร้อม' };
  }
  runLoadSource();
  return { ok: true, message: 'Step 1 โหลดข้อมูลเสร็จ' };
}

function runNormalize_Web(params) {
  return {
    ok: true,
    message: 'Normalize ทำงานใน processOneRow() อัตโนมัติ — ไม่ต้องรันแยก'
  };
}

function runMatchEngine_Web(params) {
  if (typeof runMatchEngine !== 'function') {
    return { ok: false, message: 'runMatchEngine ไม่พร้อม' };
  }
  runMatchEngine();
  return { ok: true, message: 'Match Engine เสร็จ — ตรวจ FACT_DELIVERY + Q_REVIEW' };
}

function runTestMatchDryRun_Web(params) {
  if (typeof runTestMatchDryRun_ !== 'function') {
    return { ok: false, message: 'runTestMatchDryRun_ ไม่พร้อม' };
  }
  const summary = runTestMatchDryRun_(100);
  return {
    ok: true,
    message: 'Dry Run เสร็จ — tested=' + summary.tested + ' match_rate=' + summary.matchRate + '%',
    summary: summary
  };
}

function runTestMatchDryRunForceAll_Web(params) {
  if (typeof runTestMatchDryRun_ !== 'function') {
    return { ok: false, message: 'runTestMatchDryRun_ ไม่พร้อม' };
  }
  const maxRows = (params && params.maxRows) || 100;
  const summary = runTestMatchDryRun_(maxRows, true);
  return {
    ok: true,
    message: 'Force All Dry Run เสร็จ — tested=' + summary.tested + ' match_rate=' + summary.matchRate + '%',
    summary: summary
  };
}

function analyzeRule5PlaceOnlyImpact_Web(params) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.TEST_MATCH_RESULTS);
    if (!sheet || sheet.getLastRow() < 2) {
      return {
        ok: true,
        message: 'ไม่มีข้อมูลใน TEST_MATCH_RESULTS — รัน Dry Run ก่อน',
        v6015PlaceOnly: 0,
        v6016PlaceOnlyReview: 0
      };
    }
    const lastRow = sheet.getLastRow();
    const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    let v6015PlaceOnly = 0;
    let v6016PlaceOnlyReview = 0;
    let v6015GeoPersonAnchor = 0;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const action = String(row[4] || '').trim();
      const reason = String(row[5] || '').trim();
      const evidence = String(row[7] || '').trim();
      if (action === 'AUTO_MATCH' && reason === 'GEO_ANCHOR' && evidence.indexOf('place|geo') === 0) {
        v6015PlaceOnly++;
      }
      if (action === 'AUTO_MATCH' && reason === 'GEO_ANCHOR' && evidence.indexOf('name|geo') === 0) {
        v6015GeoPersonAnchor++;
      }
      if (action === 'REVIEW' && reason === 'GEO_ANCHOR_PLACE_ONLY_NO_NAME') {
        v6016PlaceOnlyReview++;
      }
    }
    return {
      ok: true,
      message: 'วิเคราะห์เสร็จ — อ่าน ' + data.length + ' แถว',
      totalRows: data.length,
      v6015PlaceOnly: v6015PlaceOnly,
      v6015GeoPersonAnchor: v6015GeoPersonAnchor,
      v6016PlaceOnlyReview: v6016PlaceOnlyReview
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function requestPipelineStop_Web(params) {
  if (typeof requestPipelineStop_UI !== 'function') {
    // Fallback: set property directly
    try {
      PropertiesService.getScriptProperties().setProperty('PIPELINE_STOP_REQUESTED', 'true');
      return { ok: true, message: 'Stop signal ถูกตั้ง — pipeline จะหยุดภายใน 10 แถว' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  // _UI version uses getUi() — can't call from WebApp. Set property directly.
  try {
    PropertiesService.getScriptProperties().setProperty('PIPELINE_STOP_REQUESTED', 'true');
    return { ok: true, message: 'Stop signal ถูกตั้ง — pipeline จะหยุดภายใน 10 แถว' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function clearPipelineStopSignal_Web(params) {
  if (typeof clearPipelineStopSignal_ === 'function') {
    clearPipelineStopSignal_();
  } else {
    try {
      PropertiesService.getScriptProperties().deleteProperty('PIPELINE_STOP_REQUESTED');
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  return { ok: true, message: 'Stop signal ถูกเคลียร์แล้ว' };
}

function backfillAliasAuditFields_Web(params) {
  if (typeof backfillAliasAuditFields_UI !== 'function') {
    return { ok: false, message: 'backfillAliasAuditFields_UI ไม่พร้อม' };
  }
  // Call underlying function directly (skip _UI wrapper that uses getUi)
  try {
    const result = backfillAliasAuditFields();
    return {
      ok: true,
      message: 'Backfill เสร็จ — ' + (result && result.backfilled ? result.backfilled : '?') + ' rows',
      result: result
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function safeResetTransactional_Web(params) {
  if (typeof safeResetTransactional_UI !== 'function') {
    return { ok: false, message: 'safeResetTransactional_UI ไม่พร้อม' };
  }
  safeResetTransactional_UI();
  return { ok: true, message: 'Safe Reset เสร็จ — transactional data ถูกล้าง, Master ยังอยู่' };
}

function clearDoneReviews_Web(params) {
  if (typeof clearDoneReviews_UI !== 'function') {
    return { ok: false, message: 'clearDoneReviews_UI ไม่พร้อม' };
  }
  clearDoneReviews_UI();
  return { ok: true, message: 'ล้าง Done/Escalated rows เสร็จ' };
}

function buildFullQualityReport_Web(params) {
  if (typeof buildFullQualityReport !== 'function') {
    return { ok: false, message: 'buildFullQualityReport ไม่พร้อม' };
  }
  buildFullQualityReport();
  return { ok: true, message: 'Quality Report สร้างเสร็จ — ตรวจ SYS_LOG' };
}

// ─── GROUP 2 ───

function fetchDataFromSCGJWD_Web(params) {
  if (typeof fetchDataFromSCGJWD !== 'function') {
    return { ok: false, message: 'fetchDataFromSCGJWD ไม่พร้อม' };
  }
  fetchDataFromSCGJWD();
  return { ok: true, message: 'ดึงข้อมูล SCG เสร็จ — ตรวจ DAILY_JOB sheet' };
}

function clearAllSCGSheets_Web(params) {
  if (typeof clearAllSCGSheets_UI !== 'function') {
    return { ok: false, message: 'clearAllSCGSheets_UI ไม่พร้อม' };
  }
  clearAllSCGSheets_UI();
  return { ok: true, message: 'ล้างข้อมูล SCG เสร็จ' };
}

// ─── SYSTEM ───

function setupAllSheets_Web(params) {
  if (typeof setupAllSheets !== 'function') {
    return { ok: false, message: 'setupAllSheets ไม่พร้อม' };
  }
  setupAllSheets();
  return { ok: true, message: 'สร้างชีตเสร็จ — ตรวจ sheets ทั้งหมด' };
}

function buildGeoDictionary_Web(params) {
  if (typeof buildGeoDictionary !== 'function') {
    return { ok: false, message: 'buildGeoDictionary ไม่พร้อม' };
  }
  buildGeoDictionary();
  return { ok: true, message: 'Geo Dictionary อัปเดตเสร็จ' };
}

function populateGeoMetadata_Web(params) {
  if (typeof populateGeoMetadata !== 'function') {
    return { ok: false, message: 'populateGeoMetadata ไม่พร้อม' };
  }
  populateGeoMetadata();
  return { ok: true, message: 'Geo metadata เติมเสร็จ' };
}

function generatePersonAliasesFromHistory_Web(params) {
  if (typeof generatePersonAliasesFromHistory !== 'function') {
    return { ok: false, message: 'generatePersonAliasesFromHistory ไม่พร้อม' };
  }
  generatePersonAliasesFromHistory();
  return { ok: true, message: 'สร้าง aliases จาก history เสร็จ' };
}

function assignMasterUuidIfMissing_Web(params) {
  if (typeof assignMasterUuidIfMissing !== 'function') {
    return { ok: false, message: 'assignMasterUuidIfMissing ไม่พร้อม' };
  }
  assignMasterUuidIfMissing();
  return { ok: true, message: 'ตรวจ + assign UUID เสร็จ' };
}

function populateAliasFromSCGRawData_Web(params) {
  if (typeof populateAliasFromSCGRawData !== 'function') {
    return { ok: false, message: 'populateAliasFromSCGRawData ไม่พร้อม' };
  }
  populateAliasFromSCGRawData();
  return { ok: true, message: 'Populate aliases จาก SCG เสร็จ' };
}

function runPreflightAudit_Web(params) {
  if (typeof runPreflightAudit !== 'function') {
    return { ok: false, message: 'runPreflightAudit ไม่พร้อม' };
  }
  // [V6.0.040] CodeQL #55: function may not return a value (uses getUi().alert)
  //   Store result defensively — if undefined, still return ok=true with message
  let result = null;
  try {
    result = runPreflightAudit();
  } catch (e) {
    return { ok: false, message: 'Preflight audit ล้มเหลว: ' + e.message };
  }
  return { ok: true, message: 'Preflight audit เสร็จ — ตรวจ SYS_LOG สำหรับรายละเอียด', result: result };
}

function runPipelinePreflightStrict_Web(params) {
  if (typeof runPipelinePreflightStrict_UI !== 'function') {
    return { ok: false, message: 'runPipelinePreflightStrict_UI ไม่พร้อม' };
  }
  // Call underlying function (skip _UI wrapper)
  try {
    const result = runPipelinePreflight({ strict: true });
    return {
      ok: result.ready,
      message: result.ready ? 'Preflight ผ่าน — pipeline พร้อมรัน' : 'Preflight ไม่ผ่าน — แก้ issues ก่อน',
      result: result
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function detectDoubleProcessing_Web(params) {
  if (typeof detectDoubleProcessing !== 'function') {
    return { ok: false, message: 'detectDoubleProcessing ไม่พร้อม' };
  }
  // [V6.0.040] CodeQL #53: function may not return a value
  let result = null;
  try {
    result = detectDoubleProcessing();
  } catch (e) {
    return { ok: false, message: 'Detect duplicates ล้มเหลว: ' + e.message };
  }
  return { ok: true, message: 'Detect duplicates เสร็จ — ตรวจ SYS_LOG', result: result };
}

function checkSystemIntegrity_Web(params) {
  if (typeof checkSystemIntegrity !== 'function') {
    return { ok: false, message: 'checkSystemIntegrity ไม่พร้อม' };
  }
  // [V6.0.040] CodeQL #54: function may not return a value
  let result = null;
  try {
    result = checkSystemIntegrity();
  } catch (e) {
    return { ok: false, message: 'System integrity check ล้มเหลว: ' + e.message };
  }
  return { ok: true, message: 'System integrity check เสร็จ — ตรวจ SYS_LOG', result: result };
}

function diagnoseSystemState_Web(params) {
  if (typeof diagnoseSystemState !== 'function') {
    return { ok: false, message: 'diagnoseSystemState ไม่พร้อม' };
  }
  // [V6.0.040] CodeQL #55: function may not return a value
  let result = null;
  try {
    result = diagnoseSystemState();
  } catch (e) {
    return { ok: false, message: 'Diagnostic ล้มเหลว: ' + e.message };
  }
  return { ok: true, message: 'Diagnostic เสร็จ — ตรวจ SYS_LOG', result: result };
}

function resetSourceSyncStatus_Web(params) {
  if (typeof resetSourceSyncStatus !== 'function') {
    return { ok: false, message: 'resetSourceSyncStatus ไม่พร้อม' };
  }
  resetSourceSyncStatus();
  return { ok: true, message: 'รีเซ็ต SYNC_STATUS เสร็จ — pipeline จะรันใหม่ทั้งหมด' };
}

function invalidateAllGlobalCaches_Web(params) {
  if (typeof invalidateAllGlobalCaches !== 'function') {
    return { ok: false, message: 'invalidateAllGlobalCaches ไม่พร้อม' };
  }
  invalidateAllGlobalCaches();
  return { ok: true, message: 'ล้าง cache เสร็จ — 10 RAM + 13 CacheService keys' };
}

function runDedupAuditPerson_Web(params) {
  if (typeof runDedupAuditPerson_UI !== 'function') {
    return { ok: false, message: 'runDedupAuditPerson_UI ไม่พร้อม' };
  }
  runDedupAuditPerson_UI();
  return { ok: true, message: 'Person dedup audit เสร็จ — ตรวจ SYS_LOG' };
}

function runDedupAuditPlace_Web(params) {
  if (typeof runDedupAuditPlace_UI !== 'function') {
    return { ok: false, message: 'runDedupAuditPlace_UI ไม่พร้อม' };
  }
  runDedupAuditPlace_UI();
  return { ok: true, message: 'Place dedup audit เสร็จ — ตรวจ SYS_LOG' };
}

function cleanupStaleTriggers_Web(params) {
  if (typeof cleanupStaleTriggers_UI !== 'function') {
    return { ok: false, message: 'cleanupStaleTriggers_UI ไม่พร้อม' };
  }
  cleanupStaleTriggers_UI();
  return { ok: true, message: 'ลบ stale triggers เสร็จ' };
}

function cleanupAutoResumeTriggers_Web(params) {
  if (typeof cleanupAutoResumeTriggers_UI !== 'function') {
    return { ok: false, message: 'cleanupAutoResumeTriggers_UI ไม่พร้อม' };
  }
  cleanupAutoResumeTriggers_UI();
  return { ok: true, message: 'ลบ auto-resume triggers เสร็จ' };
}

function cleanupAuditTrail_Web(params) {
  if (typeof cleanupAuditTrail_UI !== 'function') {
    return { ok: false, message: 'cleanupAuditTrail_UI ไม่พร้อม' };
  }
  cleanupAuditTrail_UI();
  return { ok: true, message: 'Prune audit trail เสร็จ — ลบเก่ากว่า 90 วัน' };
}

function showVersionInfo_Web(params) {
  return {
    ok: true,
    message: 'Version info',
    version: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appName: APP_NAME
  };
}
