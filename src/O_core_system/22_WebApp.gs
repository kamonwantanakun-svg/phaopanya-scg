/**
 * VERSION: 5.5.022
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
 *     - getFactDeliveryPage() (stub) — Phase 2 (TODO)
 *     - getQReviewPage() (stub)      — Phase 2 (TODO)
 *     - getMatchEngineMetrics() (stub) — Phase 3 (TODO)
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

    // ส่งข้อมูลเริ่มต้นไปที่ template (SSR — Server-Side Rendering)
    template.appVersion = APP_VERSION;
    template.appName = APP_NAME;
    template.currentUser = getCurrentDashboardUser_();
    template.initialData = getDashboardData();
    template.deployedAt = new Date().toISOString();

    return template.evaluate()
      .setTitle('LMDS V5.5 Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setFaviconUrl('https://www.gstatic.com/images/branding/product/1x/sheets_64dp.png')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (err) {
    logError('WebApp', 'doGet ล้มเหลว: ' + err.message, err);
    return HtmlService.createHtmlOutput(
      '<h1>⚠️ เกิดข้อผิดพลาด</h1>' +
      '<p>ไม่สามารถโหลด LMDS Dashboard ได้</p>' +
      '<p>รายละเอียด: ' + (err.message || 'Unknown error') + '</p>' +
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
    const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
    if (!email) {
      logWarn('WebApp', '[Auth] ไม่สามารถอ่าน Email ผู้ใช้ได้ — ปฏิเสธการเข้าถึง');
      return false;
    }

    // อ่าน whitelist สำหรับ Dashboard (แยกจาก LMDS_ADMINS)
    const dashboardUsersStr = String(
      PropertiesService.getScriptProperties().getProperty('DASHBOARD_USERS') || ''
    ).trim();

    if (dashboardUsersStr) {
      const users = dashboardUsersStr.split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
      return users.includes(email);
    }

    // Fallback: ถ้า DASHBOARD_USERS ไม่ได้ตั้ง → ใช้ LMDS_ADMINS
    const adminsStr = String(
      PropertiesService.getScriptProperties().getProperty('LMDS_ADMINS') || ''
    ).trim();

    if (adminsStr) {
      const admins = adminsStr.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
      return admins.includes(email);
    }

    // Last resort: Script Owner เท่านั้น
    const ownerEmail = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    if (email === ownerEmail) {
      logWarn('WebApp', '[Auth] DASHBOARD_USERS และ LMDS_ADMINS ยังไม่ได้ตั้ง — Script Owner ผ่าน');
      return true;
    }

    logWarn('WebApp', '[Auth] ปฏิเสธการเข้าถึง: ' + maskEmailSafe_(email));
    return false;

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
  const email = String(Session.getActiveUser().getEmail() || '').trim();
  const ownerEmail = String(Session.getEffectiveUser().getEmail() || '').trim();
  let displayName = 'User';

  try {
    const userObj = Session.getActiveUser().getUser();
    if (userObj && typeof userObj.getDisplayName === 'function') {
      displayName = userObj.getDisplayName() || 'User';
    }
  } catch (e) {
    // บาง context ไม่สามารถอ่าน User object ได้ (เช่น Web App context บางกรณี)
    logWarn('WebApp', 'Cannot read display name from User object: ' + e.message);
  }

  return {
    authorized: true, // ถ้าเรียกฟังก์ชันนี้ได้ = ผ่าน auth แล้ว
    email: email,
    name: displayName,
    isOwner: email.toLowerCase() === ownerEmail.toLowerCase(),
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
    source: sourceSheet !== null,
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
    matchStatusCounts: {},
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

  const elapsedMs = Date.now() - startTime;
  logInfo('WebApp', 'getDashboardData served — fact=' + stats.factDeliveryTotal +
    ', review=' + stats.reviewPending + ', source=' + stats.sourceSheetTotal +
    ', elapsed=' + elapsedMs + 'ms');

  return {
    stats: stats,
    topIssues: topIssues,
    sheetsExist: sheetsExist,
    lastUpdated: new Date().toISOString(),
    appVersion: APP_VERSION,
    elapsedMs: elapsedMs,
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
  stats.autoMatchRate = stats.factDeliveryTotal > 0
    ? Math.round((autoMatchCount / stats.factDeliveryTotal) * 1000) / 10
    : 0;
  stats.todayDeliveries = todayCount;
}

/**
 * isAutoMatchStatus_ — ตรวจว่า status เป็น auto match หรือไม่
 * @param {string} status
 * @return {boolean}
 * @private
 */
