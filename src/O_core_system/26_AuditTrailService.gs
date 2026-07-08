/**
 * VERSION: 6.0.007
 * FILE: 26_AuditTrailService.gs
 * LMDS V6.0 — Audit Trail (Critical-Only Scope)
 * ===================================================
 * PURPOSE:
 *   Record all CREATE/UPDATE/DELETE/MERGE operations on M_ALIAS + Q_REVIEW
 *   into SYS_AUDIT_TRAIL sheet for change tracking + compliance.
 *
 *   Scope (V6.0.007 — Critical Only):
 *     - M_ALIAS: createGlobalAlias, cleanupStaleCanonicalAliases_, learnAliasFromReviewDecision
 *     - Q_REVIEW: applyReviewDecision (all 4 decisions: CREATE_NEW/MERGE_TO_CANDIDATE/ESCALATE/IGNORE)
 *   Not in scope (deferred): M_PERSON, M_PLACE, M_GEO_POINT, M_DESTINATION CRUD
 *
 *   Retention: keep last 90 days in SYS_AUDIT_TRAIL; older rows auto-pruned by cleanupAuditTrail_UI()
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v6.0.007 (2026-07-08) — INITIAL: SYS_AUDIT_TRAIL sheet + logAuditTrail + 4 hook points + retention cleanup
 *     v6.0.006 (2026-07-07) — Stable (audit trail was pending)
 *     v6.0.004 (2026-07-06) — Stable (audit trail was pending)
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES:
 *     - 01_Config (SHEET, AUDIT_IDX, APP_CONST)
 *     - 02_Schema (SCHEMA.SYS_AUDIT_TRAIL)
 *     - 03_SetupSheets (logInfo, logWarn, logError, safeUiAlert_)
 *     - 14_Utils (generateShortId)
 *   CALLS:
 *     - SpreadsheetApp.getActiveSpreadsheet() — write to SYS_AUDIT_TRAIL
 *     - Session.getEffectiveUser().getEmail() — record who changed what
 *     - PropertiesService.getScriptProperties() — read retention days
 *   EXPORTS TO:
 *     - 21_AliasService.gs (createGlobalAlias → logAuditTrail)
 *     - 12_ReviewService.gs (applyReviewDecision → logAuditTrail)
 *     - 10_MatchEngine.gs (cleanupStaleCanonicalAliases_ → logAuditTrail)
 *     - 00_App.gs (cleanupAuditTrail_UI — menu entry)
 *   SHEETS ACCESSED:
 *     - SHEET.SYS_AUDIT_TRAIL (Write: append-only; Read: retention pruning)
 * ===================================================
 * ARCHITECTURE:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                26_AuditTrailService.gs                   │
 *   │           Audit Trail (V6.0.007 — Critical Only)         │
 *   ├──────────────────────────────────────────────────────────┤
 *   │                                                          │
 *   │  logAuditTrail(entityType, entityId, action, ...)        │
 *   │       │                                                  │
 *   │       ├── Validate args (entityType, entityId, action)   │
 *   │       ├── Get caller email from Session                  │
 *   │       ├── Truncate old_value/new_value to 500 chars      │
 *   │       ├── Append row to SYS_AUDIT_TRAIL (batched write)  │
 *   │       └── Failsafe: logWarn + return (never throw)       │
 *   │                                                          │
 *   │  Hook Points (4 — Critical Only):                        │
 *   │   - createGlobalAlias() in 21_AliasService.gs            │
 *   │       → action='CREATE', entity_type='ALIAS'             │
 *   │   - applyReviewDecision() in 12_ReviewService.gs         │
 *   │       → action='CREATE'/'MERGE'/'UPDATE'/'DELETE'        │
 *   │   - cleanupStaleCanonicalAliases_() in 10_MatchEngine.gs │
 *   │       → action='DELETE', entity_type='ALIAS' (batch)     │
 *   │   - learnAliasFromReviewDecision() in 12_ReviewService   │
 *   │       → action='CREATE', entity_type='ALIAS' (verified)  │
 *   │                                                          │
 *   │  cleanupAuditTrail_UI() — retention pruning              │
 *   │   - Default: keep last 90 days                           │
 *   │   - Reads AUDIT_RETENTION_DAYS script property (override)│
 *   │   - Prunes rows where changed_at < now - retention_days  │
 *   │                                                          │
 *   │  Failsafe Pattern:                                       │
 *   │   - logAuditTrail NEVER throws — wraps everything in     │
 *   │     try/catch and logs warning on failure                │
 *   │   - Reason: audit failure must NOT break the operation   │
 *   │     that triggered it (defense in depth)                 │
 *   └──────────────────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 1: AUDIT_IDX — column indices for SYS_AUDIT_TRAIL
// ============================================================

/**
 * [V6.0.007] AUDIT_IDX — SYS_AUDIT_TRAIL column indices (0-based)
 *   11 columns — must match SCHEMA.SYS_AUDIT_TRAIL in 02_Schema.gs
 *   Used by logAuditTrail() and cleanupAuditTrail_UI()
 */
