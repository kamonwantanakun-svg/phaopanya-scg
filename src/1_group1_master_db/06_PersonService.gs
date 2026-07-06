/**
 * VERSION: 6.0.006
 * FILE: 06_PersonService.gs
 * LMDS V5.5 — Person Master Service
 * ===================================================
 * PURPOSE:
 *   จัดการ Master Person — ฐานข้อมูลชื่อลูกค้า/ผู้รับสินค้า
 *   เป็น Single Source of Truth สำหรับข้อมูลบุคคล
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
 *     - 01_Config.gs          (SHEET.M_PERSON, PERSON_IDX.*, AI_CONFIG)
 *     - 02_Schema.gs          (SCHEMA[SHEET.M_PERSON], SCHEMA[SHEET.M_PERSON_ALIAS])
 *     - 03_SetupSheets.gs     (logDebug, logWarn, logError)
 *     - 05_NormalizeService.gs (normalizePersonNameFull, normalizeForCompare)
 *     - 14_Utils.gs           (generateShortId, generateUUID, diceCoefficient, levenshteinDistance)
 *   CALLS (Invokes):
 *     - resolveMasterUuidViaGlobalAlias() → 21_AliasService.gs (findPersonCandidates)
 *     - convertUuidToPersonId()           → 21_AliasService.gs (findPersonCandidates)
 *     - createGlobalAlias()               → 21_AliasService.gs (mergePersonRecords ONLY — Admin Action)
 *   EXPORTS TO:
 *     - 10_MatchEngine.gs     (resolvePerson, createPerson, updatePersonStats, loadAllPersons_)
 *     - 11_TransactionService.gs (loadAllPersons_)
 *     - 17_SearchService.gs   (loadAllPersons_)
 *     - 19_Hardening.gs       (loadAllPersons_)
 *     - 21_AliasService.gs    (loadAllPersons_ — UUID converters)
 *   SHEETS ACCESSED:
 *     - SHEET.M_PERSON        (Read+Write: CRUD, Stats update)
 *     - SHEET.M_PERSON_ALIAS  (Read+Write: Alias lookup, createPersonAlias)
 * ===================================================
 * ARCHITECTURE:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  06_PersonService.gs (Person Master Hub)                   │
 *   │  ├── resolvePerson()        — Match/resolve person        │
 *   │  ├── findPersonCandidates() — Multi-strategy search       │
 *   │  │   ├── M_ALIAS Fast Path (resolveMasterUuidViaGlobalAlias)│
 *   │  │   ├── Phone Match                                       │
 *   │  │   ├── Alias Match (M_PERSON_ALIAS)                      │
 *   │  │   ├── Phonetic / Name Match                             │
 *   │  │   └── Note Search (Deep Match)                          │
 *   │  ├── scorePersonCandidate() — Score calculation            │
 *   │  ├── createPerson()         — Create new person record    │
 *   │  ├── createPersonAlias()    — Add alternate name          │
 *   │  ├── mergePersonRecords()   — Merge duplicates (Admin)    │
 *   │  ├── updatePersonStats()    — Update usage statistics     │
 *   │  └── loadAllPersons_()      — Load all persons (cached)   │
 *   └─────────────────────────────────────────────────────────────┘
 * ===================================================
 */

// [PERF-010] Note Inverted Index — Map: word → Set<personId> สำหรับค้นหา Note แบบ O(1)
let _PERSON_NOTE_INVERTED_INDEX = null;

// [PERF-009] Alias Inverted Index — Map<normalized_alias, Set<personId>>
//   Build ครั้งเดียวใน loadAllAliases_ — ลด findByAlias_ จาก O(A) scan → O(1) lookup
let _PERSON_ALIAS_INVERTED_INDEX = null;

// ============================================================
// SECTION 1: resolvePerson
// ============================================================

/**
 * resolvePerson — ค้นหาหรือประเมินบุคคลจากชื่อดิบ
 * [FIX v5.5.012 Anti-pattern #3] รองรับ optional preNormResult เพื่อหลีกเลี่ยงการ normalize ซ้อน
 *   ถ้า caller (เช่น 17_SearchService) ได้ normResult มาแล้ว ส่งเข้ามาเพื่อข้ามการ normalize ซ้ำ
 *   ถ้าไม่ส่ง → ทำ normalize ภายในเหมือนเดิม (backward compatible)
 */
