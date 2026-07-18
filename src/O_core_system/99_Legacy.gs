/**
 * VERSION: 6.0.069
 * FILE: 99_Legacy.gs
 * LMDS V6.0 — Deprecated/Legacy Functions (Compatibility Layer)
 * ===================================================
 * PURPOSE:
 *   รวบรวมฟังก์ชันที่ถูก deprecated แล้วแต่ยังเก็บไว้เพื่อ backward compatibility
 *   สำหรับ external scripts ที่อาจยังเรียกใช้งานอยู่
 *   ⚠️ ฟังก์ชันในไฟล์นี้จะถูกลบออกใน V7.0 — ควรย้ายไปใช้ API ใหม่
 *   [V6.0.069] Sunset target: V7.0.0 (Reviewer #1 TD-010 Round 3)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs (core constants/schema)
 *     - 14_Utils.gs (utility helpers used by legacy shims)
 *   CALLS: (Invokes)
 *     - logWarn()                               → 03_SetupSheets.gs (deprecation notice)
 *     - modern API replacements in 06/07/08 services (where shims forward calls)
 *   EXPORTS TO:
 *     - External legacy scripts (compatibility shims — not called by internal modules)
 *   SHEETS ACCESSED:
 *     - (none directly — shims forward to modern service APIs)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 0 — Core infrastructure (config, schema, utils, audit, RBAC, web app gateway)
 * ===================================================
 */

/* ============================================================
 * SECTION 1: Module Constants
 * [FIX SonarCloud S1192 V5.5.035] Extract repeated literals as constants
 * ============================================================ */

const LEGACY_MODULE_NAME = 'Legacy';
const TYPE_OF_FUNCTION = 'function';

/* ============================================================
 * SECTION 2: Schema Helpers (moved from 02_Schema.gs)
 * ============================================================ */

/**
 * getColIndex — หา column index จากชื่อคอลัมน์ (0-based)
 * @public สาธารณะ convenience function สำหรับ external caller
 *
 * @param {string} schemaKey - key ใน SCHEMA object (เช่น 'M_PERSON')
 * @param {string} colName - ชื่อคอลัมน์ที่ต้องการหา index
 * @return {number} 0-based column index หรือ -1 ถ้าไม่พบ
 *
 * @deprecated since V5.5.019 — Use *_IDX.* constants from 01_Config.gs
 *   ตัวอย่าง: แทน getColIndex('M_PERSON', 'phone') ให้ใช้ PERSON_IDX.PHONE
 *
 * Moved to 99_Legacy.gs in V5.5.034 (DOC-CODE SYNC workflow step 5)
 */
function getColIndex(schemaKey, colName) {
  // [REF-012] Log warning เมื่อถูกเรียก — ป้องกันการใช้งานในอนาคต
  if (typeof logWarn === TYPE_OF_FUNCTION) {
    try {
      const stack = (new Error().stack || '').split('\n');
      const caller = stack[2] || 'unknown';
      logWarn(
        LEGACY_MODULE_NAME,
        '[DEPRECATED] getColIndex("' +
          schemaKey +
          '", "' +
          colName +
          '") — Use *_IDX.* constants instead. Caller: ' +
          caller.trim()
      );
    } catch (e) {
      // ignore log error
    }
  }
  const headers = SCHEMA[schemaKey];
  if (!headers) return -1;
  return headers.indexOf(colName);
}

/* ============================================================
 * SECTION 3: Destination Helpers (moved from 09_DestinationService.gs)
 * ============================================================ */

/**
 * getDestinationsByPerson — [ADD v5.1.001] ดึง Destination ทั้งหมดของบุคคล
 * @public สาธารณะ convenience wrapper สำหรับ external caller
 *
 * @deprecated [REF-020] Use getDestsByPersonId() instead. This pass-through wrapper
 *   adds no logic and will be removed in a future version.
 * @param {string} personId
 *
 * Moved to 99_Legacy.gs in V5.5.034 (DOC-CODE SYNC workflow step 5)
 */
function getDestinationsByPerson(personId) {
  if (typeof logWarn === TYPE_OF_FUNCTION) {
    try {
      logWarn(
        LEGACY_MODULE_NAME,
        '[DEPRECATED] getDestinationsByPerson("' + personId + '") — Use getDestsByPersonId() instead.'
      );
    } catch (e) {
      // ignore log error
    }
  }
  return getDestsByPersonId(personId);
}

/**
 * getDestinationsByPlace — [ADD v5.1.001] ดึง Destination ทั้งหมดของสถานที่
 * @public สาธารณะ convenience wrapper สำหรับ external caller
 *
 * @deprecated [REF-020] Use getDestsByPlaceId() instead. This pass-through wrapper
 *   adds no logic and will be removed in a future version.
 * @param {string} placeId
 *
 * Moved to 99_Legacy.gs in V5.5.034 (DOC-CODE SYNC workflow step 5)
 */
function getDestinationsByPlace(placeId) {
  if (typeof logWarn === TYPE_OF_FUNCTION) {
    try {
      logWarn(
        LEGACY_MODULE_NAME,
        '[DEPRECATED] getDestinationsByPlace("' + placeId + '") — Use getDestsByPlaceId() instead.'
      );
    } catch (e) {
      // ignore log error
    }
  }
  return getDestsByPlaceId(placeId);
}
