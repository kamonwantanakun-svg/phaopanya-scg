/**
 * VERSION: 6.0.069
 * FILE: 10f_MatchAliasEnrichment.gs
 * LMDS V6.0 — Match Alias Enrichment (Single Writer Pattern for M_ALIAS)
 * ===================================================
 * PURPOSE:
 *   Extracted from 10_MatchEngine.gs in V6.0.050 for SRP + maintainability.
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 03_SetupSheets.gs, 14_Utils.gs (core)
 *     - 05_NormalizeService.gs (normalizeForCompare)
 *     - 06_PersonService.gs, 07_PlaceService.gs (entity lookups)
 *     - 10_MatchEngine.gs (loadAllGeos_, loadAllPersons_, loadAllPlaces_, loadAllAliases_)
 *   CALLS: (Invokes)
 *     - normalizeForCompare()                  → 05_NormalizeService.gs
 *     - loadAllPersons_() / loadAllPlaces_()   → 10_MatchEngine.gs (group 1 helpers)
 *     - loadAllGlobalAliases_()                → 21_AliasService.gs
 *     - getSheetByNameSafe_() / writeLog_()    → 03_SetupSheets.gs
 *   EXPORTS TO:
 *     - 10_MatchEngine.gs (flushBatches_ calls autoEnrichAliasesFromFactBatch_)
 *     - 12_ReviewService.gs (submitReviewDecision calls autoEnrichAliasesFromFactBatch_ after approval)
 *   SHEETS ACCESSED:
 *     - SHEET.M_ALIAS (Read/Write — global aliases)
 *     - SHEET.M_PERSON_ALIAS (Read/Write — person variant names)
 *     - SHEET.M_PLACE_ALIAS (Read/Write — place variant addresses)
 *     - SHEET.FACT_DELIVERY (Read — source of truth for canonical names)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 1 — Master data building (normalize, persons, places, geo, match engine, aliases)
 * ===================================================
 */

// ============================================================
// SECTION: Alias Enrichment — Single Writer Pattern for M_ALIAS
// 🟩 จุดเขียนเดียวสำหรับ M_ALIAS — ทุก alias เกิดที่นี่เท่านั้น
// ============================================================

// [FIX CRIT-018] Module-level cache สำหรับ alias enrichment context
// ลดการอ่านชีตซ้ำซ้อนเมื่อ flushBatches_ เรียก autoEnrich หลายครั้งใน execution เดียวกัน
let _ALIAS_ENRICHMENT_CONTEXT = null;

/**
 * [FIX CRIT-005] เพิ่ม entity ใหม่เข้า alias enrichment context แบบ incremental
 * เรียกจาก handleCreateNew_ หลังสร้าง Person/Place สำเร็จ
 * ทำให้ entity ใหม่มี alias ทันทีใน batch flush รอบเดียวกัน
 * @param {string} entityType - 'PERSON' หรือ 'PLACE'
 * @param {string} entityId - personId หรือ placeId
 * @param {string} masterUuid - UUID v4
 * @param {string} canonical - Canonical name
 * @param {string} normalized - Normalized name
 */
function addEntityToEnrichmentContext_(entityType, entityId, masterUuid, canonical, normalized) {
  if (!_ALIAS_ENRICHMENT_CONTEXT) return;
  if (entityType === 'PERSON' && entityId) {
    _ALIAS_ENRICHMENT_CONTEXT.personMap[entityId] = {
      canonical: canonical,
      normalized: normalized,
      masterUuid: masterUuid
    };
  } else if (entityType === 'PLACE' && entityId) {
    _ALIAS_ENRICHMENT_CONTEXT.placeMap[entityId] = {
      canonical: canonical,
      normalized: normalized,
      masterUuid: masterUuid
    };
  }
}

/**
 * resetAliasEnrichmentContext_ — [V6.0.052] Reset the module-level alias context
 *
 * Wrapper สำหรับล้าง _ALIAS_ENRICHMENT_CONTEXT ให้เป็น null
 * เรียกจาก 10_MatchEngine.gs runMatchEngine() ที่ 3 จุด:
 *   - preflight failed → early return
 *   - empty pendingRows → early return
 *   - finally block (เคลียร์เมื่อ execution จบ)
 *
 * ประโยชน์: ถ้าวันหนึ่งโครงสร้าง context เปลี่ยน หรือต้องเพิ่ม side effect
 * (เช่น log, flush cache) แก้จุดเดียวพอ ไม่ต้องไล่หา 3 จุดข้ามไฟล์
 * เป็นการลด coupling surface ตามแนวทาง releaseScriptLock_() pattern
 *
 * [V6.0.052] Previously 3 call sites in 10_MatchEngine.gs used raw
 *   `_ALIAS_ENRICHMENT_CONTEXT = null;` — now updated to use this wrapper.
 */