const AUDIT_IDX = Object.freeze({
  AUDIT_ID: 0,
  ENTITY_TYPE: 1,
  ENTITY_ID: 2,
  ACTION: 3,
  FIELD_CHANGED: 4,
  OLD_VALUE: 5,
  NEW_VALUE: 6,
  CHANGED_BY: 7,
  CHANGED_AT: 8,
  CHANGE_REASON: 9,
  IP_ADDRESS: 10
});

/**
 * [V6.0.007] AUDIT_ACTIONS — valid action codes for SYS_AUDIT_TRAIL
 *   Keep this list tight — any other action will be rejected by logAuditTrail()
 */
const AUDIT_ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  MERGE: 'MERGE'
});

/**
 * [V6.0.007] AUDIT_ENTITY_TYPES — valid entity_type values
 *   V6.0.007 scope: ALIAS + Q_REVIEW only
 *   Future scope: PERSON + PLACE + GEO + DESTINATION + FACT
 */
const AUDIT_ENTITY_TYPES = Object.freeze({
  ALIAS: 'ALIAS',
  Q_REVIEW: 'Q_REVIEW'
  // Reserved for future scope expansion:
  // PERSON: 'PERSON',
  // PLACE: 'PLACE',
  // GEO: 'GEO',
  // DESTINATION: 'DESTINATION',
  // FACT: 'FACT'
});

/**
 * [V6.0.007] AUDIT_RETENTION_DEFAULT_DAYS — keep last 90 days by default
 *   Override with AUDIT_RETENTION_DAYS script property (numeric)
 */
const AUDIT_RETENTION_DEFAULT_DAYS = 90;

// ============================================================
// SECTION 2: logAuditTrail — main entry point
// ============================================================

/**
 * logAuditTrail — [V6.0.007] Append an audit record to SYS_AUDIT_TRAIL
 *   Failsafe: never throws — wraps everything in try/catch and logs warning on failure.
 *   Reason: audit failure must NOT break the operation that triggered it.
 *
 * @param {string} entityType - one of AUDIT_ENTITY_TYPES (ALIAS, Q_REVIEW)
 * @param {string} entityId - FK to the entity (e.g., alias_id, review_id)
 * @param {string} action - one of AUDIT_ACTIONS (CREATE, UPDATE, DELETE, MERGE)
 * @param {string} [fieldChanged] - column name(s) that changed (comma-separated); 'all' for CREATE
 * @param {string|Object} [oldValue] - previous value (JSON string or string); null for CREATE
 * @param {string|Object} [newValue] - new value (JSON string or string); null for DELETE
 * @param {string} [reason] - optional note (e.g., "Q_REVIEW merge", "stale cleanup")
 * @return {boolean} true on success, false on failure (always — never throws)
 */
function logAuditTrail(entityType, entityId, action, fieldChanged, oldValue, newValue, reason) {
  try {
    // Validate required args
    if (!entityType || !entityId || !action) {
      logWarn('AuditTrail', 'logAuditTrail: missing required arg — entityType/entityId/action');
      return false;
    }

    // Validate entityType + action against whitelists
    const validTypes = Object.values(AUDIT_ENTITY_TYPES);
    const validActions = Object.values(AUDIT_ACTIONS);
    if (validTypes.indexOf(entityType) === -1) {
      logWarn('AuditTrail', 'logAuditTrail: invalid entityType "' + entityType + '"');
      return false;
    }
    if (validActions.indexOf(action) === -1) {
      logWarn('AuditTrail', 'logAuditTrail: invalid action "' + action + '"');
      return false;
    }

    // Get SYS_AUDIT_TRAIL sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_AUDIT_TRAIL);
    if (!sheet) {
      // Sheet may not exist if setupAllSheets() hasn't been run — fail silently
      logWarn('AuditTrail', 'logAuditTrail: SYS_AUDIT_TRAIL sheet not found — skip logging');
      return false;
    }

    // Get caller email (best effort)
    let changedBy = 'system';
    try {
      const email = Session.getEffectiveUser().getEmail();
      if (email) changedBy = email;
    } catch (e) {
      // Keep 'system' default
    }

    // Truncate values to 500 chars to prevent row overflow
    const truncate_ = function (val) {
      if (val === null || val === undefined) return '';
      let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.length > 500) str = str.substring(0, 497) + '...';
      return str;
    };

    // Build the audit row (11 columns — must match AUDIT_IDX)
    const auditId = generateShortId('AU');
    const now = new Date();
    const row = [];
    row[AUDIT_IDX.AUDIT_ID] = auditId;
    row[AUDIT_IDX.ENTITY_TYPE] = entityType;
    row[AUDIT_IDX.ENTITY_ID] = String(entityId);
    row[AUDIT_IDX.ACTION] = action;
    row[AUDIT_IDX.FIELD_CHANGED] = fieldChanged || '';
    row[AUDIT_IDX.OLD_VALUE] = truncate_(oldValue);
    row[AUDIT_IDX.NEW_VALUE] = truncate_(newValue);
    row[AUDIT_IDX.CHANGED_BY] = changedBy;
    row[AUDIT_IDX.CHANGED_AT] = now;
    row[AUDIT_IDX.CHANGE_REASON] = reason || '';
    row[AUDIT_IDX.IP_ADDRESS] = ''; // Not available in GAS

    // Append to sheet (single-row append is OK for audit — typically low frequency)
    sheet.appendRow(row);

    // Logging at debug level only (avoid log spam for normal audit events)
    if (typeof logDebug === 'function') {
      logDebug(
        'AuditTrail',
        'logAuditTrail: ' +
          action +
          ' ' +
          entityType +
          ':' +
          String(entityId).substring(0, 20) +
          ' by ' +
          changedBy +
          (reason ? ' (' + reason + ')' : '')
      );
    }

    return true;
  } catch (err) {
    // CRITICAL: logAuditTrail must NEVER throw — log warning and return false
    if (typeof logWarn === 'function') {
      logWarn('AuditTrail', 'logAuditTrail failed (non-fatal): ' + err.message);
    }
    return false;
  }
}