function isAutoMatchStatus_(status) {
  return status === APP_CONST.MATCH_FULL ||
         status === APP_CONST.MATCH_GEO ||
         status === APP_CONST.MATCH_FUZZY;
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
    const isPending = status === 'PENDING' || status === '' || status === null || status === undefined;
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
    user: getCurrentDashboardUser_().email,
  };
}

// ============================================================
// SECTION 5: Phase 2+ Stub Functions (forward declarations)
// ============================================================

/**
 * getFactDeliveryPage — Phase 2 (TODO)
 *   คืนข้อมูล FACT_DELIVERY แบบ pagination + filter
 *
 * @param {number} offset - แถวเริ่มต้น (0-based, หลัง header)
 * @param {number} limit - จำนวนแถวต่อหน้า (default 50)
 * @param {Object} filter - { status, dateFrom, dateTo, searchText }
 * @return {Object} { rows, total, offset, limit }
 */
function getFactDeliveryPage(offset, limit, filter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  // TODO: Phase 2 implementation
  return {
    rows: [],
    total: 0,
    offset: offset || 0,
    limit: limit || 50,
    filter: filter || {},
    message: 'Phase 2 — coming soon',
  };
}

/**
 * getQReviewPage — Phase 2 (TODO)
 */
function getQReviewPage(offset, limit, statusFilter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  // TODO: Phase 2 implementation
  return {
    rows: [],
    total: 0,
    offset: offset || 0,
    limit: limit || 50,
    statusFilter: statusFilter || 'PENDING',
    message: 'Phase 2 — coming soon',
  };
}

/**
 * getMatchEngineMetrics — Phase 3 (TODO)
 */
function getMatchEngineMetrics() {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  // TODO: Phase 3 implementation
  return {
    scoreDistribution: [],
    matchReasons: [],
    message: 'Phase 3 — coming soon',
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
    return { results: [], total: 0, query: rawQuery, elapsedMs: 0, message: 'คำค้นหาสั้นเกินไป (อย่างน้อย 2 ตัวอักษร)' };
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

    const persons = personSheet && personSheet.getLastRow() > 1
      ? personSheet.getRange(2, 1, personSheet.getLastRow() - 1, SCHEMA[SHEET.M_PERSON].length).getValues()
      : [];
    const places = placeSheet && placeSheet.getLastRow() > 1
      ? placeSheet.getRange(2, 1, placeSheet.getLastRow() - 1, SCHEMA[SHEET.M_PLACE].length).getValues()
      : [];
    const aliases = aliasSheet && aliasSheet.getLastRow() > 1
      ? aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, SCHEMA[SHEET.M_ALIAS].length).getValues()
      : [];
    const dests = destSheet && destSheet.getLastRow() > 1
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
    persons.forEach(function(row) {
      const name = String(row[PERSON_IDX.CANONICAL] || '').toLowerCase();
      const phone = String(row[PERSON_IDX.PHONE] || '').toLowerCase().replace(/[-\s]/g, '');
      const status = String(row[PERSON_IDX.STATUS] || '');
      if (status === APP_CONST.STATUS_ARCHIVED || status === APP_CONST.STATUS_MERGED) return;

      if (name.includes(normQuery) || (isPhoneQuery && phone.includes(normQuery.replace(/[-\s]/g, '')))) {
        matchedPersonIds.add(String(row[PERSON_IDX.PERSON_ID]));
      }
    });

    // 2. ค้นจาก M_PLACE
    places.forEach(function(row) {
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
    aliases.forEach(function(row) {
      const variant = String(row[ALIAS_IDX.VARIANT] || '').toLowerCase();
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
    matchedPersonIds.forEach(function(personId) {
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
          usageCount: dest.usageCount || person.usageCount || 0,
        });
      }
    });

    matchedPlaceIds.forEach(function(placeId) {
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
          usageCount: dest.usageCount || place.usageCount || 0,
        });
      }
    });

    // เรียงตาม usageCount  descending + จำกัดจำนวน
    results.sort(function(a, b) { return (b.usageCount || 0) - (a.usageCount || 0); });
    const trimmed = results.slice(0, maxResults);

    const elapsedMs = Date.now() - startTime;
    logInfo('WebApp', 'searchLocations("' + rawQuery + '") → ' + trimmed.length + ' results in ' + elapsedMs + 'ms');

    return {
      results: trimmed,
      total: results.length,
      query: rawQuery,
      elapsedMs: elapsedMs,
    };
  } catch (err) {
    logError('WebApp', 'searchLocations ล้มเหลว: ' + err.message, err);
    throw err;
  }
}