function resetAliasEnrichmentContext_() {
  _ALIAS_ENRICHMENT_CONTEXT = null;
}

/**
 * autoEnrichAliasesFromFactBatch_ — [REWRITE v5.4.001] Single Writer Pattern
 * ============================================================
 * 🟩 จุดเขียนเดียวสำหรับ M_ALIAS — ทุก alias เกิดที่นี่เท่านั้น
 * ============================================================
 * ทำงานอัตโนมัติเมื่อมี Fact ใหม่ → สร้าง alias ใน:
 *   1. M_ALIAS (Global) — PERSON canonical(100) + variant(95), PLACE canonical(100) + variant(90)
 *   2. M_PERSON_ALIAS  — variant name (ถ้า ≠ canonical)
 *   3. M_PLACE_ALIAS   — variant address (ถ้า ≠ canonical)
 *
 * ❌ ไม่เรียก createGlobalAlias() / syncAliasToEntityTable_()
 * ❌ ไม่เรียก createPersonAlias() / createPlaceAlias()
 * ✅ เขียน Batch ตรงทั้ง 3 ชีตเอง — เร็ว + ไม่มี circular dependency
 * ✅ รวม Canonical Name เข้า M_ALIAS ด้วย (เดิมข้าม → ทำให้ค้นไม่เจอ)
 */
function autoEnrichAliasesFromFactBatch_(factBatch) {
  if (!factBatch || factBatch.length === 0) return;

  try {
    // 1. เตรียมข้อมูล (Extract Data Loading)
    const context = prepareAliasEnrichmentData_();

    // 2. ประมวลผลหา Alias ใหม่ (Extract Processing Logic)
    const results = processFactRowsForAliases_(factBatch, context);

    // 3. บันทึกผลลงฐานข้อมูล (Extract Writing Logic)
    commitAliasChanges_(results, context);

    // 4. Log
    const totalGlobal = results.globalAliasRows.length;
    const totalPerson = results.personAliasRows.length;
    const totalPlace = results.placeAliasRows.length;

    if (totalGlobal > 0 || totalPerson > 0 || totalPlace > 0) {
      logInfo(
        'MatchEngine',
        'Auto-Enrich (Single Writer v5.4.001): ' +
          'M_ALIAS=' +
          totalGlobal +
          ' M_PERSON_ALIAS=' +
          totalPerson +
          ' M_PLACE_ALIAS=' +
          totalPlace
      );
    }
  } catch (err) {
    logError('autoEnrichAliasesFromFactBatch_', err.message, err);
    throw err;
  }
}

/**
 * [Helper 1] โหลดและเตรียม Map ข้อมูลจาก Sheets
 * @returns {Object} context object พร้อม entity maps และ alias sets
 */
function prepareAliasEnrichmentData_() {
  // [FIX CRIT-018] ใช้ cached context ถ้ามีอยู่แล้ว — ลดการอ่านชีตซ้ำซ้อน
  if (_ALIAS_ENRICHMENT_CONTEXT) return _ALIAS_ENRICHMENT_CONTEXT;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Person map: personId → { canonical, normalized, masterUuid }
  const allPersons = loadAllPersons_();
  const personMap = {};
  allPersons.forEach(function (p) {
    if (p.personId && p.masterUuid) {
      personMap[p.personId] = {
        canonical: p.canonical,
        normalized: p.normalized,
        masterUuid: p.masterUuid
      };
    }
  });

  // Place map: placeId → { canonical, normalized, masterUuid }
  const allPlaces = loadAllPlaces_();
  const placeMap = {};
  allPlaces.forEach(function (p) {
    if (p.placeId && p.masterUuid) {
      placeMap[p.placeId] = {
        canonical: p.canonical,
        normalized: p.normalized,
        masterUuid: p.masterUuid
      };
    }
  });

  // === 2. โหลด Alias ที่มีอยู่แล้ว เพื่อ Dedup ===
  const dedupSets = matchBuildDedupSets_();
  const existingPersonAliasSet = dedupSets.existingPersonAliasSet;
  const existingPlaceAliasSet = dedupSets.existingPlaceAliasSet;
  const existingGlobalAliasSet = dedupSets.existingGlobalAliasSet;
  const mAliasSheet = ss.getSheetByName(SHEET.M_ALIAS);

  const contextObj = {
    ss: ss,
    personMap: personMap,
    placeMap: placeMap,
    existingPersonAliasSet: existingPersonAliasSet,
    existingPlaceAliasSet: existingPlaceAliasSet,
    existingGlobalAliasSet: existingGlobalAliasSet,
    mAliasSheet: mAliasSheet
  };

  // [FIX CRIT-018] Cache the context for reuse within same execution
  _ALIAS_ENRICHMENT_CONTEXT = contextObj;

  return contextObj;
}

