/**
 * VERSION: 6.0.006
 * FILE: 22_WebApp.gs
 * LMDS V5.5 — Web App Server (Dashboard)
 * ===================================================
 * PURPOSE:
 *   ให้บริการ Web App สำหรับดูข้อมูล LMDS แบบ real-time
 *   ใช้ HtmlService + google.script.run pattern
 *   เป็นจุดเชื่อมระหว่าง Frontend (HTML/JS) กับ Backend (Google Sheets)
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v5.5.022 (2026-06-26) — CONSISTENCY SYNC + DEEP DIVE FIX (BUG-M01/M02/M03/H02/H03/C01 + 6 cache/config fixes)
 *     v5.5.021 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 *     v5.5.020 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES (Load Order):
 *     - 01_Config.gs     (APP_VERSION, SHEET, *_IDX, APP_CONST)
 *     - 02_Schema.gs     (SCHEMA definitions)
 *     - 14_Utils.gs      (isAuthorizedUser_, maskReviewerEmail_)
 *     - 03_SetupSheets.gs (logInfo, logError, logWarn)
 *   CALLS:
 *     - SpreadsheetApp.getActiveSpreadsheet()
 *     - PropertiesService.getScriptProperties()
 *     - Session.getActiveUser()
 *   DEFINES:
 *     - doGet(e)                     — Web App entry point
 *     - include_(filename)           — HTML template loader for <?!= include_('...') ?>
 *     - isAuthorizedDashboardUser_() — Dashboard auth check (separate from LMDS_ADMINS)
 *     - getCurrentDashboardUser_()   — Return current user info for frontend
 *     - maskEmailSafe_(email)        — PII masking for logs (defense-in-depth)
 *     - getDashboardData()           — Overview stats for Dashboard view
 *     - computeFactStats_(sheet, stats)         — FACT_DELIVERY stats (internal)
 *     - computeReviewStats_(sheet, stats)       — Q_REVIEW stats (internal)
 *     - computeSourceStats_(sheet, stats)       — Source sheet stats (internal)
 *     - computeTopIssues_(reviewSheet, limit)   — Top issue_type counts (internal)
 *     - isAutoMatchStatus_(status)              — Check auto-match status (internal)
 *     - formatDateForCompare_(date)             — YYYY-MM-DD format (internal)
 *     - ping()                       — Health check endpoint
 *     - getFactDeliveryPage()         — Phase 2 (FACT_DELIVERY pagination + filter)
 *     - getQReviewPage()              — Phase 2 (Q_REVIEW pagination + status filter)
 *     - getMatchEngineMetrics()       — Phase 3 (Match Engine statistics)
 *   USED BY:
 *     - Web App deployment (script.google.com/macros/s/.../exec)
 * ===================================================
 * ARCHITECTURE:
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  22_WebApp.gs (Web App Server)                             │
 *   │  ├── doGet(e) → HtmlService.createTemplateFromFile('Index') │
 *   │  ├── include_(filename) → HtmlService (HTML partial)       │
 *   │  ├── isAuthorizedDashboardUser_() — reuse SEC-002 pattern  │
 *   │  │   (separate whitelist: DASHBOARD_USERS Script Property)  │
 *   │  ├── getCurrentDashboardUser_() — return email + name      │
 *   │  ├── getDashboardData() — overview stats (Phase 1)         │
 *   │  ├── getFactDeliveryPage(offset, limit, filter) — Phase 2  │
 *   │  ├── getQReviewPage(offset, limit, status) — Phase 2       │
 *   │  └── getMatchEngineMetrics() — Phase 3                     │
 *   └────────────────────────────────────────────────────────────┘
 * ===================================================
 * DEPLOYMENT:
 *   1. Apps Script Editor > Deploy > New deployment
 *   2. Type: Web app
 *   3. Execute as: Me (user deploying)
 *   4. Who has access: Anyone with Google Account
 *   5. Authorize scopes when prompted
 *   6. Copy URL: https://script.google.com/macros/s/.../exec
 * ===================================================
 */

// ============================================================
// SECTION 1: Web App Entry Point (doGet)
// ============================================================

/**
 * doGet — Web App entry point
 *   ทุกครั้งที่ผู้ใช้เปิด URL ของ Web App จะเรียกฟังก์ชันนี้
 *   1. ตรวจ Auth (DASHBOARD_USERS whitelist)
 *   2. ถ้าไม่ผ่าน → return Unauthorized page
 *   3. ถ้าผ่าน → return Index.html template พร้อม SSR data
 *
 * @param {Object} e - Event object (query params in e.parameter)
 * @return {HtmlOutput}
 */
function doGet(e) {
  try {
    // [SEC-002 Pattern] Auth check ก่อนทุกอย่าง
    if (!isAuthorizedDashboardUser_()) {
      logWarn('WebApp', 'doGet: unauthorized access attempt');
      // [FIX Deploy] Apps Script ไม่รองรับ subdirectories — ใช้ flat name 'Unauthorized'
      //   เดิม: 'views/Unauthorized' (ไม่ทำงานหลัง clasp push flatten)
      return HtmlService.createHtmlOutputFromFile('Unauthorized')
        .setTitle('LMDS — ไม่มีสิทธิ์เข้าถึง')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    // สร้าง template จาก Index.html
    const template = HtmlService.createTemplateFromFile('Index');

    // [FIX Phase 1] ไม่ SSR getDashboardData() แล้ว — ใช้ client-side fetch แทน
    //   สาเหตุ: getDashboardData() ใช้เวลา 4.5 วินาที (อ่าน 445 + 479 rows)
    //   ถ้าใส่ใน template.initialData → doGet ใช้เวลา 5+ วินาที
    //   บางครั้ง Apps Script ตัดการเชื่อมต่อ → __INITIAL_DATA__ เป็น undefined → หน้าขาว
    //
    //   วิธีใหม่: ส่งเฉพาะ metadata (เร็ว) แล้วให้ frontend โหลดข้อมูลเองผ่าน api.getDashboardData()
    //   ผล: หน้าโหลดเร็วขึ้น (~1 วินาที) + ไม่มีปัญหา timeout
    template.appVersion = APP_VERSION;
    template.appName = APP_NAME;
    template.currentUser = getCurrentDashboardUser_();
    template.initialData = null; // บังคับให้ frontend โหลดเอง
    template.deployedAt = new Date().toISOString();

    return template
      .evaluate()
      .setTitle('LMDS V5.5 Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setFaviconUrl('https://www.gstatic.com/images/branding/product/1x/sheets_64dp.png')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    logError('WebApp', 'doGet ล้มเหลว: ' + err.message, err);
    return HtmlService.createHtmlOutput(
      '<h1>⚠️ เกิดข้อผิดพลาด</h1>' +
        '<p>ไม่สามารถโหลด LMDS Dashboard ได้</p>' +
        '<p>รายละเอียด: ' +
        (err.message || 'Unknown error') +
        '</p>' +
        '<p>กรุณาติดต่อผู้ดูแลระบบ</p>'
    ).setTitle('LMDS — Error');
  }
}

/**
 * include_ — โหลด HTML partial สำหรับใช้ใน <?!= include_('file') ?>
 *   ใช้ใน Index.html เพื่อ include CSS/JS/HTML partials
 *
 * @param {string} filename - ชื่อไฟล์ (ไม่มีนามสกุล) เช่น 'css/Styles', 'js/App'
 * @return {string} HTML content ของไฟล์ที่ระบุ
 */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============================================================
// SECTION 2: Authentication (Dashboard-specific)
// ============================================================

/**
 * isAuthorizedDashboardUser_ — ตรวจสอบสิทธิ์เข้าใช้ Dashboard
 *   ใช้ whitelist แยกจาก LMDS_ADMINS เพื่อให้คนดู Dashboard ได้โดยไม่ต้องเป็น Admin
 *   อ่านจาก Script Property 'DASHBOARD_USERS' (คั่นด้วยจุลภาค)
 *
 *   [SEC-001 Pattern] Deny-by-default: ถ้า DASHBOARD_USERS ยังไม่ได้ตั้ง → ใช้ LMDS_ADMINS แทน
 *   ถ้า LMDS_ADMINS ก็ยังไม่ได้ตั้ง → ปล่อยผ่านเฉพาะ Script Owner
 *
 * @return {boolean}
 */
function isAuthorizedDashboardUser_() {
  try {
    // [FIX WebApp] ใช้ effectiveUser เป็นหลัก เพราะ executeAs=USER_DEPLOYING
    //   สาเหตุ: Session.getActiveUser() ใน Web App context (access=ANYONE)
    //   มักจะคืนค่าว่าง เพราะผู้ใช้อาจไม่ได้ login ด้วย Google Account
    //   แต่ effectiveUser จะเป็น email ของเจ้าของ Apps Script เสมอ (เพราะ executeAs=USER_DEPLOYING)
    const email = String(Session.getEffectiveUser().getEmail() || '')
      .trim()
      .toLowerCase();

    logInfo('WebApp', '[Auth DEBUG] effectiveUser="' + email + '"');

    if (!email) {
      // [FIX BUG-PM-003 V5.5.041] เปลี่ยนเป็น Deny-by-default
      //   สาเหตุ: เดิมปล่อยผ่านเป็น "preview mode" เมื่อ email ว่าง ซึ่งเสี่ยงถ้า
      //   Web App deploy ผิด config (เช่น access=ANYONE โดยไม่มี executeAs=USER_DEPLOYING)
      //   → ผู้ใช้นิรนามจะเข้าถึง Dashboard ได้โดยไม่ต้อง auth
      //   ปลอดภัยกว่าคือ deny แล้วให้ผู้ดูแลตรวจสอบการ deploy
      logError(
        'WebApp',
        '[Auth] ไม่สามารถอ่าน Email ได้ — ปฏิเสธการเข้าถึง (ตรวจสอบ Web App config: ' +
          'access + executeAs=USER_DEPLOYING และ Script Properties DASHBOARD_USERS/LMDS_ADMINS)'
      );
      return false;
    }

    // อ่าน whitelist สำหรับ Dashboard (แยกจาก LMDS_ADMINS)
    const dashboardUsersStr = String(
      PropertiesService.getScriptProperties().getProperty('DASHBOARD_USERS') || ''
    ).trim();

    if (dashboardUsersStr) {
      const users = dashboardUsersStr
        .split(',')
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);
      const authorized = users.includes(email);
      logInfo('WebApp', '[Auth] DASHBOARD_USERS check: ' + (authorized ? 'PASS' : 'FAIL'));
      return authorized;
    }

    // Fallback: ถ้า DASHBOARD_USERS ไม่ได้ตั้ง → ใช้ LMDS_ADMINS
    const adminsStr = String(PropertiesService.getScriptProperties().getProperty('LMDS_ADMINS') || '').trim();

    if (adminsStr) {
      const admins = adminsStr
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean);
      const authorized = admins.includes(email);
      logInfo('WebApp', '[Auth] LMDS_ADMINS check: ' + (authorized ? 'PASS' : 'FAIL'));
      return authorized;
    }

    // Last resort: Script Owner เท่านั้น — ปล่อยผ่านเพราะ executeAs=USER_DEPLOYING = เจ้าของเสมอ
    logInfo('WebApp', '[Auth] No whitelist — ปล่อยผ่าน (Script Owner)');
    return true;
  } catch (err) {
    logError('WebApp', 'isAuthorizedDashboardUser_ ล้มเหลว: ' + err.message, err);
    return false; // Deny-by-default
  }
}

