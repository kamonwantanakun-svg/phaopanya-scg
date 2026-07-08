/**
 * VERSION: 6.0.007
 * FILE: 17_SearchService.gs
 * LMDS V5.5 — Search Service (The Bridger — Group 2)
 * ===================================================
 * PURPOSE:
 *   สะพานเชื่อม Group 2 (ตารางงานประจำวัน) → Group 1 (Master Data)
 *   รับ ShipToName → ค้นหาพิกัดที่ดีที่สุด → เขียน LatLong_Actual
 *   [REDESIGN v5.4.003] ShipToName-Only Policy:
 *     - ShipToAddress ถูกลบออกจาก logic ทั้งหมด (ไม่น่าเชื่อถือ)
 *     - LatLong_SCG ถูกลบออกจาก logic ทั้งหมด (อิงจาก ShipToAddress)
 *     - AI Reasoning ถูกลบออก (ไม่เหมาะกับ production)
 *     - ถ้าหาไม่เจอ → คืน NOT_FOUND เว้นว่าง ไม่ fallback ใดๆ
 * ===================================================
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v5.5.022 (2026-06-26) — CONSISTENCY SYNC + DEEP DIVE FIX (BUG-M01/M02/M03/H02/H03/C01 + 6 cache/config fixes)
 *     v5.5.021 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 *     v5.5.020 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES (Load Order):
 *     - 01_Config.gs          (SHEET.DAILY_JOB, DATA_IDX.*, AI_CONFIG, APP_CONST)
 *     - 02_Schema.gs          (SCHEMA[SHEET.DAILY_JOB])
 *     - 05_NormalizeService.gs (normalizePersonNameFull)
 *     - 14_Utils.gs           (isValidLatLng, parseLatLng)
 *   CALLS (Invokes):
 *     - fastLookupByShipToName()          → 21_AliasService.gs (Tier 0 Fast Track)
 *     - resolvePerson()                   → 06_PersonService.gs
 *     - getDestsByPersonId()              → 09_DestinationService.gs
 *   EXPORTS TO:
 *     - 18_ServiceSCG.gs      (findBestGeoByPersonPlace, runLookupEnrichment)
 *   SHEETS ACCESSED:
 *     - SHEET.DAILY_JOB       (Read+Write: ShipToName→LatLong_Actual + color coding)
 *     - SHEET.M_ALIAS         (Read: Tier 0 Fast Track via fastLookupByShipToName)
 * ===================================================
 * ARCHITECTURE:
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │  17_SearchService.gs                                                   │
 *   │  ├── runLookupEnrichment()   [Entry: ดึงข้อมูลจาก DAILY_JOB, loop หาพิกัด]      │
 *   │  │   └── Chunk Processing (รอบละ 500 rows) ป้องกัน GAS Time/Memory Limit   │
 *   │  ├── lookupEnrichOneRow_()   [Logic: หาสี, status, พิกัด]                 │
 *   │  │   ├── findBestGeoByPersonPlace() [ค้นหา Master DB]                      │
 *   │  │   └── lookupSingleRow()          [UI Wrapper สำหรับเรียกทีละแถว]         │
 *   │  ├── flushLookupResults_()   [Output: batch setValues กลับไปที่ DAILY_JOB] │
 *   │  │   └── ใช้ clearContent() และ setBackgrounds เฉพาะช่วง ลดการพังของ Format│
 *   │  └── (Locking handled by caller — runLookupEnrichment re-entrancy guarded) │
 *   └────────────────────────────────────────────────────────────────────────┘
 * ===================================================
 */
// [FIX V5.5.048] ลบ dead reference getEnrichmentLock_() ออกจาก ARCHITECTURE comment
//                เนื่องจากฟังก์ชันนี้ไม่มีอยู่จริง (LockService ถูกจัดการที่ caller ด้านนอก)

// ============================================================
// SECTION 1: findBestGeoByPersonPlace — ShipToName Only
// ============================================================

