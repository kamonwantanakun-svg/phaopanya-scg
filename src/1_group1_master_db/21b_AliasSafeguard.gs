/**
 * VERSION: 6.0.069
 * FILE: 21b_AliasSafeguard.gs
 * LMDS V6.0 — Alias Safeguard (Layer 1 + Layer 5)
 * ===================================================
 * PURPOSE:
 *   5-Layer Alias Safeguard สำหรับ Q_REVIEW → M_ALIAS promotion
 *   ป้องกัน misclick merge + spam approve ที่สร้าง alias ผิด
 *
 *   Currently implements (Phase C-2):
 *     - Layer 1: Structural Validation — ตรวจ similarity ratio ≥ MIN_SIMILARITY_RATIO
 *     - Layer 5: Circuit Breaker — จำกัด MAX_DAILY_ALIAS_WRITES รายการ/วัน
 *
 *   Deferred to future PR (per comparative analysis — over-engineering for small team):
 *     - Layer 2: Repetition Consensus (ต้องเห็นซ้ำ ≥ 2 ครั้งคนละวัน)
 *     - Layer 3: Conflict Detection (ตรวจ conflict กับ alias ที่มีอยู่)
 *     - Layer 4: Probation Lifecycle (7 วัน probation ก่อน confirmed)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs (SAFEGUARD_CONFIG, SHEET.M_PERSON, SHEET.M_PLACE)
 *     - 14_Utils.gs (levenshteinDistance)
 *     - 05_NormalizeService.gs (normalizeForCompare)
 *     - 06_PersonService.gs (loadAllPersons_)
 *     - 07_PlaceService.gs (loadAllPlaces_)
 *     - 03_SetupSheets.gs (logWarn, logDebug)
 *   CALLS: (Invokes)
 *     - levenshteinDistance()              → 14_Utils.gs
 *     - normalizeForCompare()              → 05_NormalizeService.gs
 *     - loadAllPersons_() / loadAllPlaces_() → 06/07 services
 *     - sendPipelineAlert_()               → 24_PipelineManager.gs (optional, typeof guard)
 *   EXPORTS TO:
 *     - 21_AliasService.gs (createGlobalAlias calls validateAliasStructure_ + checkAliasCircuitBreaker_)
 *   SHEETS ACCESSED:
 *     - (none directly — reads via loadAllPersons_/loadAllPlaces_)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 1 — Master data building (normalize, persons, places, geo, match engine, aliases)
 *   Design source: docs/ai-reviews/ai-reviewer-1/โค้ดรีวิว4_21b_AliasSafeguard.md
 * ===================================================
 */

// ============================================================
// LAYER 1: Structural Validation
// ============================================================

/**
 * validateAliasStructure_ — Layer 1
 *   ตรวจ similarity floor ด้วย Levenshtein ratio + entity_type scope binding
 *
 *   ป้องกัน alias ที่ "ไม่คล้ายเลย" หลุดเข้ามา (เช่น ผู้ใช้กด MERGE ผิด candidate)
 *
 * @param {string} variantName - ชื่อดิบที่ผู้ใช้ยืนยัน (ก่อน normalize)
 * @param {string} canonicalName - ชื่อ canonical ของ master entity ที่จะผูก alias เข้า
 * @param {string} entityType - 'PERSON' | 'PLACE'
 * @return {{pass: boolean, ratio: number, reason: string}}
 *   - pass: true ถ้าผ่าน (ratio > MIN_SIMILARITY_RATIO)
 *   - ratio: similarity ratio 0-1 (1 = identical)
 *   - reason: 'OK' หรือ reason ที่ fail
 * @private
 */