/**
 * getCurrentDashboardUser_ — คืนข้อมูลผู้ใช้ปัจจุบันสำหรับ frontend
 *   ใช้ใน Index.html เพื่อแสดง email และชื่อใน header
 *
 * @return {Object} { authorized, email, name, isOwner }
 */
function getCurrentDashboardUser_() {
  // [FIX WebApp] ใช้ effectiveUser เป็นหลัก (executeAs=USER_DEPLOYING)
  const email = String(Session.getEffectiveUser().getEmail() || '').trim();
  let displayName = 'User';

  // [FIX] Session.getEffectiveUser() คืน User object ที่มีแค่ getEmail()
  //   ไม่มีเมธอด getUser() หรือ getDisplayName() ตามที่ error log บอก:
  //   'Session.getActiveUser(...).getUser is not a function'
  //
  //   วิธีดึง display name ที่ถูกต้อง:
  //   1. ใช้ email แยกชื่อออกมา (ก่อน @)
  //   2. หรือใช้ People API (ต้อง enable advanced service)
  //   สำหรับ Phase 1 ใช้วิธีที่ 1 พอ
  if (email && email.indexOf('@') > 0) {
    displayName = email.split('@')[0];
    // แปลงจุด/ขีดล่างเป็นวรรค + ขึ้นตัวแรก
    displayName = displayName.replace(/[._-]/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  logInfo('WebApp', '[Auth DEBUG] getCurrentDashboardUser_: email="' + email + '", name="' + displayName + '"');

  return {
    authorized: true,
    email: email || 'unknown',
    name: displayName,
    isOwner: true // executeAs=USER_DEPLOYING = เจ้าของเสมอ
  };
}

/**
 * maskEmailSafe_ — Mask email ก่อน log เพื่อป้องกัน PII leak
 *   ใช้ fallback ถ้า maskReviewerEmail_ ไม่ได้ถูกประกาศใน context นี้
 *   (defense-in-depth: ฟังก์ชันนี้ไม่ throw)
 *
 * @param {string} email
 * @return {string} masked email
 * @private
 */
function maskEmailSafe_(email) {
  try {
    if (typeof maskReviewerEmail_ === 'function') {
      return maskReviewerEmail_(email);
    }
    const isEmpty = email === '' || email === null || email === undefined;
    const isTooShort = typeof email === 'string' && email.length < 3;
    if (isEmpty || isTooShort) return '***';
    const parts = email.split('@');
    if (parts.length !== 2) return '***';
    return parts[0][0] + '***@' + parts[1];
  } catch (e) {
    return '***';
  }
}

// ============================================================
// SECTION 3: Dashboard Data API (Phase 1)
// ============================================================

/**
 * getDashboardData — คืน JSON สถิติรวมสำหรับ Dashboard view
 *   เรียกจาก frontend ผ่าน google.script.run ทุก 60 วินาที (polling)
 *
 *   สถิติที่คืน:
 *   - factDeliveryTotal: จำนวนระเบียนใน FACT_DELIVERY
 *   - reviewPending: จำนวนระเบียน Q_REVIEW ที่ status=PENDING
 *   - autoMatchRate: % ของ AUTO_MATCH ใน FACT_DELIVERY
 *   - todayDeliveries: จำนวนการจัดส่งวันนี้
 *   - sourceSheetTotal: จำนวนแถวใน Source sheet
 *   - lastUpdated: ISO timestamp
 *
 * @return {Object} { stats, topIssues, lastUpdated, appVersion }
 */
function getDashboardData() {
  // Auth check ทุก call (defense-in-depth)
  if (!isAuthorizedDashboardUser_()) {
    throw new Error('Unauthorized');
  }

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ─── อ่านข้อมูลจากหลายชีตใน batch ───
  const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  const reviewSheet = ss.getSheetByName(SHEET.Q_REVIEW);
  const sourceSheet = ss.getSheetByName(SHEET.SOURCE);

  // ตรวจว่าชีตมีอยู่จริง (Boolean() แทน !! เพื่อความชัดเจน)
  const sheetsExist = {
    fact: factSheet !== null,
    review: reviewSheet !== null,
    source: sourceSheet !== null
  };

  // ─── คำนวณ stats ───
  const stats = {
    factDeliveryTotal: 0,
    reviewPending: 0,
    reviewTotal: 0,
    autoMatchRate: 0,
    todayDeliveries: 0,
    sourceSheetTotal: 0,
    sourcePending: 0,
    matchStatusCounts: {}
  };

  if (sheetsExist.fact) {
    computeFactStats_(factSheet, stats);
  }

  if (sheetsExist.review) {
    computeReviewStats_(reviewSheet, stats);
  }

  if (sheetsExist.source) {
    computeSourceStats_(sourceSheet, stats);
  }

  // ─── Top Issues (จาก Q_REVIEW issue_type) ───
  const topIssues = computeTopIssues_(reviewSheet, 5);

  // ─── Delivery Trend 7 วัน (Phase 3.4) ───
  // คำนวณ trend การจัดส่งย้อนหลัง 7 วัน เพื่อแสดงเป็น line chart บน Dashboard
  const deliveryTrend = computeDeliveryTrend7Days_(factSheet);

  const elapsedMs = Date.now() - startTime;
  // [FIX] เพิ่ม reviewTotal ใน log เพื่อ debug ปัญหา review=0
  logInfo(
    'WebApp',
    'getDashboardData served — fact=' +
      stats.factDeliveryTotal +
      ', reviewPending=' +
      stats.reviewPending +
      '/' +
      stats.reviewTotal +
      ', source=' +
      stats.sourceSheetTotal +
      ', trend7d=' +
      deliveryTrend.total +
      ', elapsed=' +
      elapsedMs +
      'ms'
  );

  return {
    stats: stats,
    topIssues: topIssues,
    deliveryTrend: deliveryTrend,
    sheetsExist: sheetsExist,
    lastUpdated: new Date().toISOString(),
    appVersion: APP_VERSION,
    elapsedMs: elapsedMs
  };
}

/**
 * computeFactStats_ — คำนวณสถิติจาก FACT_DELIVERY sheet
 *   - นับจำนวนระเบียนทั้งหมด
 *   - นับ match status breakdown
 *   - คำนวณ auto match rate (FULL + GEO + FUZZY)
 *   - นับการจัดส่งวันนี้
 *
 * @param {Sheet} factSheet
 * @param {Object} stats — object ที่จะถูก mutate
 * @private
 */
function computeFactStats_(factSheet, stats) {
  const factData = factSheet.getDataRange().getValues();
  if (factData.length <= 1) return;

  stats.factDeliveryTotal = factData.length - 1; // ลบ header

  const statusCounts = {};
  let autoMatchCount = 0;
  let todayCount = 0;
  const todayStr = formatDateForCompare_(new Date());

  for (let i = 1; i < factData.length; i++) {
    const row = factData[i];
    const status = row[FACT_IDX.MATCH_STATUS] || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (isAutoMatchStatus_(status)) {
      autoMatchCount++;
    }

    const deliveryDate = row[FACT_IDX.DELIVERY_DATE];
    if (deliveryDate instanceof Date && formatDateForCompare_(deliveryDate) === todayStr) {
      todayCount++;
    }
  }

  stats.matchStatusCounts = statusCounts;
  stats.autoMatchRate =
    stats.factDeliveryTotal > 0 ? Math.round((autoMatchCount / stats.factDeliveryTotal) * 1000) / 10 : 0;
  stats.todayDeliveries = todayCount;
}

/**
 * isAutoMatchStatus_ — ตรวจว่า status เป็น auto match หรือไม่
 * @param {string} status
 * @return {boolean}
 * @private
 */
function isAutoMatchStatus_(status) {
  return status === APP_CONST.MATCH_FULL || status === APP_CONST.MATCH_GEO || status === APP_CONST.MATCH_FUZZY;
}

/**
 * computeDeliveryTrend7Days — คำนวณจำนวนการจัดส่งย้อนหลัง 7 วัน
 *   สำหรับแสดงเป็น line chart บน Dashboard (Phase 3.4)
 *
 *   Return:
 *   - labels: array ของ date string 7 ตัว (รูปแบบ 'dd/mm' ภาษาไทย)
 *             เรียงจากเก่า → ใหม่ (ซ้าย → ขวาใน chart)
 *   - data: array ของจำนวนรายการในแต่ละวัน (เรียงตาม labels)
 *   - total: รวมทั้ง 7 วัน
 *   - dailyAvg: ค่าเฉลี่ยรายวัน (1 ตำแหน่งทศนิยม)
 *
 * @param {Sheet} factSheet - FACT_DELIVERY sheet
 * @return {Object} { labels, data, total, dailyAvg }
 * @private
 */
function computeDeliveryTrend7Days_(factSheet) {
  // Default return — ถ้า sheet ไม่มีหรือว่าง
  const emptyResult = { labels: [], data: [], total: 0, dailyAvg: 0 };
  if (factSheet === null) return emptyResult;

  const lastRow = factSheet.getLastRow();
  if (lastRow <= 1) return emptyResult;

  // สร้าง map ของ 7 วันย้อนหลัง — key = 'YYYY-MM-DD'
  // เรียงจาก 6 วันก่อน → วันนี้ (รวม 7 วัน)
  const today = new Date();
  today.setHours(0, 0, 0, 0); // normalize เป็นเที่ยงคืน

  const labels = [];
  const dateKeys = [];
  const dayCounts = {};

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = formatDateForCompare_(d);
    dateKeys.push(key);
    dayCounts[key] = 0;
    // Label รูปแบบ 'dd/mm' ภาษาไทย (เช่น '01/07')
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    labels.push(dd + '/' + mm);
  }

  // อ่านเฉพาะคอลัมน์ DELIVERY_DATE จาก FACT_DELIVERY เพื่อลด payload
  // FACT_IDX.DELIVERY_DATE = 4 → 1-based = 5
  const dateCol = FACT_IDX.DELIVERY_DATE + 1;
  const dateData = factSheet.getRange(2, dateCol, lastRow - 1, 1).getValues();

  let total = 0;
  for (let i = 0; i < dateData.length; i++) {
    const cellValue = dateData[i][0];
    if (cellValue instanceof Date) {
      const key = formatDateForCompare_(cellValue);
      // [SonarCloud S3531] ใช้ in operator แทน hasOwnProperty — กระชับกว่า
      if (key in dayCounts) {
        dayCounts[key]++;
        total++;
      }
    } else if (typeof cellValue === 'string' && cellValue.length > 0) {
      // ถ้าเก็บเป็น string พยายาม parse
      const parsed = new Date(cellValue);
      if (!isNaN(parsed.getTime())) {
        const key = formatDateForCompare_(parsed);
        if (key in dayCounts) {
          dayCounts[key]++;
          total++;
        }
      }
    }
  }

  // สร้าง data array ตามลำดับ labels
  const data = dateKeys.map(function (key) {
    return dayCounts[key];
  });
  const dailyAvg = Math.round((total / 7) * 10) / 10;

  return {
    labels: labels,
    data: data,
    total: total,
    dailyAvg: dailyAvg
  };
}

/**
 * computeReviewStats_ — คำนวณสถิติจาก Q_REVIEW sheet
 * @param {Sheet} reviewSheet
 * @param {Object} stats
 * @private
 */
function computeReviewStats_(reviewSheet, stats) {
  const reviewData = reviewSheet.getDataRange().getValues();
  if (reviewData.length <= 1) return;

  stats.reviewTotal = reviewData.length - 1;
  for (let i = 1; i < reviewData.length; i++) {
    const status = reviewData[i][REVIEW_IDX.STATUS];
    // [FIX] Q_REVIEW STATUS ใช้ค่า 'Pending' (title case) จาก setupReviewDropdowns_
    //   เดิมเช็คแค่ 'PENDING' (uppercase) จึงไม่ match → count เป็น 0
    //   แก้: เปลี่ยนเป็น case-insensitive และรองรับทั้ง 'Pending' และ 'PENDING'
    const statusUpper = String(status || '')
      .trim()
      .toUpperCase();
    const isPending = statusUpper === 'PENDING' || status === '' || status === null || status === undefined;
    if (isPending) {
      stats.reviewPending++;
    }
  }
}

/**
 * computeSourceStats_ — คำนวณสถิติจาก Source sheet
 * @param {Sheet} sourceSheet
 * @param {Object} stats
 * @private
 */
function computeSourceStats_(sourceSheet, stats) {
  const sourceData = sourceSheet.getDataRange().getValues();
  if (sourceData.length <= 1) return;

  stats.sourceSheetTotal = sourceData.length - 1;
  for (let i = 1; i < sourceData.length; i++) {
    const syncStatus = sourceData[i][SRC_IDX.SYNC_STATUS];
    const isDone = String(syncStatus || '').toUpperCase() === SCG_CONFIG.SYNC_DONE_VALUE;
    if (syncStatus !== null && syncStatus !== undefined && syncStatus !== '' && !isDone) {
      stats.sourcePending++;
    }
  }
}

/**
 * computeTopIssues_ — นับ issue_type จาก Q_REVIEW แล้วคืน top N
 *
 * @param {Sheet} reviewSheet
 * @param {number} limit - จำนวน top issues ที่ต้องการ
 * @return {Array<{issueType: string, count: number}>}
 * @private
 */
function computeTopIssues_(reviewSheet, limit) {
  if (!reviewSheet) return [];
  const data = reviewSheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const counts = {};
  for (let i = 1; i < data.length; i++) {
    const status = data[i][REVIEW_IDX.STATUS];
    const isPending = status === 'PENDING' || status === '' || status === null || status === undefined;
    // นับเฉพาะที่ยัง PENDING
    if (isPending) {
      const issueType = data[i][REVIEW_IDX.ISSUE_TYPE] || 'UNKNOWN';
      counts[issueType] = (counts[issueType] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([issueType, count]) => ({ issueType: issueType, count: count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * formatDateForCompare_ — แปลง Date เป็น string YYYY-MM-DD สำหรับเทียบวัน
 *
 * @param {Date} date
 * @return {string}
 * @private
 */
function formatDateForCompare_(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

// ============================================================
// SECTION 4: Health Check (used by frontend to verify API connectivity)
// ============================================================

/**
 * ping — ใช้สำหรับ frontend ทดสอบว่า server ตอบสนองได้
 *   และ auth ยังผ่านอยู่
 *
 * @return {Object} { ok: true, timestamp: '...', user: '...' }
 */
function ping() {
  if (!isAuthorizedDashboardUser_()) {
    return { ok: false, error: 'Unauthorized' };
  }
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    appVersion: APP_VERSION,
    user: getCurrentDashboardUser_().email
  };
}

// ============================================================
// SECTION 5: Phase 2+ Page Functions (FACT_DELIVERY, Q_REVIEW, Match Engine)
// ============================================================

/**
 * getFactDeliveryPage — Phase 2 (FACT_DELIVERY pagination + filter)
 *   คืนข้อมูล FACT_DELIVERY แบบ pagination + filter
 *
 * @param {number} offset - แถวเริ่มต้น (0-based, หลัง header)
 * @param {number} limit - จำนวนแถวต่อหน้า (default 50)
 * @param {Object} filter - { status, dateFrom, dateTo, searchText }
 * @return {Object} { rows, total, offset, limit }
 */
function getFactDeliveryPage(offset, limit, filter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);

  if (!sheet) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      statusCounts: {},
      elapsedMs: 0,
      error: 'ไม่พบ sheet FACT_DELIVERY'
    };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      statusCounts: {},
      elapsedMs: 0
    };
  }

  // อ่านข้อมูลทั้งหมด batch
  const data = sheet.getRange(2, 1, lastRow - 1, SCHEMA[SHEET.FACT_DELIVERY].length).getValues();

  // นับ match status ทั้งหมด (สำหรับ filter tabs)
  const statusCounts = {};
  data.forEach(function (row) {
    const s = String(row[FACT_IDX.MATCH_STATUS] || 'UNKNOWN').trim();
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  // Filter — รองรับ filter.status (string) หรือ filter.statuses (array)
  const filterObj = filter || {};
  let filtered = data;
  if (filterObj.status && filterObj.status !== 'all' && filterObj.status !== '') {
    filtered = data.filter(function (row) {
      return String(row[FACT_IDX.MATCH_STATUS] || '').trim() === filterObj.status;
    });
  } else if (Array.isArray(filterObj.statuses) && filterObj.statuses.length > 0) {
    filtered = data.filter(function (row) {
      return filterObj.statuses.indexOf(String(row[FACT_IDX.MATCH_STATUS] || '').trim()) !== -1;
    });
  }

  // Pagination
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const pageRows = filtered.slice(safeOffset, safeOffset + safeLimit);

  // แปลง rows เป็น objects
  const rows = pageRows.map(function (row) {
    return {
      txId: String(row[FACT_IDX.TX_ID] || ''),
      deliveryDate:
        row[FACT_IDX.DELIVERY_DATE] instanceof Date
          ? row[FACT_IDX.DELIVERY_DATE].toISOString()
          : String(row[FACT_IDX.DELIVERY_DATE] || ''),
      deliveryTime: String(row[FACT_IDX.DELIVERY_TIME] || ''),
      invoiceNo: String(row[FACT_IDX.INVOICE_NO] || ''),
      shipmentNo: String(row[FACT_IDX.SHIPMENT_NO] || ''),
      driverName: String(row[FACT_IDX.DRIVER_NAME] || ''),
      truckLicense: String(row[FACT_IDX.TRUCK_LICENSE] || ''),
      soldToName: String(row[FACT_IDX.SOLD_TO_NAME] || ''),
      shipToName: String(row[FACT_IDX.SHIP_TO_NAME] || ''),
      shipToAddress: String(row[FACT_IDX.SHIP_TO_ADDR] || ''),
      geoResolvedAddr: String(row[FACT_IDX.GEO_RESOLVED_ADDR] || ''),
      personId: String(row[FACT_IDX.PERSON_ID] || ''),
      placeId: String(row[FACT_IDX.PLACE_ID] || ''),
      destId: String(row[FACT_IDX.DEST_ID] || ''),
      warehouse: String(row[FACT_IDX.WAREHOUSE] || ''),
      rawLat: Number(row[FACT_IDX.RAW_LAT] || 0),
      rawLng: Number(row[FACT_IDX.RAW_LNG] || 0),
      matchStatus: String(row[FACT_IDX.MATCH_STATUS] || ''),
      matchConfidence: Number(row[FACT_IDX.MATCH_CONF] || 0),
      matchReason: String(row[FACT_IDX.MATCH_REASON] || ''),
      matchAction: String(row[FACT_IDX.MATCH_ACTION] || ''),
      resolvedLat: Number(row[FACT_IDX.RESOLVED_LAT] || 0),
      resolvedLng: Number(row[FACT_IDX.RESOLVED_LNG] || 0),
      driverVerifiedName: String(row[FACT_IDX.DRIVER_VERIFIED_NAME] || ''),
      driverVerifiedAddr: String(row[FACT_IDX.DRIVER_VERIFIED_ADDR] || '')
    };
  });

  const elapsedMs = Date.now() - startTime;
  logInfo(
    'WebApp',
    'getFactDeliveryPage: status=' +
      (filterObj.status || 'all') +
      ' offset=' +
      safeOffset +
      ' limit=' +
      safeLimit +
      ' → ' +
      rows.length +
      '/' +
      filtered.length +
      ' rows in ' +
      elapsedMs +
      'ms'
  );

  return {
    rows: rows,
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    filter: filterObj,
    statusCounts: statusCounts,
    elapsedMs: elapsedMs
  };
}

/**
 * getQReviewPage — Phase 2: ดึงรายการ Q_REVIEW แบบ pagination + filter
 *   เรียกจาก frontend ผ่าน google.script.run
 *
 * @param {number} offset - แถวเริ่มต้น (0-based, หลัง header) — default 0
 * @param {number} limit - จำนวนแถวต่อหน้า — default 50
 * @param {string} statusFilter - 'Pending' | 'Approved' | 'Rejected' | 'Escalated' | 'Done' | 'all'
 *                                ถ้าไม่ระบุ จะใช้ 'Pending' เป็น default
 * @return {Object} { rows, total, offset, limit, statusFilter, statusCounts }
 *   - rows: array ของ review objects (เลือกเฉพาะ field ที่ frontend ต้องการ เพื่อลด payload)
 *   - total: จำนวนรายการทั้งหมดที่ match filter (ไม่ใช่ทั้ง sheet)
 *   - statusCounts: จำนวนรายการแต่ละ status ทั้งหมด (สำหรับ filter tabs)
 */
function getQReviewPage(offset, limit, statusFilter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.Q_REVIEW);

  if (!sheet) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      statusFilter: statusFilter || 'Pending',
      statusCounts: {},
      elapsedMs: 0,
      error: 'ไม่พบ sheet Q_REVIEW'
    };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      statusFilter: statusFilter || 'Pending',
      statusCounts: {},
      elapsedMs: 0
    };
  }

  // อ่านข้อมูลทั้งหมด (GAS อ่าน batch เร็วกว่า row-by-row)
  const data = sheet.getRange(2, 1, lastRow - 1, SCHEMA[SHEET.Q_REVIEW].length).getValues();

  // นับ status ทั้งหมด (สำหรับ filter tabs)
  const statusCounts = { Pending: 0, Approved: 0, Rejected: 0, Escalated: 0, Done: 0, Other: 0 };
  data.forEach(function (row) {
    const s = String(row[REVIEW_IDX.STATUS] || '').trim();
    if (s === 'Pending' || s === 'PENDING' || s === '') statusCounts['Pending']++;
    else if (s === 'Approved' || s === 'APPROVED') statusCounts['Approved']++;
    else if (s === 'Rejected' || s === 'REJECTED') statusCounts['Rejected']++;
    else if (s === 'Escalated' || s === 'ESCALATED') statusCounts['Escalated']++;
    else if (s === 'Done' || s === 'DONE') statusCounts['Done']++;
    else statusCounts['Other']++;
  });

  // Filter
  const wantStatus = (statusFilter || 'Pending').toLowerCase();
  const filtered = data.filter(function (row) {
    if (wantStatus === 'all') return true;
    const s = String(row[REVIEW_IDX.STATUS] || '')
      .trim()
      .toLowerCase();
    if (wantStatus === 'pending') return s === '' || s === 'pending';
    return s === wantStatus;
  });

  // Pagination
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const pageRows = filtered.slice(safeOffset, safeOffset + safeLimit);

  // แปลง rows เป็น objects (เลือกเฉพาะ field ที่ frontend ใช้)
  const rows = pageRows.map(function (row, idx) {
    return {
      reviewId: String(row[REVIEW_IDX.REVIEW_ID] || ''),
      issueType: String(row[REVIEW_IDX.ISSUE_TYPE] || ''),
      priority: String(row[REVIEW_IDX.PRIORITY] || ''),
      invoiceNo: String(row[REVIEW_IDX.INVOICE_NO] || ''),
      rawPerson: String(row[REVIEW_IDX.RAW_PERSON] || ''),
      rawPlace: String(row[REVIEW_IDX.RAW_PLACE] || ''),
      rawAddress: String(row[REVIEW_IDX.RAW_SYS_ADDR] || ''),
      rawLat: Number(row[REVIEW_IDX.RAW_LAT] || 0),
      rawLng: Number(row[REVIEW_IDX.RAW_LNG] || 0),
      matchScore: Number(row[REVIEW_IDX.MATCH_SCORE] || 0),
      recommend: String(row[REVIEW_IDX.RECOMMEND] || ''),
      status: String(row[REVIEW_IDX.STATUS] || 'Pending'),
      reviewer: String(row[REVIEW_IDX.REVIEWER] || ''),
      decision: String(row[REVIEW_IDX.DECISION] || ''),
      note: String(row[REVIEW_IDX.NOTE] || ''),
      candPersonIds: safeParseJsonArray_(row[REVIEW_IDX.CAND_PERSONS]),
      candPlaceIds: safeParseJsonArray_(row[REVIEW_IDX.CAND_PLACES]),
      sourceRowNumber: Number(row[REVIEW_IDX.SOURCE_ROW] || 0),
      // ส่ง row index (1-based ใน sheet) กลับไป เพื่อใช้ตอน applyReviewDecision
      _sheetRow: idx + safeOffset + 2
    };
  });

  const elapsedMs = Date.now() - startTime;
  logInfo(
    'WebApp',
    'getQReviewPage: status=' +
      (statusFilter || 'Pending') +
      ' offset=' +
      safeOffset +
      ' limit=' +
      safeLimit +
      ' → ' +
      rows.length +
      '/' +
      filtered.length +
      ' rows in ' +
      elapsedMs +
      'ms'
  );

  return {
    rows: rows,
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    statusFilter: statusFilter || 'Pending',
    statusCounts: statusCounts,
    elapsedMs: elapsedMs
  };
}

/**
 * safeParseJsonArray_ — parse JSON string เป็น array อย่างปลอดภัย
 * @param {*} val
 * @return {Array}
 * @private
 */
function safeParseJsonArray_(val) {
  if (val === null || val === undefined || val === '') return [];
  if (Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(String(val));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * submitReviewDecision — Phase 2: บันทึกการตัดสินใจ Approve/Reject ของ reviewer
 *   wrapper รอบ applyReviewDecision() ใน 12_ReviewService.gs
 *   เพิ่ม auth check + return structured response สำหรับ frontend
 *
 * @param {string} reviewId - review_id ของรายการที่จะตัดสินใจ
 * @param {string} decision - 'CREATE_NEW' (Approve = สร้าง entity ใหม่)
 *                            | 'MERGE_TO_CANDIDATE' (Approve = merge เข้า candidate)
 *                            | 'IGNORE' (Reject = ไม่ action, ปิดไป)
 *                            | 'ESCALATE' (Reject + ส่งต่อ)
 * @param {string} note - หมายเหตุ (optional)
 * @return {Object} { ok, reviewId, decision, message }
 */
function submitReviewDecision(reviewId, decision, note) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  // [V6.0.004] RBAC: require reviewer/admin
  if (typeof requirePermission_ === 'function') requirePermission_('action:approve_review');

  if (!reviewId || !decision) {
    return { ok: false, message: 'กรุณาระบุ reviewId และ decision' };
  }

  const validDecisions = ['CREATE_NEW', 'MERGE_TO_CANDIDATE', 'IGNORE', 'ESCALATE'];
  if (validDecisions.indexOf(decision) === -1) {
    return { ok: false, message: 'decision ไม่ถูกต้อง ต้องเป็น: ' + validDecisions.join(', ') };
  }

  try {
    // ดึง rowData ล่าสุดจาก sheet (frontend ส่งมาอาจเก่าแล้ว)
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet) {
      return { ok: false, message: 'ไม่พบ sheet Q_REVIEW' };
    }

    // หา row ที่มี reviewId นี้
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return { ok: false, message: 'Q_REVIEW ว่าง' };
    }

    const data = sheet.getRange(2, 1, lastRow - 1, SCHEMA[SHEET.Q_REVIEW].length).getValues();
    let targetRow = -1;
    let rowData = null;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][REVIEW_IDX.REVIEW_ID]).trim() === reviewId) {
        targetRow = i + 2;
        rowData = data[i];
        break;
      }
    }

    if (targetRow === -1 || !rowData) {
      return { ok: false, message: 'ไม่พบ reviewId: ' + reviewId };
    }

    // ตรวจว่ารายการยัง Pending อยู่หรือไม่ (defense-in-depth)
    const currentStatus = String(rowData[REVIEW_IDX.STATUS] || '')
      .trim()
      .toLowerCase();
    if (
      currentStatus === 'approved' ||
      currentStatus === 'rejected' ||
      currentStatus === 'done' ||
      currentStatus === 'escalated'
    ) {
      return {
        ok: false,
        message: 'รายการนี้ถูกตัดสินใจแล้ว (status=' + currentStatus + ') ไม่สามารถเปลี่ยนแปลงได้',
        reviewId: reviewId
      };
    }

    // เพิ่ม note ถ้ามี
    if (note) {
      rowData[REVIEW_IDX.NOTE] = note;
    }

    // เรียกใช้ฟังก์ชันที่มีอยู่แล้วใน 12_ReviewService.gs
    const result = applyReviewDecision(reviewId, decision, rowData, targetRow);

    // [FIX V5.5.049 BUG-QREVIEW] เขียน factRowData ลง FACT_DELIVERY จริง
    //   ปัญหา: applyReviewDecision คืน factRowData แต่ไม่ได้เขียนลง sheet
    //   ใน batch flow (applyAllPendingDecisions) มี batch write แต่ single decision ไม่มี
    //   ทำให้กด Approve แล้วข้อมูลไม่ถูกสร้างใน FACT_DELIVERY
    let factRowWritten = false;
    if (result && result.factRowData) {
      try {
        const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
        if (factSheet) {
          // [FIX BUG-PM-004 V5.5.041] Math.min guard สำหรับ column count mismatch
          const factSchemaLen = SCHEMA[SHEET.FACT_DELIVERY].length;
          const factSheetCols = Math.min(factSchemaLen, factSheet.getLastColumn());
          const rowsToWrite =
            factSheetCols === factSchemaLen ? [result.factRowData] : [result.factRowData.slice(0, factSheetCols)];
          factSheet.getRange(factSheet.getLastRow() + 1, 1, 1, factSheetCols).setValues(rowsToWrite);
          factRowWritten = true;
          logInfo(
            'WebApp',
            'submitReviewDecision: เขียน FACT_DELIVERY สำเร็จ — txId=' + result.factRowData[FACT_IDX.TX_ID]
          );
        }
      } catch (factErr) {
        logError('WebApp', 'submitReviewDecision: เขียน FACT_DELIVERY ล้มเหลว — ' + factErr.message, factErr);
      }
    }

    logInfo(
      'WebApp',
      'submitReviewDecision: ' + reviewId + ' → ' + decision + ' โดย ' + (getCurrentDashboardUser_().email || '?')
    );

    return {
      ok: true,
      reviewId: reviewId,
      decision: decision,
      message: 'บันทึกการตัดสินใจสำเร็จ',
      result: { factRowWritten: factRowWritten }
    };
  } catch (err) {
    logError('WebApp', 'submitReviewDecision ล้มเหลว: ' + err.message, err);
    return { ok: false, message: err.message || 'Unknown error', reviewId: reviewId };
  }
}