/**
 * matchBuildDedupSets_ — [F-11] สร้าง Dedup Sets สำหรับ alias enrichment
 * แยกออกจาก prepareAliasEnrichmentData_() เพื่อ SRP
 * @returns {Object} { existingPersonAliasSet, existingPlaceAliasSet, existingGlobalAliasSet }
 */
function matchBuildDedupSets_() {
  // M_PERSON_ALIAS dedup: "personId::normalized"
  const existingPersonAliasSet = new Set();
  const existingPersonAliasData = loadAllAliases_();
  existingPersonAliasData.forEach(function (r) {
    if (!r[PERSON_ALIAS_IDX.ACTIVE_FLAG]) return;
    const pId = String(r[PERSON_ALIAS_IDX.PERSON_ID] || '').trim();
    const aNorm = normalizeForCompare(r[PERSON_ALIAS_IDX.ALIAS_NAME]);
    if (pId && aNorm) existingPersonAliasSet.add(pId + '::' + aNorm);
  });

  // M_PLACE_ALIAS dedup: "placeId::normalized"
  const existingPlaceAliasSet = new Set();
  const existingPlaceAliasData = loadAllPlaceAliases_();
  existingPlaceAliasData.forEach(function (r) {
    if (!r[PLACE_ALIAS_IDX.ACTIVE_FLAG]) return;
    const plId = String(r[PLACE_ALIAS_IDX.PLACE_ID] || '').trim();
    const aNorm = normalizeForCompare(r[PLACE_ALIAS_IDX.ALIAS_NAME]);
    if (plId && aNorm) existingPlaceAliasSet.add(plId + '::' + aNorm);
  });

  // M_ALIAS dedup: "ENTITY_TYPE::masterUuid::normalized"
  // [PERF-008] ใช้ buildGlobalAliasDedupSet_() แทนการอ่าน Sheet ตรง — ใช้ cache ที่มีอยู่แล้ว
  const existingGlobalAliasSet = buildGlobalAliasDedupSet_();

  return {
    existingPersonAliasSet: existingPersonAliasSet,
    existingPlaceAliasSet: existingPlaceAliasSet,
    existingGlobalAliasSet: existingGlobalAliasSet
  };
}

/**
 * [Helper 2] วนลูปตรวจสอบ Fact Rows และสร้าง Row ใหม่
 * @param {Array} factBatch - แถวข้อมูลจาก M_FACT
 * @param {Object} context - ข้อมูลที่เตรียมจาก prepareAliasEnrichmentData_()
 * @returns {Object} results object พร้อม rows ใหม่ทั้ง 3 ประเภท
 */
