/**
 * VERSION: 6.0.069
 * FILE: 10e_MatchResolvePersist.gs
 * LMDS V6.0 — Resolve & Persist for Q_REVIEW
 * ===================================================
 * PURPOSE:
 *   รวม resolveAndPersist* + reproc* functions สำหรับ reprocessing
 *   Q_REVIEW decisions (MERGE_TO_CANDIDATE / CREATE_NEW from review)
 *   แยกออกจาก 10_MatchEngine.gs เพื่อลดขนาดไฟล์ (audit 1.2)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 10_MatchEngine.gs       (match context + handleReview_ gateway)
 *     - 06_PersonService, 07_PlaceService, 08_GeoService, 09_DestinationService (master CRUD)
 *     - 11_TransactionService.gs (upsertFactDelivery)
 *     - 21_AliasService.gs     (alias binding on resolve)
 *     - 26_AuditTrailService.gs (audit on persist)
 *   CALLS: (Invokes)
 *     - resolvePerson() / resolvePlace() / resolveGeo() / resolveDestination() → 06/07/08/09
 *     - upsertFactDelivery()                    → 11_TransactionService.gs
 *     - bindAlias()                             → 21_AliasService.gs
 *     - recordAuditTrail()                      → 26_AuditTrailService.gs
 *   EXPORTS TO:
 *     - 12_ReviewService.gs (applyReviewDecision → resolveAndPersist_)
 *     - 10_MatchEngine.gs (handleReview_ → resolveAndPersist_)
 *   SHEETS ACCESSED:
 *     - (delegates to 06/07/08/09/11/21 services — no direct sheet writes here)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 1 — Master data building (normalize, persons, places, geo, match engine, aliases)
 * ===================================================
 */

/**
 * resolveAndPersist_ — [REF-001] Gateway function for Group 1 CRUD operations
 * Encapsulates the full resolve-create-enrich-upsert sequence.
 * Used by ReviewService to avoid direct Group 1 CRUD calls.
 *
 * For MERGE_TO_CANDIDATE:
 *   - Resolves person, merges if needed
 *   - Resolves geo and destination
 *   - Calls upsertFactDelivery
 *
 * For CREATE_NEW:
 *   - Resolves/creates person, place, geo, destination
 *   - Enriches geo data
 *   - Calls upsertFactDelivery
 *
 * @param {Object} srcObj - Source object with raw data
 * @param {string} decisionType - 'MERGE_TO_CANDIDATE' or 'CREATE_NEW'
 * @param {Object} candidates - { candPersonIds: [], candPlaceIds: [] } for MERGE
 * @param {string} [optReviewId] - Q_REVIEW review_id (for audit trail in M_ALIAS, MERGE only)
 * @return {Object|null} { factRowData } or null
 */
function resolveAndPersist_(srcObj, decisionType, candidates, optReviewId) {
  if (decisionType === 'MERGE_TO_CANDIDATE') {
    return resolveAndPersistMerge_(srcObj, candidates, optReviewId);
  } else if (decisionType === 'CREATE_NEW') {
    return resolveAndPersistCreate_(srcObj);
  }
  logWarn('MatchEngine', 'resolveAndPersist_: Unknown decisionType ' + decisionType);
  return null;
}

/**
 * persistSemanticNotesForEntity_ — [V6.0.053] Centralized notes persistence
 *
 * ดึง structured notes (CONTACT/TIME/COD/FRAGILE/INSTRUCTION/OTHER) จาก raw text
 * และเขียนไป SYS_NOTES sheet สำหรับ entity ที่กำหนด
 *
 * ใช้ใน 3 code paths:
 *   - resolveAndPersistCreate_ (CREATE_NEW) — เดิมมีอยู่แล้ว, ปรับให้ใช้ helper นี้
 *   - resolveAndPersistMerge_  (MERGE from Q_REVIEW) — [V6.0.053] เพิ่มใหม่
 *   - handleAutoMatch_         (AUTO_MATCH) — [V6.0.053] เพิ่มใหม่
 *
 * ปัญหาที่แก้ (Reviewer 2 finding):
 *   ก่อนหน้านี้ AUTO_MATCH และ MERGE ไม่ได้เก็บ notes จาก source row ปัจจุบัน
 *   ทำให้ notes ใหม่ (เช่น "โทร 089-876-5432 ส่งด่วน") หายไปถ้าแถวนั้น match เข้า entity ที่มีอยู่แล้ว
 *
 * @param {string} rawPersonName - ชื่อดิบจาก source row
 * @param {string|null} personId - personId ที่ resolved แล้ว (null = ไม่มี)
 * @param {string} rawPlaceName - ชื่อสถานที่ดิบ
 * @param {string} rawAddress - ที่อยู่ดิบ (fallback ถ้า rawPlaceName ว่าง)
 * @param {string|null} placeId - placeId ที่ resolved แล้ว (null = ไม่มี)
 * @private
 */