/**
 * getReviewDetail — Phase 2: ดึงรายละเอียดเต็มของ review item เพื่อให้ reviewer
 *   ตัดสินใจได้มั่นใจ ประกอบด้วย:
 *   - review row เต็ม (รวม note, reviewer, reviewed_at)
 *   - source row (จาก SOURCE sheet) — ข้อมูลดิบที่ทำให้เกิดการ review
 *   - candidate persons (จาก M_PERSON) — แสดง name, phone, usage_count, status
 *   - candidate places (จาก M_PLACE) — แสดง name, address, usage_count
 *   - candidate destinations (จาก M_DESTINATION) — แสดง lat, lng, route_label
 *   - distance (เมตร) ระหว่าง raw_lat/lng กับ candidate destination lat/lng
 *
 * @param {string} reviewId
 * @return {Object} { review, source, candidates: { persons: [], places: [], destinations: [] } }
 */
function getReviewDetail(reviewId) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  if (!reviewId) {
    return { ok: false, message: 'กรุณาระบุ reviewId' };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ─── 1. ดึง review row ───
    const reviewSheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!reviewSheet || reviewSheet.getLastRow() <= 1) {
      return { ok: false, message: 'ไม่พบ sheet Q_REVIEW หรือว่าง' };
    }

    const reviewData = reviewSheet
      .getRange(2, 1, reviewSheet.getLastRow() - 1, SCHEMA[SHEET.Q_REVIEW].length)
      .getValues();
    let reviewRow = null;
    let reviewSheetRow = -1;
    for (let i = 0; i < reviewData.length; i++) {
      if (String(reviewData[i][REVIEW_IDX.REVIEW_ID]).trim() === reviewId) {
        reviewRow = reviewData[i];
        reviewSheetRow = i + 2;
        break;
      }
    }
    if (!reviewRow) {
      return { ok: false, message: 'ไม่พบ reviewId: ' + reviewId };
    }

    const review = {
      reviewId: String(reviewRow[REVIEW_IDX.REVIEW_ID] || ''),
      issueType: String(reviewRow[REVIEW_IDX.ISSUE_TYPE] || ''),
      priority: String(reviewRow[REVIEW_IDX.PRIORITY] || ''),
      sourceRecId: String(reviewRow[REVIEW_IDX.SOURCE_REC_ID] || ''),
      sourceRowNumber: Number(reviewRow[REVIEW_IDX.SOURCE_ROW] || 0),
      invoiceNo: String(reviewRow[REVIEW_IDX.INVOICE_NO] || ''),
      rawPerson: String(reviewRow[REVIEW_IDX.RAW_PERSON] || ''),
      rawPlace: String(reviewRow[REVIEW_IDX.RAW_PLACE] || ''),
      rawAddress: String(reviewRow[REVIEW_IDX.RAW_SYS_ADDR] || ''),
      rawLat: Number(reviewRow[REVIEW_IDX.RAW_LAT] || 0),
      rawLng: Number(reviewRow[REVIEW_IDX.RAW_LNG] || 0),
      matchScore: Number(reviewRow[REVIEW_IDX.MATCH_SCORE] || 0),
      recommend: String(reviewRow[REVIEW_IDX.RECOMMEND] || ''),
      status: String(reviewRow[REVIEW_IDX.STATUS] || 'Pending'),
      reviewer: String(reviewRow[REVIEW_IDX.REVIEWER] || ''),
      decision: String(reviewRow[REVIEW_IDX.DECISION] || ''),
      note: String(reviewRow[REVIEW_IDX.NOTE] || ''),
      _sheetRow: reviewSheetRow
    };

    // ─── 2. ดึง source row (ถ้ามี sourceRowNumber) ───
    let source = null;
    if (review.sourceRowNumber > 1) {
      const srcSheet = ss.getSheetByName(SHEET.SOURCE);
      if (srcSheet && srcSheet.getLastRow() >= review.sourceRowNumber) {
        const srcData = srcSheet.getRange(review.sourceRowNumber, 1, 1, srcSheet.getLastColumn()).getValues()[0];
        source = {
          rowNumber: review.sourceRowNumber,
          sourceId: String(srcData[SRC_IDX.SOURCE_ID] || ''),
          deliveryDate:
            srcData[SRC_IDX.DELIVERY_DATE] instanceof Date
              ? srcData[SRC_IDX.DELIVERY_DATE].toISOString()
              : String(srcData[SRC_IDX.DELIVERY_DATE] || ''),
          deliveryTime: String(srcData[SRC_IDX.DELIVERY_TIME] || ''),
          driverName: String(srcData[SRC_IDX.DRIVER_NAME] || ''),
          truckLicense: String(srcData[SRC_IDX.TRUCK_LICENSE] || ''),
          shipmentNo: String(srcData[SRC_IDX.SHIPMENT_NO] || ''),
          invoiceNo: String(srcData[SRC_IDX.INVOICE_NO] || ''),
          customerCode: String(srcData[SRC_IDX.CUSTOMER_CODE] || ''),
          soldToName: String(srcData[SRC_IDX.SOLD_TO_NAME] || ''),
          rawPersonName: String(srcData[SRC_IDX.RAW_PERSON_NAME] || ''),
          lat: Number(srcData[SRC_IDX.LAT] || 0),
          lng: Number(srcData[SRC_IDX.LNG] || 0),
          warehouse: String(srcData[SRC_IDX.WAREHOUSE] || ''),
          rawAddress: String(srcData[SRC_IDX.RAW_ADDRESS] || ''),
          resolvedAddr: String(srcData[SRC_IDX.RESOLVED_ADDR] || ''),
          remark: String(srcData[SRC_IDX.REMARK] || ''),
          distFromWh: Number(srcData[SRC_IDX.DIST_FROM_WH] || 0),
          driverVerifiedName: String(srcData[SRC_IDX.DRIVER_VERIFIED_NAME] || ''),
          driverVerifiedAddr: String(srcData[SRC_IDX.DRIVER_VERIFIED_ADDR] || '')
        };
      }
    }

    // ─── 3. ดึง candidate persons + places + destinations ───
    const candPersonIds = safeParseJsonArray_(reviewRow[REVIEW_IDX.CAND_PERSONS]);
    const candPlaceIds = safeParseJsonArray_(reviewRow[REVIEW_IDX.CAND_PLACES]);
    const candDestIds = safeParseJsonArray_(reviewRow[REVIEW_IDX.CAND_DESTS]);

    const candidates = {
      persons: [],
      places: [],
      destinations: []
    };

    // 3a. Candidate persons
    if (candPersonIds.length > 0) {
      const personSheet = ss.getSheetByName(SHEET.M_PERSON);
      if (personSheet && personSheet.getLastRow() > 1) {
        const persons = personSheet
          .getRange(2, 1, personSheet.getLastRow() - 1, SCHEMA[SHEET.M_PERSON].length)
          .getValues();
        persons.forEach(function (row) {
          const pid = String(row[PERSON_IDX.PERSON_ID] || '');
          if (candPersonIds.indexOf(pid) !== -1) {
            candidates.persons.push({
              personId: pid,
              canonicalName: String(row[PERSON_IDX.CANONICAL] || ''),
              phone: String(row[PERSON_IDX.PHONE] || ''),
              usageCount: Number(row[PERSON_IDX.USAGE_COUNT] || 0),
              status: String(row[PERSON_IDX.STATUS] || ''),
              lastSeen: row[PERSON_IDX.LAST_SEEN] instanceof Date ? row[PERSON_IDX.LAST_SEEN].toISOString() : ''
            });
          }
        });
      }
    }

    // 3b. Candidate places
    if (candPlaceIds.length > 0) {
      const placeSheet = ss.getSheetByName(SHEET.M_PLACE);
      if (placeSheet && placeSheet.getLastRow() > 1) {
        const places = placeSheet.getRange(2, 1, placeSheet.getLastRow() - 1, SCHEMA[SHEET.M_PLACE].length).getValues();
        places.forEach(function (row) {
          const pid = String(row[PLACE_IDX.PLACE_ID] || '');
          if (candPlaceIds.indexOf(pid) !== -1) {
            candidates.places.push({
              placeId: pid,
              canonicalName: String(row[PLACE_IDX.CANONICAL] || ''),
              placeType: String(row[PLACE_IDX.PLACE_TYPE] || ''),
              subDistrict: String(row[PLACE_IDX.SUB_DISTRICT] || ''),
              district: String(row[PLACE_IDX.DISTRICT] || ''),
              province: String(row[PLACE_IDX.PROVINCE] || ''),
              postcode: String(row[PLACE_IDX.POSTCODE] || ''),
              usageCount: Number(row[PLACE_IDX.USAGE_COUNT] || 0),
              status: String(row[PLACE_IDX.STATUS] || ''),
              lastSeen: row[PLACE_IDX.LAST_SEEN] instanceof Date ? row[PLACE_IDX.LAST_SEEN].toISOString() : ''
            });
          }
        });
      }
    }

    // 3c. Candidate destinations (สำคัญที่สุดเพราะมี lat/lng จริง)
    if (candDestIds.length > 0) {
      const destSheet = ss.getSheetByName(SHEET.M_DESTINATION);
      if (destSheet && destSheet.getLastRow() > 1) {
        const dests = destSheet
          .getRange(2, 1, destSheet.getLastRow() - 1, SCHEMA[SHEET.M_DESTINATION].length)
          .getValues();
        dests.forEach(function (row) {
          const did = String(row[DEST_IDX.DEST_ID] || '');
          if (candDestIds.indexOf(did) !== -1) {
            const lat = Number(row[DEST_IDX.LAT] || 0);
            const lng = Number(row[DEST_IDX.LNG] || 0);
            const distance =
              review.rawLat && review.rawLng && lat && lng
                ? haversineDistanceMeters_(review.rawLat, review.rawLng, lat, lng)
                : null;
            candidates.destinations.push({
              destId: did,
              personId: String(row[DEST_IDX.PERSON_ID] || ''),
              placeId: String(row[DEST_IDX.PLACE_ID] || ''),
              lat: lat,
              lng: lng,
              routeLabel: String(row[DEST_IDX.ROUTE_LABEL] || ''),
              usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0),
              status: String(row[DEST_IDX.STATUS] || ''),
              lastSeen: row[DEST_IDX.LAST_SEEN] instanceof Date ? row[DEST_IDX.LAST_SEEN].toISOString() : '',
              distanceFromRawMeters: distance
            });
          }
        });
      }
    }

    const elapsedMs = Date.now() - startTime;
    logInfo(
      'WebApp',
      'getReviewDetail: ' +
        reviewId +
        ' → candidates: ' +
        candidates.persons.length +
        'p/' +
        candidates.places.length +
        'pl/' +
        candidates.destinations.length +
        'd in ' +
        elapsedMs +
        'ms'
    );

    return {
      ok: true,
      review: review,
      source: source,
      candidates: candidates,
      elapsedMs: elapsedMs
    };
  } catch (err) {
    logError('WebApp', 'getReviewDetail ล้มเหลว: ' + err.message, err);
    return { ok: false, message: err.message || 'Unknown error' };
  }
}

