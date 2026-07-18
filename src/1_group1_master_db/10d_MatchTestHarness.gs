/**
 * VERSION: 6.0.069
 * FILE: 10d_MatchTestHarness.gs
 * LMDS V6.0 — Match Engine Test Harness
 * ===================================================
 * PURPOSE:
 *   รวม Dry Run + test functions ที่ไม่เขียน master sheets
 *   แยกออกจาก 10_MatchEngine.gs เพื่อลดขนาดไฟล์ (audit 1.2)
 *   ถูกเรียกโดย 00_App.gs menu (runTestMatchDryRun_UI / runTestMatchDryRunForceAll_UI)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 10_MatchEngine.gs       (core match logic for dry run)
 *     - 04_SourceRepository.gs (getAllSourceRowsForceAll)
 *     - 29_SnapshotTest.gs      (baseline capture before dry run)
 *   CALLS: (Invokes)
 *     - runMatchEngine()                        → 10_MatchEngine.gs
 *     - getAllSourceRowsForceAll()              → 04_SourceRepository.gs
 *     - saveSnapshot()                          → 29_SnapshotTest.gs
 *     - logInfo()                               → 03_SetupSheets.gs
 *   EXPORTS TO:
 *     - 00_App.gs (runTestMatchDryRun_UI, runTestMatchDryRunForceAll_UI menus)
 *     - 29_SnapshotTest.gs (baseline capture before dry run)
 *     - 28_WebAppActions.gs (dry run action)
 *   SHEETS ACCESSED:
 *     - SHEET.TEST_MATCH_RESULTS (Write — append dry run results; Read — comparison)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 1 — Master data building (normalize, persons, places, geo, match engine, aliases)
 * ===================================================
 */

/**
 * runTestMatchDryRun_ — [V6.0.012 P1.7] Dry-run matching on SOURCE data
 *   Reads unprocessed source rows, calls resolvePerson/Place/Geo + makeMatchDecision
 *   for each row WITHOUT executing the decision (no writes to master sheets).
 *   Writes results to TEST_MATCH_RESULTS sheet (clear-and-replace pattern).
 *
 *   Use case: compare match rates before/after tweaking matching algorithm
 *   without polluting production data.
 *
 * [V6.0.017] เพิ่ม param forceAllRows (optional, default false)
 *   - false (default): ใช้ loadSourceBatch_() — กรองเฉพาะ unprocessed rows (เหมือนเดิม)
 *   - true: ใช้ getAllSourceRowsForceAll() — ข้าม SYNC_STATUS filter เพื่อทดสอบซ้ำกับข้อมูลที่ processed แล้ว
 *     ใช้เพื่อเปรียบเทียบ algorithm เก่า vs ใหม่ บนข้อมูลชุดเดิมโดยไม่ต้องรีเซ็ต SYNC_STATUS
 *
 * @param {number} [maxRows=100] - max rows to test (default 100)
 * @param {boolean} [forceAllRows=false] - [V6.0.017] ถ้า true → ข้าม SYNC_STATUS filter (ทดสอบได้ซ้ำ)
 * @return {{ tested: number, totalRows: number, autoMatched: number,
 *            createdNew: number, queuedReview: number, errors: number,
 *            matchRate: number, elapsedSec: number, forceAllRows: boolean }}
 */
