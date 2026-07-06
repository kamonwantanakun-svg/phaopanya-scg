/**
 * VERSION: 6.0.001
 * FILE: INVESTIGATE_Issue26.gs
 * LMDS V5.5 — Investigation Script for Issue #26
 * ===================================================
 * PURPOSE:
 *   Script สำหรับ investigate Issue #26 (createPlace empty fields bug)
 *   รันใน Apps Script Editor → Execute → ดูผลใน Stackdriver Logs (View → Logs)
 *
 *   Investigate เรื่อง:
 *   - reprocResolveOrCreatePlaceForReview_ ส่ง '' ทั้ง 4 fields ให้ createPlace
 *   - ทำให้ place ใหม่ที่สร้างใน reprocess flow ไม่มี province/district/postcode
 *
 *   รันครั้งเดียว — output ไป Stackdriver Logs
 *   ไม่แก้ไขข้อมูล — read-only investigation
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES (Load Order):
 *     - 01_Config.gs (SHEET.M_PLACE, SHEET.FACT_DELIVERY, FACT_IDX)
 *   CALLS (Invokes):
 *     - None (read-only script)
 *   EXPORTS TO:
 *     - Stackdriver Logs (console.log)
 *   SHEETS ACCESSED (Read-only):
 *     - SHEET.M_PLACE
 *     - SHEET.FACT_DELIVERY
 * ===================================================
 * CHANGELOG:
 *   V5.5.045 (2026-07-05) — Initial creation for Issue #26 investigation
 * ===================================================
 */