/**
 * findBestGeoByPersonPlace — ค้นหาพิกัดจาก ShipToName เท่านั้น
 * [REDESIGN v5.4.003] ShipToName-Only Policy:
 *   - ShipToAddress ถูกลบออกจาก logic ทั้งหมด (ไม่น่าเชื่อถือ)
 *   - LatLong_SCG ถูกลบออกจาก logic ทั้งหมด
 *   - ถ้าหาไม่เจอ → คืน NOT_FOUND เว้นว่าง ไม่ fallback ใดๆ
 *
 * [V5.5.011] Same-Clean-Process-as-Sheet1 Policy:
 *   - ก่อนหน้านี้ใช้แค่ String(rawPerson).trim() ส่งตรงเข้า lookup
 *   - ทำให้ ShipToName จาก Sheet2 ไม่ผ่านกระบวนการทำความสะอาดเหมือน Sheet1
 *   - ผลลัพธ์คือค้นไม่เจอแม้จะเป็นร้านเดียวกัน เพราะในชื่อมี "จำกัด"/"ร้าน"/เบอร์โทร ฯลฯ
 *   - ตอนนี้ผ่าน normalizePersonNameFull ก่อน → ได้ cleanName เหมือน Sheet1
 *   - แล้วลองค้นด้วย cleanName ก่อน, หากไม่เจอค่อย fallback ด้วย rawName
 *
 * Tier 0: ShipToName → normalizePersonNameFull → M_ALIAS → masterUuid → dest → lat,lng (เร็วสุด)
 *         [Tie-Breaker ถ้าพบหลาย dest]
 * Tier 1: ShipToName → normalizePersonNameFull → resolvePerson() → getDestsByPersonId() (usage-dominant)
 *         [Tie-Breaker ถ้าพบหลาย dest]
 * NOT_FOUND: เว้นว่าง LatLong_Actual
 *
 * [ADD v5.5.022-PATCH1] ShipToAddress Tie-Breaker Policy:
 *   - กรณี ShipToName ซ้ำ (พบหลาย Destination ใน Person/Place เดียวกัน)
 *     จะใช้ ShipToAddress เป็น tie-breaker โดยเปรียบเทียบกับ address ของแต่ละ Destination
 *   - ถ้า tie-breaker match อันใดอันหนึ่ง → ใช้ dest นั้น
 *   - ถ้า tie-breaker ไม่ match เลย → fallback เอา usageCount สูงสุด (พฤติกรรมเดิม)
 *   - ถ้าไม่มี rawAddress ส่งเข้ามา → ใช้พฤติกรรมเดิม (เอา usageCount สูงสุด)
 *
 * @param {string} rawPerson - ShipToName จาก ตารางงานประจำวัน
 * @param {string} [rawAddress] - ShipToAddress จาก ตารางงานประจำวัน (optional - ใช้เป็น tie-breaker)
 */
