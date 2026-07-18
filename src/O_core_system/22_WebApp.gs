/**
 * VERSION: 6.0.069
 * FILE: 22_WebApp.gs
 * LMDS V6.0 — Web App Server (Dashboard)
 * ===================================================
 * PURPOSE:
 *   ให้บริการ Web App สำหรับดูข้อมูล LMDS แบบ real-time
 *   ใช้ HtmlService + google.script.run pattern
 *   เป็นจุดเชื่อมระหว่าง Frontend (HTML/JS) กับ Backend (Google Sheets)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 14_Utils.gs, 03_SetupSheets.gs (core)
 *     - 27_RbacService.gs       (RBAC for dashboard access)
 *     - 22b_WebAppViews.gs      (view data providers)
 *     - 22c_WebAppActions.gs    (action dispatchers)
 *     - 28_WebAppActions.gs     (mobile menu actions)
 *   CALLS: (Invokes)
 *     - isAuthorizedDashboardUser_()             → 27_RbacService.gs
 *     - getDashboardData() / getFactDeliveryData() / getQReviewData() → 22b_WebAppViews.gs
 *     - runWebAppAction()                        → 28_WebAppActions.gs
 *     - logInfo()                                → 03_SetupSheets.gs
 *   EXPORTS TO:
 *     - Frontend (doGet entry; google.script.run calls from HTML/JS views)
 *   SHEETS ACCESSED:
 *     - (none directly — delegates to 22b/22c/28)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 3 — Web frontend server (dashboard, views, actions, mobile menu)
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
      return (
        HtmlService.createHtmlOutputFromFile('Unauthorized')
          .setTitle('LMDS — ไม่มีสิทธิ์เข้าถึง')
          .addMetaTag('viewport', 'width=device-width, initial-scale=1')
          // [V6.0.054] ALLOWALL required for GAS sandbox — see SECURITY.md §1 for risk + mitigations
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      );
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

    return (
      template
        .evaluate()
        .setTitle('LMDS V6.0 Dashboard')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        .setFaviconUrl('https://www.gstatic.com/images/branding/product/1x/sheets_64dp.png')
        // [V6.0.054] ALLOWALL required for GAS sandbox — see SECURITY.md §1 for risk + mitigations
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    );
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

    // [V6.0.067] PII masking — mask email + downgrade to logDebug (Reviewer #1+#2 Round 3)
    logDebug('WebApp', '[Auth DEBUG] effectiveUser="' + maskEmailSafe_(email) + '"');

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

    // [V6.0.067] Security hardening — deny-by-default instead of fail-open (Reviewer #2 TD-006)
    //   เดิม: return true (fail-open) → ถ้าไม่มี whitelist ใครก็เข้าได้
    //   ใหม่: return false (deny-by-default) → ถ้าไม่มี whitelist ปฏิเสธทุกคน
    //   Admin ต้องตั้ง DASHBOARD_USERS หรือ LMDS_ADMINS ให้ชัดเจน
    logWarn('WebApp', '[Auth] No whitelist configured — access DENIED (deny-by-default)');
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

  // [V6.0.067] PII masking — mask email + downgrade to logDebug (Reviewer #1+#2 Round 3)
  logDebug(
    'WebApp',
    '[Auth DEBUG] getCurrentDashboardUser_: email="' + maskEmailSafe_(email) + '", name="' + displayName + '"'
  );

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

// ============================================================
// SECTION 4: Health Check (used by frontend to verify API connectivity)
// ============================================================

// ============================================================
// SECTION 5: Phase 2+ Page Functions (FACT_DELIVERY, Q_REVIEW, Match Engine)
// ============================================================

// ============================================================
// SECTION 6: Search Locations — Phase 2 (Search by name/address/phone)
// ============================================================

// === Search Helpers ===

// ============================================================
// SECTION 11: V6.0.004 — Map Analytics + Live Feed
// ============================================================

// ============================================================
// [V6.0.021] Mobile Actions — see 28_WebAppActions.gs
//   getWebAppActionRegistry() and runWebAppAction(actionId, params)
//   are defined in 28_WebAppActions.gs and available globally
//   via google.script.run (no duplicate declarations here)
// ============================================================