function validateAliasStructure_(variantName, canonicalName, entityType) {
  if (!variantName || !canonicalName) {
    return { pass: false, ratio: 0, reason: 'EMPTY_INPUT' };
  }
  if (entityType !== 'PERSON' && entityType !== 'PLACE') {
    return { pass: false, ratio: 0, reason: 'INVALID_ENTITY_TYPE' };
  }

  const a = normalizeForCompare(variantName);
  const b = normalizeForCompare(canonicalName);
  if (!a || !b) return { pass: false, ratio: 0, reason: 'EMPTY_AFTER_NORMALIZE' };

  // [Layer 1a] Similarity floor — กัน alias ที่ "ไม่คล้ายเลย" หลุดเข้ามา
  //   (เช่น ผู้ใช้กด MERGE ผิด candidate โดยไม่ได้ตั้งใจ)
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const ratio = maxLen === 0 ? 1 : 1 - dist / maxLen;

  const floor = typeof SAFEGUARD_CONFIG !== 'undefined' ? SAFEGUARD_CONFIG.MIN_SIMILARITY_RATIO : 0.5;
  // [V6.0.069] Changed <= to < — names scoring exactly at floor should pass (borderline is OK)
  if (ratio < floor) {
    return { pass: false, ratio: ratio, reason: 'BELOW_SIMILARITY_FLOOR (' + ratio.toFixed(2) + ' < ' + floor + ')' };
  }

  return { pass: true, ratio: ratio, reason: 'OK' };
}

/**
 * getCanonicalNameForAlias_ — Lookup canonical name from masterUuid + entityType
 *
 *   ใช้สำหรับ Layer 1 validation — ดึง canonical name จาก M_PERSON หรือ M_PLACE
 *   เพื่อเปรียบเทียบ similarity กับ variantName
 *
 * @param {string} masterUuid - UUID ของ master entity
 * @param {string} entityType - 'PERSON' | 'PLACE'
 * @return {string} canonical name หรือ '' ถ้าไม่พบ
 * @private
 */
function getCanonicalNameForAlias_(masterUuid, entityType) {
  if (!masterUuid || !entityType) return '';

  try {
    if (entityType === 'PERSON' && typeof loadAllPersons_ === 'function') {
      const persons = loadAllPersons_();
      const found = persons.find(function (p) {
        return p.masterUuid === masterUuid || p.personId === masterUuid;
      });
      return found ? found.canonical || '' : '';
    }
    if (entityType === 'PLACE' && typeof loadAllPlaces_ === 'function') {
      const places = loadAllPlaces_();
      const found = places.find(function (p) {
        return p.masterUuid === masterUuid || p.placeId === masterUuid;
      });
      return found ? found.canonical || '' : '';
    }
  } catch (e) {
    logDebug('AliasSafeguard', 'getCanonicalNameForAlias_ lookup failed: ' + e.message);
  }
  return '';
}

// ============================================================
// LAYER 5: Circuit Breaker / Rate Limiting
// ============================================================

/**
 * checkAliasCircuitBreaker_ — Layer 5
 *   นับจำนวน alias ที่ promote ไปแล้ว "วันนี้" จาก PropertiesService
 *   ถ้าเกิน MAX_DAILY_ALIAS_WRITES → ตัด (ให้ค้างเป็น PENDING รอวันถัดไป) + แจ้งเตือน admin
 *
 *   การนับจะ reset อัตโนมัติทุกวัน (key มี date suffix)
 *
 * @return {{tripped: boolean, countToday: number, limit: number}}
 *   - tripped: true ถ้าเกิน limit (ควร skip การ promote)
 *   - countToday: จำนวนที่ promote ไปแล้ววันนี้
 *   - limit: MAX_DAILY_ALIAS_WRITES
 * @private
 */