function resolvePerson(rawName, preNormResult, contextHint) {
  // [FIX v5.5.012] ใช้ preNormResult ถ้ามี — หลีกเลี่ยง double normalization
  const normResult = preNormResult || normalizePersonNameFull(rawName);
  const cleanName = normResult.cleanName;

  if (!cleanName || cleanName.length < 2) {
    return { personId: null, status: 'LOW_QUALITY', confidence: 0, normResult };
  }

  const candidates = findPersonCandidates(cleanName, normResult.extractedPhone);

  if (candidates.length === 0) {
    return { personId: null, status: 'NOT_FOUND', confidence: 0, normResult };
  }

  // [UPGRADE v5.5.047] เก็บอันดับ 2 ไว้ด้วยเผื่อต้อง tie-break ด้วย context (2.1)
  let bestPerson = null;
  let bestScore = 0;
  let secondBestPerson = null;
  let secondBestScore = 0;

  candidates.forEach((candidate) => {
    // [UPGRADE v5.1.001] ส่งข้อมูลว่า match ด้วยเบอร์โทรหรือไม่
    const score = scorePersonCandidate(cleanName, candidate, normResult.extractedPhone);
    if (score > bestScore) {
      secondBestPerson = bestPerson;
      secondBestScore = bestScore;
      bestScore = score;
      bestPerson = candidate;
    } else if (score > secondBestScore) {
      secondBestScore = score;
      secondBestPerson = candidate;
    }
  });

  // [NEW v5.5.047 — Contextual Disambiguation 2.1]
  //   คะแนนอันดับ 1-2 ใกล้กันมาก + มี SoldToName context → เช็คประวัติจริงจาก FACT_DELIVERY
  //   ถ้า candidate อันดับ 2 เคยส่งของให้ SoldToName นี้ แต่อันดับ 1 ไม่เคย → สลับ
  const AMBIGUITY_MARGIN = 8;
  if (
    contextHint &&
    contextHint.soldToName &&
    secondBestPerson &&
    bestScore - secondBestScore < AMBIGUITY_MARGIN &&
    bestScore >= AI_CONFIG.THRESHOLD_REVIEW
  ) {
    const bestMatchesContext = personMatchesSoldToContext_(bestPerson.personId, contextHint.soldToName);
    const secondMatchesContext = personMatchesSoldToContext_(secondBestPerson.personId, contextHint.soldToName);
    if (secondMatchesContext && !bestMatchesContext) {
      logDebug(
        'PersonService',
        'Contextual Disambiguation: สลับจาก ' +
          bestPerson.personId +
          ' → ' +
          secondBestPerson.personId +
          ' (SoldTo="' +
          contextHint.soldToName +
          '")'
      );
      bestPerson = secondBestPerson;
      bestScore = Math.max(secondBestScore, AI_CONFIG.THRESHOLD_AUTO);
    }
  }

  if (bestScore >= AI_CONFIG.THRESHOLD_AUTO) {
    return { personId: bestPerson.personId, status: 'FOUND', confidence: bestScore, normResult };
  }
  if (bestScore >= AI_CONFIG.THRESHOLD_REVIEW) {
    // [V6.0.002] Expose secondBestPerson/Score so 10_MatchEngine.processOneRow can
    //   invoke breakTieAmongCandidates() when scores are within ±2. Non-breaking:
    //   existing callers don't read these fields. secondBestPerson may be null when
    //   only one candidate scored above THRESHOLD_REVIEW.
    return {
      personId: bestPerson.personId,
      status: 'NEEDS_REVIEW',
      confidence: bestScore,
      normResult,
      secondBestPerson: secondBestPerson,
      secondBestScore: secondBestScore
    };
  }
  return { personId: null, status: 'NOT_FOUND', confidence: bestScore, normResult };
}

// ============================================================
// SECTION 2: findPersonCandidates
// ============================================================

/**
 * findPersonCandidates — ค้นหา Candidate จาก M_PERSON
 * [FIX v003] Object reference bug: includes → .some(p => p.personId===)
 * [FIX v003] Phone match > 1 → ไปต่อ scoring แทน return ทันที
 * [FIX v003] Phonetic fallback substring(0,2) → (0,3)
 */
function findPersonCandidates(cleanName, phone) {
  // [REF-007] V5.5.019: Refactored — 5 strategies extracted to private helpers
  //   1. findCandidatesByAliasFastPath_  — M_ALIAS Fast Path (early return)
  //   2. findCandidatesByPhone_          — Phone Match (early return if 1, accumulate if >1)
  //   3. accumulateByAliasMatch_         — Alias Match (mutate results/existingIds)
  //   4. accumulateByPhoneticMatch_      — Phonetic/Name Match (mutate results/existingIds)
  //   5. accumulateByNoteSearch_         — Note Search (mutate results/existingIds — only if results empty)
  //   Preserve Behavior 100% — same strategy order, same early returns, same mutation pattern

  const allPersons = loadAllPersons_();
  const results = [];
  // [PERF-004] ใช้ Set<string> สำหรับ O(1) dedup lookup แทน results.some() O(K)
  //   ลดจาก 1M × O(K) → 1M × O(1) ใน Pipeline 1,000 source rows × M_PERSON 1,000
  const existingIds = new Set();

  // Strategy 1: M_ALIAS Fast Path — early return
  const fastPath = findCandidatesByAliasFastPath_(cleanName, allPersons);
  if (fastPath) return fastPath;

  // Strategy 2: Phone Match — early return if exactly 1, accumulate if >1
  const phoneResult = findCandidatesByPhone_(phone, allPersons, results, existingIds);
  if (phoneResult) return phoneResult;

  // Strategy 3: Alias Match — accumulate
  accumulateByAliasMatch_(cleanName, allPersons, results, existingIds);

  // Strategy 4: Phonetic/Name Match — accumulate
  accumulateByPhoneticMatch_(cleanName, allPersons, results, existingIds);

  // Strategy 5: Note Search — only if results still empty
  if (results.length === 0) {
    accumulateByNoteSearch_(cleanName, allPersons, results, existingIds);
  }

  // [V6.0.002] Strategy 6: Double Metaphone Phonetic Match — find persons whose
  //   primary/secondary phonetic key matches the query. Handles ล↔ร confusion and
  //   similar spelling variations that the single-key buildThaiPhoneticKey (Strategy 4)
  //   misses. Uses existing allPersons + existingIds (no extra sheet read).
  if (typeof phoneticMatch === 'function' && cleanName) {
    for (const p of allPersons) {
      if (existingIds.has(p.personId)) continue; // skip already-found candidates
      const phResult = phoneticMatch(cleanName, p.canonical || p.normalized);
      if (phResult.match && phResult.score >= 80) {
        p._phoneticScore = phResult.score;
        p._matchedKey = phResult.matchedKey;
        results.push(p);
        existingIds.add(p.personId);
      }
    }
  }

  return results;
}