// ============================================================
// SECTION 3: queryAuditTrail — read audit records (for reporting)
// ============================================================

/**
 * queryAuditTrail — [V6.0.007] Query audit records with optional filters
 *   Performance: O(n) scan of SYS_AUDIT_TRAIL — keep sheet small via retention pruning
 *
 * @param {Object} [filters] - optional filters
 * @param {string} [filters.entityType] - filter by entity_type
 * @param {string} [filters.entityId] - filter by entity_id
 * @param {string} [filters.action] - filter by action
 * @param {string} [filters.changedBy] - filter by changed_by email
 * @param {Date} [filters.since] - filter by changed_at >= since
 * @param {Date} [filters.until] - filter by changed_at <= until
 * @param {number} [filters.limit=500] - max records to return (default 500)
 * @return {Array<Object>} array of audit record objects
 */
function queryAuditTrail(filters) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_AUDIT_TRAIL);
    if (!sheet || sheet.getLastRow() < 2) return [];

    const f = filters || {};
    const limit = f.limit || 500;
    const data = sheet.getDataRange().getValues();
    const results = [];

    for (let i = 1; i < data.length && results.length < limit; i++) {
      const row = data[i];
      const record = {
        auditId: String(row[AUDIT_IDX.AUDIT_ID] || ''),
        entityType: String(row[AUDIT_IDX.ENTITY_TYPE] || ''),
        entityId: String(row[AUDIT_IDX.ENTITY_ID] || ''),
        action: String(row[AUDIT_IDX.ACTION] || ''),
        fieldChanged: String(row[AUDIT_IDX.FIELD_CHANGED] || ''),
        oldValue: String(row[AUDIT_IDX.OLD_VALUE] || ''),
        newValue: String(row[AUDIT_IDX.NEW_VALUE] || ''),
        changedBy: String(row[AUDIT_IDX.CHANGED_BY] || ''),
        changedAt: row[AUDIT_IDX.CHANGED_AT],
        changeReason: String(row[AUDIT_IDX.CHANGE_REASON] || ''),
        ipAddress: String(row[AUDIT_IDX.IP_ADDRESS] || '')
      };

      // Apply filters
      if (f.entityType && record.entityType !== f.entityType) continue;
      if (f.entityId && record.entityId !== f.entityId) continue;
      if (f.action && record.action !== f.action) continue;
      if (f.changedBy && record.changedBy !== f.changedBy) continue;
      if (f.since && record.changedAt && new Date(record.changedAt) < new Date(f.since)) continue;
      if (f.until && record.changedAt && new Date(record.changedAt) > new Date(f.until)) continue;

      results.push(record);
    }
    return results;
  } catch (err) {
    if (typeof logError === 'function') {
      logError('AuditTrail', 'queryAuditTrail failed: ' + err.message, err);
    }
    return [];
  }
}

// ============================================================
// SECTION 4: cleanupAuditTrail_UI — retention pruning
// ============================================================