function processFactRowsForAliases_(factBatch, context) {
  const personMap = context.personMap;
  const placeMap = context.placeMap;

  const newGlobalAliasRows = []; // M_ALIAS
  const newPersonAliasRows = []; // M_PERSON_ALIAS
  const newPlaceAliasRows = []; // M_PLACE_ALIAS
  const now = new Date();

  factBatch.forEach(function (r) {
    const pId = String(r[FACT_IDX.PERSON_ID] || '').trim();
    const plId = String(r[FACT_IDX.PLACE_ID] || '').trim();
    const pInfo = pId ? personMap[pId] : null;
    const plInfo = plId ? placeMap[plId] : null;

    // ─── PERSON: Canonical + Variant ───
    if (pInfo) {
      matchEnrichPersonAliases_(r, pInfo, context, newGlobalAliasRows, newPersonAliasRows, now);
    }

    // ─── PLACE: Canonical + Variant ───
    if (plInfo) {
      matchEnrichPlaceAliases_(r, plInfo, context, newGlobalAliasRows, newPlaceAliasRows, now);
    }

    // [ADD v5.5.014] ─── DRIVER VERIFIED: ชื่อจริง/ที่อยู่จริง → M_ALIAS ───
    // ถ้ามี "ชื่อจริง" (col 32) และ Person match ได้ → สร้าง alias "ชื่อจริง" → master_uuid
    // ถ้ามี "ที่อยู่จริง" (col 33) และ Place match ได้ → สร้าง alias "ที่อยู่จริง" → master_uuid
    const driverVerifiedName = String(r[FACT_IDX.DRIVER_VERIFIED_NAME] || '').trim();
    const driverVerifiedAddr = String(r[FACT_IDX.DRIVER_VERIFIED_ADDR] || '').trim();

    if (driverVerifiedName && pInfo) {
      // สร้าง alias สำหรับ "ชื่อจริง" → Person master_uuid
      matchEnrichEntityAliases_(
        'PERSON',
        pId,
        pInfo.masterUuid,
        pInfo.canonical,
        pInfo.normalized,
        driverVerifiedName,
        100, // confidence=100 เพราะคนขับยืนยันเอง
        {
          existingGlobalAliasSet: context.existingGlobalAliasSet,
          entityAliasSet: context.existingPersonAliasSet,
          source: 'DRIVER_VERIFIED'
        },
        newGlobalAliasRows,
        newPersonAliasRows,
        now
      );
    }

    if (driverVerifiedAddr && plInfo) {
      // สร้าง alias สำหรับ "ที่อยู่จริง" → Place master_uuid
      matchEnrichEntityAliases_(
        'PLACE',
        plId,
        plInfo.masterUuid,
        plInfo.canonical,
        plInfo.normalized,
        driverVerifiedAddr,
        100, // confidence=100 เพราะคนขับยืนยันเอง
        {
          existingGlobalAliasSet: context.existingGlobalAliasSet,
          entityAliasSet: context.existingPlaceAliasSet,
          source: 'DRIVER_VERIFIED'
        },
        newGlobalAliasRows,
        newPlaceAliasRows,
        now
      );
    }
  });

  return {
    globalAliasRows: newGlobalAliasRows,
    personAliasRows: newPersonAliasRows,
    placeAliasRows: newPlaceAliasRows
  };
}

/**
 * matchEnrichEntityAliases_ — [REF-015] Generic alias enricher for both Person and Place
 * Replaces duplicate logic in matchEnrichPersonAliases_ and matchEnrichPlaceAliases_.
 * @param {string} entityType - 'PERSON' or 'PLACE'
 * @param {string} entityId - person_id or place_id
 * @param {string} masterUuid - master UUID for the entity
 * @param {string} canonical - Canonical name (clean version)
 * @param {string} canonicalNorm - Normalized canonical name
 * @param {string} rawVariant - Raw variant name/address from source
 * @param {number} variantConfidence - Confidence score for variant (95 for PERSON, 90 for PLACE)
 * @param {Object} context - { existingGlobalAliasSet, entityAliasSet, source }
 * @param {Array} globalRows - M_ALIAS accumulator
 * @param {Array} entityRows - M_PERSON_ALIAS or M_PLACE_ALIAS accumulator
 * @param {Date} now - timestamp
 */