function persistSemanticNotesForEntity_(rawPersonName, personId, rawPlaceName, rawAddress, placeId) {
  // PERSON notes
  if (personId && rawPersonName) {
    try {
      if (typeof parseAndStoreSemanticNotes === 'function') {
        parseAndStoreSemanticNotes(rawPersonName, 'PERSON', personId, 'SCG_RAW');
      }
    } catch (e) {
      logDebug('MatchEngine', 'parseAndStoreSemanticNotes (PERSON) skipped: ' + e.message);
    }
  }
  // PLACE notes
  if (placeId && (rawPlaceName || rawAddress)) {
    try {
      if (typeof parseAndStoreSemanticNotes === 'function') {
        parseAndStoreSemanticNotes(rawPlaceName || rawAddress, 'PLACE', placeId, 'SCG_RAW');
      }
    } catch (e) {
      logDebug('MatchEngine', 'parseAndStoreSemanticNotes (PLACE) skipped: ' + e.message);
    }
  }
}

/**
 * resolveAndPersistMerge_ — [REF-001] MERGE path within resolveAndPersist_
 *   [V6.0.007] Added optReviewId parameter — wired through to createGlobalAlias
 *   so the M_ALIAS verified_by/review_id/verified_at fields are populated
 *   for HUMAN-verified aliases (the previous code passed verified_by but
 *   left review_id empty, which is why M_ALIAS cols 8-10 were empty).
 * @param {Object} srcObj
 * @param {Object} candidates - { candPersonIds: [], candPlaceIds: [] }
 * @param {string} [optReviewId] - Q_REVIEW review_id (for audit trail in M_ALIAS)
 * @return {Object|null} { factRowData } or null
 */