function checkAliasCircuitBreaker_() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
  const key = 'ALIAS_SAFEGUARD_COUNT_' + today;
  const countToday = Number(props.getProperty(key) || 0);
  const limit = typeof SAFEGUARD_CONFIG !== 'undefined' ? SAFEGUARD_CONFIG.MAX_DAILY_ALIAS_WRITES : 50;

  if (countToday >= limit) {
    // แจ้งเตือนแค่ครั้งแรกที่ trip ในวันนั้น (กันสแปม alert)
    const alertedKey = 'ALIAS_SAFEGUARD_ALERTED_' + today;
    if (!props.getProperty(alertedKey)) {
      props.setProperty(alertedKey, '1');
      if (typeof sendPipelineAlert_ === 'function') {
        sendPipelineAlert_(
          'Alias Safeguard Circuit Breaker ตัดการทำงาน — promote alias เกิน ' +
            limit +
            ' รายการวันนี้แล้ว\nรายการที่เหลือจะถูก hold ไว้เป็น PENDING รอ reset วันถัดไป',
          'WARN'
        );
      }
    }
    return { tripped: true, countToday: countToday, limit: limit };
  }
  return { tripped: false, countToday: countToday, limit: limit };
}

/**
 * incrementAliasCircuitBreakerCount_ — เพิ่มตัวนับหลัง promote สำเร็จ 1 รายการ
 *
 *   เรียกหลัง createGlobalAlias() สำเร็จ (source='HUMAN' เท่านั้น)
 *
 * @private
 */
function incrementAliasCircuitBreakerCount_() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
  const key = 'ALIAS_SAFEGUARD_COUNT_' + today;
  const countToday = Number(props.getProperty(key) || 0);
  props.setProperty(key, String(countToday + 1));
}

/**
 * runAliasSafeguardForHumanAlias_ — Entry point สำหรับ HUMAN source aliases
 *
 *   รัน Layer 1 + Layer 5 เพื่อตรวจก่อน createGlobalAlias()
 *   ใช้เฉพาะ source='HUMAN' (auto-aliases ไม่ต้องผ่าน safeguard — มี quality control อื่นอยู่แล้ว)
 *
 * @param {string} masterUuid - UUID ของ master entity
 * @param {string} variantName - ชื่อดิบจาก Q_REVIEW
 * @param {string} entityType - 'PERSON' | 'PLACE'
 * @return {{allow: boolean, reason: string, layer: string}}
 *   - allow: true ถ้าผ่านทั้ง Layer 1 + 5
 *   - reason: 'OK' หรือ reason ที่ block
 *   - layer: 'LAYER1' | 'LAYER5' | 'OK'
 * @private
 */
function runAliasSafeguardForHumanAlias_(masterUuid, variantName, entityType) {
  // Layer 1: Structural Validation
  const canonicalName = getCanonicalNameForAlias_(masterUuid, entityType);
  if (!canonicalName) {
    // ไม่พบ canonical — skip Layer 1 (ไม่ block เพราะอาจเป็น entity ใหม่ที่ยังไม่ได้ index)
    logDebug(
      'AliasSafeguard',
      'runAliasSafeguardForHumanAlias_: canonical not found for ' + entityType + ' ' + masterUuid + ' — skip Layer 1'
    );
  } else {
    const structCheck = validateAliasStructure_(variantName, canonicalName, entityType);
    if (!structCheck.pass) {
      logWarn(
        'AliasSafeguard',
        'runAliasSafeguardForHumanAlias_: REJECTED at Layer 1 — ' +
          structCheck.reason +
          ' (variant="' +
          variantName +
          '", canonical="' +
          canonicalName +
          '")'
      );
      return { allow: false, reason: 'LAYER1_' + structCheck.reason, layer: 'LAYER1' };
    }
  }

  // Layer 5: Circuit Breaker
  const breaker = checkAliasCircuitBreaker_();
  if (breaker.tripped) {
    logWarn(
      'AliasSafeguard',
      'runAliasSafeguardForHumanAlias_: BLOCKED at Layer 5 — circuit breaker tripped (' +
        breaker.countToday +
        '/' +
        breaker.limit +
        ' today)'
    );
    return { allow: false, reason: 'LAYER5_CIRCUIT_BREAKER_TRIPPED', layer: 'LAYER5' };
  }

  return { allow: true, reason: 'OK', layer: 'OK' };
}