function matchEnrichEntityAliases_(
  entityType,
  entityId,
  masterUuid,
  canonical,
  canonicalNorm,
  rawVariant,
  variantConfidence,
  context,
  globalRows,
  entityRows,
  now
) {
  const entityAliasSet = context.entityAliasSet;

  // 3a/3c. Canonical Name → M_ALIAS (confidence 100)
  if (canonicalNorm && canonicalNorm.length >= 2) {
    const canonKey = entityType + '::' + masterUuid + '::' + canonicalNorm;
    if (!context.existingGlobalAliasSet.has(canonKey)) {
      context.existingGlobalAliasSet.add(canonKey);
      // [FIX V6.0.007] Push 11 columns to match SCHEMA.M_ALIAS (V6.0.003 added 3 cols)
      //   0-7: alias_id, master_uuid, variant_name, entity_type, confidence, source, created_at, active_flag
      //   8-10: verified_by, review_id, verified_at (empty for AUTO_ENRICH — not human-verified)
      //   Previous bug: pushed only 8 cols → Sheets API threw
      //   "จำนวนคอลัมน์ในข้อมูลไม่ตรงกับจำนวนคอลัมน์ในช่วง ข้อมูลมี 8 คอลัมน์ แต่ช่วงดังกล่าวมี 11 คอลัมน์"
      globalRows.push([
        generateShortId('A'), // [0] alias_id
        masterUuid, // [1] master_uuid
        canonical, // [2] variant_name
        entityType, // [3] entity_type
        100, // [4] confidence (canonical = 100)
        context.source || 'AUTO_ENRICH_FACT', // [5] source
        now, // [6] created_at
        true, // [7] active_flag
        '', // [8] verified_by (empty — AUTO_ENRICH is not human-verified)
        '', // [9] review_id (empty — not from Q_REVIEW)
        '' // [10] verified_at (empty — not verified)
      ]);
    }
  }

  // 3b/3d. Variant → M_ALIAS + Entity Alias
  if (rawVariant && rawVariant.length >= 2) {
    const rawNorm = normalizeForCompare(rawVariant);
    if (rawNorm && rawNorm.length >= 2) {
      // M_ALIAS variant
      const variantKey = entityType + '::' + masterUuid + '::' + rawNorm;
      if (!context.existingGlobalAliasSet.has(variantKey)) {
        context.existingGlobalAliasSet.add(variantKey);
        // [FIX V6.0.007] Push 11 columns to match SCHEMA.M_ALIAS (V6.0.003 added 3 cols)
        //   Same fix as canonical push above — must include verified_by/review_id/verified_at
        globalRows.push([
          generateShortId('A'), // [0] alias_id
          masterUuid, // [1] master_uuid
          rawVariant, // [2] variant_name
          entityType, // [3] entity_type
          variantConfidence, // [4] confidence (95 for PERSON, 90 for PLACE)
          context.source || 'AUTO_ENRICH_FACT', // [5] source
          now, // [6] created_at
          true, // [7] active_flag
          '', // [8] verified_by (empty — AUTO_ENRICH is not human-verified)
          '', // [9] review_id (empty — not from Q_REVIEW)
          '' // [10] verified_at (empty — not verified)
        ]);
      }

      // Entity-specific alias (เฉพาะ variant ≠ canonical)
      if (rawNorm !== canonicalNorm) {
        const eaKey = entityId + '::' + rawNorm;
        if (!entityAliasSet.has(eaKey)) {
          entityAliasSet.add(eaKey);
          const entityPrefix = entityType === 'PERSON' ? 'PA' : 'PLA';
          entityRows.push([generateShortId(entityPrefix), entityId, rawVariant, variantConfidence, now, true]);
        }
      }
    }
  }
}

/**
 * matchEnrichPersonAliases_ — [REF-015] Thin wrapper → matchEnrichEntityAliases_
 * Preserves original signature for backward compatibility.
 * @param {Array} factRow - แถวข้อมูลจาก M_FACT
 * @param {Object} pInfo - { canonical, normalized, masterUuid } จาก personMap
 * @param {Object} context - dedup sets + maps
 * @param {Array} globalRows - shared M_ALIAS accumulator (mutated in-place)
 * @param {Array} personRows - shared M_PERSON_ALIAS accumulator (mutated in-place)
 * @param {Date} now - timestamp
 */
function matchEnrichPersonAliases_(factRow, pInfo, context, globalRows, personRows, now) {
  const pId = String(factRow[FACT_IDX.PERSON_ID] || '').trim();
  const rawPersonName = String(factRow[FACT_IDX.SHIP_TO_NAME] || '').trim();
  matchEnrichEntityAliases_(
    'PERSON',
    pId,
    pInfo.masterUuid,
    pInfo.canonical,
    pInfo.normalized,
    rawPersonName,
    95,
    {
      existingGlobalAliasSet: context.existingGlobalAliasSet,
      entityAliasSet: context.existingPersonAliasSet,
      source: 'AUTO_ENRICH_FACT'
    },
    globalRows,
    personRows,
    now
  );
}

/**
 * matchEnrichPlaceAliases_ — [REF-015] Thin wrapper → matchEnrichEntityAliases_
 * Preserves original signature for backward compatibility.
 * @param {Array} factRow - แถวข้อมูลจาก M_FACT
 * @param {Object} plInfo - { canonical, normalized, masterUuid } จาก placeMap
 * @param {Object} context - dedup sets + maps
 * @param {Array} globalRows - shared M_ALIAS accumulator (mutated in-place)
 * @param {Array} placeRows - shared M_PLACE_ALIAS accumulator (mutated in-place)
 * @param {Date} now - timestamp
 */
function matchEnrichPlaceAliases_(factRow, plInfo, context, globalRows, placeRows, now) {
  const plId = String(factRow[FACT_IDX.PLACE_ID] || '').trim();
  const rawPlaceAddr = String(factRow[FACT_IDX.SHIP_TO_ADDR] || '').trim();
  matchEnrichEntityAliases_(
    'PLACE',
    plId,
    plInfo.masterUuid,
    plInfo.canonical,
    plInfo.normalized,
    rawPlaceAddr,
    90,
    {
      existingGlobalAliasSet: context.existingGlobalAliasSet,
      entityAliasSet: context.existingPlaceAliasSet,
      source: 'AUTO_ENRICH_FACT'
    },
    globalRows,
    placeRows,
    now
  );
}

