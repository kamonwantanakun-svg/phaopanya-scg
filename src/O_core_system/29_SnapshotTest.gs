/**
 * VERSION: 6.0.069
 * FILE: 29_SnapshotTest.gs
 * LMDS V6.0 — Snapshot Test Harness for Refactoring Safety
 * ===================================================
 * PURPOSE:
 *   บันทึก TEST_MATCH_RESULTS ปัจจุบันเป็น baseline ก่อน refactor
 *   เปรียบเทียบ TEST_MATCH_RESULTS หลัง refactor กับ baseline
 *   เพื่อยืนยันว่า refactoring ไม่เปลี่ยนแปลง decision ของแต่ละ row
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 10d_MatchTestHarness.gs (test data access)
 *   CALLS: (Invokes)
 *     - getSheetByNameSafe_()                   → 03_SetupSheets.gs
 *     - logInfo() / logWarn()                   → 03_SetupSheets.gs
 *   EXPORTS TO:
 *     - 00_App.gs (menu: saveSnapshot, compareSnapshot)
 *     - 10d_MatchTestHarness.gs (baseline capture before dry run)
 *   SHEETS ACCESSED:
 *     - SHEET.TEST_MATCH_RESULTS (Read/Write — save baseline + compare after refactor)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 0 — Core infrastructure (config, schema, utils, audit, RBAC, web app gateway)
 * ===================================================
 */

// ============================================================
// SECTION 1: Save Baseline
// ============================================================

/**
 * snapshotSaveBaseline_ — บันทึก TEST_MATCH_RESULTS ปัจจุบันเป็น baseline
 *   เก็บใน PropertiesService เป็น JSON (key: SNAPSHOT_TEST_BASELINE)
 *   ถ้า baseline เดิมมีอยู่ → ถูก overwrite
 *
 *   Note: PropertiesService มี limit ~500KB/value
 *   400 rows × 8 cols × ~100 bytes/row ≈ 32KB → ปลอดภัย
 *
 * @return {{ ok: boolean, rows: number, message: string }}
 * @private
 */
function snapshotSaveBaseline_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.TEST_MATCH_RESULTS);
    if (!sheet || sheet.getLastRow() < 2) {
      return { ok: false, rows: 0, message: 'ไม่มีข้อมูลใน TEST_MATCH_RESULTS — รัน Dry Run ก่อน' };
    }

    const lastRow = sheet.getLastRow();
    const colsToRead = Math.min(8, sheet.getLastColumn());
    const data = sheet.getRange(2, 1, lastRow - 1, colsToRead).getValues();

    // Convert to compact format: [[source_row, action, reason, confidence, evidence], ...]
    // ไม่เก็บ invoice_no (masked, ไม่ใช้ใน comparison) และ person/place name (display only)
    const compact = data.map(function (r) {
      return [
        String(r[TEST_MATCH_IDX.SOURCE_ROW] || ''),
        String(r[TEST_MATCH_IDX.ACTION] || ''),
        String(r[TEST_MATCH_IDX.REASON] || ''),
        Number(r[TEST_MATCH_IDX.CONFIDENCE] || 0),
        String(r[TEST_MATCH_IDX.EVIDENCE] || '')
      ];
    });

    const baseline = {
      savedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      rows: compact.length,
      data: compact
    };

    const json = JSON.stringify(baseline);
    PropertiesService.getScriptProperties().setProperty('SNAPSHOT_TEST_BASELINE', json);

    logInfo('SnapshotTest', 'Saved baseline: ' + compact.length + ' rows (v' + APP_VERSION + ')');
    return {
      ok: true,
      rows: compact.length,
      message: 'บันทึก baseline สำเร็จ — ' + compact.length + ' rows (v' + APP_VERSION + ')'
    };
  } catch (e) {
    logError('SnapshotTest', 'snapshotSaveBaseline_ ล้มเหลว: ' + e.message, e);
    return { ok: false, rows: 0, message: e.message };
  }
}

// ============================================================
// SECTION 2: Compare
// ============================================================

/**
 * snapshotCompare_ — เปรียบเทียบ TEST_MATCH_RESULTS ปัจจุบันกับ baseline
 *   ส่งคืน array ของ differences (empty = ไม่มี regression)
 *
 * @return {{ ok: boolean, baselineRows: number, currentRows: number, differences: Array, message: string }}
 * @private
 */