function resolveAndPersistMerge_(srcObj, candidates, optReviewId) {
  let targetPersonId = null;
  if (candidates && candidates.candPersonIds && candidates.candPersonIds.length > 0) {
    const personResult = resolvePerson(srcObj.rawPersonName);
    if (personResult.personId && personResult.personId !== candidates.candPersonIds[0]) {
      mergePersonRecords(personResult.personId, candidates.candPersonIds[0]);
    }
    targetPersonId = candidates.candPersonIds[0];
  }

  let targetPlaceId =
    candidates && candidates.candPlaceIds && candidates.candPlaceIds.length > 0 ? candidates.candPlaceIds[0] : null;

  // [FIX V5.5.050 BUG-QREVIEW-MPERSON] ถ้าไม่มี candidate เลย → fallback เป็น CREATE_NEW
  //   ปัญหา: MERGE_TO_CANDIDATE แต่ candPersonIds=[] และ candPlaceIds=[]
  //   → targetPersonId=null, targetPlaceId=null → ไม่สร้างอะไรเลยใน M_PERSON/M_PLACE
  //   แก้: ถ้าไม่มี candidate ทั้งคู่ → เรียก resolveAndPersistCreate_ แทน
  if (!targetPersonId && !targetPlaceId) {
    logInfo(
      'MatchEngine',
      'resolveAndPersistMerge_: ไม่มี candidate — fallback เป็น CREATE_NEW (person="' + srcObj.rawPersonName + '")'
    );
    return resolveAndPersistCreate_(srcObj);
  }

  // [FIX V5.5.050 BUG-QREVIEW-MPERSON] ถ้ามี place candidate แต่ไม่มี person candidate
  //   → สร้าง person ใหม่ (เพราะ MERGE หมายถึง merge เข้า candidate ที่มี
  //   แต่ถ้าไม่มี person candidate เลย ต้องสร้างใหม่)
  if (!targetPersonId && srcObj.rawPersonName) {
    const personResult = resolvePerson(srcObj.rawPersonName);
    targetPersonId = personResult.personId;
    if (!targetPersonId) {
      targetPersonId = createPerson(personResult.normResult);
      logInfo('MatchEngine', 'resolveAndPersistMerge_: สร้าง Person ใหม่ — ' + targetPersonId);
    }
  }

  // [FIX V5.5.050 BUG-QREVIEW-MPERSON] ถ้ามี person candidate แต่ไม่มี place candidate
  //   → สร้าง place ใหม่
  if (!targetPlaceId && (srcObj.rawPlaceName || srcObj.rawAddress)) {
    const rawPlace = srcObj.rawPlaceName || srcObj.rawAddress;
    const rawAddr = srcObj.rawAddress || '';
    const placeResult = resolvePlace(rawPlace, rawAddr);
    let newPlaceId = placeResult.placeId;
    if (!newPlaceId) {
      let geoEnrich = null;
      try {
        geoEnrich = getEnrichedGeoData(rawAddr, rawPlace);
      } catch (e) {
        logDebug('MatchEngine', 'resolveAndPersistMerge_: getEnrichedGeoData skipped — ' + e.message);
      }
      const safeGeoEnrich = geoEnrich || {};
      const placeNorm = placeResult.normResult || {};
      if (safeGeoEnrich.fullAddress) placeNorm.fullAddress = safeGeoEnrich.fullAddress;
      newPlaceId = createPlace(
        placeNorm,
        safeGeoEnrich.province || '',
        safeGeoEnrich.district || '',
        safeGeoEnrich.subDistrict || '',
        safeGeoEnrich.postcode || ''
      );
      targetPlaceId = newPlaceId;
      logInfo('MatchEngine', 'resolveAndPersistMerge_: สร้าง Place ใหม่ — ' + newPlaceId);
    }
  }

  // [NEW v5.5.046 — Self-Healing Alias 3.1]
  //   Admin ยืนยัน MERGE_TO_CANDIDATE = Human-in-the-loop ที่แม่นยำที่สุด
  //   เรียนรู้ typo pattern โดยสร้าง Global Alias จากชื่อดิบ → masterUuid ทันที
  //   รอบ Match Engine ถัดไปจะจับคู่ได้เองโดยไม่ต้องเข้า Q_REVIEW ซ้ำ
  //   [Rule 12] ห้ามให้ alias-learning ทำให้ MERGE decision ล้มเหลว
  // [V6.0.003] Pass verified_by + review_id to createGlobalAlias — audit trail
  //   - verified_by: ดึงจาก Session.getEffectiveUser().getEmail() (อาจว่างใน WebApp context)
  //   - review_id:   ไม่มีใน signature ปัจจุบัน (resolveAndPersist_ → resolveAndPersistMerge_
  //     ไม่ได้รับ reviewId จาก caller) — pass เป็น '' ไปก่อน, ปรับ caller chain ภายหลัง
  try {
    // [V6.0.003] ดึง email ผู้ Reviewer สำหรับ verified_by field
    let verifiedBy = '';
    try {
      verifiedBy = Session.getEffectiveUser().getEmail() || '';
    } catch (e) {
      /* WebApp context — Session may not be available */
    }

    if (targetPersonId && srcObj.rawPersonName) {
      const personUuid = getPersonMasterUuid_(targetPersonId);
      if (personUuid) {
        const newAliasId = createGlobalAlias(
          personUuid,
          srcObj.rawPersonName,
          'PERSON',
          100,
          'HUMAN',
          verifiedBy,
          optReviewId || ''
        );
        if (newAliasId) {
          logInfo('MatchEngine', 'Self-Healing Alias: PERSON "' + srcObj.rawPersonName + '" → ' + targetPersonId);
        }
      }
    }
    if (targetPlaceId && srcObj.rawPlaceName) {
      const placeUuid = getPlaceMasterUuid_(targetPlaceId);
      if (placeUuid) {
        const newAliasId = createGlobalAlias(
          placeUuid,
          srcObj.rawPlaceName,
          'PLACE',
          100,
          'HUMAN',
          verifiedBy,
          optReviewId || ''
        );
        if (newAliasId) {
          logInfo('MatchEngine', 'Self-Healing Alias: PLACE "' + srcObj.rawPlaceName + '" → ' + targetPlaceId);
        }
      }
    }
  } catch (aliasErr) {
    logError('MatchEngine', 'Self-Healing Alias ล้มเหลว (ไม่กระทบ MERGE): ' + aliasErr.message, aliasErr);
  }

  // [V6.0.053] Persist semantic notes from current source row → SYS_NOTES
  //   Previously MERGE path skipped this — notes (phone, COD, time, etc.) from
  //   the current source row were lost. Now stored against target entity IDs.
  persistSemanticNotesForEntity_(
    srcObj.rawPersonName,
    targetPersonId,
    srcObj.rawPlaceName,
    srcObj.rawAddress,
    targetPlaceId
  );

  // Geo + Dest resolution
  let targetGeoId = null;
  let targetDestId = null;
  if (srcObj.hasGeo) {
    const geoResult = resolveGeo(srcObj.rawLat, srcObj.rawLng);
    targetGeoId = geoResult ? geoResult.geoId : null;
  }
  if (targetPersonId || targetPlaceId) {
    const destResult = resolveDestination(targetPersonId, targetPlaceId, targetGeoId);
    if (destResult && (destResult.status === 'FOUND' || destResult.status === 'PARTIAL_MATCH')) {
      targetDestId = destResult.destId;
    }
  }

  const factResult = upsertFactDelivery(srcObj, targetPersonId, targetPlaceId, targetGeoId, targetDestId, {
    action: 'MERGE_TO_CANDIDATE',
    reason: 'REVIEW_MERGE_APPROVED',
    confidence: 90,
    priority: 0
  });

  if (factResult && factResult.isNew && factResult.rowData) {
    return { factRowData: factResult.rowData };
  }
  return null;
}