/**
 * [Helper 3] บันทึกข้อมูลลง Sheet ทั้ง 3 แบบ Batch
 * [F-12] Delegates to matchCommit* helpers for SRP
 * @param {Object} results - ผลลัพธ์จาก processFactRowsForAliases_()
 * @param {Object} context - Context ที่เตรียมไว้
 */
function commitAliasChanges_(results, context) {
  matchCommitGlobalAlias_(context.mAliasSheet, results.globalAliasRows);
  matchCommitPersonAlias_(context.ss, results.personAliasRows, context);
  matchCommitPlaceAlias_(context.ss, results.placeAliasRows, context);

  // [FIX Phase-B #16] Cleanup stale canonical aliases
  //   หลังเขียน canonical alias ใหม่ → deactivate canonical alias เก่าที่ variant_name ≠ canonical ปัจจุบัน
  //   ป้องกัน stale canonical alias หลงเหลือใน M_ALIAS หลัง user แก้ canonical_name ใน M_PERSON/M_PLACE
  cleanupStaleCanonicalAliases_(results.globalAliasRows, context);
}

/**
 * cleanupStaleCanonicalAliases_ — [FIX Phase-B #16] Deactivate stale canonical aliases
 *   ปัญหา: autoEnrichAliasesFromFactBatch_ สร้าง canonical alias ทุก batch — ถ้า user แก้ canonical_name manual
 *          → alias เก่ายัง active อยู่ → ค้นเจอ alias เก่าที่ variant_name ≠ canonical ปัจจุบัน → match ผิด
 *   วิธีแก้: หลังเขียน canonical alias ใหม่ → ค้นหา alias เก่าที่ canonical ≠ ปัจจุบัน → set active_flag=false
 *   Target criteria (only these are deactivated):
 *     - Same masterUuid + entityType
 *     - confidence == 100 (canonical)
 *     - active_flag == true
 *     - source starts with 'AUTO_ENRICH' (preserve DRIVER_VERIFIED / MANUAL / MIGRATION aliases)
 *     - normalized variant_name ≠ current canonical_norm
 *   Performance: 1 read of M_ALIAS + 1 batched getRangeList().setValue(false) per batch
 * @param {Array<Array>} newGlobalAliasRows - rows being written this batch (from results.globalAliasRows)
 * @param {Object} context - context with mAliasSheet
 */