/**
 * haversineDistanceMeters_ — คำนวณระยะทางระหว่าง 2 พิกัด (เมตร)
 *   [FIX Static Audit Issue 4] delegate ไป haversineDistanceM() ใน 14_Utils.gs
 *   แทนการ re-implement Haversine formula ซ้ำ — Single Source of Truth
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @return {number} ระยะทางในหน่วยเมตร (rounded)
 * @private
 */
function haversineDistanceMeters_(lat1, lng1, lat2, lng2) {
  if (typeof haversineDistanceM === 'function') {
    return Math.round(haversineDistanceM(lat1, lng1, lat2, lng2));
  }
  // Fallback: re-implement (กรณี 14_Utils.gs ยังไม่ถูกโหลด)
  const R = 6371000;
  const toRad = function (deg) {
    return (deg * Math.PI) / 180;
  };
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * getMatchEngineMetrics — Phase 3: สถิติ Match Engine สำหรับหน้า dashboard
 *   วิเคราะห์ข้อมูลจาก FACT_DELIVERY sheet เพื่อให้ภาพรวมคุณภาพการ match
 *
 * Metrics ที่ส่งกลับ:
 *   - summary: { total, autoMatchedCount, autoMatchRate, avgScore, maxScore, minScore, withScoreCount }
 *   - statusCounts: { FULL_MATCH, GEO_ANCHOR, FUZZY_MATCH, CREATE_NEW, NEEDS_REVIEW, ERROR, ... }
 *   - scoreDistribution: array ขนาด 10 — count ของ score ในแต่ละ bin (0-9, 10-19, ..., 90-100)
 *   - scoreBins: labels ของ bins (สำหรับ chart)
 *   - matchReasons: array เรียงตาม count desc — [{ reason, count }]
 *   - matchActions: array เรียงตาม count desc — [{ action, count }]
 *
 * @return {Object} { summary, statusCounts, scoreDistribution, scoreBins, matchReasons, matchActions, elapsedMs }
 */
function getMatchEngineMetrics() {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);

  if (!sheet || sheet.getLastRow() <= 1) {
    return {
      summary: {
        total: 0,
        autoMatchedCount: 0,
        autoMatchRate: 0,
        avgScore: 0,
        maxScore: 0,
        minScore: 0,
        withScoreCount: 0
      },
      statusCounts: {},
      scoreDistribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      scoreBins: ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100'],
      matchReasons: [],
      matchActions: [],
      elapsedMs: 0
    };
  }

  // อ่านเฉพาะคอลัมน์ที่จำเป็น เพื่อลด payload — match_status, match_confidence, match_reason, match_action
  // ใช้ getRange(row, col, numRows, numCols) เพื่อดึงเฉพาะ 4 คอลัมน์
  const startCol = FACT_IDX.MATCH_STATUS + 1; // 1-based
  const numCols = 4; // MATCH_STATUS, MATCH_CONF, MATCH_REASON, MATCH_ACTION
  const data = sheet.getRange(2, startCol, sheet.getLastRow() - 1, numCols).getValues();

  // ─── Summary + Status counts ───
  const total = data.length;
  let autoMatchedCount = 0;
  let withScoreCount = 0;
  let sumScore = 0;
  let maxScore = 0;
  let minScore = 101; // start higher than max possible
  const statusCounts = {};

  // ─── Score distribution (10 bins: 0-9, 10-19, ..., 90-100) ───
  const scoreDistribution = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  // ─── Reason + Action counts ───
  const reasonCounts = {};
  const actionCounts = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const status = String(row[0] || '').trim();
    const score = Number(row[1] || 0);
    const reason = String(row[2] || '').trim();
    const action = String(row[3] || '').trim();

    // Status counts
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    // Auto-match (FULL + GEO + FUZZY)
    if (isAutoMatchStatus_(status)) {
      autoMatchedCount++;
    }

    // Score stats
    if (score > 0) {
      withScoreCount++;
      sumScore += score;
      if (score > maxScore) maxScore = score;
      if (score < minScore) minScore = score;

      // Bin index: 0-9 → 0, 10-19 → 1, ..., 90-100 → 9
      let binIdx = Math.floor(score / 10);
      if (binIdx > 9) binIdx = 9; // 100 → bin 9
      if (binIdx < 0) binIdx = 0;
      scoreDistribution[binIdx]++;
    }

    // Reason counts (skip empty)
    if (reason) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    // Action counts (skip empty)
    if (action) {
      actionCounts[action] = (actionCounts[action] || 0) + 1;
    }
  }

  // ─── Sort reasons + actions ───
  const matchReasons = Object.keys(reasonCounts)
    .map(function (r) {
      return { reason: r, count: reasonCounts[r] };
    })
    .sort(function (a, b) {
      return b.count - a.count;
    })
    .slice(0, 15); // top 15

  const matchActions = Object.keys(actionCounts)
    .map(function (a) {
      return { action: a, count: actionCounts[a] };
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });

  const elapsedMs = Date.now() - startTime;
  logInfo('WebApp', 'getMatchEngineMetrics: ' + total + ' rows analyzed in ' + elapsedMs + 'ms');

  return {
    summary: {
      total: total,
      autoMatchedCount: autoMatchedCount,
      autoMatchRate: total > 0 ? Math.round((autoMatchedCount / total) * 1000) / 10 : 0,
      avgScore: withScoreCount > 0 ? Math.round((sumScore / withScoreCount) * 10) / 10 : 0,
      maxScore: maxScore,
      minScore: minScore === 101 ? 0 : minScore,
      withScoreCount: withScoreCount
    },
    statusCounts: statusCounts,
    scoreDistribution: scoreDistribution,
    scoreBins: ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100'],
    matchReasons: matchReasons,
    matchActions: matchActions,
    elapsedMs: elapsedMs
  };
}