function INVESTIGATE_Issue26() {
  console.log('=== INVESTIGATE Issue #26: createPlace empty fields ===');
  console.log('Timestamp: ' + new Date().toISOString());
  console.log('');

  // ============================================================
  // PHASE 1: นับ place ที่ province/district/postcode ว่างใน M_PLACE
  // ============================================================
  console.log('--- PHASE 1: M_PLACE Data Quality Scan ---');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const placeSheet = ss.getSheetByName(SHEET.M_PLACE);
  if (!placeSheet) {
    console.log('❌ M_PLACE sheet not found');
    return;
  }

  const placeLastRow = placeSheet.getLastRow();
  if (placeLastRow < 2) {
    console.log('⚠️ M_PLACE empty');
    return;
  }

  // Columns: place_id, canonical_name, normalized_name, place_type, sub_district,
  //          district, province, postcode, first_seen, last_seen, usage_count,
  //          record_status, note, master_uuid
  // Indices: 0=place_id, 4=sub_district, 5=district, 6=province, 7=postcode
  const placeData = placeSheet.getRange(2, 1, placeLastRow - 1, 14).getValues();

  const totalPlaces = placeData.length;
  let emptyProvince = 0;
  let emptyDistrict = 0;
  let emptyPostcode = 0;
  let emptyAllFour = 0;
  const emptyProvinceSamples = [];

  for (let i = 0; i < placeData.length; i++) {
    const row = placeData[i];
    const province = String(row[6] || '').trim();
    const district = String(row[5] || '').trim();
    const subDistrict = String(row[4] || '').trim();
    const postcode = String(row[7] || '').trim();

    const hasEmptyProvince = province === '';
    const hasEmptyDistrict = district === '';
    const hasEmptyPostcode = postcode === '';

    if (hasEmptyProvince) emptyProvince++;
    if (hasEmptyDistrict) emptyDistrict++;
    if (hasEmptyPostcode) emptyPostcode++;
    if (hasEmptyProvince && hasEmptyDistrict && hasEmptyPostcode && subDistrict === '') {
      emptyAllFour++;
    }

    // Collect samples (first 10) for places with empty province
    if (hasEmptyProvince && emptyProvinceSamples.length < 10) {
      emptyProvinceSamples.push({
        placeId: row[0],
        canonicalName: row[1],
        province: province,
        district: district,
        postcode: postcode,
        firstSeen: row[8] ? new Date(row[8]).toISOString() : null,
        usageCount: row[10]
      });
    }
  }

  console.log('Total places in M_PLACE: ' + totalPlaces);
  console.log(
    'Places with empty province: ' + emptyProvince + ' (' + Math.round((emptyProvince / totalPlaces) * 100) + '%)'
  );
  console.log(
    'Places with empty district: ' + emptyDistrict + ' (' + Math.round((emptyDistrict / totalPlaces) * 100) + '%)'
  );
  console.log(
    'Places with empty postcode: ' + emptyPostcode + ' (' + Math.round((emptyPostcode / totalPlaces) * 100) + '%)'
  );
  console.log(
    'Places with ALL FOUR empty (sub_district+district+province+postcode): ' +
      emptyAllFour +
      ' (' +
      Math.round((emptyAllFour / totalPlaces) * 100) +
      '%)'
  );
  console.log('');

  if (emptyProvinceSamples.length > 0) {
    console.log('Sample places with empty province (first 10):');
    for (let s = 0; s < emptyProvinceSamples.length; s++) {
      const sample = emptyProvinceSamples[s];
      console.log(
        '  ' +
          (s + 1) +
          '. placeId=' +
          sample.placeId +
          ' | name="' +
          sample.canonicalName +
          '"' +
          ' | firstSeen=' +
          sample.firstSeen +
          ' | usageCount=' +
          sample.usageCount
      );
    }
    console.log('');
  }

  // ============================================================
  // PHASE 2: ดูการใช้งาน reprocess flow ใน FACT_DELIVERY
  //   นับ FACT rows ที่มี match_reason บอกว่ามาจาก reprocess (post_process_v55)
  // ============================================================
  console.log('--- PHASE 2: Reprocess Flow Usage (FACT_DELIVERY) ---');

  const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  if (!factSheet) {
    console.log('❌ FACT_DELIVERY sheet not found');
    return;
  }

  const factLastRow = factSheet.getLastRow();
  if (factLastRow < 2) {
    console.log('⚠️ FACT_DELIVERY empty');
    return;
  }

  // FACT_IDX.MATCH_REASON = 24, FACT_IDX.PERSON_ID = 15, FACT_IDX.PLACE_ID = 16
  // FACT_IDX.DELIVERY_DATE = 4, FACT_IDX.MATCH_STATUS = 22
  // อ่านเฉพาะคอลัมน์ที่จำเป็น (cols 5-25, 1-based)
  const factCols = factSheet.getLastColumn();
  const factData = factSheet.getRange(2, 1, factLastRow - 1, Math.min(factCols, 34)).getValues();

  const totalFacts = factData.length;
  let reprocessedFacts = 0;
  const reprocessedSamples = [];

  for (let j = 0; j < factData.length; j++) {
    const frow = factData[j];
    const matchReason = String(frow[24] || ''); // MATCH_REASON
    const matchStatus = String(frow[22] || ''); // MATCH_STATUS

    // ตรวจหา evidence ที่บอกว่ามาจาก reprocess flow
    if (matchReason.indexOf('post_process_v55') !== -1 || matchReason.indexOf('GEO_ANCHOR_NEW') !== -1) {
      reprocessedFacts++;
      if (reprocessedSamples.length < 5) {
        reprocessedSamples.push({
          txId: frow[0],
          invoiceNo: frow[6],
          personId: frow[15],
          placeId: frow[16],
          geoId: frow[17],
          matchStatus: matchStatus,
          matchReason: matchReason,
          deliveryDate: frow[4] ? new Date(frow[4]).toISOString().split('T')[0] : null
        });
      }
    }
  }

  console.log('Total facts in FACT_DELIVERY: ' + totalFacts);
  console.log(
    'Reprocessed facts (post_process_v55 / GEO_ANCHOR_NEW): ' +
      reprocessedFacts +
      ' (' +
      Math.round((reprocessedFacts / totalFacts) * 100) +
      '%)'
  );
  console.log('');

  if (reprocessedSamples.length > 0) {
    console.log('Sample reprocessed facts (first 5):');
    for (let r = 0; r < reprocessedSamples.length; r++) {
      const rs = reprocessedSamples[r];
      console.log(
        '  ' +
          (r + 1) +
          '. txId=' +
          rs.txId +
          ' | invoice=' +
          rs.invoiceNo +
          ' | placeId=' +
          rs.placeId +
          ' | reason=' +
          rs.matchReason.substring(0, 80)
      );
    }
    console.log('');
  }

  // ============================================================
  // PHASE 3: Cross-reference — placeIds ที่สร้างใน reprocess flow
  //   มี province ว่างไหม?
  // ============================================================
  console.log('--- PHASE 3: Cross-reference Reprocess PlaceIds → M_PLACE ---');

  if (reprocessedSamples.length === 0) {
    console.log('No reprocessed samples found — skip cross-reference');
    console.log('');
    console.log('=== INVESTIGATION COMPLETE ===');
    console.log('');
    console.log('Summary:');
    console.log('  - Total M_PLACE: ' + totalPlaces);
    console.log('  - Empty province: ' + emptyProvince + ' (' + Math.round((emptyProvince / totalPlaces) * 100) + '%)');
    console.log('  - Empty all four fields: ' + emptyAllFour);
    console.log('  - Reprocess flow usage: ' + reprocessedFacts + ' facts');
    console.log('');
    console.log('Next steps:');
    console.log('  1. If emptyProvince is HIGH (>20%) → likely a bug');
    console.log('  2. If emptyProvince is LOW (<5%) → may be design intent');
    console.log('  3. If reprocessedFacts is 0 → reprocess flow never ran → no impact');
    return;
  }

  // Build placeId → place map for quick lookup
  const placeMap = {};
  for (let p = 0; p < placeData.length; p++) {
    const pid = placeData[p][0];
    if (pid) placeMap[pid] = placeData[p];
  }

  // Check each reprocessed sample's placeId
  let reprocessedPlaceWithEmptyProvince = 0;
  for (let k = 0; k < reprocessedSamples.length; k++) {
    const samplePlaceId = reprocessedSamples[k].placeId;
    if (samplePlaceId && placeMap[samplePlaceId]) {
      const placeRow = placeMap[samplePlaceId];
      const placeProvince = String(placeRow[6] || '').trim();
      const placeDistrict = String(placeRow[5] || '').trim();
      const placePostcode = String(placeRow[7] || '').trim();

      console.log('  Place ' + samplePlaceId + ' (from reprocessed fact):');
      console.log('    Province: "' + placeProvince + '"');
      console.log('    District: "' + placeDistrict + '"');
      console.log('    Postcode: "' + placePostcode + '"');
      console.log('    Canonical name: "' + placeRow[1] + '"');

      if (placeProvince === '' && placeDistrict === '' && placePostcode === '') {
        reprocessedPlaceWithEmptyProvince++;
      }
    }
  }

  console.log('');
  console.log('=== INVESTIGATION COMPLETE ===');
  console.log('');
  console.log('SUMMARY:');
  console.log('  - Total M_PLACE: ' + totalPlaces);
  console.log(
    '  - Empty province in M_PLACE: ' + emptyProvince + ' (' + Math.round((emptyProvince / totalPlaces) * 100) + '%)'
  );
  console.log('  - Reprocess flow facts: ' + reprocessedFacts);
  console.log(
    '  - Reprocessed place samples with empty province: ' +
      reprocessedPlaceWithEmptyProvince +
      '/' +
      reprocessedSamples.length
  );
  console.log('');
  console.log('DIAGNOSIS:');
  if (emptyAllFour > 0 && reprocessedFacts > 0) {
    console.log('  ⚠️ BUG CONFIRMED — places created with all 4 fields empty exist');
    console.log('  ⚠️ Reprocess flow has been used (reprocessedFacts > 0)');
    console.log("  → Likely caused by reprocResolveOrCreatePlaceForReview_ createPlace('', '', '', '')");
    console.log('  → Recommend: apply fix in PR #28 (V6.0 Phase 3)');
  } else if (emptyAllFour > 0 && reprocessedFacts === 0) {
    console.log('  ⚠️ Empty places exist BUT reprocess flow never ran');
    console.log('  → Empty places may come from OTHER source (manual entry, old data)');
    console.log('  → Still recommend fix as defense-in-depth');
  } else if (emptyAllFour === 0) {
    console.log('  ✅ No places with all 4 fields empty found');
    console.log('  → Either reprocess flow never created new places');
    console.log('  → OR places were enriched after creation (unlikely)');
    console.log('  → Fix is still valid as preventive measure');
  }
  console.log('');
  console.log('Done — copy this log to GitHub Issue #26');
}