// === Search Helpers ===

function buildPersonMap_(persons) {
  const map = {};
  persons.forEach(function(row) {
    const id = String(row[PERSON_IDX.PERSON_ID] || '');
    if (id) {
      map[id] = {
        personId: id,
        canonicalName: String(row[PERSON_IDX.CANONICAL] || ''),
        phone: String(row[PERSON_IDX.PHONE] || ''),
        usageCount: Number(row[PERSON_IDX.USAGE_COUNT] || 0),
      };
    }
  });
  return map;
}

function buildPlaceMap_(places) {
  const map = {};
  places.forEach(function(row) {
    const id = String(row[PLACE_IDX.PLACE_ID] || '');
    if (id) {
      map[id] = {
        placeId: id,
        canonicalName: String(row[PLACE_IDX.CANONICAL] || ''),
        subDistrict: String(row[PLACE_IDX.SUB_DISTRICT] || ''),
        district: String(row[PLACE_IDX.DISTRICT] || ''),
        province: String(row[PLACE_IDX.PROVINCE] || ''),
        postcode: String(row[PLACE_IDX.POSTCODE] || ''),
        usageCount: Number(row[PLACE_IDX.USAGE_COUNT] || 0),
      };
    }
  });
  return map;
}

function buildDestIndexByPerson_(dests) {
  const map = {};
  dests.forEach(function(row) {
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
          usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0),
        };
      }
    }
  });
  return map;
}

function buildDestIndexByPlace_(dests) {
  const map = {};
  dests.forEach(function(row) {
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
          usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0),
        };
      }
    }
  });
  return map;
}

function findPersonIdByUuid_(persons, uuid) {
  for (var i = 0; i < persons.length; i++) {
    if (String(persons[i][PERSON_IDX.MASTER_UUID] || '') === uuid) {
      return String(persons[i][PERSON_IDX.PERSON_ID] || '');
    }
  }
  return '';
}

function findPlaceIdByUuid_(places, uuid) {
  for (var i = 0; i < places.length; i++) {
    if (String(places[i][PLACE_IDX.MASTER_UUID] || '') === uuid) {
      return String(places[i][PLACE_IDX.PLACE_ID] || '');
    }
  }
  return '';
}

function buildAddressStr_(place) {
  var parts = [];
  if (place.canonicalName) parts.push(place.canonicalName);
  if (place.subDistrict) parts.push(place.subDistrict);
  if (place.district) parts.push(place.district);
  if (place.province) parts.push(place.province);
  if (place.postcode) parts.push(place.postcode);
  return parts.join(' ');
}