/**
 * getSourcePage — Phase 2.4: ดึงรายการจาก SOURCE sheet (SCGนครหลวงJWDภูมิภาค)
 *   แสดงข้อมูลดิบจาก SCG API + SYNC_STATUS ว่าประมวลผลแล้วหรือยัง
 *
 * @param {number} offset - 0-based (หลัง header)
 * @param {number} limit - rows per page (default 50, max 200)
 * @param {Object} filter - { syncStatus: 'SUCCESS' | 'PENDING' | 'ERROR' | 'all' }
 * @return {Object} { rows, total, offset, limit, filter, syncStatusCounts, elapsedMs }
 */
function getSourcePage(offset, limit, filter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.SOURCE);

  if (!sheet) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      syncStatusCounts: {},
      elapsedMs: 0,
      error: 'ไม่พบ sheet SOURCE'
    };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      syncStatusCounts: {},
      elapsedMs: 0
    };
  }

  // อ่านข้อมูลทั้งหมด batch — sheet SOURCE มี 39 columns
  const lastCol = Math.max(SRC_IDX.DRIVER_VERIFIED_ADDR + 1, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // คำนวณ sync status — bucket เป็น SUCCESS / PENDING / ERROR / EMPTY
  const bucketSyncStatus_ = function (rawStatus) {
    const s = String(rawStatus || '')
      .trim()
      .toUpperCase();
    if (s === SCG_CONFIG.SYNC_DONE_VALUE) return 'SUCCESS';
    if (s === '') return 'EMPTY';
    if (s.indexOf('ERROR') !== -1 || s.indexOf('FAIL') !== -1) return 'ERROR';
    return 'PENDING';
  };

  // นับ sync status ทั้งหมด
  const syncStatusCounts = { SUCCESS: 0, PENDING: 0, ERROR: 0, EMPTY: 0 };
  data.forEach(function (row) {
    const bucket = bucketSyncStatus_(row[SRC_IDX.SYNC_STATUS]);
    syncStatusCounts[bucket] = (syncStatusCounts[bucket] || 0) + 1;
  });

  // Filter
  const filterObj = filter || {};
  const wantSync = (filterObj.syncStatus || 'all').toUpperCase();
  let filtered = data;
  if (wantSync !== 'ALL' && wantSync !== '') {
    filtered = data.filter(function (row) {
      return bucketSyncStatus_(row[SRC_IDX.SYNC_STATUS]) === wantSync;
    });
  }

  // Pagination
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const pageRows = filtered.slice(safeOffset, safeOffset + safeLimit);

  // แปลง rows เป็น objects (เลือก field ที่ frontend ใช้)
  const rows = pageRows.map(function (row, idx) {
    return {
      _sheetRow: safeOffset + idx + 2,
      rowId: Number(row[SRC_IDX.ROW_ID] || 0),
      sourceId: String(row[SRC_IDX.SOURCE_ID] || ''),
      deliveryDate:
        row[SRC_IDX.DELIVERY_DATE] instanceof Date
          ? row[SRC_IDX.DELIVERY_DATE].toISOString()
          : String(row[SRC_IDX.DELIVERY_DATE] || ''),
      deliveryTime: String(row[SRC_IDX.DELIVERY_TIME] || ''),
      driverName: String(row[SRC_IDX.DRIVER_NAME] || ''),
      truckLicense: String(row[SRC_IDX.TRUCK_LICENSE] || ''),
      shipmentNo: String(row[SRC_IDX.SHIPMENT_NO] || ''),
      invoiceNo: String(row[SRC_IDX.INVOICE_NO] || ''),
      customerCode: String(row[SRC_IDX.CUSTOMER_CODE] || ''),
      soldToName: String(row[SRC_IDX.SOLD_TO_NAME] || ''),
      rawPersonName: String(row[SRC_IDX.RAW_PERSON_NAME] || ''),
      lat: Number(row[SRC_IDX.LAT] || 0),
      lng: Number(row[SRC_IDX.LNG] || 0),
      warehouse: String(row[SRC_IDX.WAREHOUSE] || ''),
      rawAddress: String(row[SRC_IDX.RAW_ADDRESS] || ''),
      resolvedAddr: String(row[SRC_IDX.RESOLVED_ADDR] || ''),
      remark: String(row[SRC_IDX.REMARK] || ''),
      month: String(row[SRC_IDX.MONTH] || ''),
      distFromWh: Number(row[SRC_IDX.DIST_FROM_WH] || 0),
      syncStatus: String(row[SRC_IDX.SYNC_STATUS] || ''),
      syncStatusBucket: bucketSyncStatus_(row[SRC_IDX.SYNC_STATUS]),
      driverVerifiedName: String(row[SRC_IDX.DRIVER_VERIFIED_NAME] || ''),
      driverVerifiedAddr: String(row[SRC_IDX.DRIVER_VERIFIED_ADDR] || ''),
      qcResult: String(row[SRC_IDX.QC_RESULT] || ''),
      qcIssue: String(row[SRC_IDX.QC_ISSUE] || '')
    };
  });

  const elapsedMs = Date.now() - startTime;
  logInfo(
    'WebApp',
    'getSourcePage: sync=' +
      (filterObj.syncStatus || 'all') +
      ' offset=' +
      safeOffset +
      ' limit=' +
      safeLimit +
      ' → ' +
      rows.length +
      '/' +
      filtered.length +
      ' rows in ' +
      elapsedMs +
      'ms'
  );

  return {
    rows: rows,
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    filter: filterObj,
    syncStatusCounts: syncStatusCounts,
    elapsedMs: elapsedMs
  };
}