/**
 * cleanupAuditTrail_UI — [V6.0.007] Menu wrapper to prune old audit records
 *   Default retention: 90 days (override via AUDIT_RETENTION_DAYS script property)
 *   Action: delete rows where changed_at < now - retention_days
 *
 *   Safety: shows confirmation dialog with row count before deleting.
 *   Audit: logs the cleanup action itself to SYS_LOG (not to SYS_AUDIT_TRAIL — recursion guard).
 */
function cleanupAuditTrail_UI() {
  try {
    const ui = SpreadsheetApp.getUi();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_AUDIT_TRAIL);
    if (!sheet) {
      safeUiAlert_('❌ ไม่พบชีต SYS_AUDIT_TRAIL — กรุณารัน setupAllSheets() ก่อน');
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      safeUiAlert_('ℹ️ SYS_AUDIT_TRAIL ยังว่าง — ไม่มีข้อมูลให้ prune');
      return;
    }

    // Resolve retention days
    let retentionDays = AUDIT_RETENTION_DEFAULT_DAYS;
    try {
      const propValue = PropertiesService.getScriptProperties().getProperty('AUDIT_RETENTION_DAYS');
      if (propValue) {
        const parsed = parseInt(propValue, 10);
        if (!isNaN(parsed) && parsed > 0) retentionDays = parsed;
      }
    } catch (e) {
      // keep default
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Scan for rows to delete
    const data = sheet.getDataRange().getValues();
    const rowsToDelete = []; // 1-indexed row numbers
    for (let i = 1; i < data.length; i++) {
      const changedAt = data[i][AUDIT_IDX.CHANGED_AT];
      if (changedAt && new Date(changedAt) < cutoff) {
        rowsToDelete.push(i + 1); // +1 because data[0] is header
      }
    }

    if (rowsToDelete.length === 0) {
      safeUiAlert_('✅ ไม่มีรายการที่ต้อง prune (เก่ากว่า ' + retentionDays + ' วัน)');
      return;
    }

    // Confirmation
    const confirm = ui.alert(
      '🧹 Prune Audit Trail',
      'พบ ' +
        rowsToDelete.length +
        ' รายการที่เก่ากว่า ' +
        retentionDays +
        ' วัน\n' +
        '(changed_at < ' +
        cutoff.toISOString().substring(0, 10) +
        ')\n\n' +
        'ยืนยันการลบ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    // Delete from bottom to top to preserve row numbers
    rowsToDelete.reverse();
    rowsToDelete.forEach(function (rowNum) {
      sheet.deleteRow(rowNum);
    });

    logInfo(
      'AuditTrail',
      'cleanupAuditTrail_UI: pruned ' + rowsToDelete.length + ' rows older than ' + retentionDays + ' days'
    );
    safeUiAlert_('✅ ลบ ' + rowsToDelete.length + ' รายการเรียบร้อย');
  } catch (err) {
    logError('AuditTrail', 'cleanupAuditTrail_UI failed: ' + err.message, err);
    safeUiAlert_('❌ ล้มเหลว: ' + err.message);
  }
}

// ============================================================
// SECTION 5: getAuditTrailStats — summary for dashboard
// ============================================================

/**
 * getAuditTrailStats — [V6.0.007] Return summary stats for SYS_AUDIT_TRAIL
 *   Used by WebApp dashboard to show audit activity (e.g., "24 changes today")
 *
 * @return {{ totalRows: number, last24h: number, last7d: number, byAction: Object, byEntityType: Object }}
 */
function getAuditTrailStats() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_AUDIT_TRAIL);
    if (!sheet || sheet.getLastRow() < 2) {
      return { totalRows: 0, last24h: 0, last7d: 0, byAction: {}, byEntityType: {} };
    }

    const data = sheet.getDataRange().getValues();
    const now = Date.now();
    const day24h = now - 24 * 60 * 60 * 1000;
    const day7d = now - 7 * 24 * 60 * 60 * 1000;
    const byAction = {};
    const byEntityType = {};
    let last24h = 0;
    let last7d = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const changedAt = row[AUDIT_IDX.CHANGED_AT];
      const action = String(row[AUDIT_IDX.ACTION] || '');
      const entityType = String(row[AUDIT_IDX.ENTITY_TYPE] || '');

      if (changedAt) {
        const ts = new Date(changedAt).getTime();
        if (ts >= day24h) last24h++;
        if (ts >= day7d) last7d++;
      }

      byAction[action] = (byAction[action] || 0) + 1;
      byEntityType[entityType] = (byEntityType[entityType] || 0) + 1;
    }

    return {
      totalRows: data.length - 1,
      last24h: last24h,
      last7d: last7d,
      byAction: byAction,
      byEntityType: byEntityType
    };
  } catch (err) {
    logError('AuditTrail', 'getAuditTrailStats failed: ' + err.message, err);
    return { totalRows: 0, last24h: 0, last7d: 0, byAction: {}, byEntityType: {} };
  }
}