function runTestMatchDryRun_(maxRows, forceAllRows) {
  maxRows = maxRows || 100;
  forceAllRows = forceAllRows === true; // [V6.0.017] explicit boolean coercion
  const startTime = new Date();

  // Load source rows
  // [V6.0.012 P1.7] Reset cached state — same pattern as prepareMatchEngineContext_
  resetProcessingState_();

  // [V6.0.017] เลือก loader ตาม forceAllRows flag
  //   - false: loadSourceBatch_() → getUnprocessedRows() → กรอง SYNC_STATUS + PROCESSED_INVOICES
  //   - true:  getAllSourceRowsForceAll() → ข้ามทั้งคู่ (test ได้ทุกแถว)
  let allPendingRows;
  if (forceAllRows) {
    allPendingRows = typeof getAllSourceRowsForceAll === 'function' ? getAllSourceRowsForceAll() : [];
    logInfo('MatchEngine', 'runTestMatchDryRun_: forceAllRows=true — ข้าม SYNC_STATUS filter');
  } else {
    allPendingRows = loadSourceBatch_();
  }

  if (allPendingRows.length === 0) {
    logInfo('MatchEngine', 'runTestMatchDryRun_: ไม่มีแถวที่ต้องประมวลผล');
    return {
      tested: 0,
      totalRows: 0,
      autoMatched: 0,
      createdNew: 0,
      queuedReview: 0,
      errors: 0,
      matchRate: 0,
      elapsedSec: 0,
      forceAllRows: forceAllRows
    };
  }

  const rowsToTest = allPendingRows.slice(0, maxRows);
  logInfo(
    'MatchEngine',
    'runTestMatchDryRun_: testing ' +
      rowsToTest.length +
      '/' +
      allPendingRows.length +
      ' rows' +
      (forceAllRows ? ' (forceAllRows=true)' : '')
  );

  // Initialize counters
  let autoMatched = 0;
  let createdNew = 0;
  let queuedReview = 0;
  let errors = 0;

  // Collect result rows for batch write to TEST_MATCH_RESULTS sheet
  const resultRows = [];

  // [V6.0.029] Time guard — ป้องกัน GAS 6-min timeout
  //   เดิม: Dry Run ไม่มี time guard → 400 rows × 1.5s = 600s → timeout at 360s
  //   ใหม่: หยุดที่ 300s (5 min) เพื่อเหลือ buffer 60s สำหรับ write TEST_MATCH_RESULTS
  //   ถ้าหยุดกลางทาง → เขียนผลที่ได้ + บอก user ว่าเหลือกี่แถว
  const DRY_RUN_TIME_LIMIT_MS = 300000; // 5 minutes
  let stoppedByTimeGuard = false;

  for (let i = 0; i < rowsToTest.length; i++) {
    // [V6.0.029] Time guard check — ทุก 10 rows เพื่อลด overhead
    if (i % 10 === 0 && i > 0) {
      const elapsed = new Date() - startTime;
      if (elapsed > DRY_RUN_TIME_LIMIT_MS) {
        logWarn(
          'MatchEngine',
          'runTestMatchDryRun_: Time guard หยุดที่แถว ' +
            i +
            '/' +
            rowsToTest.length +
            ' (elapsed=' +
            Math.round(elapsed / 1000) +
            's, limit=' +
            DRY_RUN_TIME_LIMIT_MS / 1000 +
            's) — เขียนผลที่ได้ ' +
            resultRows.length +
            ' rows'
        );
        stoppedByTimeGuard = true;
        break;
      }
    }

    const srcObj = rowsToTest[i];
    try {
      // Mirror processOneRow() resolution calls — but stop BEFORE executeDecision()
      // [V6.0.014 REVERT V6.0.013] sync with processOneRow — use rawPlaceName [18] as primary
      //   (with fallback to rawAddress [24]) — see processOneRow comment for full rationale
      const personResult = resolvePerson(srcObj.rawPersonName, null, { soldToName: srcObj.soldToName });
      const placeResult = resolvePlace(srcObj.rawPlaceName || srcObj.rawAddress, srcObj.rawAddress || '');
      const geoResult = resolveGeo(srcObj.rawLat, srcObj.rawLng);

      // [V6.0.002] Tie-breaker — same as processOneRow (mirror logic for accuracy)
      if (personResult.status === 'NEEDS_REVIEW' && personResult.secondBestPerson) {
        const candidates = [
          { personId: personResult.personId, score: personResult.confidence },
          { personId: personResult.secondBestPerson.personId, score: personResult.secondBestScore }
        ];
        const chosen = breakTieAmongCandidates(candidates, srcObj);
        if (chosen && chosen.tiebreaker) {
          personResult.personId = chosen.personId;
          personResult.confidence = chosen.score;
          personResult.status = chosen.score >= AI_CONFIG.THRESHOLD_AUTO ? 'FOUND' : 'NEEDS_REVIEW';
        }
      }

      // Make decision ONLY — do NOT call executeDecision() (no writes!)
      const decision = makeMatchDecision(srcObj, personResult, placeResult, geoResult);

      // Count
      if (decision.action === 'AUTO_MATCH') autoMatched++;
      else if (decision.action === 'CREATE_NEW') createdNew++;
      else if (decision.action === 'REVIEW') queuedReview++;

      // Build result row — invoice_no masked (3 chars + ***)
      const maskedInvoice = srcObj.invoiceNo ? String(srcObj.invoiceNo).substring(0, 3) + '***' : '';

      resultRows.push([
        srcObj.sourceRow, // [0] source_row
        maskedInvoice, // [1] invoice_no (masked)
        String(srcObj.rawPersonName || '').substring(0, 100), // [2] person_name (trunc)
        String(srcObj.rawPlaceName || '').substring(0, 100), // [3] place_name (trunc)
        decision.action || '', // [4] action
        String(decision.reason || '').substring(0, 80), // [5] reason
        decision.confidence || 0, // [6] confidence
        String(decision.evidence || '').substring(0, 200) // [7] evidence
      ]);
    } catch (rowErr) {
      errors++;
      logError('MatchEngine', 'runTestMatchDryRun_: row ' + srcObj.sourceRow + ' failed — ' + rowErr.message, rowErr);
      // Still push a placeholder row so user can see which row errored
      const maskedInvoice = srcObj.invoiceNo ? String(srcObj.invoiceNo).substring(0, 3) + '***' : '';
      resultRows.push([
        srcObj.sourceRow,
        maskedInvoice,
        String(srcObj.rawPersonName || '').substring(0, 100),
        String(srcObj.rawPlaceName || '').substring(0, 100),
        'ERROR',
        String(rowErr.message || '').substring(0, 80),
        0,
        ''
      ]);
    }
  }

  // Write results to TEST_MATCH_RESULTS sheet (clear-and-replace pattern)
  //   Clear existing data rows (keep header) → write new rows in one batch
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.TEST_MATCH_RESULTS);
    if (!sheet) {
      logWarn(
        'MatchEngine',
        'runTestMatchDryRun_: TEST_MATCH_RESULTS sheet not found — skipping write (results in log only)'
      );
    } else {
      // Clear existing data rows (keep header row 1)
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        const schemaLen = getSheetHeaders(SHEET.TEST_MATCH_RESULTS).length;
        sheet.getRange(2, 1, lastRow - 1, schemaLen).clearContent();
      }
      // Write new rows in one batch
      if (resultRows.length > 0) {
        sheet.getRange(2, 1, resultRows.length, resultRows[0].length).setValues(resultRows);
      }
      logInfo('MatchEngine', 'runTestMatchDryRun_: wrote ' + resultRows.length + ' rows to TEST_MATCH_RESULTS');
    }
  } catch (writeErr) {
    logError('MatchEngine', 'runTestMatchDryRun_: write to TEST_MATCH_RESULTS failed — ' + writeErr.message, writeErr);
    // Non-fatal — counts are still returned to caller
  }

  // Compute match rate
  const tested = resultRows.length;
  const matchRate = tested > 0 ? Math.round((autoMatched / tested) * 100) : 0;
  const elapsedSec = Math.round((new Date() - startTime) / 1000);

  logInfo(
    'MatchEngine',
    'runTestMatchDryRun_ done: tested=' +
      tested +
      ' auto_match=' +
      autoMatched +
      ' create_new=' +
      createdNew +
      ' review=' +
      queuedReview +
      ' errors=' +
      errors +
      ' match_rate=' +
      matchRate +
      '% (' +
      elapsedSec +
      's)'
  );

  return {
    tested: tested,
    totalRows: allPendingRows.length,
    autoMatched: autoMatched,
    createdNew: createdNew,
    queuedReview: queuedReview,
    errors: errors,
    matchRate: matchRate,
    elapsedSec: elapsedSec,
    forceAllRows: forceAllRows, // [V6.0.017] expose mode in summary
    stoppedByTimeGuard: stoppedByTimeGuard, // [V6.0.029] true if time guard stopped processing early
    requestedRows: maxRows // [V6.0.029] how many rows user requested
  };
}