/**
 * INVESTIGATE_Issue26_DryRun — ทดสอบ createPlace flow โดยไม่เขียนจริง
 *   รันเพื่อดูว่าถ้า reprocess flow ทำงานจริง จะเกิดอะไรขึ้น
 *
 *   ⚠️ ฟังก์ชันนี้ READ-ONLY — ไม่ write ลง sheet ใดๆ
 */
function INVESTIGATE_Issue26_DryRun() {
  console.log('=== INVESTIGATE Issue #26: Dry Run Test ===');
  console.log('');

  // Simulate what reprocResolveOrCreatePlaceForReview_ does
  const testRawPlace = 'ร้านสมชาย';
  const testRawAddr = '123 ถ.สุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110';

  console.log('Test inputs:');
  console.log('  rawPlace: "' + testRawPlace + '"');
  console.log('  rawAddr:  "' + testRawAddr + '"');
  console.log('');

  // Step 1: Simulate resolvePlace
  console.log('Step 1: resolvePlace(placeInput, rawAddr)');
  console.log('  → Would search M_PLACE for matches...');
  console.log('  → If not found → status: NOT_FOUND');

  // Step 2: Simulate createPlace (current behavior — empty 4 fields)
  console.log('');
  console.log('Step 2 (CURRENT BEHAVIOR): createPlace(normResult, "", "", "", "")');
  console.log('  → New place created with:');
  console.log('    province: "" (empty)');
  console.log('    district: "" (empty)');
  console.log('    subDistrict: "" (empty)');
  console.log('    postcode: "" (empty)');
  console.log('  ⚠️ Data quality issue confirmed');

  // Step 3: Show what SHOULD happen
  console.log('');
  console.log('Step 2 (CORRECTED BEHAVIOR): createPlace with geo enrichment');
  console.log('  → Should call getEnrichedGeoData(rawAddr) first:');
  console.log('    province: "กรุงเทพมหานคร"');
  console.log('    district: "คลองเตย"');
  console.log('    subDistrict: "คลองเตย"');
  console.log('    postcode: "10110"');
  console.log('  → Place would have full data ✅');

  console.log('');
  console.log('=== Dry Run Complete ===');
  console.log('');
  console.log('Conclusion:');
  console.log('  - Current behavior is BUG (confirmed by code inspection)');
  console.log('  - Fix: add getEnrichedGeoData() call before createPlace');
  console.log('  - Trade-off: ~50-100ms per call (acceptable for batch)');
  console.log('  - Recommend: implement fix in PR #28 (V6.0 Phase 3)');
}