/**
 * resolveAndPersistCreate_ — [REF-001] CREATE_NEW path within resolveAndPersist_
 * @param {Object} srcObj
 * @return {Object|null} { factRowData } or null
 */
function resolveAndPersistCreate_(srcObj) {
  const rawPerson = srcObj.rawPersonName || '';
  const rawPlace = srcObj.rawPlaceName || '';
  const rawAddr = srcObj.rawAddress || '';

  // Geo enrichment
  let geoEnrich = null;
  try {
    geoEnrich = getEnrichedGeoData(rawAddr, rawPlace);
  } catch (geoErr) {
    logDebug('MatchEngine', 'resolveAndPersistCreate_: getEnrichedGeoData ข้าม — ' + geoErr.message);
  }
  const safeGeoEnrich = geoEnrich || {};

  // Person
  const personResult = resolvePerson(rawPerson);
  let personId = personResult.personId;
  if (!personId) personId = createPerson(personResult.normResult);

  // Place
  const placeResult = resolvePlace(rawPlace, rawAddr);
  let placeId = placeResult.placeId;
  if (!placeId) {
    const placeNorm = placeResult.normResult || {};
    if (safeGeoEnrich.fullAddress) placeNorm.fullAddress = safeGeoEnrich.fullAddress;
    placeId = createPlace(
      placeNorm,
      safeGeoEnrich.province,
      safeGeoEnrich.district,
      safeGeoEnrich.subDistrict,
      safeGeoEnrich.postcode
    );
  }

  // [V6.0.002 → V6.0.053] Store structured notes → SYS_NOTES
  //   Refactored to use persistSemanticNotesForEntity_ helper for consistency
  //   with MERGE and AUTO_MATCH paths. Same behavior, less duplication.
  persistSemanticNotesForEntity_(srcObj.rawPersonName, personId, srcObj.rawPlaceName, srcObj.rawAddress, placeId);

  // Geo
  let geoId = null;
  if (srcObj.hasGeo) {
    const geoRes = resolveGeo(srcObj.rawLat, srcObj.rawLng);
    geoId = geoRes.geoId;
    if (!geoId) {
      geoId = createGeoPoint(
        srcObj.rawLat,
        srcObj.rawLng,
        'manual',
        safeGeoEnrich.fullAddress || rawAddr,
        safeGeoEnrich.province,
        safeGeoEnrich.district,
        placeId
      );
    }
  }

  // Destination
  let destId = null;
  if (geoId && (personId || placeId)) {
    // [V6.0.012 P1.1] Dedup: resolve existing destination first before creating new
    //   เดิม: เรียก createDestination() ทันที → ถ้า (personId, placeId, geoId) ชุดเดิมมีอยู่แล้ว
    //         จะสร้าง duplicate destination row (เกิดจาก reprocess review queue หลายรอบ)
    //   ใหม่: เรียก resolveDestination() ก่อน ถ้าเจอ → reuse destId, ไม่สร้างใหม่
    //   Pattern เดียวกับ handleAutoMatch_ และ handleCreateNew_
    if (typeof resolveDestination === 'function') {
      try {
        const existingDestResult = resolveDestination(personId, placeId, geoId);
        if (
          existingDestResult &&
          (existingDestResult.status === 'FOUND' || existingDestResult.status === 'PARTIAL_MATCH')
        ) {
          destId = existingDestResult.destId;
          logDebug('MatchEngine', 'resolveAndPersistCreate_: reused existing destination ' + destId);
        }
      } catch (destErr) {
        // Non-fatal — fallback to createDestination below
        logDebug(
          'MatchEngine',
          'resolveAndPersistCreate_: resolveDestination failed, will create new — ' + destErr.message
        );
      }
    }
    if (!destId) {
      destId = createDestination(personId, placeId, geoId, srcObj.rawLat, srcObj.rawLng, null);
    }
  }

  const factResult = upsertFactDelivery(srcObj, personId, placeId, geoId, destId, {
    action: 'CREATE_NEW',
    reason: 'REVIEW_APPROVED',
    confidence: 95,
    priority: 0
  });

  if (factResult && factResult.isNew && factResult.rowData) {
    return { factRowData: factResult.rowData };
  }
  return null;
}