/**
 * findCandidatesByAliasFastPath_ — [REF-007] Strategy 1: M_ALIAS Fast Path
 *   รักษา behavior เดิม 100% — early return [perfect] ถ้า score >= 95
 * @param {string} cleanName
 * @param {Array} allPersons
 * @return {Array|null} array of 1 candidate หรือ null ถ้าไม่ match
 * @private
 */
function findCandidatesByAliasFastPath_(cleanName, allPersons) {
  const aliasResolve =
    typeof resolveMasterUuidViaGlobalAlias === 'function' ? resolveMasterUuidViaGlobalAlias(cleanName, 'PERSON') : null;
  if (aliasResolve && aliasResolve.masterUuid && aliasResolve.score >= 95) {
    const ownerId = convertUuidToPersonId(aliasResolve.masterUuid);
    const perfect = allPersons.find((p) => p.personId === ownerId);
    if (perfect) return [perfect];
  }
  return null;
}

/**
 * findCandidatesByPhone_ — [REF-007] Strategy 2: Phone Match
 *   รักษา behavior เดิม 100% — return byPhone ถ้า length === 1, accumulate ถ้า > 1
 *   Mutates results + existingIds ในกรณี > 1 match
 * @param {string} phone
 * @param {Array} allPersons
 * @param {Array} results - mutate ในกรณี > 1 match
 * @param {Set} existingIds - mutate ในกรณี > 1 match
 * @return {Array|null} array ถ้า length === 1 (early return), null ถ้าไม่มีหรือ > 1
 * @private
 */
function findCandidatesByPhone_(phone, allPersons, results, existingIds) {
  if (!phone) return null;
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const byPhone = allPersons.filter((p) => {
    const stored = String(p.phone || '').replace(/[^0-9]/g, '');
    return stored === cleanPhone && stored.length >= 9;
  });

  if (byPhone.length === 1) {
    // [FIX v003] เจอ 1 คน → return เลย (confident)
    return byPhone;
  }
  if (byPhone.length > 1) {
    // [FIX v003] เจอหลายคน → เพิ่มเข้า results แล้วไปต่อ scoring
    byPhone.forEach((p) => {
      // [PERF-004] sync existingIds Set ด้วย (กัน Phone Match path ตกหล่น)
      if (!existingIds.has(p.personId)) {
        results.push(p);
        existingIds.add(p.personId);
      }
    });
  }
  return null;
}

/**
 * accumulateByAliasMatch_ — [REF-007] Strategy 3: Alias Match (mutate results/existingIds)
 *   รักษา behavior เดิม 100%
 * @param {string} cleanName
 * @param {Array} allPersons
 * @param {Array} results - mutate
 * @param {Set} existingIds - mutate
 * @private
 */
function accumulateByAliasMatch_(cleanName, allPersons, results, existingIds) {
  const aliasMatches = findByAlias_(cleanName);
  aliasMatches.forEach((personId) => {
    const found = allPersons.find((p) => p.personId === personId);
    // [PERF-004] O(1) Set lookup แทน results.some() O(K)
    if (found && !existingIds.has(found.personId)) {
      results.push(found);
      existingIds.add(found.personId);
    }
  });
}

/**
 * accumulateByPhoneticMatch_ — [REF-007] Strategy 4: Phonetic/Name Match (mutate results/existingIds)
 *   รักษา behavior เดิม 100% — same buildThaiPhoneticKey, same normAPrefix3 logic
 * @param {string} cleanName
 * @param {Array} allPersons
 * @param {Array} results - mutate
 * @param {Set} existingIds - mutate
 * @private
 */
function accumulateByPhoneticMatch_(cleanName, allPersons, results, existingIds) {
  const searchKey = buildThaiPhoneticKey(cleanName);
  // [PERF-004] ดึง normA ออกนอกลูป (computed ครั้งเดียว ไม่ใช่ทุก iteration)
  //   เดิม: normalizeForCompare(cleanName) ถูกเรียก 1,000 ครั้ง (1 ต่อ person)
  //   ใหม่: เรียกครั้งเดียว + reuse → ลด CPU ~99% สำหรับส่วนนี้
  const normA = normalizeForCompare(cleanName);
  const normAPrefix3 = normA.length >= 3 ? normA.substring(0, 3) : '';

  allPersons.forEach((person) => {
    // [PERF-004] O(1) Set lookup แทน results.some() O(K)
    if (existingIds.has(person.personId)) return;
    const personKey = buildThaiPhoneticKey(person.normalized);

    if (searchKey && personKey && searchKey === personKey) {
      results.push(person);
      existingIds.add(person.personId);
    } else if (normAPrefix3) {
      const normB = normalizeForCompare(person.normalized);
      if (normB && normB.length >= 3 && normB.startsWith(normAPrefix3)) {
        results.push(person);
        existingIds.add(person.personId);
      }
    }
  });
}