function cleanupStaleCanonicalAliases_(newGlobalAliasRows, context) {
  try {
    if (!newGlobalAliasRows || newGlobalAliasRows.length === 0) return;
    if (typeof loadGlobalAliasAll_ !== 'function') return; // guard — AliasService must be loaded

    // 1. Collect canonical aliases being written this batch
    //    globalRow format: [aliasId, masterUuid, variantName, entityType, confidence, source, createdAt, activeFlag]
    // [FIX V5.5.048] ใช้ ALIAS_IDX.* (จาก 01_Config.gs) แทน magic numbers row[1]/row[2]/row[3]/row[4] — Law 1 (No Hardcoded Index)
    const canonicalMap = {}; // key: "entityType::masterUuid" → canonicalNorm (current canonical)
    newGlobalAliasRows.forEach(function (row) {
      const confidence = Number(row[ALIAS_IDX.CONFIDENCE] || 0);
      if (confidence !== 100) return; // only canonical aliases
      const masterUuid = String(row[ALIAS_IDX.MASTER_UUID] || '').trim();
      const entityType = String(row[ALIAS_IDX.ENTITY_TYPE] || '').trim();
      const variantName = String(row[ALIAS_IDX.VARIANT_NAME] || '').trim();
      const canonicalNorm = normalizeForCompare(variantName);
      if (!masterUuid || !entityType || !canonicalNorm) return;
      const key = entityType + '::' + masterUuid;
      // Keep the last one if multiple (shouldn't happen but safe)
      canonicalMap[key] = canonicalNorm;
    });

    const keysToCheck = Object.keys(canonicalMap);
    if (keysToCheck.length === 0) return;

    // 2. Load all M_ALIAS rows (including inactive) to find stale canonical aliases
    const allAliases = loadGlobalAliasAll_();
    if (allAliases.length === 0) return;

    // 3. Find rows to deactivate
    const rowsToDeactivate = [];
    allAliases.forEach(function (alias) {
      if (!alias.activeFlag) return; // already inactive — skip
      if (Number(alias.confidence) !== 100) return; // only canonical aliases
      const source = String(alias.source || '');
      // Only deactivate AUTO_ENRICH aliases — preserve DRIVER_VERIFIED / MANUAL / MIGRATION
      if (source.indexOf('AUTO_ENRICH') !== 0) return;

      const key = alias.entityType + '::' + alias.masterUuid;
      const currentCanonicalNorm = canonicalMap[key];
      if (!currentCanonicalNorm) return; // not in this batch — skip

      const existingNorm = normalizeForCompare(alias.variantName);
      if (existingNorm === currentCanonicalNorm) return; // matches current canonical — keep

      // Stale canonical — mark for deactivation
      rowsToDeactivate.push(alias._rowNum);
    });

    if (rowsToDeactivate.length === 0) return;

    // 4. Batch deactivate: set active_flag = false สำหรับ stale rows
    const mAliasSheet = context.mAliasSheet;
    if (!mAliasSheet) return;

    const activeFlagCol = ALIAS_IDX.ACTIVE_FLAG + 1; // 1-indexed column number
    const a1Notations = rowsToDeactivate.map(function (rn) {
      // Convert column number to letter (inline — avoid cross-module dependency)
      let col = activeFlagCol;
      let letter = '';
      let temp;
      while (col > 0) {
        temp = (col - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        col = (col - temp - 1) / 26;
      }
      return letter + rn;
    });

    mAliasSheet.getRangeList(a1Notations).setValue(false);

    // 5. Invalidate cache so next read sees deactivated rows
    if (typeof invalidateChunkedCache_ === 'function') {
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_ALL);
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_REVERSE);
    } else {
      CacheService.getScriptCache().removeAll([CACHE_KEY.GLOBAL_ALIAS_ALL, CACHE_KEY.GLOBAL_ALIAS_REVERSE]);
    }

    logInfo(
      'MatchEngine',
      'cleanupStaleCanonicalAliases_: deactivated ' +
        rowsToDeactivate.length +
        ' stale canonical aliases across ' +
        keysToCheck.length +
        ' entities'
    );

    // [V6.0.007] Audit Trail — record batch alias deactivation (Critical-Only scope)
    //   Since this is a batch operation, we log one DELETE record per deactivated row.
    //   For very large batches (>50), we summarize to avoid audit spam.
    //   Failsafe: logAuditTrail never throws — wrapped in its own try/catch
    if (typeof logAuditTrail === 'function' && typeof AUDIT_ENTITY_TYPES !== 'undefined') {
      if (rowsToDeactivate.length <= 50) {
        // Log each row individually for fine-grained audit
        rowsToDeactivate.forEach(function (rowNum) {
          logAuditTrail(
            AUDIT_ENTITY_TYPES.ALIAS,
            'row:' + rowNum,
            AUDIT_ACTIONS.DELETE,
            'active_flag',
            'true',
            'false',
            'cleanupStaleCanonicalAliases_ (batch)'
          );
        });
      } else {
        // Large batch — log one summary record
        logAuditTrail(
          AUDIT_ENTITY_TYPES.ALIAS,
          'batch:' + keysToCheck.length,
          AUDIT_ACTIONS.DELETE,
          'active_flag',
          String(rowsToDeactivate.length) + ' rows',
          'false',
          'cleanupStaleCanonicalAliases_ (batch summary)'
        );
      }
    }
  } catch (err) {
    // Non-fatal — don't break the pipeline just because cleanup failed
    logError('cleanupStaleCanonicalAliases_', err.message, err);
  }
}

/**
 * matchCommitGlobalAlias_ — [F-12] เขียน M_ALIAS + cache invalidation
 *   [V6.0.007] Defensive width check — auto-pad short rows to SCHEMA.M_ALIAS.length
 *   to prevent "จำนวนคอลัมน์ไม่ตรง" Sheets API error if a future schema change
 *   misses a row push site.
 * @param {Sheet} mAliasSheet - Sheet object สำหรับ M_ALIAS
 * @param {Array} rows - Array of row arrays สำหรับ M_ALIAS
 */