/**
 * reprocResolveOrCreatePersonForReview_ — [REF-001] Resolve-or-create Person สำหรับ reproc flow
 *   ไม่ upsert FACT_DELIVERY — คืนเฉพาะ personId ให้ caller ใช้ mutate factData ภายหลัง
 *   Behavior mirror ของ Group B inline logic (12_ReviewService.gs:1361-1372)
 * @param {string} rawPerson - raw person name from review row
 * @return {{personId: string|null, error: string|null}}
 */
function reprocResolveOrCreatePersonForReview_(rawPerson) {
  if (!rawPerson) return { personId: null, error: null };
  try {
    const pRes = resolvePerson(rawPerson);
    if (pRes && pRes.status === 'FOUND' && pRes.personId) {
      return { personId: pRes.personId, error: null };
    }
    if (pRes && pRes.normResult) {
      const newPersonId = createPerson(pRes.normResult);
      return { personId: newPersonId, error: null };
    }
    return { personId: null, error: null };
  } catch (e) {
    return { personId: null, error: e.message };
  }
}

/**
 * reprocResolveOrCreatePlaceForReview_ — [REF-001] Resolve-or-create Place สำหรับ reproc flow
 *   Behavior mirror ของ Group B inline logic (12_ReviewService.gs:1374-1386)
 *
 *   [FIX V5.5.045 Issue #26] เพิ่ม geo enrichment ก่อน createPlace
 *     เดิมส่ง '' ทั้ง 4 fields → place ใหม่ไม่มี province/district/postcode
 *     ทำให้ Match Engine Rule 3 (GEO_PROVINCE_CONFLICT) ไม่ทำงาน + reporting ไม่ครบ
 *     ตอนนี้ใช้ getEnrichedGeoData() เหมือน flow หลัก (executeDecision บรรทัด 1193)
 *
 * @param {string} rawPlace - raw place name
 * @param {string} rawAddr - raw address (fallback, ใช้สำหรับ geo enrichment)
 * @return {{placeId: string|null, error: string|null}}
 */