/**
 * accumulateByNoteSearch_ — [REF-007] Strategy 5: Note Search (mutate results/existingIds)
 *   รักษา behavior เดิม 100% — uses _PERSON_NOTE_INVERTED_INDEX ถ้ามี, fallback to O(N×M) scan
 * @param {string} cleanName
 * @param {Array} allPersons
 * @param {Array} results - mutate
 * @param {Set} existingIds - mutate
 * @private
 */
function accumulateByNoteSearch_(cleanName, allPersons, results, existingIds) {
  const queryParts = cleanName.split(/\s+/).filter(function (p) {
    return p.length >= 2;
  });
  // ใช้ _PERSON_NOTE_INVERTED_INDEX ถ้ามี — ลดจาก O(N×M) เหลือ O(M)
  if (_PERSON_NOTE_INVERTED_INDEX && Object.keys(_PERSON_NOTE_INVERTED_INDEX).length > 0) {
    const matchingPersonIds = new Set();
    queryParts.forEach(function (part) {
      const key = part.toLowerCase();
      const personIdSet = _PERSON_NOTE_INVERTED_INDEX[key];
      if (personIdSet) {
        personIdSet.forEach(function (pid) {
          matchingPersonIds.add(pid);
        });
      }
    });
    matchingPersonIds.forEach(function (pid) {
      const found = allPersons.find(function (p) {
        return p.personId === pid;
      });
      // [PERF-004] sync existingIds Set
      if (found && !existingIds.has(found.personId)) {
        results.push(found);
        existingIds.add(found.personId);
      }
    });
  } else {
    // Fallback: ถ้ายังไม่มี index ใช้วิธีเดิม
    allPersons.forEach(function (person) {
      if (existingIds.has(person.personId)) return;
      const noteStr = String(person.note || '');
      if (!noteStr) return;
      const isMatch = queryParts.some(function (part) {
        return noteStr.includes(part);
      });
      if (isMatch) {
        results.push(person);
        existingIds.add(person.personId);
      }
    });
  }
}

/**
 * findByAlias_ — ค้นหา Person ID จาก M_PERSON_ALIAS
 * [FIX v003] ใช้ Set กัน duplicate
 * [PERF-009] ใช้ _PERSON_ALIAS_INVERTED_INDEX (O(1) lookup) แทน forEach O(A) scan
 *   เดิม: 1,000 source rows × 2,000 aliases = 2M comparisons + 2M redundant normalizeForCompare
 *   ใหม่: 1,000 source rows × 1 index lookup = 1,000 O(1) lookups
 */
function findByAlias_(cleanName) {
  // [PERF-009] Trigger index build if not yet built
  if (!_PERSON_ALIAS_INVERTED_INDEX) {
    loadAllAliases_();
  }

  const targetNorm = normalizeForCompare(cleanName);
  if (!targetNorm) return [];

  // [PERF-009] O(1) index lookup แทน O(A) forEach scan
  if (_PERSON_ALIAS_INVERTED_INDEX) {
    const personIdSet = _PERSON_ALIAS_INVERTED_INDEX.get(targetNorm);
    return personIdSet ? Array.from(personIdSet) : [];
  }

  // Fallback (defensive — ถ้า index build ล้มเหลว): legacy O(A) scan
  const allAliases = loadAllAliases_();
  const foundSet = new Set();

  allAliases.forEach((alias) => {
    if (!alias[PERSON_ALIAS_IDX.ACTIVE_FLAG]) return;
    const aliasNorm = normalizeForCompare(alias[PERSON_ALIAS_IDX.ALIAS_NAME]);
    if (aliasNorm === targetNorm && aliasNorm.length > 0) {
      foundSet.add(String(alias[PERSON_ALIAS_IDX.PERSON_ID]));
    }
  });

  return Array.from(foundSet);
}

// ============================================================
// SECTION 3: Scoring
// ============================================================

/**
 * scorePersonCandidate — คำนวณคะแนน Match
 * [UPGRADE v5.1.001] เพิ่ม Phone Match Bonus = 95
 * [Fix Phase-C #7] Phone match name-score gate
 *   เดิม: phone match (len≥9) → return 95 ทันที โดยไม่ตรวจชื่อ
 *   ใหม่: phone match + name match (>= SCORE_MIN_THRESHOLD) → return 95 (AUTO_MATCH)
 *        phone match + name mismatch → return nameScore (force REVIEW หรือ reject)
 *   เหตุผล: เบอร์บ้าน/บริษัทใช้ร่วมกันหลายคน → AUTO_MATCH ผิด
 */
