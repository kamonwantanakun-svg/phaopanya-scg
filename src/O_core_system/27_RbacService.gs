/**
 * VERSION: 6.0.010
 * FILE: 27_RbacService.gs
 * LMDS V6.0 — Role-Based Access Control
 * ===================================================
 * PURPOSE:
 *   3 roles: Viewer (read-only) / Reviewer (+ approve Q_REVIEW) / Admin (full)
 *   Enforce deny-by-default pattern in WebApp + menu actions (SEC-001)
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v6.0.006 (2026-07-07) — DOC SYNC (header added) + Stale trigger cleanup + Telegram HTML fix
 *     v6.0.005 (2026-07-07) — Stable (no RBAC changes)
 *     v6.0.004 (2026-07-06) — INITIAL: RBAC 3 roles + 11 permissions + 3 helper functions
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES:
 *     - 01_Config (RBAC_CONFIG — defined in this file)
 *     - 03_SetupSheets (logError, safeUiAlert_)
 *   CALLS:
 *     - PropertiesService.getScriptProperties() — read LMDS_ADMINS, ROLE_ASSIGNMENTS
 *     - Session.getEffectiveUser().getEmail() — identify caller
 *     - SpreadsheetApp.getUi() — prompt UI for setupRoleAssignments_UI
 *   EXPORTS TO:
 *     - 22_WebApp.gs (requirePermission_, hasPermission_ — guards for doGet/doPost)
 *     - 00_App.gs (setupRoleAssignments_UI — menu entry under "🔐 Security")
 *   SHEETS ACCESSED: none (RBAC config is in PropertiesService, not Sheets)
 * ===================================================
 * ARCHITECTURE:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                27_RbacService.gs                         │
 *   │           Role-Based Access Control (V6.0)               │
 *   ├──────────────────────────────────────────────────────────┤
 *   │                                                          │
 *   │  RBAC_CONFIG (frozen) ── ROLES + PERMISSIONS matrix      │
 *   │       │                                                  │
 *   │       ├── getCurrentUserRole_()                          │
 *   │       │     1. LMDS_ADMINS property → admin              │
 *   │       │     2. ROLE_ASSIGNMENTS property → matched role  │
 *   │       │     3. Default → viewer (deny-by-default)        │
 *   │       │                                                  │
 *   │       ├── hasPermission_(permission) → boolean           │
 *   │       │     Check role vs PERMISSIONS[permission] list   │
 *   │       │                                                  │
 *   │       ├── requirePermission_(permission) → throws        │
 *   │       │     Throw if hasPermission_() returns false      │
 *   │       │                                                  │
 *   │       └── setupRoleAssignments_UI()                      │
 *   │             Menu wrapper to set ROLE_ASSIGNMENTS prop    │
 *   │                                                          │
 *   │  Integration Points:                                     │
 *   │   - 22_WebApp.gs doGet/doPost → requirePermission_()     │
 *   │   - 00_App.gs menu actions → hasPermission_() guards     │
 *   │                                                          │
 *   │  Security Pattern: DENY-BY-DEFAULT                      │
 *   │   - Unknown user → viewer (read-only)                   │
 *   │   - Unknown permission key → false (deny)               │
 *   │   - Role resolution error → null → deny                 │
 *   └──────────────────────────────────────────────────────────┘
 * ===================================================
 */

const RBAC_CONFIG = Object.freeze({
  ROLES: {
    VIEWER: 'viewer',
    REVIEWER: 'reviewer',
    ADMIN: 'admin'
  },
  PERMISSIONS: {
    'view:dashboard': ['viewer', 'reviewer', 'admin'],
    'view:fact_delivery': ['viewer', 'reviewer', 'admin'],
    'view:qreview': ['viewer', 'reviewer', 'admin'],
    'view:map_analytics': ['viewer', 'reviewer', 'admin'],
    'view:source_sheet': ['reviewer', 'admin'],
    'view:live_feed': ['reviewer', 'admin'],
    'action:approve_review': ['reviewer', 'admin'],
    'action:run_pipeline': ['admin'],
    'action:edit_master': ['admin'],
    'action:config': ['admin'],
    'action:clear_cache': ['admin']
  },
  ROLE_ASSIGNMENTS_KEY: 'ROLE_ASSIGNMENTS'
});