function findBestGeoByPersonPlace(rawPerson, rawAddress) {
  // Guard: ชื่อว่างหรือสั้นเกิน → NOT_FOUND ทันที
  if (!rawPerson || String(rawPerson).trim().length < 2) {
    return buildSearchResult_(null, null, 'NOT_FOUND', 0, null, 'ShipToName ว่างหรือสั้นเกิน');
  }

  const rawName = String(rawPerson).trim();
  const rawAddr = rawAddress ? String(rawAddress).trim() : '';

  // [V5.5.011] ทำความสะอาดชื่อแบบเดียวกับ Sheet1 ก่อนนำไปค้นหา
  // normalizePersonNameFull จะ:
  //   1. ดึงเบอร์โทรออก
  //   2. ดึงเลขเอกสารออก
  //   3. ดึง Delivery Notes (ฝากยาม, COD, ด่วน ฯลฯ) ออก
  //   4. ตัด Company Suffix (จำกัด, บจก., หจก. ฯลฯ) และ Chain Store (ร้าน, ร้านค้า)
  //   5. ตัดคำนำหน้า (นาย, นาง, บริษัท ฯลฯ)
  //   6. ล้างช่องว่างและอักขระพิเศษ
  // ทำให้ cleanName สามารถจับคู่กับ M_ALIAS/M_PERSON ที่บันทึกจาก Sheet1 ได้แม่นยำขึ้น
  let cleanName = rawName;
  let normResult = null;
  try {
    if (typeof normalizePersonNameFull === 'function') {
      normResult = normalizePersonNameFull(rawName);
      if (normResult && normResult.cleanName && normResult.cleanName.length >= 2) {
        cleanName = normResult.cleanName;
      }
    }
  } catch (normErr) {
    // ถ้า normalize ล้มเหลว ใช้ rawName ต่อไป
    logDebug('SearchService', 'normalizePersonNameFull ล้มเหลว ใช้ rawName: ' + normErr.message);
  }

  // ─── Tier 0: M_ALIAS Fast Track ───────────────────────────────────
  // [FIX v5.5.021 C1] ส่ง cleanName เข้าไปเลย เพื่อลดการทำ Normalization ซ้ำซ้อน
  // [ADD v5.5.022-PATCH1] ส่ง rawAddress เข้าไปเพื่อ tie-breaker กรณีพบหลาย dest
  if (typeof fastLookupByShipToName === 'function') {
    let fastResult = fastLookupByShipToName(cleanName, normResult, rawAddr);
    if (!fastResult && cleanName !== rawName) {
      // Fallback: ลองด้วย rawName เผื่อ M_ALIAS เก็บ variant แบบ raw ไว้
      fastResult = fastLookupByShipToName(rawName, null, rawAddr);
    }
    if (fastResult && fastResult.lat != null && fastResult.lng != null) {
      // [FIX v5.5.021 M1/M2] Mask rawName เพื่อป้องกัน PII Leak ใน SYS_LOG
      const reason =
        cleanName !== rawName ? `M_ALIAS Fast Track (cleaned) → "${cleanName}"` : `M_ALIAS Fast Track: "${cleanName}"`;
      return buildSearchResult_(
        fastResult.lat,
        fastResult.lng,
        'FOUND_ALIAS_FAST',
        fastResult.confidence,
        fastResult.destId,
        reason
      );
    }
  }

  // ─── Tier 1: resolvePerson → M_DESTINATION ────────────────────────
  // [FIX v5.5.012 Anti-pattern #3] ส่ง normResult เข้า resolvePerson เพื่อหลีกเลี่ยง double normalization
  //   เดิมส่ง cleanName เข้า resolvePerson ซึ่งจะ normalize ซ้ำอีกครั้ง (safe but wasteful)
  //   ตอนนี้ส่ง rawName + preNormResult ให้ resolvePerson ใช้ normResult ที่เราคำนวณแล้ว
  const personResult = resolvePerson(rawName, normResult);
  const personId = personResult ? personResult.personId : null;

  if (personId) {
    const dests = getDestsByPersonId(personId).sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

    if (dests.length > 0) {
      // [ADD v5.5.022-PATCH1] Tie-Breaker: ถ้ามีหลาย dest และมี rawAddress → เลือกด้วย address matching
      const top = dests.length > 1 && rawAddr ? selectBestDestByAddress_(dests, rawAddr) || dests[0] : dests[0];
      // [FIX v5.5.021 M1/M2] Mask rawName
      const reason =
        cleanName !== rawName
          ? `Person match (cleaned) → "${cleanName}" → usageCount:${top.usageCount}`
          : `Person match: "${cleanName}" → usageCount:${top.usageCount}`;
      return buildSearchResult_(top.lat, top.lng, 'FOUND_DOMINANT', 90, top.destId, reason);
    }
  }

  // ไม่พบ — เว้นว่าง LatLong_Actual
  const reason =
    cleanName !== rawName ? `ไม่พบข้อมูล (cleaned: "${cleanName}")` : `ไม่พบข้อมูล — ShipToName:"${cleanName}"`;
  return buildSearchResult_(null, null, 'NOT_FOUND', 0, null, reason);
}

// ============================================================
// SECTION 1a: ShipToAddress Tie-Breaker Helper — [ADD v5.5.022-PATCH1]
// ============================================================

/**
 * selectBestDestByAddress_ — [ADD v5.5.022-PATCH1]
 * Tie-Breaker: เลือก Destination ที่มี address ตรงกับ ShipToAddress มากที่สุด
 *
 * Algorithm (Token Overlap with Dice coefficient):
 *   1. สร้าง address string ของแต่ละ destination จาก place.canonical + sub_district + district + province + postcode
 *      (place โหลดจาก loadAllPlaces_ ซึ่งมี cache อยู่แล้ว — ไม่ต้องอ่าน sheet ซ้ำ)
 *   2. Normalize ทั้ง ShipToAddress และ destAddress ด้วย normalizeForCompare (ลบ case/spacing/punctuation)
 *   3. แยก tokens เป็น bigram sets แล้วคำนวณ Dice coefficient (overlap ของ bigram sets)
 *   4. คืน dest ที่มี Dice >= 0.70 (70%) และสูงสุด — ถ้าไม่มีอันไหนผ่าน คืน null (caller fallback usageCount)
 *      [Fix Phase-C #1] เพิ่ม threshold จาก 0.4 → 0.70 เพราะ Thai address มี common tokens
 *      (เลขที่, ถนน, จังหวัด) ทำให้ Dice สูงโดยไม่ได้แปลว่าที่เดียวกัน — "บางนา" vs "บางบอน" = 0.444
 *
 * @param {Array} dests - array ของ destination object (จาก getDestsByPersonId)
 * @param {string} rawAddress - ShipToAddress ดิบ
 * @return {Object|null} destination object ที่ match ที่สุด หรือ null
 * @private
 */