// ============================================================
// SECTION 6: Search Locations — Phase 2 (Search by name/address/phone)
// ============================================================

/**
 * searchLocations — ค้นหาพิกัดจากชื่อ/ที่อยู่/เบอร์โทร
 *   ค้นหาใน M_PERSON (canonical_name, phone)
 *   ค้นหาใน M_PLACE (canonical_name, sub_district, district, province, postcode)
 *   ค้นหาใน M_ALIAS (variant_name) → map กลับไป person/place
 *   รวมผลลัพธ์ + ดึงพิกัดจาก M_DESTINATION
 *
 * @param {string} query - คำค้นหา (ชื่อ/ที่อยู่/เบอร์โทร/รหัสไปรษณีย์)
 * @param {number} limit - จำนวนผลลัพธ์สูงสุด (default 20)
 * @return {Object} { results, total, query, elapsedMs }
 */
function searchLocations(query, limit) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const maxResults = limit || 20;
  const rawQuery = String(query || '').trim();

  if (rawQuery.length < 2) {
    return {
      results: [],
      total: 0,
      query: rawQuery,
      elapsedMs: 0,
      message: 'คำค้นหาสั้นเกินไป (อย่างน้อย 2 ตัวอักษร)'
    };
  }

  const normQuery = rawQuery.toLowerCase().replace(/\s+/g, '');
  const isPhoneQuery = /^\d{6,}$/.test(normQuery.replace(/[-\s]/g, ''));
  const isPostcodeQuery = /^\d{5}$/.test(normQuery);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // โหลดข้อมูลจาก 4 sheets แบบ batch
    const personSheet = ss.getSheetByName(SHEET.M_PERSON);
    const placeSheet = ss.getSheetByName(SHEET.M_PLACE);
    const aliasSheet = ss.getSheetByName(SHEET.M_ALIAS);
    const destSheet = ss.getSheetByName(SHEET.M_DESTINATION);

    const persons =
      personSheet && personSheet.getLastRow() > 1
        ? personSheet.getRange(2, 1, personSheet.getLastRow() - 1, SCHEMA[SHEET.M_PERSON].length).getValues()
        : [];
    const places =
      placeSheet && placeSheet.getLastRow() > 1
        ? placeSheet.getRange(2, 1, placeSheet.getLastRow() - 1, SCHEMA[SHEET.M_PLACE].length).getValues()
        : [];
    const aliases =
      aliasSheet && aliasSheet.getLastRow() > 1
        ? aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, SCHEMA[SHEET.M_ALIAS].length).getValues()
        : [];
    const dests =
      destSheet && destSheet.getLastRow() > 1
        ? destSheet.getRange(2, 1, destSheet.getLastRow() - 1, SCHEMA[SHEET.M_DESTINATION].length).getValues()
        : [];

    // สร้าง index maps
    const personMap = buildPersonMap_(persons);
    const placeMap = buildPlaceMap_(places);
    const destByPerson = buildDestIndexByPerson_(dests);
    const destByPlace = buildDestIndexByPlace_(dests);

    // ค้นหา
    const matchedPersonIds = new Set();
    const matchedPlaceIds = new Set();

    // 1. ค้นจาก M_PERSON
    persons.forEach(function (row) {
      const name = String(row[PERSON_IDX.CANONICAL] || '').toLowerCase();
      const phone = String(row[PERSON_IDX.PHONE] || '')
        .toLowerCase()
        .replace(/[-\s]/g, '');
      const status = String(row[PERSON_IDX.STATUS] || '');
      if (status === APP_CONST.STATUS_ARCHIVED || status === APP_CONST.STATUS_MERGED) return;

      if (name.includes(normQuery) || (isPhoneQuery && phone.includes(normQuery.replace(/[-\s]/g, '')))) {
        matchedPersonIds.add(String(row[PERSON_IDX.PERSON_ID]));
      }
    });

    // 2. ค้นจาก M_PLACE
    places.forEach(function (row) {
      const name = String(row[PLACE_IDX.CANONICAL] || '').toLowerCase();
      const subDistrict = String(row[PLACE_IDX.SUB_DISTRICT] || '').toLowerCase();
      const district = String(row[PLACE_IDX.DISTRICT] || '').toLowerCase();
      const province = String(row[PLACE_IDX.PROVINCE] || '').toLowerCase();
      const postcode = String(row[PLACE_IDX.POSTCODE] || '');
      const status = String(row[PLACE_IDX.STATUS] || '');
      if (status === APP_CONST.STATUS_ARCHIVED || status === APP_CONST.STATUS_MERGED) return;

      const haystack = name + ' ' + subDistrict + ' ' + district + ' ' + province;
      if (haystack.includes(normQuery) || (isPostcodeQuery && postcode === normQuery)) {
        matchedPlaceIds.add(String(row[PLACE_IDX.PLACE_ID]));
      }
    });

    // 3. ค้นจาก M_ALIAS → map กลับไป person/place
    aliases.forEach(function (row) {
      const variant = String(row[ALIAS_IDX.VARIANT_NAME] || '').toLowerCase();
      const masterUuid = String(row[ALIAS_IDX.MASTER_UUID] || '');
      const entityType = String(row[ALIAS_IDX.ENTITY_TYPE] || '');
      const active = String(row[ALIAS_IDX.ACTIVE_FLAG] || '');
      if (active !== 'true' && active !== 'TRUE') return;

      if (variant.includes(normQuery)) {
        if (entityType === 'PERSON') {
          const personId = findPersonIdByUuid_(persons, masterUuid);
          if (personId) matchedPersonIds.add(personId);
        } else if (entityType === 'PLACE') {
          const placeId = findPlaceIdByUuid_(places, masterUuid);
          if (placeId) matchedPlaceIds.add(placeId);
        }
      }
    });

    // 4. สร้างผลลัพธ์
    const results = [];
    matchedPersonIds.forEach(function (personId) {
      const person = personMap[personId];
      if (!person) return;
      const dest = destByPerson[personId];
      if (dest && dest.lat && dest.lng) {
        results.push({
          name: person.canonicalName,
          phone: person.phone,
          address: '',
          lat: dest.lat,
          lng: dest.lng,
          destId: dest.destId,
          source: 'PERSON',
          usageCount: dest.usageCount || person.usageCount || 0
        });
      }
    });

    matchedPlaceIds.forEach(function (placeId) {
      const place = placeMap[placeId];
      if (!place) return;
      const dest = destByPlace[placeId];
      if (dest && dest.lat && dest.lng) {
        results.push({
          name: place.canonicalName,
          phone: '',
          address: buildAddressStr_(place),
          lat: dest.lat,
          lng: dest.lng,
          destId: dest.destId,
          source: 'PLACE',
          usageCount: dest.usageCount || place.usageCount || 0
        });
      }
    });

    // เรียงตาม usageCount  descending + จำกัดจำนวน
    results.sort(function (a, b) {
      return (b.usageCount || 0) - (a.usageCount || 0);
    });
    const trimmed = results.slice(0, maxResults);

    const elapsedMs = Date.now() - startTime;
    logInfo('WebApp', 'searchLocations("' + rawQuery + '") → ' + trimmed.length + ' results in ' + elapsedMs + 'ms');

    return {
      results: trimmed,
      total: results.length,
      query: rawQuery,
      elapsedMs: elapsedMs
    };
  } catch (err) {
    logError('WebApp', 'searchLocations ล้มเหลว: ' + err.message, err);
    throw err;
  }
}