/**
 * getCurrentUserRole_ — [V6.0.004] Resolve current user's RBAC role
 *   Resolution order:
 *     1. LMDS_ADMINS script property → admin
 *     2. ROLE_ASSIGNMENTS script property (email:role pairs) → matched role
 *     3. Default → viewer
 * @return {string|null} role slug ('viewer'|'reviewer'|'admin') or null on error
 * @private
 */
function getCurrentUserRole_() {
  try {
    const email = String(Session.getEffectiveUser().getEmail() || '')
      .trim()
      .toLowerCase();
    if (!email) return null;

    // Script Owner / explicit admin list = admin always
    try {
      if (PropertiesService.getScriptProperties().getProperty('LMDS_ADMINS')) {
        const admins = PropertiesService.getScriptProperties()
          .getProperty('LMDS_ADMINS')
          .split(',')
          .map((a) => a.trim().toLowerCase());
        if (admins.indexOf(email) !== -1) return RBAC_CONFIG.ROLES.ADMIN;
      }
    } catch (e) {
      /* ignore */
    }

    const assignments = PropertiesService.getScriptProperties().getProperty(RBAC_CONFIG.ROLE_ASSIGNMENTS_KEY) || '';
    const map = {};
    assignments.split(',').forEach(function (pair) {
      const parts = pair.split(':');
      if (parts.length === 2) {
        map[parts[0].trim().toLowerCase()] = parts[1].trim().toLowerCase();
      }
    });

    return map[email] || RBAC_CONFIG.ROLES.VIEWER; // Default: viewer
  } catch (e) {
    logError('Rbac', 'getCurrentUserRole_ failed: ' + e.message, e);
    return null;
  }
}

/**
 * hasPermission_ — [V6.0.004] Check if current user has the given permission
 * @param {string} permission - permission key (see RBAC_CONFIG.PERMISSIONS)
 * @return {boolean}
 * @private
 */
function hasPermission_(permission) {
  const role = getCurrentUserRole_();
  if (!role) return false;
  const allowedRoles = RBAC_CONFIG.PERMISSIONS[permission];
  if (!allowedRoles) return false;
  return allowedRoles.indexOf(role) !== -1;
}

/**
 * requirePermission_ — [V6.0.004] Throw if current user lacks the permission
 * @param {string} permission - permission key (see RBAC_CONFIG.PERMISSIONS)
 * @throws {Error} if user lacks permission
 * @private
 */
function requirePermission_(permission) {
  if (!hasPermission_(permission)) {
    const role = getCurrentUserRole_() || 'none';
    throw new Error('Access denied: requires "' + permission + '" (your role: ' + role + ')');
  }
}

/**
 * setupRoleAssignments_UI — [V6.0.004] Menu wrapper to set role assignments
 *   Format: email:role,email:role (roles: viewer, reviewer, admin)
 */
function setupRoleAssignments_UI() {
  try {
    const ui = SpreadsheetApp.getUi();
    const result = ui.prompt(
      '👥 ตั้งค่า Role Assignments',
      'กรอกในรูปแบบ: email:role,email:role\n\nRoles: viewer, reviewer, admin\nตัวอย่าง: user1@gmail.com:reviewer,user2@gmail.com:viewer',
      ui.ButtonSet.OK_CANCEL
    );
    if (result.getSelectedButton() !== ui.Button.OK) return;
    const input = result.getResponseText().trim();
    if (input) {
      PropertiesService.getScriptProperties().setProperty(RBAC_CONFIG.ROLE_ASSIGNMENTS_KEY, input);
      safeUiAlert_('✅ บันทึก Role Assignments สำเร็จ!\n\n' + input);
    }
  } catch (e) {
    logError('Rbac', 'setupRoleAssignments_UI failed: ' + e.message, e);
    safeUiAlert_('❌ ล้มเหลว: ' + e.message);
  }
}