function scorePersonCandidate(queryName, candidate, queryPhone) {
  const nameA = normalizeForCompare(queryName);
  const nameB = normalizeForCompare(candidate.normalized || candidate.canonical);

  if (!nameA || !nameB) return 0;

  // [Fix Phase-C #7] คำนวณ nameScore ก่อน — ใช้สำหรับ phone match gate
  const nameScore = calculateNameScore_(nameA, nameB);

  // [Fix Phase-C #7] Phone match name-score gate
  //   เดิม: if (phone match) return 95;  (skip name check ทั้งหมด)
  //   ใหม่: ตรวจชื่อด้วย — ถ้าชื่อไม่ match (nameScore < SCORE_MIN_THRESHOLD)
  //        ให้ return nameScore แทน 95 (force REVIEW แทน AUTO_MATCH)
  if (queryPhone && candidate.phone) {
    const p1 = String(queryPhone).replace(/[^0-9]/g, '');
    const p2 = String(candidate.phone).replace(/[^0-9]/g, '');
    if (p1 === p2 && p1.length >= 9) {
      if (nameScore >= AI_CONFIG.SCORE_MIN_THRESHOLD) {
        return 95; // phone + name ตรง → AUTO_MATCH
      }
      // phone ตรงแต่ชื่อไม่ตรง → คืน nameScore (อาจ < 70 → REVIEW หรือ < 50 → reject)
      //   ไม่ return 95 เพื่อป้องกัน AUTO_MATCH ผิดจากเบอร์บ้าน/บริษัทใช้ร่วมกัน
      logInfo(
        'PersonService',
        'Phone match but name mismatch: phone=' +
          queryPhone +
          ', nameScore=' +
          nameScore +
          ' (threshold=' +
          AI_CONFIG.SCORE_MIN_THRESHOLD +
          ')'
      );
      return nameScore;
    }
  }

  // [FIX v003] ใช้ Config แทน hardcode 60
  let finalScore = nameScore < AI_CONFIG.SCORE_MIN_THRESHOLD ? 0 : nameScore;

  // [V6.0.002] Phonetic match bonus — adds 0-2 points when Double Metaphone matched
  //   (primary=100 → +2, cross=90 → +1, secondary=80 → +0). Only applies to non-phone
  //   matches; phone-match returns above already short-circuit before this line.
  if (candidate._phoneticScore) {
    finalScore += Math.round((candidate._phoneticScore - 80) * 0.1);
  }

  return finalScore;
}

/**
 * calculateNameScore_ — คำนวณ name similarity score จาก normalized names
 * [ADD Phase-C #7] แยก logic การคำนวณ name score ออกจาก phone match gate
 *   เพื่อให้ phone match branch สามารถตรวจ nameScore ก่อนตัดสินใจ return 95 ได้
 *   คืน raw rounded score (0-100) — ยังไม่ผ่าน SCORE_MIN_THRESHOLD check (caller จัดการเอง)
 *
 * Algorithm (เดิมจาก scorePersonCandidate):
 *   - Levenshtein distance → levScore (similarity ratio)
 *   - Dice coefficient (bigram overlap) → diceScore
 *   - Substring containment → ratioScore (100 exact, 80 substring, 0 otherwise)
 *   - ถ้าชื่อสั้น (< 4 ตัว) → เน้น levenshtein เพราะ dice ไม่น่าเชื่อถือ
 *   - ถ้าชื่อยาว (>= 4 ตัว) → เน้น dice เพราะจับความคล้ายแบบ n-gram ได้ดีกว่า
 *
 * @param {string} nameA - normalized query name (จาก normalizeForCompare)
 * @param {string} nameB - normalized candidate name (จาก normalizeForCompare)
 * @return {number} rounded score (0-100) — ยังไม่ผ่าน threshold check
 * @private
 */
function calculateNameScore_(nameA, nameB) {
  const levDist = levenshteinDistance(nameA, nameB);
  const maxLen = Math.max(nameA.length, nameB.length);
  const levScore = maxLen > 0 ? Math.max(0, (1 - levDist / maxLen) * 100) : 0;
  const diceScore = diceCoefficient(nameA, nameB) * 100;

  // แก้ไขบรรทัดที่ 434 จาก nested ternary เป็น logic ที่อ่านง่ายขึ้น:
  let ratioScore = 0;
  if (nameA === nameB) {
    ratioScore = 100;
  } else if (nameA.includes(nameB) || nameB.includes(nameA)) {
    ratioScore = 80;
  }

  let finalScore;
  if (nameA.length < 4) {
    finalScore = levScore * 0.6 + diceScore * 0.2 + ratioScore * 0.2;
  } else {
    finalScore = diceScore * 0.5 + levScore * 0.3 + ratioScore * 0.2;
  }
  return Math.round(finalScore);
}

// ============================================================
// SECTION 4: CRUD
// ============================================================

/**
 * createPerson — สร้างบุคคลใหม่ใน M_PERSON
 * [V6.0.001] เพิ่ม phonetic_primary/secondary (Double Metaphone Thai) ใน newRow
 */
function createPerson(normResult) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_PERSON);
    const now = new Date();
    const newId = generateShortId('P');

    const phoneStr = normResult.extractedPhone ? "'" + normResult.extractedPhone : '';

    // [FIX v5.2.002] รวบรวม Note ทั้งหมด (Phone, Doc, Prefix)
    const allNotes = normResult.deliveryNotes || [];

    const universalMasterId = typeof generateUUID === 'function' ? generateUUID() : generateShortId('UID');

    // [V6.0.001] Compute Double Metaphone keys from cleanName (handles ล/ร confusion)
    //   Falls back gracefully if buildThaiDoubleMetaphone is unavailable (defensive)
    const phoneticKeys =
      typeof buildThaiDoubleMetaphone === 'function'
        ? buildThaiDoubleMetaphone(normResult.cleanName)
        : { primary: '', secondary: '' };

    const newRow = [
      newId,
      normResult.cleanName,
      normalizeForCompare(normResult.cleanName),
      phoneStr,
      now,
      now,
      1,
      APP_CONST.STATUS_ACTIVE,
      allNotes.join(','),
      universalMasterId,
      // [V6.0.001] Phonetic keys — used by MatchEngine for fuzzy name match
      phoneticKeys.primary,
      phoneticKeys.secondary
    ];

    // [FIX-05 v5.4.003] ใช้ getRange+setValues แทน appendRow เพื่อความเสถียร
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, newRow.length).setValues([newRow]);
    invalidatePersonCache_();
    logDebug(
      'PersonService',
      `createPerson: ${newId} (name hash: ${generateMd5Hash(String(normResult.cleanName || '')).substring(0, 8)})`
    );

    // [REMOVED v5.4.001] ไม่เรียก createGlobalAlias() — M_ALIAS เขียนที่ autoEnrich เท่านั้น (Single Writer)
    // autoEnrichAliasesFromFactBatch_() จะเขียน canonical+variant เข้า M_ALIAS เอง

    return newId;
  } catch (err) {
    // [FIX B3 v5.5.002] เพิ่ม try-catch ตาม Rule 12
    logError('PersonService', `createPerson ล้มเหลว: ${err.message}`, err);
    return null;
  }
}