function selectBestDestByAddress_(dests, rawAddress) {
  if (!dests || dests.length === 0 || !rawAddress) return null;

  // Normalize ShipToAddress ครั้งเดียว
  let normAddr = String(rawAddress).trim();
  try {
    if (typeof normalizeForCompare === 'function') {
      normAddr = normalizeForCompare(normAddr);
    } else {
      normAddr = normAddr.toLowerCase().replace(/\s+/g, '');
    }
  } catch (e) {
    /* fallback */
  }
  if (normAddr.length < 4) return null; // ที่อยู่สั้นเกินไป ไม่น่าเชื่อถือ

  // โหลด place map (placeId → address string) — ใช้ loadAllPlaces_ cache อยู่แล้ว
  let placeMap = null;
  try {
    if (typeof loadAllPlaces_ === 'function') {
      const allPlaces = loadAllPlaces_();
      placeMap = {};
      allPlaces.forEach(function (p) {
        if (p && p.placeId) {
          // ประกอบ address จาก canonical + sub_district + district + province + postcode
          const parts = [
            p.canonical || '',
            p.subDistrict || '',
            p.district || '',
            p.province || '',
            p.postcode || ''
          ].filter(Boolean);
          placeMap[p.placeId] = parts.join(' ');
        }
      });
    }
  } catch (e) {
    logWarn('SearchService', 'selectBestDestByAddress_: loadAllPlaces_ ล้มเหลว — skip tie-breaker: ' + e.message);
    return null;
  }
  if (!placeMap) return null;

  // สร้าง bigram set ของ ShipToAddress
  let addrBigrams;
  try {
    addrBigrams = buildBigramSetSafe_(normAddr);
  } catch (e) {
    return null;
  }
  if (!addrBigrams || addrBigrams.size === 0) return null;

  // คะแนนแต่ละ dest
  let bestDest = null;
  let bestScore = 0;
  // [Fix Phase-C #1] Thai address มี common tokens (เลขที่, ถนน, จังหวัด) ทำให้ Dice สูงโดยไม่ได้แปลว่าที่เดียวกัน
  //   ตัวอย่าง: "บางนา" vs "บางบอน" = 0.444 (false match ที่ threshold เดิม 0.4)
  //   ยก threshold เป็น 0.70 เพื่อให้ address ต้องคล้ายกันจริง ๆ จึงจะถือว่าเป็นที่เดียวกัน
  //   ค่า 0.4-0.70 จะถูก log เป็น warning (near miss) เพื่อ monitoring
  const TIE_BREAK_THRESHOLD = 0.7; // 70% Dice — strict match
  const NEAR_MISS_THRESHOLD = 0.4; // 40% Dice — ค่าเดิม ใช้สำหรับ near-miss monitoring เท่านั้น

  for (let i = 0; i < dests.length; i++) {
    const dest = dests[i];
    if (!dest.placeId) continue;

    const placeAddrRaw = placeMap[dest.placeId] || '';
    if (!placeAddrRaw) continue;

    let normPlaceAddr = placeAddrRaw;
    try {
      if (typeof normalizeForCompare === 'function') {
        normPlaceAddr = normalizeForCompare(normPlaceAddr);
      } else {
        normPlaceAddr = normPlaceAddr.toLowerCase().replace(/\s+/g, '');
      }
    } catch (e) {
      /* fallback */
    }
    if (normPlaceAddr.length < 4) continue;

    let placeBigrams;
    try {
      placeBigrams = buildBigramSetSafe_(normPlaceAddr);
    } catch (e) {
      continue;
    }
    if (!placeBigrams || placeBigrams.size === 0) continue;

    // Dice coefficient = 2 * |A ∩ B| / (|A| + |B|)
    let intersection = 0;
    addrBigrams.forEach(function (b) {
      if (placeBigrams.has(b)) intersection++;
    });
    const dice = (2.0 * intersection) / (addrBigrams.size + placeBigrams.size);

    if (dice > bestScore) {
      bestScore = dice;
      bestDest = dest;
    }
  }

  if (bestDest && bestScore >= TIE_BREAK_THRESHOLD) {
    logDebug(
      'SearchService',
      'selectBestDestByAddress_: match destId=' + bestDest.destId + ' (Dice=' + bestScore.toFixed(2) + ')'
    );
    return bestDest;
  }

  // [Fix Phase-C #1] Near-miss monitoring: Dice ระหว่าง 0.40-0.70 เป็น zone ที่เคย match ได้ (threshold เดิม)
  //   แต่ตอนนี้ถือว่าไม่ match — log warning เพื่อให้เฝ้าระวัง pattern ที่อาจต้องปรับ threshold หรือเพิ่ม alias
  if (bestDest && bestScore >= NEAR_MISS_THRESHOLD) {
    logWarn(
      'SearchService',
      'selectBestDestByAddress_: NEAR MISS — best Dice=' +
        bestScore.toFixed(2) +
        ' (between ' +
        NEAR_MISS_THRESHOLD +
        ' and ' +
        TIE_BREAK_THRESHOLD +
        ') destId=' +
        bestDest.destId +
        ' → fallback usageCount (threshold 0.70 not met)'
    );
  } else if (bestDest) {
    logDebug(
      'SearchService',
      'selectBestDestByAddress_: best Dice=' +
        bestScore.toFixed(2) +
        ' ต่ำกว่า threshold ' +
        TIE_BREAK_THRESHOLD +
        ' → fallback usageCount'
    );
  }
  return null;
}