function matchCommitGlobalAlias_(mAliasSheet, rows) {
  if (rows.length > 0 && mAliasSheet) {
    const expectedWidth = SCHEMA[SHEET.M_ALIAS].length; // 11 (V6.0.003)
    // [V6.0.007] Defensive: pad short rows to expected width (fill with '')
    //   This prevents total pipeline failure if a row push site was missed
    //   during a schema migration. Logs a warning so the missed site can be fixed.
    let widthMismatchFound = false;
    const paddedRows = rows.map(function (row) {
      if (row.length < expectedWidth) {
        widthMismatchFound = true;
        const padded = row.slice();
        while (padded.length < expectedWidth) padded.push('');
        return padded;
      }
      return row;
    });
    if (widthMismatchFound) {
      logWarn(
        'MatchEngine',
        'matchCommitGlobalAlias_: detected row(s) with width < ' +
          expectedWidth +
          ' — auto-padded with empty strings. Check matchEnrichEntityAliases_ and generatePersonAliasesFromHistory_' +
          ' to ensure all row pushes include the V6.0.003 columns (verified_by, review_id, verified_at).'
      );
    }
    mAliasSheet.getRange(mAliasSheet.getLastRow() + 1, 1, paddedRows.length, expectedWidth).setValues(paddedRows);
    // [FIX BUG-C01 V5.5.022] Use invalidateChunkedCache_ instead of removeAll
    //   เดิมใช้ removeAll เฉพาะ base keys ทำให้ chunk keys (_CHUNKS, _0, _1, ...) ตกค้าง
    //   loadGlobalAliasesMap_/loadGlobalAliasReverseIndex_ อ่านจาก chunk keys เก่า → stale alias data
    //   ทำให้ fastLookupByShipToName ไม่เจอ alias ใหม่จนกว่า TTL จะหมด
    if (typeof invalidateChunkedCache_ === 'function') {
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_ALL);
      invalidateChunkedCache_(CACHE_KEY.GLOBAL_ALIAS_REVERSE);
    } else {
      CacheService.getScriptCache().removeAll([CACHE_KEY.GLOBAL_ALIAS_ALL, CACHE_KEY.GLOBAL_ALIAS_REVERSE]);
    }
  }
}

/**
 * matchCommitPersonAlias_ — [F-12] เขียน M_PERSON_ALIAS + cache + dedup update
 * @param {Spreadsheet} ss - Active spreadsheet
 * @param {Array} rows - Array of row arrays สำหรับ M_PERSON_ALIAS
 * @param {Object} context - Context สำหรับ dedup set update
 */
function matchCommitPersonAlias_(ss, rows, context) {
  if (rows.length > 0) {
    const paSheet = ss.getSheetByName(SHEET.M_PERSON_ALIAS);
    if (paSheet) {
      paSheet.getRange(paSheet.getLastRow() + 1, 1, rows.length, SCHEMA[SHEET.M_PERSON_ALIAS].length).setValues(rows);
      invalidateAliasCache_();
      // [FIX CRIT-018] Update in-memory dedup sets incrementally
      if (_ALIAS_ENRICHMENT_CONTEXT) {
        rows.forEach(function (paRow) {
          const pId = String(paRow[PERSON_ALIAS_IDX.PERSON_ID] || '').trim();
          const aNorm = normalizeForCompare(paRow[PERSON_ALIAS_IDX.ALIAS_NAME]);
          if (pId && aNorm) _ALIAS_ENRICHMENT_CONTEXT.existingPersonAliasSet.add(pId + '::' + aNorm);
        });
      }
    }
  }
}

/**
 * matchCommitPlaceAlias_ — [F-12] เขียน M_PLACE_ALIAS + cache + dedup update
 * @param {Spreadsheet} ss - Active spreadsheet
 * @param {Array} rows - Array of row arrays สำหรับ M_PLACE_ALIAS
 * @param {Object} context - Context สำหรับ dedup set update
 */
function matchCommitPlaceAlias_(ss, rows, context) {
  if (rows.length > 0) {
    const plaSheet = ss.getSheetByName(SHEET.M_PLACE_ALIAS);
    if (plaSheet) {
      plaSheet.getRange(plaSheet.getLastRow() + 1, 1, rows.length, SCHEMA[SHEET.M_PLACE_ALIAS].length).setValues(rows);
      invalidatePlaceAliasCache_();
      // [FIX CRIT-018] Update in-memory dedup sets incrementally
      if (_ALIAS_ENRICHMENT_CONTEXT) {
        rows.forEach(function (plaRow) {
          const plId = String(plaRow[PLACE_ALIAS_IDX.PLACE_ID] || '').trim();
          const aNorm = normalizeForCompare(plaRow[PLACE_ALIAS_IDX.ALIAS_NAME]);
          if (plId && aNorm) _ALIAS_ENRICHMENT_CONTEXT.existingPlaceAliasSet.add(plId + '::' + aNorm);
        });
      }
    }
  }
}