function reprocResolveOrCreatePlaceForReview_(rawPlace, rawAddr) {
  const placeInput = rawPlace || rawAddr || '';
  if (!placeInput) return { placeId: null, error: null };
  try {
    // [FIX BUG-AUDIT-003 V5.5.042] ส่ง rawAddr ต่อให้ resolvePlace แทนการทิ้งเป็น ''
    //   เหตุผล: resolvePlace ใช้ rawAddress ใน extractProvince_() + findPlaceCandidates()
    //   เพื่อกรอง candidate ตามจังหวัด — ถ้าส่ง '' ระบบจะเลือก place ผิดจังหวัดแบบเงียบ
    //   กระทบ flow: Reprocess Review Queue (Group A/B/C ใน reprocessReviewQueue)
    const plRes = resolvePlace(placeInput, rawAddr || '');
    if (plRes && plRes.status === 'FOUND' && plRes.placeId) {
      return { placeId: plRes.placeId, error: null };
    }
    if (plRes && plRes.normResult) {
      // [FIX V5.5.045 Issue #26] เพิ่ม geo enrichment เหมือน flow หลัก (executeDecision)
      //   เดิม: createPlace(plRes.normResult, '', '', '', '') → place ใหม่ไม่มี province/district/postcode
      //   ใหม่: ดึง enrichment จาก rawAddr ผ่าน getEnrichedGeoData() (ใช้ RAM cache)
      //   Trade-off: +50-100ms per call (acceptable เพราะใช้ loadCachedGeoRowsForPlace_ cache)
      //   Fallback: ถ้า getEnrichedGeoData fail → ใช้ค่าว่าง (preserve old behavior) + log warn
      const geoEnrich = { province: '', district: '', subDistrict: '', postcode: '' };
      if (typeof getEnrichedGeoData === 'function' && rawAddr) {
        try {
          const enrichResult = getEnrichedGeoData(rawAddr);
          if (enrichResult) {
            geoEnrich.province = enrichResult.province || '';
            geoEnrich.district = enrichResult.district || '';
            geoEnrich.subDistrict = enrichResult.subDistrict || '';
            geoEnrich.postcode = enrichResult.postcode || '';
          }
        } catch (enrichErr) {
          // ไม่ block flow — ใช้ค่าว่าง + log warn เพื่อให้วินิจฉัยได้
          logWarn(
            'MatchEngine',
            'reprocResolveOrCreatePlaceForReview_: getEnrichedGeoData failed - ' +
              enrichErr.message +
              ' (continuing with empty geoEnrich)'
          );
        }
      }
      const newPlaceId = createPlace(
        plRes.normResult,
        geoEnrich.province,
        geoEnrich.district,
        geoEnrich.subDistrict,
        geoEnrich.postcode
      );
      return { placeId: newPlaceId, error: null };
    }
    return { placeId: null, error: null };
  } catch (e) {
    return { placeId: null, error: e.message };
  }
}

/**
 * reprocCreateDestinationForReview_ — [REF-001] Create Destination สำหรับ reproc flow
 *   Behavior mirror ของ createDestination() calls ใน Group A/B/C
 *   ไม่ upsert FACT_DELIVERY — คืนเฉพาะ destId
 * @param {string|null} personId
 * @param {string|null} placeId
 * @param {string} geoId
 * @param {number} rawLat
 * @param {number} rawLng
 * @return {{destId: string|null, error: string|null}}
 */
function reprocCreateDestinationForReview_(personId, placeId, geoId, rawLat, rawLng) {
  if (!((personId || placeId) && geoId)) return { destId: null, error: null };
  try {
    const newDestId = createDestination(personId, placeId, geoId, rawLat, rawLng, '');
    return { destId: newDestId, error: null };
  } catch (e) {
    return { destId: null, error: e.message };
  }
}