/**
 * buildBigramSetSafe_ — [ADD v5.5.022-PATCH1]
 * สร้าง Set ของ bigrams (2-char substrings) จาก string
 * ใช้สำหรับ Dice coefficient ใน selectBestDestByAddress_
 *
 * @param {string} str - normalized string (no spaces, lowercase)
 * @return {Set<string>} set ของ bigrams
 * @private
 */
function buildBigramSetSafe_(str) {
  const s = String(str || '');
  if (s.length < 2) return new Set();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.substring(i, i + 2));
  }
  return set;
}

// [REMOVED v5.4.003] callGeminiReasoning_ — ลบแล้วตาม ShipToName-Only Policy
// AI Reasoning ไม่เหมาะกับ production — พิกัดที่ AI คาดเดาไม่น่าเชื่อถือ

/**
 * buildSearchResult_ — สร้าง Object ผลลัพธ์มาตรฐาน
 * [FIX v003] NOT_FOUND คืน lat:null, lng:null แทน 0,0
 */
function buildSearchResult_(lat, lng, status, confidence, destId, reason) {
  return {
    lat: lat, // null เมื่อ NOT_FOUND
    lng: lng, // null เมื่อ NOT_FOUND
    status: status,
    confidence: confidence,
    destId: destId, // null ถ้าไม่มี Dest
    reason: reason
  };
}

// ============================================================
// SECTION 2: runLookupEnrichment — Batch Process (ShipToName Only)
// ============================================================

/**
 * runLookupEnrichment — วนทุกแถวใน ตารางงานประจำวัน
 * [REDESIGN v5.4.003] ShipToName-Only Policy:
 *   - อ่านเฉพาะ ShipToName เป็นหลักในการค้นหาพิกัด
 *   - ShipToAddress และ LatLong_SCG ถูกลบออกทั้งหมด
 *   - ผลลัพธ์: เจอ (เขียว) / ไม่เจอ (แดง) เท่านั้น
 *
 * [FIX v003] setBackground loop → setBackgrounds() Batch ทีเดียว
 * [FIX v003] existingLL check → parseLatLng + isValidLatLng
 * [ADD v003] Time Guard ป้องกัน Timeout
 */