function snapshotCompare_() {
  try {
    // 1. อ่าน baseline จาก PropertiesService
    const baselineJson = PropertiesService.getScriptProperties().getProperty('SNAPSHOT_TEST_BASELINE');
    if (!baselineJson) {
      return {
        ok: false,
        baselineRows: 0,
        currentRows: 0,
        differences: [],
        message: 'ไม่พบ baseline — กด "Save Baseline" ก่อน'
      };
    }

    let baseline;
    try {
      baseline = JSON.parse(baselineJson);
    } catch (parseErr) {
      return {
        ok: false,
        baselineRows: 0,
        currentRows: 0,
        differences: [],
        message: 'Baseline JSON corrupt — บันทึกใหม่อีกครั้ง'
      };
    }

    // 2. อ่าน TEST_MATCH_RESULTS ปัจจุบัน
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.TEST_MATCH_RESULTS);
    if (!sheet || sheet.getLastRow() < 2) {
      return {
        ok: false,
        baselineRows: baseline.rows,
        currentRows: 0,
        differences: [],
        message: 'ไม่มีข้อมูลใน TEST_MATCH_RESULTS — รัน Dry Run ก่อน'
      };
    }

    const lastRow = sheet.getLastRow();
    const colsToRead = Math.min(8, sheet.getLastColumn());
    const data = sheet.getRange(2, 1, lastRow - 1, colsToRead).getValues();

    // Convert current to same compact format
    const current = data.map(function (r) {
      return [
        String(r[TEST_MATCH_IDX.SOURCE_ROW] || ''),
        String(r[TEST_MATCH_IDX.ACTION] || ''),
        String(r[TEST_MATCH_IDX.REASON] || ''),
        Number(r[TEST_MATCH_IDX.CONFIDENCE] || 0),
        String(r[TEST_MATCH_IDX.EVIDENCE] || '')
      ];
    });

    // 3. Build lookup by source_row (key = source_row)
    const baselineMap = {};
    baseline.data.forEach(function (row) {
      baselineMap[row[0]] = row;
    });
    const currentMap = {};
    current.forEach(function (row) {
      currentMap[row[0]] = row;
    });

    // 4. Compare
    const differences = [];
    const allKeys = new Set(Object.keys(baselineMap).concat(Object.keys(currentMap)));

    allKeys.forEach(function (sourceRow) {
      const b = baselineMap[sourceRow];
      const c = currentMap[sourceRow];

      if (!b) {
        differences.push({
          sourceRow: sourceRow,
          type: 'NEW_IN_CURRENT',
          baseline: null,
          current: c
        });
        return;
      }
      if (!c) {
        differences.push({
          sourceRow: sourceRow,
          type: 'MISSING_IN_CURRENT',
          baseline: b,
          current: null
        });
        return;
      }

      // Compare field by field
      // [0]=source_row, [1]=action, [2]=reason, [3]=confidence, [4]=evidence
      const actionChanged = b[1] !== c[1];
      const reasonChanged = b[2] !== c[2];
      const confChanged = b[3] !== c[3];
      const evidenceChanged = b[4] !== c[4];

      if (actionChanged || reasonChanged || confChanged || evidenceChanged) {
        differences.push({
          sourceRow: sourceRow,
          type: 'CHANGED',
          baseline: { action: b[1], reason: b[2], confidence: b[3], evidence: b[4] },
          current: { action: c[1], reason: c[2], confidence: c[3], evidence: c[4] },
          changes: {
            action: actionChanged,
            reason: reasonChanged,
            confidence: confChanged,
            evidence: evidenceChanged
          }
        });
      }
    });

    const msg =
      differences.length === 0
        ? '✅ ไม่มี regression — decisions เหมือนเดิมทุก row'
        : '❌ พบ ' + differences.length + ' differences — ตรวจสอบก่อน merge';

    logInfo(
      'SnapshotTest',
      'Compare: ' + differences.length + ' differences (baseline=' + baseline.rows + ', current=' + current.length + ')'
    );

    return {
      ok: differences.length === 0,
      baselineRows: baseline.rows,
      currentRows: current.length,
      baselineVersion: baseline.appVersion,
      baselineSavedAt: baseline.savedAt,
      differences: differences,
      message: msg
    };
  } catch (e) {
    logError('SnapshotTest', 'snapshotCompare_ ล้มเหลว: ' + e.message, e);
    return { ok: false, baselineRows: 0, currentRows: 0, differences: [], message: e.message };
  }
}

// ============================================================
// SECTION 3: Clear Baseline
// ============================================================

/**
 * snapshotClearBaseline_ — ลบ baseline ออกจาก PropertiesService
 *   ใช้เมื่อต้องการเริ่มใหม่ หรือหลัง merge refactor PR
 * @return {{ ok: boolean, message: string }}
 * @private
 */
function snapshotClearBaseline_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty('SNAPSHOT_TEST_BASELINE');
    logInfo('SnapshotTest', 'Cleared baseline');
    return { ok: true, message: 'ล้าง baseline เรียบร้อย' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