/**
 * createPersonAlias — เพิ่มชื่อสำรองให้บุคคล
 */
function createPersonAlias(personId, aliasName, matchScore) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_PERSON_ALIAS);
    const newId = generateShortId('PA');

    // [FIX-05 v5.4.003] ใช้ getRange+setValues แทน appendRow
    const aliasRow = [newId, personId, aliasName, matchScore || 0, new Date(), true];
    const aliasLastRow = sheet.getLastRow();
    sheet.getRange(aliasLastRow + 1, 1, 1, aliasRow.length).setValues([aliasRow]);
    invalidateAliasCache_();
    logDebug(
      'PersonService',
      `createPersonAlias: ${personId} (alias hash: ${generateMd5Hash(String(aliasName || '')).substring(0, 8)})`
    );

    // [REMOVED v5.4.001] ไม่เรียก createGlobalAlias() — M_ALIAS เขียนที่ autoEnrich เท่านั้น (Single Writer)
  } catch (err) {
    // [FIX B3 v5.5.002] เพิ่ม try-catch ตาม Rule 12
    logError('PersonService', `createPersonAlias ล้มเหลว: ${err.message}`, err);
  }
}

/**
 * updatePersonStats — อัปเดต last_seen และ usage_count
 * [FIX v003] โหลดเฉพาะ person_id column + guard idCol === -1
 */
function updatePersonStats(personId) {
  if (!personId) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_PERSON);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    // [FIX v003] โหลดเฉพาะคอลัมน์ person_id (col 1) แทนทั้งชีต
    const idCol = PERSON_IDX.PERSON_ID + 1;
    const idData = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    let targetRow = -1;

    for (let i = 0; i < idData.length; i++) {
      if (String(idData[i][0]).trim() === personId) {
        targetRow = i + 2;
        break;
      }
    }

    if (targetRow === -1) {
      logWarn('PersonService', `updatePersonStats: ไม่พบ personId ${personId}`);
      return;
    }

    const lastSeenCol = PERSON_IDX.LAST_SEEN + 1;
    // [FIX CodeQL js/unused-local-variable V5.5.035] usageCountCol ไม่ถูกใช้ — statsRange ใช้ width=2 แทน

    // [FIX v5.4.003] Batch write: อ่านทั้ง 2 คอลัมน์ → แก้ใน RAM → เขียนทีเดียว
    // ลดจาก 3 API calls เหลือ 1+1 = 2 API calls
    const statsRange = sheet.getRange(targetRow, lastSeenCol, 1, 2);
    const statsVals = statsRange.getValues();
    const currCount = Number(statsVals[0][1]) || 0;
    statsVals[0][0] = new Date();
    statsVals[0][1] = currCount + 1;
    statsRange.setValues(statsVals);
    invalidatePersonCache_();
  } catch (err) {
    // [FIX LAW-13 v5.4.003] ส่ง err object เพื่อให้ stack trace เข้า SYS_LOG
    logError('PersonService', `updatePersonStats ล้มเหลว: ${err.message}`, err);
  }
}

/**
 * mergePersonRecords — Merge บุคคล 2 คนให้เป็น 1
 * [FIX v003] aliasName ใช้ canonical name ของ sourceId ไม่ใช่ sourceId เอง
 * [FIX v003] เพิ่ม guard idCol === -1
 * [FIX v003] comment "ห้ามลบ" แก้จาก "ห้างลบ"
 */
function mergePersonRecords(sourceId, targetId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.M_PERSON);
    // [FIX B1 v5.5.002] Math.min guard: ป้องกัน Range error ถ้า sheet มีคอลัมน์น้อยกว่า SCHEMA
    const colsToRead = Math.min(SCHEMA[SHEET.M_PERSON].length, sheet.getLastColumn());
    const data = sheet.getRange(1, 1, sheet.getLastRow(), colsToRead).getValues();
    // [FIX v5.5.001] Use PERSON_IDX constants consistently instead of headers.indexOf()
    const idCol = PERSON_IDX.PERSON_ID;
    const statCol = PERSON_IDX.STATUS;
    // [FIX CodeQL js/unused-local-variable V5.5.035] noteCol ไม่ถูกใช้ — ลบทิ้ง
    const canCol = PERSON_IDX.CANONICAL;

    let sourceCanonical = sourceId; // fallback
    let targetMasterUuid = '';

    for (let i = 1; i < data.length; i++) {
      const rowPersonId = String(data[i][idCol]);
      if (rowPersonId === targetId && PERSON_IDX.MASTER_UUID < data[i].length) {
        targetMasterUuid = String(data[i][PERSON_IDX.MASTER_UUID] || '');
      }
      if (rowPersonId !== sourceId) continue;

      const targetRow = i + 1;

      // [FIX v003] ดึง canonical_name ของ source ก่อน merge
      if (data[i][canCol]) {
        sourceCanonical = String(data[i][canCol]);
      }

      // [FIX v003] ห้ามลบ — เปลี่ยน Status เป็น Merged แทน
      // [FIX S5 v5.5.002] Batch write: 2x setValue → 1x setValues (Rule 11)
      const mergeRange = sheet.getRange(targetRow, statCol + 1, 1, 2);
      const mergeNote = `Merged → ${targetId} on ${toThaiDateStr(new Date())}`;
      mergeRange.setValues([[APP_CONST.STATUS_MERGED, mergeNote]]);
      break;
    }

    // [FIX v003] สร้าง Alias ด้วย canonical_name ของ source ไม่ใช่ sourceId
    createPersonAlias(targetId, sourceCanonical, 100);
    if (typeof createGlobalAlias === 'function' && targetMasterUuid) {
      createGlobalAlias(targetMasterUuid, sourceCanonical, 'PERSON', 100, 'ADMIN_MERGE_ACT');
    }
    invalidatePersonCache_();
    logInfo('PersonService', `mergePersonRecords: ${sourceId} → ${targetId}`);
  } catch (err) {
    logError('PersonService', `mergePersonRecords ล้มเหลว: ${err.message}`, err);
    throw err;
  }
}