function runLookupEnrichment() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.DAILY_JOB);

  if (!sheet || sheet.getLastRow() < 2) {
    logWarn('SearchService', 'ตารางงานประจำวัน ว่างอยู่');
    return;
  }

  const startTime = new Date();
  const timeLimit = AI_CONFIG.TIME_LIMIT_MS || 5 * 60 * 1000;
  const totalRows = sheet.getLastRow() - 1;
  const schemaLen = SCHEMA[SHEET.DAILY_JOB].length;

  // [FIX v5.5.021 H1] เพิ่ม Chunk Processing ป้องกัน Memory Spike
  const CHUNK_SIZE = 500;
  let countFound = 0;
  let countNotFound = 0;
  let countSkipped = 0;
  let timedOut = false;

  try {
    for (let startRow = 2; startRow <= sheet.getLastRow(); startRow += CHUNK_SIZE) {
      if (new Date() - startTime > timeLimit) {
        logWarn('SearchService', `runLookupEnrichment: Time Guard หยุดที่แถว ${startRow - 1}/${totalRows}`);
        timedOut = true;
        break;
      }

      const numRows = Math.min(CHUNK_SIZE, sheet.getLastRow() - startRow + 1);
      const chunkData = sheet.getRange(startRow, 1, numRows, schemaLen).getValues();
      const latActualArr = [];
      const bgColorArr = [];

      chunkData.forEach((row, i) => {
        const r = lookupEnrichOneRow_(row);
        latActualArr.push(r.latActual);
        bgColorArr.push(r.bgColor);
        countFound += r.found;
        countNotFound += r.notFound;
        countSkipped += r.skipped;
      });

      // Flush ทีละ Chunk ลดการบริโภค Memory (ใช้ startRow)
      flushLookupResults_(sheet, latActualArr, bgColorArr, schemaLen, startRow, 'batch-write');
    }
  } catch (err) {
    logError('SearchService', `runLookupEnrichment error: ${err.message}`, err);
    throw err; // re-throw ให้ caller จัดการต่อ
  }

  const msg =
    '✅ จับคู่พิกัดเสร็จ\n' +
    `เจอ: ${countFound} | ไม่พบ: ${countNotFound} | ข้าม: ${countSkipped}` +
    (timedOut ? '\n⚠️ หยุดก่อนครบเพราะใกล้ Timeout — รันอีกครั้งเพื่อดำเนินการต่อ' : '');

  logInfo('SearchService', msg.replace(/\n/g, ' '));
  ss.toast(msg, APP_NAME, 8);

  // [FIX LAW-05 v5.4.003] ติดตั้ง auto-resume เมื่อ timeout เพื่อให้รันต่ออัตโนมัติ
  if (timedOut && typeof installAutoResume_ === 'function') {
    installAutoResume_('runLookupEnrichment');
  }
}

/**
 * lookupEnrichOneRow_ — processes 1 row for runLookupEnrichment
 * Extracts ShipToName, checks existing coords, calls findBestGeoByPersonPlace
 * @param {Array} row - single row from DAILY_JOB data
 * @return {{ latActual: Array, bgColor: Array, found: number, notFound: number, skipped: number }}
 */
function lookupEnrichOneRow_(row) {
  // [REDESIGN v5.4.003] อ่านเฉพาะ ShipToName — ShipToAddress/LatLong_SCG ไม่ใช้แล้ว
  // [ADD v5.5.022-PATCH1] อ่าน ShipToAddress เพิ่ม — ใช้เป็น tie-breaker กรณี ShipToName ซ้ำ
  const rawPerson = String(row[DATA_IDX.SHIP_TO_NAME] || '').trim();
  const rawAddress = String(row[DATA_IDX.SHIP_TO_ADDR] || '').trim();
  const existingLL = String(row[DATA_IDX.LATLNG_ACTUAL] || '').trim();

  // ตรวจ existingLL — ข้ามแถวที่มีพิกัดดีอยู่แล้ว
  if (existingLL) {
    const parsed = parseLatLng(existingLL);
    if (parsed && isValidLatLng(parsed.lat, parsed.lng)) {
      return { latActual: [existingLL], bgColor: [null], found: 0, notFound: 0, skipped: 1 };
    }
  }

  // ค้นหาพิกัดจาก ShipToName เท่านั้น (rawAddress ใช้เป็น tie-breaker เมื่อ ShipToName ซ้ำ)
  const result = findBestGeoByPersonPlace(rawPerson, rawAddress);

  // [FIX v5.5.021 C2] รวบ switch case ป้องกัน silent fallback
  if (
    ['FOUND', 'FOUND_DOMINANT', 'FOUND_ALIAS_FAST'].includes(result.status) &&
    result.lat != null &&
    result.lng != null
  ) {
    return {
      latActual: [`${result.lat},${result.lng}`],
      bgColor: [APP_CONST.COLOR_FOUND],
      found: 1,
      notFound: 0,
      skipped: 0
    };
  }

  // ถ้า status ไม่รู้จัก ให้ log warning แจ้งเตือน
  if (result.status !== 'NOT_FOUND') {
    logWarn('SearchService', `Unknown status "${result.status}" for "${rawPerson}" — treated as NOT_FOUND`);
  }

  return { latActual: [''], bgColor: [APP_CONST.COLOR_NOT_FOUND], found: 0, notFound: 1, skipped: 0 };
}