// === Search Helpers ===

function buildPersonMap_(persons) {
  const map = {};
  persons.forEach(function (row) {
    const id = String(row[PERSON_IDX.PERSON_ID] || '');
    if (id) {
      map[id] = {
        personId: id,
        canonicalName: String(row[PERSON_IDX.CANONICAL] || ''),
        phone: String(row[PERSON_IDX.PHONE] || ''),
        usageCount: Number(row[PERSON_IDX.USAGE_COUNT] || 0)
      };
    }
  });
  return map;
}

function buildPlaceMap_(places) {
  const map = {};
  places.forEach(function (row) {
    const id = String(row[PLACE_IDX.PLACE_ID] || '');
    if (id) {
      map[id] = {
        placeId: id,
        canonicalName: String(row[PLACE_IDX.CANONICAL] || ''),
        subDistrict: String(row[PLACE_IDX.SUB_DISTRICT] || ''),
        district: String(row[PLACE_IDX.DISTRICT] || ''),
        province: String(row[PLACE_IDX.PROVINCE] || ''),
        postcode: String(row[PLACE_IDX.POSTCODE] || ''),
        usageCount: Number(row[PLACE_IDX.USAGE_COUNT] || 0)
      };
    }
  });
  return map;
}

function buildDestIndexByPerson_(dests) {
  const map = {};
  dests.forEach(function (row) {
    const personId = String(row[DEST_IDX.PERSON_ID] || '');
    const status = String(row[DEST_IDX.STATUS] || '');
    if (personId && status !== APP_CONST.STATUS_ARCHIVED && status !== APP_CONST.STATUS_MERGED) {
      const lat = Number(row[DEST_IDX.LAT] || 0);
      const lng = Number(row[DEST_IDX.LNG] || 0);
      if (lat && lng && personId) {
        map[personId] = {
          destId: String(row[DEST_IDX.DEST_ID] || ''),
          lat: lat,
          lng: lng,
          usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0)
        };
      }
    }
  });
  return map;
}