// ============================================================
// SECTION 5: Data Loaders (with Cache)
// ============================================================

function loadAllPersons_() {
  const cacheKey = 'M_PERSON_ALL';
  const cache = CacheService.getScriptCache();
  // [PERF-004] ลองอ่าน chunked cache ก่อน
  const cachedData = loadChunkedCache_(cache, cacheKey);
  if (cachedData) return cachedData;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.M_PERSON);
  if (!sheet || sheet.getLastRow() < 2) return [];

  // [FIX v5.4.001] ใช้ Math.min เพื่อป้องกัน Range error เมื่อชีตมีคอลัมน์น้อยกว่า SCHEMA
  // (กรณีชีตเก่าที่ยังไม่มี master_uuid column)
  const colsToRead = Math.min(SCHEMA[SHEET.M_PERSON].length, sheet.getLastColumn());
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, colsToRead).getValues();

  const result = rows
    .filter((r) => r[PERSON_IDX.PERSON_ID])
    .filter(
      (r) => r[PERSON_IDX.STATUS] !== APP_CONST.STATUS_ARCHIVED && r[PERSON_IDX.STATUS] !== APP_CONST.STATUS_MERGED
    )
    .map((r) => ({
      personId: String(r[PERSON_IDX.PERSON_ID]),
      canonical: String(r[PERSON_IDX.CANONICAL] || ''),
      normalized: String(r[PERSON_IDX.NORMALIZED] || ''),
      phone: String(r[PERSON_IDX.PHONE] || '').replace(/^'/, ''),
      usageCount: Number(r[PERSON_IDX.USAGE_COUNT] || 0),
      note: String(r[PERSON_IDX.NOTE] || ''),
      masterUuid: String(r[PERSON_IDX.MASTER_UUID] || '')
    }));

  // [PERF-010] สร้าง Note Inverted Index — Map: word → Set<personId>
  const noteIndex = {};
  result.forEach(function (p) {
    const noteStr = String(p.note || '').trim();
    if (!noteStr) return;
    // แยกคำจาก note โดยใช้ whitespace + common delimiters
    const words = noteStr.split(/[\s,;|\/\-]+/).filter(function (w) {
      return w.length >= 2;
    });
    words.forEach(function (word) {
      const key = word.toLowerCase();
      if (!noteIndex[key]) noteIndex[key] = new Set();
      noteIndex[key].add(p.personId);
    });
  });
  _PERSON_NOTE_INVERTED_INDEX = noteIndex;

  // [PERF-004] Chunked cache — แบ่งข้อมูลเป็น chunk ละ 200 items เพื่อไม่ให้เกิน 100KB limit
  saveChunkedCache_(cache, cacheKey, result);
  return result;
}

function loadAllAliases_() {
  const cacheKey = 'M_PERSON_ALIAS_ALL';
  const cache = CacheService.getScriptCache();
  // [PERF-004] ลองอ่าน chunked cache ก่อน
  const cachedData = loadChunkedCache_(cache, cacheKey);
  if (cachedData) {
    // [PERF-009] Build inverted index ครั้งเดียวหลัง cache hit
    _buildPersonAliasInvertedIndex_(cachedData);
    return cachedData;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.M_PERSON_ALIAS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  // [FIX v5.4.001] ใช้ Math.min เพื่อป้องกัน Range error
  const colsToRead = Math.min(SCHEMA[SHEET.M_PERSON_ALIAS].length, sheet.getLastColumn());
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, colsToRead).getValues();
  // [PERF-004] Chunked cache — แบ่งข้อมูลเป็น chunk ละ 200 items
  saveChunkedCache_(cache, cacheKey, rows);
  // [PERF-009] Build inverted index ครั้งเดียวหลัง sheet read
  _buildPersonAliasInvertedIndex_(rows);
  return rows;
}

/**
 * _buildPersonAliasInvertedIndex_ — [PERF-009] Build Map<normalized_alias, Set<personId>>
 *   เรียกครั้งเดียวหลัง loadAllAliases_ เพื่อให้ findByAlias_ ใช้ O(1) lookup แทน O(A) scan
 *   Index ถูก cache ใน RAM (_PERSON_ALIAS_INVERTED_INDEX) — rebuild เมื่อ invalidateAliasCache_
 * @param {Array[]} allAliases - 2D array ของ M_PERSON_ALIAS rows
 * @private
 */