// ============================================================
// SECTION 2b: flushLookupResults_ — [REF-007] Unified Flush Helper
// ============================================================

/**
 * flushLookupResults_ — [REF-007] เขียน latActual + backgroundColor ลงชีต
 * ทั้ง success path และ error path ใช้ helper นี้ร่วมกัน
 * ลด duplicate flush logic ที่เคยมีใน 2 ที่ (error catch + normal batch write)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - DAILY_JOB sheet
 * @param {Array[]} latActualArr - array of [['lat,lng'], [''], ...]
 * @param {Array[]} bgColorArr - array of [['#color'], [null], ...]
 * @param {number} schemaLen - total columns in schema (for bgMatrix width)
 * @param {number} startRow - row to start writing
 * @param {string} context - 'batch-write' (normal) or 'error-flush' (catch path)
 */
function flushLookupResults_(sheet, latActualArr, bgColorArr, schemaLen, startRow, context) {
  const processedCount = latActualArr.length;
  if (processedCount === 0) return;

  try {
    // Batch Write LatLong_Actual
    const latActualCol = DATA_IDX.LATLNG_ACTUAL + 1;
    sheet.getRange(startRow, latActualCol, processedCount, 1).setValues(latActualArr.slice(0, processedCount));

    // [FIX v5.5.021 C3] Batch setBackgrounds เฉพาะคอลัมน์ LATLNG_ACTUAL เพื่อไม่ให้ทับสีคอลัมน์อื่น
    const targetColors = bgColorArr.slice(0, processedCount).map((row) => (row[0] ? [row[0]] : [null]));
    sheet.getRange(startRow, latActualCol, processedCount, 1).setBackgrounds(targetColors);

    if (context === 'error-flush') {
      logInfo('SearchService', `Flushed ${processedCount} rows before re-throw`);
    }
  } catch (flushErr) {
    const label = context === 'error-flush' ? 'Flush ล้มเหลว' : 'batch write ล้มเหลว';
    logError('SearchService', `runLookupEnrichment ${label}: ${flushErr.message}`, flushErr);
  }
}

// ============================================================
// SECTION 3: lookupSingleRow — Debug Helper (ShipToName Only)
// ============================================================

/**
 * lookupSingleRow — ค้นหาพิกัดสำหรับ 1 แถว (ทดสอบ)
 * [REDESIGN v5.4.003] ShipToName-Only: ลบ rawPlace, scgLatLng params
 */
function lookupSingleRow(rowNumber) {
  // [FIX R12] เพิ่ม try-catch — entry point ต้องมี error handling
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.DAILY_JOB);
    if (!sheet || rowNumber < 2) return null;

    const rowData = sheet.getRange(rowNumber, 1, 1, SCHEMA[SHEET.DAILY_JOB].length).getValues()[0];
    const rawPerson = String(rowData[DATA_IDX.SHIP_TO_NAME] || '').trim();
    const rawAddress = String(rowData[DATA_IDX.SHIP_TO_ADDR] || '').trim();
    // [ADD v5.5.022-PATCH1] ส่ง rawAddress เป็น tie-breaker กรณี ShipToName ซ้ำ

    const result = findBestGeoByPersonPlace(rawPerson, rawAddress);

    logDebug(
      'SearchService',
      `Row ${rowNumber} → Status:${result.status} ` +
        `(${result.confidence}%) lat:${result.lat} lng:${result.lng} — ` +
        `Reason: ${result.reason}`
    );

    return result;
  } catch (e) {
    logError('SearchService', 'lookupSingleRow ล้มเหลว: ' + e.message, e);
    // [FIX v5.5.021 H2] แจ้งเตือนผู้ใช้ ไม่เงียบ
    if (typeof safeUiAlert_ === 'function') {
      safeUiAlert_('❌ lookupSingleRow ล้มเหลว: ' + e.message);
    }
    return null;
  }
}