function buildDestIndexByPlace_(dests) {
  const map = {};
  dests.forEach(function (row) {
    const placeId = String(row[DEST_IDX.PLACE_ID] || '');
    const status = String(row[DEST_IDX.STATUS] || '');
    if (placeId && status !== APP_CONST.STATUS_ARCHIVED && status !== APP_CONST.STATUS_MERGED) {
      const lat = Number(row[DEST_IDX.LAT] || 0);
      const lng = Number(row[DEST_IDX.LNG] || 0);
      if (lat && lng) {
        map[placeId] = {
          destId: String(row[DEST_IDX.DEST_ID] || ''),
          lat: lat,
          lng: lng,
          usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0)
        };
      }
    }
  });
  return map;
}

function findPersonIdByUuid_(persons, uuid) {
  for (let i = 0; i < persons.length; i++) {
    if (String(persons[i][PERSON_IDX.MASTER_UUID] || '') === uuid) {
      return String(persons[i][PERSON_IDX.PERSON_ID] || '');
    }
  }
  return '';
}

function findPlaceIdByUuid_(places, uuid) {
  for (let i = 0; i < places.length; i++) {
    if (String(places[i][PLACE_IDX.MASTER_UUID] || '') === uuid) {
      return String(places[i][PLACE_IDX.PLACE_ID] || '');
    }
  }
  return '';
}

function buildAddressStr_(place) {
  const parts = [];
  if (place.canonicalName) parts.push(place.canonicalName);
  if (place.subDistrict) parts.push(place.subDistrict);
  if (place.district) parts.push(place.district);
  if (place.province) parts.push(place.province);
  if (place.postcode) parts.push(place.postcode);
  return parts.join(' ');
}

// ============================================================
// SECTION 11: V6.0.004 — Map Analytics + Live Feed
// ============================================================

/**
 * getMapAnalyticsData — [V6.0.004] Get delivery data for map visualization
 * @param {number} [days=30] - number of days to look back
 * @param {string} [filterStatus=''] - filter by match status
 * @return {Array} array of { lat, lng, count, matchStatus, personId, destId }
 */
function getMapAnalyticsData(days, filterStatus) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  const lookbackDays = days || 30;
  const statusFilter = filterStatus || '';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const cols = Math.min(SCHEMA[SHEET.FACT_DELIVERY].length, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols).getValues();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const points = [];
  const seen = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const deliveryDate = row[FACT_IDX.DELIVERY_DATE];
    if (deliveryDate && new Date(deliveryDate) < cutoff) continue;

    const status = String(row[FACT_IDX.MATCH_STATUS] || '');
    if (statusFilter && status !== statusFilter) continue;

    const lat = Number(row[FACT_IDX.RESOLVED_LAT] || 0);
    const lng = Number(row[FACT_IDX.RESOLVED_LNG] || 0);
    if (lat === 0 || lng === 0) continue;

    const key = Math.round(lat * 1000) / 1000 + ',' + Math.round(lng * 1000) / 1000;
    if (seen[key]) {
      seen[key].count++;
    } else {
      seen[key] = {
        lat: lat,
        lng: lng,
        count: 1,
        matchStatus: status,
        personId: String(row[FACT_IDX.PERSON_ID] || ''),
        destId: String(row[FACT_IDX.DEST_ID] || '')
      };
      points.push(seen[key]);
    }
  }

  return points.slice(0, 5000);
}

/**
 * getMatchEngineLiveStatus — [V6.0.004] Get current MatchEngine progress
 * @return {Object} { isRunning, currentRow, totalRows, recentMatches, errorCount, startedAt }
 */
function getMatchEngineLiveStatus() {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  const props = PropertiesService.getScriptProperties();
  return {
    isRunning: props.getProperty('MATCH_ENGINE_RUNNING') === 'true',
    currentRow: Number(props.getProperty('MATCH_ENGINE_CURRENT_ROW') || 0),
    totalRows: Number(props.getProperty('MATCH_ENGINE_TOTAL_ROWS') || 0),
    startedAt: props.getProperty('MATCH_ENGINE_STARTED_AT'),
    lastMatchAt: props.getProperty('MATCH_ENGINE_LAST_MATCH'),
    errorCount: Number(props.getProperty('MATCH_ENGINE_ERRORS') || 0),
    recentMatches: JSON.parse(props.getProperty('MATCH_ENGINE_RECENT') || '[]')
  };
}