function _buildPersonAliasInvertedIndex_(allAliases) {
  if (_PERSON_ALIAS_INVERTED_INDEX) return; // already built
  _PERSON_ALIAS_INVERTED_INDEX = new Map();
  if (!allAliases || allAliases.length === 0) return;

  allAliases.forEach(function (alias) {
    if (!alias[PERSON_ALIAS_IDX.ACTIVE_FLAG]) return;
    const aliasNorm = normalizeForCompare(alias[PERSON_ALIAS_IDX.ALIAS_NAME]);
    if (!aliasNorm) return;
    const personId = String(alias[PERSON_ALIAS_IDX.PERSON_ID]);
    if (!_PERSON_ALIAS_INVERTED_INDEX.has(aliasNorm)) {
      _PERSON_ALIAS_INVERTED_INDEX.set(aliasNorm, new Set());
    }
    _PERSON_ALIAS_INVERTED_INDEX.get(aliasNorm).add(personId);
  });
}

/**
 * batchUpdatePersonStats_ — [PERF-001] [REF-009] Batch stats update สำหรับ Person
 * Delegated to batchUpdateEntityStats_() in 14_Utils.gs — thin wrapper
 * @param {Set<string>} personIds - Set of person IDs to update
 */
function batchUpdatePersonStats_(personIds) {
  batchUpdateEntityStats_(
    SHEET.M_PERSON,
    PERSON_IDX,
    PERSON_IDX.PERSON_ID,
    PERSON_IDX.USAGE_COUNT,
    PERSON_IDX.LAST_SEEN,
    personIds,
    invalidatePersonCache_
  );
}

/**
 * invalidatePersonCache_ — [REF-011] Uses centralized invalidateChunkedCache_
 */
function invalidatePersonCache_() {
  invalidateChunkedCache_('M_PERSON_ALL', function () {
    _PERSON_NOTE_INVERTED_INDEX = null;
  });
}
/**
 * invalidateAliasCache_ — [REF-011] Uses centralized invalidateChunkedCache_
 * [PERF-009] ล้าง _PERSON_ALIAS_INVERTED_INDEX ด้วย — กัน stale index หลัง alias changes
 *   (createPersonAlias, autoEnrichAliasesFromFactBatch_, MIGRATION Step 2)
 */
function invalidateAliasCache_() {
  _PERSON_ALIAS_INVERTED_INDEX = null; // [PERF-009] clear inverted index → rebuild on next loadAllAliases_
  invalidateChunkedCache_('M_PERSON_ALIAS_ALL');
}

// ============================================================
// SECTION 6: [PERF-004] [REF-010] Chunked Cache Helpers
// MOVED to 14_Utils.gs (saveChunkedCache_, loadChunkedCache_)
// These functions are now centralized in 14_Utils.gs Section 9.
// Callers in this file use saveChunkedCache_() / loadChunkedCache_()
// which resolve to the global functions in 14_Utils.gs.
// ============================================================

// ============================================================
// SECTION 7: [NEW v5.5.047] Contextual Disambiguation (2.1)
// ============================================================

/**
 * buildPersonSoldToIndex_ — [NEW v5.5.047] สร้าง index personId → [soldToName ที่เคยพบ] จาก FACT_DELIVERY
 *   ใช้ใน Contextual Disambiguation — ถ้าชื่อซ้ำ ใช้ SoldToName เป็น tie-breaker
 *   Cache ผ่าน chunked cache (TTL ตาม AI_CONFIG.CACHE_TTL_SEC ปกติ 6 ชม.)
 * @return {Object} { [personId]: string[] }
 * @private
 */
function buildPersonSoldToIndex_() {
  const cacheKey = 'M_PERSON_SOLDTO_INDEX';
  const cache = CacheService.getScriptCache();
  const cached = loadChunkedCache_(cache, cacheKey);
  if (cached) return cached;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  const index = {};
  if (!sheet || sheet.getLastRow() < 2) return index;

  const colsToRead = Math.min(SCHEMA[SHEET.FACT_DELIVERY].length, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colsToRead).getValues();

  data.forEach(function (row) {
    const personId = String(row[FACT_IDX.PERSON_ID] || '').trim();
    const soldTo = normalizeForCompare(String(row[FACT_IDX.SOLD_TO_NAME] || ''));
    if (!personId || !soldTo) return;
    if (!index[personId]) index[personId] = [];
    if (index[personId].indexOf(soldTo) === -1) index[personId].push(soldTo);
  });

  saveChunkedCache_(cache, cacheKey, index);
  return index;
}

/**
 * personMatchesSoldToContext_ — [NEW v5.5.047] เช็คว่า personId เคยส่งของให้ SoldToName นี้มาก่อนไหม
 *   ใช้ใน Contextual Disambiguation เป็น tie-breaker
 * @param {string} personId
 * @param {string} soldToNameRaw
 * @return {boolean}
 * @private
 */
function personMatchesSoldToContext_(personId, soldToNameRaw) {
  if (!personId || !soldToNameRaw) return false;
  const idx = buildPersonSoldToIndex_();
  const soldTo = normalizeForCompare(soldToNameRaw);
  return !!(idx[personId] && idx[personId].indexOf(soldTo) !== -1);
}
