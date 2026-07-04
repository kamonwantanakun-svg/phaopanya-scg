# LMDS V6.0 Enhancement Roadmap

> **Document Type:** Technical Enhancement Roadmap
> **Version:** 6.0.0-draft
> **Last Updated:** 2026-07-05
> **Author:** LMDS Engineering (with AI Assistant)
> **Status:** Draft for Review
> **Base Version:** V5.5.044 (post-audit PR #22-#25)
> **Target Version:** V6.0.000 (after all 7 phases complete)

---

## สารบัญ

1. [Executive Summary & Vision](#1-executive-summary--vision)
2. [Current State Analysis (V5.5.044)](#2-current-state-analysis-v55044)
3. [Phase 1: Data Cleansing (PR #26)](#3-phase-1-data-cleansing-pr-26)
4. [Phase 2: Matching Engine (PR #27)](#4-phase-2-matching-engine-pr-27)
5. [Phase 3: System Learning (PR #28)](#5-phase-3-system-learning-pr-28)
6. [Phase 4: WebApp & Dashboard (PR #29)](#6-phase-4-webapp--dashboard-pr-29)
7. [Phase 5: Pipeline Management (PR #30)](#7-phase-5-pipeline-management-pr-30)
8. [Phase 6: Architecture & Data (PR #31)](#8-phase-6-architecture--data-pr-31)
9. [Phase 7: Security RBAC (PR #32)](#9-phase-7-security-rbac-pr-32)
10. [Migration & Deployment Plan](#10-migration--deployment-plan)
11. [Effort Estimates & Timeline](#11-effort-estimates--timeline)
12. [Risk Assessment & Mitigation](#12-risk-assessment--mitigation)
13. [Acceptance Criteria per Phase](#13-acceptance-criteria-per-phase)
14. [Appendix: Technical Specifications](#14-appendix-technical-specifications)

---

## 1. Executive Summary & Vision

### 1.1 เป้าหมายหลัก

LMDS V6.0 มุ่งยกระดับระบบจาก **"Master Data + Matching Engine ที่ใช้งานได้"** เป็น **"Intelligent Logistics Data Platform ที่เรียนรู้และปรับตัวเองได้"** โดยเพิ่ม 14 enhancements ครอบคลุม 7 ด้าน:

| ด้าน | Features | Phase | PR |
|-----|----------|-------|-----|
| **Data Cleansing** | Semantic Note Parser + Double Metaphone Phonetic | Phase 1 | #26 |
| **Matching Engine** | Contextual Disambiguation + Dynamic Weighting + Geofencing Tie-breaker | Phase 2 | #27 |
| **System Learning** | Self-Healing Alias จาก Q_REVIEW | Phase 3 | #28 |
| **WebApp & Dashboard** | Map Analytics + Live Feed Monitor | Phase 4 | #29 |
| **Pipeline Management** | Email Alert + Dependency-aware Pipeline | Phase 5 | #30 |
| **Architecture & Data** | Dedup Audit + Audit Trail | Phase 6 | #31 |
| **Security** | RBAC 3 roles (Viewer/Reviewer/Admin) | Phase 7 | #32 |

### 1.2 Business Outcomes

หลัง implement ครบทั้ง 7 phases ระบบจะ:

| Outcome | Current (V5.5.044) | Target (V6.0.000) | Measurement |
|---------|-------------------|-------------------|-------------|
| **Auto Match Rate** | ~75% | ≥90% | FACT_DELIVERY.match_status = AUTO_MATCHED |
| **Q_REVIEW Pending** | ~25% | ≤10% | Q_REVIEW.status = Pending count |
| **Admin Time Saved** | baseline | -50% | SOP-D01/D02 manual work time |
| **False Positive Rate** | ~5% | ≤2% | Q_REVIEW decision = IGNORE ratio |
| **Master Data Quality** | unmaintained | auditable | SYS_AUDIT_TRAIL coverage ≥95% |
| **Time-to-Detect Issues** | manual review | ≤5 min | Email alert latency from event |

### 1.3 Key Decisions (จาก user clarification)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Approach | Roadmap doc ก่อน | ลด scope creep risk |
| Phase 1 Priority | Cleansing + Matching | impact สูงสุดต่อ match rate |
| PR Strategy | 1 category = 1 PR | balance velocity & review quality |
| Data Storage | Sheet ใหม่ | normalized, scalable |
| Map Library | Leaflet.js | free, lightweight, GAS-friendly |
| Alert Channel | Email (GmailApp) | ไม่ต้องเพิ่ม OAuth scope ใหม่ |
| RBAC Roles | 3 roles | ครอบคลุม use case จริง |

---

## 2. Current State Analysis (V5.5.044)

### 2.1 Strengths (จาก audit 4 รอบ)

หลัง PR #22-#25 ระบบมีความแข็งแรงในด้าน:

| ด้าน | Status | Evidence |
|-----|--------|----------|
| **State Machine** | ✅ Stable | BUG-PM-001 fixed (Pipeline Manager) |
| **Auth Security** | ✅ Hardened | BUG-PM-003 deny-by-default |
| **API Key Validation** | ✅ Consistent | BUG-PM-002 dual format |
| **Schema Validation** | ✅ Consistent | BUG-PM-004 Math.min guard |
| **Schedule Enforcement** | ✅ Bounded | BUG-PM-005 business hours guard |
| **Silent Failure** | ✅ Logged | 8 catch blocks แก้แล้ว |
| **Dead Code** | ✅ Removed | 12 functions + 1 RAM cache ลบแล้ว |
| **Code Quality** | ✅ 16/16 Laws | COMPLIANT |

### 2.2 Gaps ที่ V6.0 จะ address

| Gap | Current Behavior | V6.0 Solution | Phase |
|-----|-----------------|---------------|-------|
| **Note สูญหาย** | ลบทิ้งจาก name | Extract → SYS_NOTES | Phase 1.1 |
| **Phonetic ไม่ละเอียด** | ตัดพยัญชนะ 6 ตัว | Double Metaphone | Phase 1.2 |
| **Duplicate Name Match** | สับสน "สมชาย" หลายคน | SoldToName disambiguation | Phase 2.1 |
| **Fixed Weights** | person/place/geo ตายตัว | Dynamic ตาม data completeness | Phase 2.2 |
| **Tie-break ไม่มี** | เลือก candidate แรก | History-based + street distance | Phase 2.3 |
| **No Learning** | Admin edit แล้วไม่เรียนรู้ | Self-Healing Alias | Phase 3.1 |
| **No Spatial View** | tables/charts only | Leaflet heatmap | Phase 4.1 |
| **No Live Monitoring** | รอ pipeline จบ | Live Feed WebSocket-style | Phase 4.2 |
| **No Alerting** | ต้องเช็คเอง | Email alert | Phase 5.1 |
| **No Dependency Check** | รันได้แม้ข้อมูลไม่ครบ | Pre-flight readiness check | Phase 5.2 |
| **No Dedup Audit** | duplicates สะสม | Levenshtein <2 scanner | Phase 6.1 |
| **No Audit Trail** | ไม่รู้ใครแก้อะไร | SYS_AUDIT_TRAIL | Phase 6.2 |
| **Binary Auth** | admin/non-admin | 3 roles RBAC | Phase 7.1 |

### 2.3 Baseline Metrics (สำหรับวัดผล V6.0)

ก่อนเริ่ม Phase 1, ให้ capture baseline:

```sql
-- รันใน Apps Script Editor เพื่อ capture baseline
SELECT
  COUNT(*) AS total_fact,
  SUM(CASE WHEN match_status IN ('AUTO_MATCHED','FULL_MATCH','GEO_ANCHOR','FUZZY_MATCH') THEN 1 ELSE 0 END) AS auto_matched,
  SUM(CASE WHEN match_status = 'CREATED' THEN 1 ELSE 0 END) AS created_new,
  SUM(CASE WHEN match_status = 'REVIEW' THEN 1 ELSE 0 END) AS review_pending
FROM FACT_DELIVERY
WHERE delivery_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
```

บันทึกผลใน `docs/V6.0_baseline_metrics.md` ก่อนเริ่ม Phase 1

---

## 3. Phase 1: Data Cleansing (PR #26)

### 3.1 Feature 1.1: Semantic Note Parser

#### 3.1.1 ปัญหาปัจจุบัน

ปัจจุบัน `05_NormalizeService.gs` ใช้ `DELIVERY_NOTE_LIST` (50+ patterns) ลบทิ้งจาก name/address:

```javascript
// ปัจจุบัน — ลบทิ้งอย่างเดียว
DELIVERY_NOTE_LIST.forEach(noteWord => {
  if (working.includes(noteWord)) {
    notes.push(noteWord);  // push ลง notes array แต่ไม่ structure
    working = working.replace(new RegExp(safeNote, 'g'), '').trim();
  }
});
```

**ผลกระทบ:**
- ข้อมูลสำคัญหายไป (เบอร์โทรติดต่อ, เวลานัดส่ง, คำสั่งพิเศษ)
- ฝ่ายปฏิบัติการไม่เห็น note ตอนจัดรถ
- ไม่มี audit trail ของ note ที่ถูก extract

#### 3.1.2 Solution: SYS_NOTES Sheet

**Schema ใหม่:**

```javascript
// 02_Schema.gs — เพิ่ม SYS_NOTES schema
'SYS_NOTES': [
  'note_id',           // [0] N+12 hex (generateShortId('N'))
  'entity_type',       // [1] 'PERSON' | 'PLACE' | 'FACT'
  'entity_id',         // [2] FK → M_PERSON.person_id | M_PLACE.place_id | FACT_DELIVERY.tx_id
  'note_type',         // [3] 'CONTACT' | 'TIME' | 'INSTRUCTION' | 'COD' | 'FRAGILE' | 'OTHER'
  'note_value',        // [4] structured value (เบอร์โทร, เวลา, etc.)
  'note_raw',          // [5] original text ที่ extract มา
  'source',            // [6] 'SCG_RAW' | 'DRIVER_INPUT' | 'AI_EXTRACTED'
  'confidence',        // [7] 0-100 (100 = regex match, 80 = AI extracted)
  'created_at',        // [8] timestamp
  'created_by',        // [9] 'system' | user email
  'active_flag',       // [10] TRUE/FALSE
],
```

**Note Type Classification:**

| Type | Patterns | Example |
|------|----------|---------|
| `CONTACT` | `โทร\s*\d`, `เบอร์\s*\d`, `Tel\s*\d` | "โทร 081-234-5678" → note_value = "0812345678" |
| `TIME` | `ส่งก่อนเที่ยง`, `ส่งเช้า`, `นัดส่ง\s*\d+:\d+` | "ส่งก่อนเที่ยง" → note_value = "BEFORE_NOON" |
| `INSTRUCTION` | `ฝากป้อม`, `ฝากยาม`, `เข้าซอย` | "ฝากป้อม" → note_value = "GUARD_POST" |
| `COD` | `COD`, `เก็บเงินปลายทาง`, `เก็บเงินสด` | "COD 5000" → note_value = "5000" |
| `FRAGILE` | `ห้ามโยน`, `ระวังแตก`, `บอบบาง`, `แก้ว` | "ห้ามโยน" → note_value = "FRAGILE" |
| `OTHER` | ที่เหลือ | raw text |

**Function Signatures:**

```javascript
/**
 * parseAndStoreSemanticNotes — extract + store notes ใน SYS_NOTES
 * @param {string} rawText - raw name/address ก่อน normalize
 * @param {string} entityType - 'PERSON' | 'PLACE' | 'FACT'
 * @param {string} entityId - FK to master table
 * @param {string} source - 'SCG_RAW' | 'DRIVER_INPUT' | 'AI_EXTRACTED'
 * @return {{ cleanText: string, notesExtracted: number, notesByType: Object }}
 */
function parseAndStoreSemanticNotes(rawText, entityType, entityId, source) { ... }

/**
 * getNotesForEntity — ดึง notes ทั้งหมดของ entity
 * @param {string} entityType
 * @param {string} entityId
 * @param {string[]} [noteTypes] - filter by type (optional)
 * @return {Array} array of note objects
 */
function getNotesForEntity(entityType, entityId, noteTypes) { ... }

/**
 * extractContactPhone — regex extract phone number
 * @param {string} text
 * @return {{ phone: string|null, cleanedText: string }}
 * @private
 */
function extractContactPhone_(text) { ... }

// Similar: extractTime_, extractCOD_, extractFragile_, extractInstruction_
```

#### 3.1.3 Integration Points

| Caller | File | Change |
|--------|------|--------|
| `normalizePersonNameFull` | `05_NormalizeService.gs:156` | เรียก `parseAndStoreSemanticNotes` ก่อน strip |
| `normalizePlaceName` | `05_NormalizeService.gs:356` | เรียก `parseAndStoreSemanticNotes` ก่อน strip |
| `processOneRow` | `10_MatchEngine.gs:876` | ส่ง rawPersonName + rawAddress เข้า parser ก่อน normalize |
| `applyReviewDecision` | `12_ReviewService.gs` | ดึง notes มาแสดงใน review UI |

#### 3.1.4 Migration Plan

```javascript
/**
 * MIGRATION_V6_SemanticNotes — one-time migration script
 *   1. สร้าง SYS_NOTES sheet ถ้ายังไม่มี
 *   2. อ่าน M_PERSON + M_PLACE ทั้งหมด
 *   3. รัน parseAndStoreSemanticNotes กับแต่ละ row
 *   4. บันทึก notes ที่ extract ได้ลง SYS_NOTES (source = 'MIGRATION')
 *   5. อย่าแก้ canonical_name ของ master (เก็บ original ไว้)
 */
function MIGRATION_V6_SemanticNotes() { ... }
```

#### 3.1.5 Test Cases

```javascript
// Test data
const testCases = [
  {
    input: 'สมชาย โทร 081-234-5678 ส่งก่อนเที่ยง',
    expected: {
      cleanText: 'สมชาย',
      notes: [
        { type: 'CONTACT', value: '0812345678', raw: 'โทร 081-234-5678' },
        { type: 'TIME', value: 'BEFORE_NOON', raw: 'ส่งก่อนเที่ยง' }
      ]
    }
  },
  {
    input: 'ร้าน ABC COD 5000 ห้ามโยน ฝากป้อม',
    expected: {
      cleanText: 'ร้าน ABC',
      notes: [
        { type: 'COD', value: '5000', raw: 'COD 5000' },
        { type: 'FRAGILE', value: 'FRAGILE', raw: 'ห้ามโยน' },
        { type: 'INSTRUCTION', value: 'GUARD_POST', raw: 'ฝากป้อม' }
      ]
    }
  }
];
```

---

### 3.2 Feature 1.2: Double Metaphone for Thai

#### 3.2.1 ปัญหาปัจจุบัน

`buildThaiPhoneticKey` ปัจจุบันแค่ลบสระ + วรรณยุกต์ + ตัด 6 ตัว:

```javascript
// ปัจจุบัน — ง่ายเกินไป
function buildThaiPhoneticKey(thaiName) {
  if (!thaiName) return '';
  const key = thaiName.replace(/[\u0E30-\u0E4E\s]/g, '');
  if (key.length < 3) return '';
  return key.substring(0, 6);
}
```

**ปัญหา:**
- "พรรณ" (ph-r-n) vs "พัน" (ph-n) → key เดียวกัน "พร" → false positive
- "ศิริ" vs "สิริ" → key ต่างกัน ("ศร" vs "สร") → false negative
- ไม่รองรับ sound-alike (ร/l, ศ/ษ/ส, ๑/๒)

#### 3.2.2 Solution: Thai Double Metaphone

**Algorithm (Lawrence Philips' Double Metaphone adapted for Thai):**

```javascript
/**
 * buildThaiDoubleMetaphone — Thai-aware Double Metaphone
 *   สร้าง 2 keys (primary, secondary) สำหรับแต่ละ name
 *   ช่วยให้ match "พรรณ" ↔ "พัน" (different spelling, same sound)
 *
 * @param {string} thaiName - ชื่อไทยเต็ม
 * @return {{ primary: string, secondary: string }}
 *   primary: หลัก (เก็บ consonant class)
 *   secondary: สำรอง (สำหรับ variant)
 */
function buildThaiDoubleMetaphone(thaiName) {
  if (!thaiName) return { primary: '', secondary: '' };

  // Step 1: Normalize — ลบสระ + วรรณยุกต์ + symbol
  let s = String(thaiName)
    .replace(/[\u0E30-\u0E4E\s]/g, '')  // สระ + วรรณยุกต์
    .replace(/[\u0E4F-\u0E7F]/g, '');    // symbols

  if (s.length < 2) return { primary: '', secondary: '' };

  // Step 2: Phonetic substitutions (Thai-specific)
  // ศ/ษ/ส → S, ร/L → R, ล/R → L (variant), ฃ/ข/K → K, etc.
  const primaryMap = {
    'ศ': 'S', 'ษ': 'S', 'ส': 'S', 'ซ': 'S',
    'จ': 'J', 'ฉ': 'C', 'ช': 'C', 'ฌ': 'C',
    'ฎ': 'D', 'ด': 'D', 'ฏ': 'D', 'ต': 'D', 'ฑ': 'D', 'ท': 'D', 'ธ': 'D',
    'บ': 'B', 'ป': 'B', 'พ': 'B', 'ฟ': 'B', 'ภ': 'B',
    'ก': 'K', 'ข': 'K', 'ค': 'K', 'ฃ': 'K', 'ฅ': 'K', 'ฆ': 'K', 'ง': 'K',
    'ม': 'M', 'น': 'N', 'ณ': 'N', 'ญ': 'N', 'ณ': 'N', 'ฬ': 'N',
    'ย': 'Y', 'ฬ': 'L', 'ล': 'L', 'ร': 'L',  // R→L (Thai R sounds like L in some dialects)
    'ว': 'W', 'ห': 'H', 'ฮ': 'H', 'อ': 'A',
  };
  // Secondary map (for variant matching)
  const secondaryMap = { ...primaryMap, 'ร': 'R', 'ล': 'R' };  // R/L swap

  let primary = '';
  let secondary = '';
  for (const ch of s) {
    if (primaryMap[ch]) {
      primary += primaryMap[ch];
      secondary += secondaryMap[ch] || primaryMap[ch];
    }
  }

  // Step 3: Collapse duplicates
  primary = primary.replace(/(.)\1+/g, '$1');
  secondary = secondary.replace(/(.)\1+/g, '$1');

  return {
    primary: primary.substring(0, 8),
    secondary: secondary.substring(0, 8)
  };
}
```

**Comparison Helper:**

```javascript
/**
 * phoneticMatch — check if 2 names phonetically match
 *   ใช้ double metaphone — match ถ้า primary ตรง หรือ cross-match (primary↔secondary)
 * @param {string} name1
 * @param {string} name2
 * @return {{ match: boolean, score: number, matchedKey: 'primary'|'secondary'|'cross' }}
 */
function phoneticMatch(name1, name2) {
  const k1 = buildThaiDoubleMetaphone(name1);
  const k2 = buildThaiDoubleMetaphone(name2);

  if (!k1.primary || !k2.primary) return { match: false, score: 0, matchedKey: null };

  if (k1.primary === k2.primary) {
    return { match: true, score: 100, matchedKey: 'primary' };
  }
  if (k1.primary === k2.secondary || k1.secondary === k2.primary) {
    return { match: true, score: 90, matchedKey: 'cross' };
  }
  if (k1.secondary === k2.secondary) {
    return { match: true, score: 80, matchedKey: 'secondary' };
  }
  return { match: false, score: 0, matchedKey: null };
}
```

#### 3.2.3 Test Cases

```javascript
const testCases = [
  { a: 'พรรณ', b: 'พัน', expectMatch: true,  expectScore: 90 },  // R→L
  { a: 'ศิริ', b: 'สิริ', expectMatch: true,  expectScore: 100 }, // ศ/ส → S
  { a: 'กอบัติ', b: 'กอบัติ', expectMatch: true,  expectScore: 100 },
  { a: 'สมชาย', b: 'สมหญิง', expectMatch: false, expectScore: 0 }, // ต่างท้าย
  { a: 'นภา', b: 'นภา', expectMatch: true,  expectScore: 100 },
  { a: 'วิไล', b: 'วิไลวรรณ', expectMatch: true,  expectScore: 90 }, // prefix match
];
```

#### 3.2.4 Schema Migration

เพิ่ม column ใหม่ใน `M_PERSON` และ `M_PLACE`:

```javascript
// 02_Schema.gs
'M_PERSON': [
  // ... existing 10 columns ...
  'phonetic_primary',   // [10] Double Metaphone primary key
  'phonetic_secondary', // [11] Double Metaphone secondary key
],
```

```javascript
// 01_Config.gs — PERSON_IDX เพิ่ม
PERSON_IDX = Object.freeze({
  // ... existing ...
  PHONETIC_PRIMARY: 10,
  PHONETIC_SECONDARY: 11,
});
```

---

## 4. Phase 2: Matching Engine (PR #27)

### 4.1 Feature 2.1: Contextual Disambiguation

#### 4.1.1 ปัญหา

"สมชาย" มีได้หลายคนใน M_PERSON — คนขับ SCG, คนขับ JWD, ลูกค้าบริษัท A, ลูกค้าบริษัท B ปัจจุบัน MatchEngine ไม่สนใจ context อาจ match ผิดคน

#### 4.1.2 Solution: SoldToName Disambiguation Rule

**New Rule 4.5 (ระหว่าง Rule 4 FULL_MATCH และ Rule 5 GEO_ANCHOR):**

```javascript
/**
 * makeMatchDecision — เพิ่ม Rule 4.5
 *   Rule 4.5: CONTEXTUAL_DISAMBIGUATION
 *     ถ้า Person match แต่ SoldToName ต่าง customer group → demote score + send to Q_REVIEW
 */
function makeMatchDecision(srcObj, personResult, placeResult, geoResult) {
  // ... Rule 1-4 existing ...

  // Rule 4.5: Contextual Disambiguation
  if (personResult.personId) {
    const masterSoldTo = getMasterSoldToForPerson_(personResult.personId);
    if (masterSoldTo && srcObj.soldToName &&
        !isSameCustomerGroup_(masterSoldTo, srcObj.soldToName)) {
      // Demote + review
      return {
        status: 'REVIEW',
        confidence: 70,
        reason: 'CONTEXT_AMBIGUOUS_SOLDTO_MISMATCH',
        action: 'REVIEW',
        evidence: `person_match|soldto_mismatch(master=${masterSoldTo},src=${srcObj.soldToName})`
      };
    }
  }

  // ... Rule 5-8 existing ...
}

/**
 * getMasterSoldToForPerson_ — ดึง SoldToName ล่าสุดที่เคยจัดส่งให้ person นี้
 *   จาก FACT_DELIVERY ล่าสุด 30 วัน
 * @private
 */
function getMasterSoldToForPerson_(personId) {
  // Query FACT_DELIVERY WHERE person_id = ? ORDER BY delivery_date DESC LIMIT 1
  // Return sold_to_name
}

/**
 * isSameCustomerGroup_ — เช็คว่า 2 SoldToName อยู่ในกลุ่มลูกค้าเดียวกันไหม
 *   ใช้ prefix matching + SCG_CONFIG.EPOD_OWNERS list
 * @private
 */
function isSameCustomerGroup_(soldTo1, soldTo2) {
  // 1. Exact match → true
  // 2. ตรวจ SCG_CONFIG.EPOD_OWNERS — ถ้าทั้งคู่อยู่ในกลุ่มเดียวกัน → true
  // 3. Prefix match (first 3 words) → true
  // 4. อื่นๆ → false
}
```

#### 4.1.2 Score Adjustment

ถ้า SoldToName ตรง → bonus +5 คะแนน (ลด false negative)

### 4.2 Feature 2.2: Dynamic Weighting

#### 4.2.1 ปัญหา

ปัจจุบัน weights ตายตัว:
- Rule 4 FULL_MATCH: `geo×0.5 + person×0.3 + place×0.2`
- Rule 5 GEO_ANCHOR: `geo×0.60 + person|place×(0.25/0.15)`

ถ้า address สั้นมาก (noise เยอะ) แต่ phone ตรง → ควรให้ phone weight สูงกว่า place

#### 4.2.2 Solution: Data Completeness-Aware Weights

```javascript
/**
 * calculateDynamicWeights — ปรับ weights ตาม data completeness
 * @param {Object} srcObj - { rawPersonName, rawAddress, rawPhone, rawLat, rawLng }
 * @return {Object} { person, place, geo, phone }
 */
function calculateDynamicWeights(srcObj) {
  // Default weights (Rule 4)
  let weights = { person: 0.3, place: 0.2, geo: 0.5, phone: 0 };

  // Calculate completeness scores (0-1)
  const personRichness = assessNameRichness_(srcObj.rawPersonName); // length, has thai, has latin
  const placeRichness = assessAddressRichness_(srcObj.rawAddress); // length, has postcode, has province
  const hasPhone = !!(srcObj.rawPhone && srcObj.rawPhone.length >= 9);
  const hasGeo = !!(srcObj.rawLat && srcObj.rawLng && srcObj.rawLat !== 0);

  // Adjust: if place very weak, shift weight to person+phone
  if (placeRichness < 0.3) {
    weights.place = 0.05;
    weights.person += 0.10;
    if (hasPhone) weights.phone = 0.10;
    weights.geo += 0.05;
  }

  // Adjust: if person very short (<4 chars), shift weight to phone+place
  if (personRichness < 0.4) {
    weights.person = 0.15;
    weights.place += 0.10;
    if (hasPhone) weights.phone = 0.15;
  }

  // Adjust: if phone present, give it weight
  if (hasPhone && weights.phone === 0) {
    weights.phone = 0.05;
    weights.geo -= 0.05;
  }

  // Normalize to sum = 1.0
  const sum = weights.person + weights.place + weights.geo + weights.phone;
  Object.keys(weights).forEach(k => weights[k] = weights[k] / sum);

  return weights;
}

function assessNameRichness_(name) {
  if (!name) return 0;
  let score = 0;
  if (name.length >= 4) score += 0.4;
  if (name.length >= 8) score += 0.3;
  if (/[\u0E00-\u0E7F]/.test(name)) score += 0.2; // has Thai
  if (/[a-zA-Z]/.test(name)) score += 0.1; // has Latin
  return Math.min(score, 1);
}

function assessAddressRichness_(addr) {
  if (!addr) return 0;
  let score = 0;
  if (addr.length >= 20) score += 0.3;
  if (addr.length >= 50) score += 0.2;
  if (/\d{5}/.test(addr)) score += 0.2; // postcode
  if (/(กรุงเทพ|เชียงใหม่|ภูเก็ต|นนทบุรี)/.test(addr)) score += 0.15; // major province
  if (/(ถ\.|ซอย|หมู่)/.test(addr)) score += 0.15; // has street indicators
  return Math.min(score, 1);
}
```

#### 4.2.3 Integration

```javascript
// 10_MatchEngine.gs — matchCalcFullScore_
function matchCalcFullScore_(personScore, placeScore, geoScore, phoneScore, srcObj) {
  const weights = calculateDynamicWeights(srcObj);
  return (
    personScore * weights.person +
    placeScore * weights.place +
    geoScore * weights.geo +
    (phoneScore || 0) * weights.phone
  );
}
```

### 4.3 Feature 2.3: Geofencing Multi-Candidate Tie-breaker

#### 4.3.1 ปัญหา

เมื่อหลาย candidates มี score ใกล้กัน (±2 คะแนน) ปัจจุบันเลือก candidate แรก → อาจผิด

#### 4.3.2 Solution: History-based + Street Distance Tie-breaker

```javascript
/**
 * breakTieAmongCandidates — resolve tie ระหว่าง candidates ที่ score ใกล้กัน
 * @param {Array} candidates - sorted by score desc, top N
 * @param {Object} srcObj - source row
 * @return {Object} chosen candidate
 */
function breakTieAmongCandidates(candidates, srcObj) {
  if (candidates.length === 1) return candidates[0];

  // Filter to top candidates within ±2 score
  const topScore = candidates[0].score;
  const tied = candidates.filter(c => topScore - c.score <= 2);

  if (tied.length === 1) return tied[0];

  // Tie-breaker 1: Historical destination frequency (same driver)
  if (srcObj.driverName) {
    const driverHistory = getDriverHistory_(srcObj.driverName, srcObj.rawPersonName);
    if (driverHistory.length > 0) {
      // Prefer candidate that driver has visited before
      for (const c of tied) {
        if (driverHistory.some(h => h.destId === c.destId)) {
          c.score += 5; // bonus
          c.tiebreaker = 'driver_history';
        }
      }
    }
  }

  // Tie-breaker 2: Street distance (Google Maps API)
  if (tied[0].score === tied[1].score && srcObj.rawLat && srcObj.rawLng) {
    for (const c of tied) {
      if (c.resolvedLat && c.resolvedLng) {
        const streetDist = getStreetDistance_(
          srcObj.rawLat, srcObj.rawLng,
          c.resolvedLat, c.resolvedLng
        );
        if (streetDist !== null) {
          c.streetDistM = streetDist;
        }
      }
    }
    // Sort by street distance (if available)
    const withDist = tied.filter(c => c.streetDistM !== undefined);
    if (withDist.length === tied.length) {
      withDist.sort((a, b) => a.streetDistM - b.streetDistM);
      withDist[0].score += 3;
      withDist[0].tiebreaker = (withDist[0].tiebreaker || '') + '+street_dist';
    }
  }

  // Sort again and return top
  tied.sort((a, b) => b.score - a.score);
  return tied[0];
}

/**
 * getDriverHistory_ — ดึงประวัติ destination ที่คนขับเคยไป
 *   จาก FACT_DELIVERY ล่าสุด 90 วัน ที่ match_status = AUTO_MATCHED
 * @private
 */
function getDriverHistory_(driverName, personName) {
  // Query FACT_DELIVERY WHERE driver_name = ? AND person_id IN (
  //   SELECT person_id FROM M_PERSON WHERE canonical_name LIKE ?%
  // ) AND delivery_date >= DATE_SUB(NOW(), INTERVAL 90 DAY)
  // ORDER BY delivery_date DESC LIMIT 20
}

/**
 * getStreetDistance_ — Google Maps Distance Matrix API
 *   ⚠️ ใช้ cache เพราะ API quota จำกัด
 * @private
 */
function getStreetDistance_(lat1, lng1, lat2, lng2) {
  const cacheKey = `street_${lat1}_${lng1}_${lat2}_${lng2}`;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return Number(cached);

  // Call GOOGLEMAPS_DISTANCE custom function (15_GoogleMapsAPI.gs)
  const dist = GOOGLEMAPS_DISTANCE(`${lat1},${lng2}`, `${lat2},${lng2}`, 'driving');
  if (dist) {
    CacheService.getScriptCache().put(cacheKey, String(dist), 21600); // 6h TTL
  }
  return dist;
}
```

#### 4.3.3 Performance Consideration

- Street distance API call ใช้ cache (6h TTL) — ลด calls 90%
- Driver history query ใช้ RAM cache (per execution)
- จำกัด tie-breaker เฉพาะ top 3 candidates เท่านั้น

---

## 5. Phase 3: System Learning (PR #28)

### 5.1 Feature 3.1: Self-Healing Alias

#### 5.1.1 ปัญหา

เมื่อ Admin แก้ Q_REVIEW (CREATE_NEW, MERGE_TO_CANDIDATE, IGNORE) ระบบบันทึก decision แต่ไม่เรียนรู้ pattern → ครั้งต่อไปเจอชื่อเดียวกันก็ต้อง review ใหม่

#### 5.1.2 Solution: Auto-learn Alias จาก Q_REVIEW Decision

```javascript
/**
 * learnAliasFromReviewDecision — เรียนรู้ alias จากการ review
 *   เรียกหลัง applyReviewDecision เสร็จ
 * @param {string} reviewId
 * @param {string} decision - 'CREATE_NEW' | 'MERGE_TO_CANDIDATE' | 'IGNORE' | 'ESCALATE'
 * @param {Object} reviewData - row data from Q_REVIEW
 */
function learnAliasFromReviewDecision(reviewId, decision, reviewData) {
  if (decision === 'MERGE_TO_CANDIDATE') {
    // Admin ยืนยันว่า raw_name = candidate_name → create alias
    const candidatePersonId = extractFirstId_(reviewData.candidatePersonIds);
    if (candidatePersonId && reviewData.rawPersonName) {
      createVerifiedAlias_({
        entityType: 'PERSON',
        entityId: candidatePersonId,
        variantName: reviewData.rawPersonName,
        source: 'HUMAN_REVIEW',
        confidence: 100,
        verifiedBy: Session.getEffectiveUser().getEmail(),
        reviewId: reviewId
      });
    }
    // Same for place
    const candidatePlaceId = extractFirstId_(reviewData.candidatePlaceIds);
    if (candidatePlaceId && reviewData.rawPlaceName) {
      createVerifiedAlias_({
        entityType: 'PLACE',
        entityId: candidatePlaceId,
        variantName: reviewData.rawPlaceName,
        source: 'HUMAN_REVIEW',
        confidence: 100,
        verifiedBy: Session.getEffectiveUser().getEmail(),
        reviewId: reviewId
      });
    }
  }

  if (decision === 'CREATE_NEW') {
    // Admin ยืนยันว่าเป็น entity ใหม่ → alias จะถูกสร้างอัตโนมัติ
    // โดย autoEnrichAliasesFromFactBatch_ ในครั้งต่อไป
    // แค่ mark review ว่าเรียบรู้แล้ว
    logInfo('SystemLearning',
      `learnAliasFromReviewDecision: CREATE_NEW for reviewId=${reviewId} — alias will be auto-created by next batch`);
  }

  if (decision === 'IGNORE') {
    // Admin บอกว่าไม่ใช่ match → mark เป็น negative sample
    // ป้องกัน autoEnrich สร้าง alias ผิด
    markAsNegativeSample_(reviewData);
  }
}

/**
 * createVerifiedAlias — สร้าง alias ใน M_ALIAS พร้อม verified_by_human flag
 *   ใช้ source = 'HUMAN_REVIEW' แทน 'FACT_DELIVERY' เพื่อให้ตรวจสอบได้
 *   confidence = 100 (สูงสุด เพราะผ่านการยืนยันโดยคน)
 */
function createVerifiedAlias_(aliasData) {
  // Insert into M_ALIAS
  // source = 'HUMAN_REVIEW'
  // confidence = 100
  // active_flag = TRUE
  // Trigger invalidateAliasCache_ to refresh
}

/**
 * markAsNegativeSample_ — mark review ว่าเป็น negative sample
 *   เก็บใน SYS_NEGATIVE_SAMPLES sheet เพื่อไม่ให้ autoEnrich สร้าง alias ผิด
 */
function markAsNegativeSample_(reviewData) {
  // Insert into SYS_NEGATIVE_SAMPLES (new sheet)
  // Fields: sample_id, raw_person_name, raw_place_name, candidate_person_id, candidate_place_id, marked_at, marked_by
}
```

#### 5.1.3 Schema Changes

```javascript
// 02_Schema.gs — M_ALIAS เพิ่ม field
'M_ALIAS': [
  // ... existing 8 columns ...
  'verified_by',       // [8] user email ที่ verify (null ถ้า source = FACT_DELIVERY)
  'review_id',         // [9] FK to Q_REVIEW (null ถ้าไม่ได้มาจาก review)
  'verified_at',       // [10] timestamp ที่ verify
],
```

```javascript
// Sheet ใหม่: SYS_NEGATIVE_SAMPLES
'SYS_NEGATIVE_SAMPLES': [
  'sample_id',
  'raw_person_name',
  'raw_place_name',
  'candidate_person_id',
  'candidate_place_id',
  'reason',         // 'WRONG_MATCH' | 'DIFFERENT_PERSON' | 'DATA_QUALITY'
  'marked_by',
  'marked_at',
],
```

#### 5.1.4 Integration

```javascript
// 12_ReviewService.gs — applyReviewDecision
function applyReviewDecision(reviewId, decision, note) {
  // ... existing logic ...

  // [V6.0] เรียนรู้ alias หลัง decision
  try {
    const reviewData = getReviewById_(reviewId);
    if (typeof learnAliasFromReviewDecision === 'function') {
      learnAliasFromReviewDecision(reviewId, decision, reviewData);
    }
  } catch (e) {
    logError('ReviewService', 'learnAliasFromReviewDecision failed: ' + e.message, e);
    // ไม่ block main flow
  }
}
```

#### 5.1.5 Metrics

| Metric | Target |
|--------|--------|
| Aliases created from human review (per week) | ≥10 |
| Repeat review rate (same raw_name reviewed twice) | ≤5% |
| Verified alias match rate (alias.source = HUMAN_REVIEW → match next time) | ≥95% |

---

## 6. Phase 4: WebApp & Dashboard (PR #29)

### 6.1 Feature 4.1: Interactive Map Analytics

#### 6.1.1 Stack

- **Leaflet.js 1.9.4** (CDN with SRI)
- **leaflet.heat 0.2.0** (heatmap plugin)
- **Leaflet.markercluster 1.5.3** (cluster markers)
- Tiles: OpenStreetMap (free, no API key)

#### 6.1.2 New View: MapAnalytics.html

```javascript
// Server-side: 22_WebApp.gs
function getMapAnalyticsData(dateRange, filterStatus) {
  // Query FACT_DELIVERY with resolved_lat, resolved_lng
  // Return: [{ lat, lng, count, match_status, person_id, dest_id }, ...]
  // Limit: 5000 points (for performance)
}

// Frontend: views/MapAnalytics.html
const MapAnalyticsView = {
  render: function(data, container) {
    // Initialize Leaflet map centered on Thailand
    const map = L.map(container).setView([13.7563, 100.5018], 6);

    // Add OSM tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map);

    // Heatmap layer
    const heatPoints = data.map(d => [d.lat, d.lng, d.count]);
    L.heatLayer(heatPoints, {
      radius: 25,
      blur: 15,
      maxZoom: 17,
      gradient: { 0.2: 'blue', 0.4: 'lime', 0.6: 'orange', 0.8: 'red' }
    }).addTo(map);

    // Cluster markers (clickable)
    const markers = L.markerClusterGroup();
    data.forEach(d => {
      const marker = L.marker([d.lat, d.lng]);
      marker.bindPopup(`
        <strong>${d.count} deliveries</strong><br>
        Status: ${d.match_status}<br>
        <a href="#">View details</a>
      `);
      markers.addLayer(marker);
    });
    map.addLayer(markers);
  }
};
```

#### 6.1.3 Filters

- Date range (7d / 30d / 90d / custom)
- Match status (ALL / AUTO_MATCHED / CREATED / REVIEW)
- Province filter (dropdown from M_PLACE)

### 6.2 Feature 4.2: Real-time Matching Monitor

#### 6.2.1 Architecture

```
[MatchEngine running] → [writes progress to PropertiesService]
                                     ↓
[WebApp LiveFeed view] ← [polls every 3s via google.script.run]
                                     ↓
[UI updates: progress bar, current row, recent matches/errors]
```

#### 6.2.2 Server-side Functions

```javascript
// 22_WebApp.gs
function getMatchEngineLiveStatus() {
  const props = PropertiesService.getScriptProperties();
  return {
    isRunning: props.getProperty('MATCH_ENGINE_RUNNING') === 'true',
    currentRow: Number(props.getProperty('MATCH_ENGINE_CURRENT_ROW') || 0),
    totalRows: Number(props.getProperty('MATCH_ENGINE_TOTAL_ROWS') || 0),
    startedAt: props.getProperty('MATCH_ENGINE_STARTED_AT'),
    lastMatchAt: props.getProperty('MATCH_ENGINE_LAST_MATCH'),
    recentMatches: JSON.parse(props.getProperty('MATCH_ENGINE_RECENT') || '[]'),
    errorCount: Number(props.getProperty('MATCH_ENGINE_ERRORS') || 0),
    eta: calculateEta_(/* ... */)
  };
}

// 10_MatchEngine.gs — เพิ่ม progress tracking
function processOneRow(srcObj) {
  // ... existing logic ...

  // [V6.0] Update progress (every 10 rows to avoid quota)
  if (currentRowIndex % 10 === 0) {
    updateMatchEngineProgress_(currentRowIndex, totalRows, recentMatch);
  }
}
```

#### 6.2.3 Frontend View

```javascript
// views/LiveFeed.html
const LiveFeedView = {
  pollInterval: null,

  render: function(data, container) {
    container.innerHTML = `
      <div class="live-feed">
        <h2>Match Engine Live Monitor</h2>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${data.percent}%"></div>
          <span>${data.currentRow} / ${data.totalRows}</span>
        </div>
        <div class="stats">
          <div>⏱️ Started: ${data.startedAt}</div>
          <div>✅ Matched: ${data.matchedCount}</div>
          <div>❌ Errors: ${data.errorCount}</div>
          <div>⏳ ETA: ${data.eta}</div>
        </div>
        <div class="recent-matches">
          <h3>Recent Matches (live)</h3>
          <table id="recentTable">...</table>
        </div>
      </div>
    `;

    // Start polling
    this.startPolling();
  },

  startPolling: function() {
    this.pollInterval = setInterval(async () => {
      const status = await api.getMatchEngineLiveStatus();
      this.updateUI(status);
    }, 3000); // 3s
  }
};
```

#### 6.2.4 Quota Considerations

- Polling 3s × 60s/min × 5min = 100 calls per viewing session
- GAS quota: 90,000 UrlFetch/day → no issue (this uses google.script.run, not UrlFetch)
- PropertiesService write quota: 500 writes/hour → update every 10 rows = OK for 5000 rows/hour

---

## 7. Phase 5: Pipeline Management (PR #30)

### 7.1 Feature 5.1: Email Alert

#### 7.1.1 Alert Scenarios

| Scenario | Trigger | Severity |
|----------|---------|----------|
| Pipeline paused due to errors | `state = PAUSED_ERRORS` | 🔴 HIGH |
| Circuit breaker tripped | `consecutiveErrors >= 3` | 🔴 HIGH |
| Q_REVIEW backlog exceeds threshold | `pending_count > 100` | 🟡 MEDIUM |
| Pipeline completed | `state = COMPLETED` | 🟢 INFO |
| Quota warning | `quota.runtimeMs > 60min` | 🟡 MEDIUM |
| Source sheet not loaded | `today's SCG data missing` | 🔴 HIGH |

#### 7.1.2 Implementation

```javascript
// 25_AlertService.gs (new file)
const ALERT_CONFIG = Object.freeze({
  RECIPIENTS_KEY: 'ALERT_RECIPIENTS',  // Script Property
  Q_REVIEW_THRESHOLD: 100,
  QUOTA_WARNING_MS: 60 * 60 * 1000, // 60 min
  COOLDOWN_MS: 30 * 60 * 1000,       // 30 min between same alert
});

/**
 * sendPipelineAlert — ส่ง email alert สำหรับ pipeline events
 * @param {string} alertType - 'PAUSED_ERRORS' | 'CIRCUIT_BREAKER' | etc.
 * @param {Object} context - additional data
 */
function sendPipelineAlert(alertType, context) {
  // Check cooldown (avoid spam)
  const cooldownKey = `ALERT_COOLDOWN_${alertType}`;
  const lastSent = PropertiesService.getScriptProperties().getProperty(cooldownKey);
  if (lastSent && Date.now() - Number(lastSent) < ALERT_CONFIG.COOLDOWN_MS) {
    return; // Skip — in cooldown
  }

  const recipients = PropertiesService.getScriptProperties()
    .getProperty(ALERT_CONFIG.RECIPIENTS_KEY);
  if (!recipients) {
    logWarn('AlertService', 'No recipients configured — skip alert');
    return;
  }

  const template = getAlertTemplate_(alertType, context);
  GmailApp.sendEmail(
    recipients,
    template.subject,
    template.body,
    {
      htmlBody: template.htmlBody,
      name: 'LMDS Alert Bot'
    }
  );

  // Update cooldown
  PropertiesService.getScriptProperties().setProperty(cooldownKey, String(Date.now()));

  logInfo('AlertService', `Alert sent: ${alertType} to ${recipients}`);
}
```

#### 7.1.3 OAuth Scope

เพิ่ม OAuth scope (revert จากการลด scope ใน V5.5.017):

```json
// appsscript.json — เพิ่ม
"https://www.googleapis.com/auth/gmail.send"
```

⚠️ **Trade-off:** จาก 6 scopes → 7 scopes (เพิ่ม 1) แต่ได้ alerting ที่จำเป็น

### 7.2 Feature 5.2: Dependency-aware Pipeline

#### 7.2.1 Pre-flight Checklist

```javascript
/**
 * runPipelinePreflight — ตรวจสอบความพร้อมก่อนรัน MatchEngine
 * @return {{ ready: boolean, issues: string[] }}
 */
function runPipelinePreflight() {
  const issues = [];

  // Check 1: SCG API data loaded today?
  const today = new Date().toISOString().split('T')[0];
  const dailyJobSheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SHEET.DAILY_JOB);
  if (dailyJobSheet && dailyJobSheet.getLastRow() > 1) {
    const lastDeliveryDate = dailyJobSheet.getRange(2, DATA_IDX.PLAN_DELIVERY + 1, 1, 1)
      .getValue();
    if (lastDeliveryDate && lastDeliveryDate.toISOString().split('T')[0] !== today) {
      issues.push('DAILY_JOB sheet ยังไม่มีข้อมูลของวันนี้ — กรุณารัน "ดึงข้อมูล SCG API" ก่อน');
    }
  } else {
    issues.push('DAILY_JOB sheet ว่าง — กรุณารัน "ดึงข้อมูล SCG API" ก่อน');
  }

  // Check 2: SYS_TH_GEO dictionary exists?
  const geoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.SYS_TH_GEO);
  if (!geoSheet || geoSheet.getLastRow() < 100) {
    issues.push('SYS_TH_GEO dictionary ไม่ครบ — กรุณารัน "buildGeoDictionary" ก่อน');
  }

  // Check 3: GEMINI_API_KEY set? (only if USE_AI_REASONING = true)
  if (AI_CONFIG.USE_AI_REASONING) {
    try {
      getGeminiApiKey(); // throws if not set
    } catch (e) {
      issues.push('GEMINI_API_KEY ยังไม่ได้ตั้งค่า — กรุณารัน "ตั้งค่า API Key"');
    }
  }

  // Check 4: Source sheet has unprocessed rows?
  const sourceSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.SOURCE);
  if (sourceSheet) {
    const syncCol = SRC_IDX.SYNC_STATUS + 1;
    const data = sourceSheet.getRange(2, syncCol, sourceSheet.getLastRow() - 1, 1).getValues();
    const pending = data.filter(r => r[0] !== 'SUCCESS' && r[0] !== 'REVIEW').length;
    if (pending === 0) {
      issues.push('SOURCE sheet ไม่มีแถวที่ต้องประมวลผล (SYNC_STATUS ทั้งหมด = SUCCESS/REVIEW)');
    }
  }

  return {
    ready: issues.length === 0,
    issues: issues
  };
}

// Integration: 10_MatchEngine.gs
function runMatchEngine() {
  // [V6.0] Pre-flight check
  const preflight = runPipelinePreflight();
  if (!preflight.ready) {
    const message = 'Pipeline preflight failed:\n' + preflight.issues.join('\n');
    safeUiAlert_('⚠️ Pipeline ไม่พร้อมรัน', message);
    sendPipelineAlert('PREFLIGHT_FAILED', { issues: preflight.issues });
    return;
  }

  // ... existing MatchEngine logic ...
}
```

---

## 8. Phase 6: Architecture & Data (PR #31)

### 8.1 Feature 6.1: Master Data Health Check (Dedup Audit)

#### 8.1.1 Dedup Algorithm

```javascript
/**
 * runDedupAudit — สแกนหา potential duplicates ใน M_PERSON / M_PLACE
 *   ใช้ Levenshtein distance + phonetic match
 * @param {string} entityType - 'PERSON' | 'PLACE'
 * @return {{ duplicates: Array, scannedCount: number, duration: number }}
 */
function runDedupAudit(entityType) {
  const startTime = Date.now();
  const all = entityType === 'PERSON' ? loadAllPersons_() : loadAllPlaces_();

  const duplicates = [];
  // O(n²) — but with phonetic pre-filter to reduce comparisons
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];

      // Skip if same master_uuid (already merged)
      if (a.masterUuid === b.masterUuid) continue;

      // Quick filter: phonetic match
      const phMatch = phoneticMatch(a.canonicalName, b.canonicalName);
      if (!phMatch.match && phMatch.score < 80) continue;

      // Detailed: Levenshtein distance
      const levDist = levenshteinDistance(a.canonicalName, b.canonicalName);
      const similarity = 1 - (levDist / Math.max(a.canonicalName.length, b.canonicalName.length));

      if (similarity >= 0.85 || (phMatch.score >= 90 && similarity >= 0.7)) {
        duplicates.push({
          entityA: { id: a.personId, name: a.canonicalName, uuid: a.masterUuid },
          entityB: { id: b.personId, name: b.canonicalName, uuid: b.masterUuid },
          similarity: similarity,
          phoneticScore: phMatch.score,
          reason: similarity >= 0.85 ? 'HIGH_LEVENSHTEIN' : 'PHONETIC_MATCH',
          suggestion: 'MERGE'
        });
      }
    }
  }

  return {
    duplicates: duplicates,
    scannedCount: all.length,
    duration: Date.now() - startTime
  };
}
```

#### 8.1.2 New Menu Entry

```javascript
// 00_App.gs
.addItem('🔍 [V6] Dedup Audit (Person)', 'runDedupAuditPerson_UI')
.addItem('🔍 [V6] Dedup Audit (Place)', 'runDedupAuditPlace_UI')
```

### 8.2 Feature 6.2: Audit Trail (SYS_AUDIT_TRAIL)

#### 8.2.1 Schema

```javascript
// 02_Schema.gs
'SYS_AUDIT_TRAIL': [
  'audit_id',          // [0] A+12 hex
  'entity_type',       // [1] 'PERSON' | 'PLACE' | 'GEO' | 'DESTINATION' | 'ALIAS' | 'FACT'
  'entity_id',         // [2] FK
  'action',            // [3] 'CREATE' | 'UPDATE' | 'DELETE' | 'MERGE'
  'field_changed',     // [4] column name that changed
  'old_value',         // [5] previous value (JSON or string)
  'new_value',         // [6] new value (JSON or string)
  'changed_by',        // [7] user email
  'changed_at',        // [8] timestamp
  'change_reason',     // [9] optional note (e.g., "Q_REVIEW merge")
  'ip_address',        // [10] (best effort — may be empty in GAS)
],
```

#### 8.2.2 Implementation

```javascript
// 26_AuditTrailService.gs (new file)
function logAuditTrail(entityType, entityId, action, fieldChanged, oldValue, newValue, reason) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SYS_AUDIT_TRAIL');
  if (!sheet) {
    logWarn('AuditTrail', 'SYS_AUDIT_TRAIL sheet not found — skip logging');
    return;
  }

  const row = [
    generateShortId('A'),
    entityType,
    entityId,
    action,
    fieldChanged,
    String(oldValue || '').substring(0, 500),  // truncate to prevent row overflow
    String(newValue || '').substring(0, 500),
    Session.getEffectiveUser().getEmail(),
    new Date(),
    reason || '',
    ''  // ip_address (not available in GAS)
  ];

  sheet.appendRow(row);  // ⚠️ Use batch write if high volume
}

// Wrap createPerson, updatePerson, etc.
function createPerson(normResult) {
  // ... existing logic ...
  const newId = generateShortId('P');
  // ... insert ...

  // [V6.0] Audit trail
  logAuditTrail('PERSON', newId, 'CREATE', 'all', null, JSON.stringify(normResult), 'system');
  return newId;
}

function updatePersonStats(personId, ...) {
  // ... existing logic ...

  // [V6.0] Audit trail
  logAuditTrail('PERSON', personId, 'UPDATE', 'usage_count,last_seen', oldValues, newValues, 'match_usage');
}
```

#### 8.2.3 Retention Policy

- Keep last 90 days in SYS_AUDIT_TRAIL
- After 90 days → archive to SYS_AUDIT_ARCHIVE sheet (or export to PDF)
- Run cleanup weekly via trigger

---

## 9. Phase 7: Security RBAC (PR #32)

### 9.1 Feature 7.1: Role-Based Access Control

#### 9.1.1 Role Definitions

| Role | Description | Permissions |
|------|-------------|-------------|
| **Viewer** | ดูข้อมูลได้อย่างเดียว | Dashboard, FACT_DELIVERY (read), Q_REVIEW (read), Map Analytics |
| **Reviewer** | + อนุมัติ Q_REVIEW | All Viewer + Q_REVIEW approve/reject, Search |
| **Admin** | + จัดการระบบ | All Reviewer + Pipeline control, Master Data edits, Config, Audit Trail |

#### 9.1.2 Permission Matrix

```javascript
// 01_Config.gs — RBAC_CONFIG
const RBAC_CONFIG = Object.freeze({
  ROLES: {
    VIEWER: 'viewer',
    REVIEWER: 'reviewer',
    ADMIN: 'admin'
  },

  PERMISSIONS: {
    // WebApp views
    'view:dashboard': [RBAC_CONFIG.ROLES.VIEWER, RBAC_CONFIG.ROLES.REVIEWER, RBAC_CONFIG.ROLES.ADMIN],
    'view:fact_delivery': [RBAC_CONFIG.ROLES.VIEWER, RBAC_CONFIG.ROLES.REVIEWER, RBAC_CONFIG.ROLES.ADMIN],
    'view:qreview': [RBAC_CONFIG.ROLES.VIEWER, RBAC_CONFIG.ROLES.REVIEWER, RBAC_CONFIG.ROLES.ADMIN],
    'view:map_analytics': [RBAC_CONFIG.ROLES.VIEWER, RBAC_CONFIG.ROLES.REVIEWER, RBAC_CONFIG.ROLES.ADMIN],
    'view:source_sheet': [RBAC_CONFIG.ROLES.REVIEWER, RBAC_CONFIG.ROLES.ADMIN],
    'view:audit_trail': [RBAC_CONFIG.ROLES.ADMIN],

    // Actions
    'action:approve_review': [RBAC_CONFIG.ROLES.REVIEWER, RBAC_CONFIG.ROLES.ADMIN],
    'action:run_pipeline': [RBAC_CONFIG.ROLES.ADMIN],
    'action:edit_master': [RBAC_CONFIG.ROLES.ADMIN],
    'action:config': [RBAC_CONFIG.ROLES.ADMIN],
    'action:clear_cache': [RBAC_CONFIG.ROLES.ADMIN],
  },

  // Script Property: ROLE_ASSIGNMENTS = "email1:role,email2:role,..."
  ROLE_ASSIGNMENTS_KEY: 'ROLE_ASSIGNMENTS'
});
```

#### 9.1.3 Implementation

```javascript
// 27_RbacService.gs (new file)
/**
 * getCurrentUserRole — ดึง role ของ user ปัจจุบัน
 * @return {string} 'viewer' | 'reviewer' | 'admin' | null (if not assigned)
 */
function getCurrentUserRole_() {
  const email = Session.getEffectiveUser().getEmail().toLowerCase();
  if (!email) return null;

  // Script Owner = admin always
  const ownerEmail = ScriptApp.getScriptId().getOwnerEmail?.() || '';
  if (email === ownerEmail.toLowerCase()) return RBAC_CONFIG.ROLES.ADMIN;

  // Check ROLE_ASSIGNMENTS
  const assignments = PropertiesService.getScriptProperties()
    .getProperty(RBAC_CONFIG.ROLE_ASSIGNMENTS_KEY) || '';

  const map = {};
  assignments.split(',').forEach(pair => {
    const [e, r] = pair.split(':');
    if (e && r) map[e.trim().toLowerCase()] = r.trim().toLowerCase();
  });

  return map[email] || null;
}

/**
 * hasPermission — check ว่า user มี permission หรือไม่
 * @param {string} permission - e.g., 'action:approve_review'
 * @return {boolean}
 */
function hasPermission_(permission) {
  const role = getCurrentUserRole_();
  if (!role) return false;

  const allowedRoles = RBAC_CONFIG.PERMISSIONS[permission];
  if (!allowedRoles) {
    logWarn('Rbac', `Unknown permission: ${permission}`);
    return false;
  }

  return allowedRoles.includes(role);
}

/**
 * requirePermission — throw ถ้าไม่มี permission
 * @param {string} permission
 * @throws {Error} if no permission
 */
function requirePermission_(permission) {
  if (!hasPermission_(permission)) {
    const role = getCurrentUserRole_() || 'none';
    throw new Error(`Access denied: requires "${permission}" (your role: ${role})`);
  }
}

// Integration: 22_WebApp.gs
function submitReviewDecision(reviewId, decision, note) {
  requirePermission_('action:approve_review');
  // ... existing logic ...
}

function startPipeline() {
  requirePermission_('action:run_pipeline');
  // ... existing logic ...
}
```

#### 9.1.4 Frontend Adaptation

```javascript
// 22_WebApp.gs — doGet
function doGet(e) {
  const user = getCurrentDashboardUser_();
  if (!user.authorized) {
    return HtmlService.createHtmlOutputFromFile('Unauthorized');
  }

  const role = getCurrentUserRole_();
  const template = HtmlService.createTemplateFromFile('Index');
  template.currentUser = user;
  template.userRole = role;
  template.permissions = getPermissionsForRole_(role); // { canApproveReview: true, ... }
  // ... rest
}

// Index.html — show/hide nav based on permissions
<? if (permissions.canViewSourceSheet) { ?>
  <button onclick="navigateTo('source')">Source Sheet</button>
<? } ?>
```

#### 9.1.5 Migration

```javascript
/**
 * MIGRATION_V6_RBAC — one-time migration
 *   1. อ่าน LMDS_ADMINS (existing) → assign all to 'admin' role
 *   2. อ่าน DASHBOARD_USERS (existing) → assign all to 'viewer' role (default)
 *   3. Admin ต้อง manually promote บางคนเป็น 'reviewer' ผ่าน menu
 */
function MIGRATION_V6_RBAC() { ... }
```

---

## 10. Migration & Deployment Plan

### 10.1 Schema Migration Summary

| Phase | New Sheets | New Columns | New Script Properties | OAuth Scopes |
|-------|-----------|-------------|----------------------|--------------|
| **1** | SYS_NOTES | M_PERSON.phonetic_primary/secondary, M_PLACE.phonetic_primary/secondary | - | - |
| **2** | - | - | - | - |
| **3** | SYS_NEGATIVE_SAMPLES | M_ALIAS.verified_by, M_ALIAS.review_id, M_ALIAS.verified_at | - | - |
| **4** | - | - | MATCH_ENGINE_RUNNING, MATCH_ENGINE_CURRENT_ROW, etc. | - |
| **5** | - | - | ALERT_RECIPIENTS, ALERT_COOLDOWN_* | `gmail.send` ⚠️ |
| **6** | SYS_AUDIT_TRAIL, SYS_AUDIT_ARCHIVE | - | - | - |
| **7** | - | - | ROLE_ASSIGNMENTS | - |

### 10.2 Backward Compatibility Strategy

| Change Type | Strategy |
|-------------|----------|
| New sheet | `setupAllSheets()` auto-create — no migration needed |
| New column | `validateSheetHeaders()` auto-add missing columns (existing behavior) |
| New IDX | Add to `*_IDX` constants — old code unaffected (just won't use new fields) |
| New function | Additive — old code doesn't break |
| New Script Property | Lazy init on first use |
| OAuth scope change | User must re-authorize (one-time prompt) |

### 10.3 Deployment Checklist (per phase)

```markdown
- [ ] Code merged to main
- [ ] clasp push to Apps Script project
- [ ] Re-authorize OAuth (if scope changed)
- [ ] Run setupAllSheets() to create new sheets
- [ ] Run migration script (if any)
- [ ] Verify with smoke test (1-2 rows)
- [ ] Run full pipeline test
- [ ] Check SYS_LOG for errors
- [ ] Update documentation (BLUEPRINT.md, README.md)
- [ ] Tag release: V6.0.0XX
```

### 10.4 Phase Dependencies

```
Phase 1 (Cleansing) ──┐
                      ├──► Phase 2 (Matching) ──┐
                      │                          │
                      ├──► Phase 3 (Learning) ◄──┘
                      │
Phase 4 (WebApp) ─────┼────► Phase 5 (Pipeline)
                      │
Phase 6 (Arch) ───────┼────► Phase 7 (Security)
                      │
                      ▼
              Phase 7 (RBAC) — last (depends on all features being in place to assign permissions)
```

**Recommended order:** 1 → 2 → 3 → 6 → 5 → 4 → 7

---

## 11. Effort Estimates & Timeline

### 11.1 T-shirt Sizing per Feature

| Phase | Feature | Size | Effort (person-days) | Notes |
|-------|---------|------|---------------------|-------|
| **1** | 1.1 Semantic Note Parser | L | 3-4 | New sheet + migration + parser logic |
| **1** | 1.2 Double Metaphone Thai | M | 2 | Algorithm + schema + tests |
| **2** | 2.1 Contextual Disambiguation | M | 2-3 | New rule + SoldToName lookup |
| **2** | 2.2 Dynamic Weighting | M | 2 | Weight calculation + integration |
| **2** | 2.3 Geofencing Tie-breaker | L | 3 | Google Maps API + history query |
| **3** | 3.1 Self-Healing Alias | M | 2-3 | Trigger + alias creation + schema |
| **4** | 4.1 Map Analytics | L | 3-4 | Leaflet + heatmap + server data |
| **4** | 4.2 Live Feed Monitor | M | 2 | Polling + UI + progress tracking |
| **5** | 5.1 Email Alert | S | 1-2 | GmailApp + templates |
| **5** | 5.2 Dependency-aware Pipeline | S | 1 | Pre-flight check |
| **6** | 6.1 Dedup Audit | M | 2 | Algorithm + UI |
| **6** | 6.2 Audit Trail | L | 3-4 | Schema + wrap all CRUD + retention |
| **7** | 7.1 RBAC | L | 3-4 | Permission matrix + UI adaptation |

**Total: ~30-37 person-days** (~6-8 weeks at 1 person, 3-4 weeks at 2 people)

### 11.2 Suggested Sprint Cadence

| Sprint | Duration | Phases | Deliverable |
|--------|----------|--------|-------------|
| Sprint 1 | 2 weeks | Phase 1 | V6.0.001 — Cleansing improvements |
| Sprint 2 | 2 weeks | Phase 2 | V6.0.002 — Matching improvements |
| Sprint 3 | 2 weeks | Phase 3 + 6 | V6.0.003 — Learning + Audit |
| Sprint 4 | 2 weeks | Phase 5 + 4 | V6.0.004 — Pipeline + WebApp |
| Sprint 5 | 2 weeks | Phase 7 | V6.0.005 — RBAC |
| Sprint 6 | 1 week | Polish + bug fixes | V6.0.000 — Release |

**Total: 11 weeks (~2.5 months)**

---

## 12. Risk Assessment & Mitigation

### 12.1 Phase 1 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration ช้า (large M_PERSON) | Medium | Medium | Batch process + checkpoint |
| Note parser regex ผิด → false positive | Medium | Low | Test cases + manual review sample |
| Phonetic key collision | Low | Medium | Track false positive rate |

### 12.2 Phase 2 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SoldToName lookup ช้า | Medium | Medium | Cache + limit query to 30 days |
| Dynamic weights ทำให้ match rate ตก | Medium | High | A/B test with old weights |
| Google Maps API quota | High | Medium | Cache 6h + fallback to Haversine |

### 12.3 Phase 5 Risks (OAuth scope)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| User ไม่ยอม re-authorize | High | High | Show clear message + fallback to in-app alert |
| GmailApp quota | Low | Low | Throttle + cooldown |
| Alert spam | Medium | Low | Cooldown 30 min per alert type |

### 12.4 Phase 6 Risks (Audit Trail performance)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SYS_AUDIT_TRAIL sheet ใหญ่เกินไป | High | Medium | Retention 90 days + weekly cleanup |
| appendRow ช้า (high volume) | Medium | Medium | Batch write + buffer |
| Wrap every CRUD ลืมบางจุด | High | Low | grep audit + code review checklist |

### 12.5 Phase 7 Risks (RBAC)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Lockout — admin ลืว assign role ตัวเอง | Medium | High | Script Owner = admin always |
| Migration จาก LMDS_ADMINS ไม่ครบ | Low | Medium | Migration script + verify count |
| Permission check ลืมบาง endpoint | High | High | Audit all google.script.run + code review |

---

## 13. Acceptance Criteria per Phase

### Phase 1: Data Cleansing

- [ ] `parseAndStoreSemanticNotes` รับ input 100 test cases และ extract notes ถูกต้อง ≥90%
- [ ] `buildThaiDoubleMetaphone` รับ 50 test pairs และ match ถูกต้อง ≥85%
- [ ] SYS_NOTES sheet สร้างแล้ว + มีข้อมูลจาก migration
- [ ] M_PERSON.phonetic_primary มีค่าทุก row (หลัง migration)
- [ ] Match rate เพิ่มขึ้น ≥3% จาก baseline (เนื่องจาก phonetic match ดีขึ้น)

### Phase 2: Matching Engine

- [ ] Rule 4.5 ทำงาน — เมื่อ SoldToName ต่างกัน → Q_REVIEW (ไม่ auto-match ผิด)
- [ ] Dynamic weights ปรับได้ถูกต้องตาม data richness
- [ ] Tie-breaker เลือก candidate ที่ driver เคยไป → ลด false match
- [ ] Match rate เพิ่มขึ้น ≥5% จาก Phase 1
- [ ] False positive rate ลดลง ≥2%

### Phase 3: System Learning

- [ ] Admin review → alias ถูกสร้างใน M_ALIAS ทันที (source = HUMAN_REVIEW)
- [ ] ครั้งต่อไปที่เจอชื่อเดียวกัน → auto-match (ไม่ต้อง review ซ้ำ)
- [ ] Repeat review rate ลดลง ≥30%

### Phase 4: WebApp & Dashboard

- [ ] Map view แสดง heatmap ได้ภายใน 5 วินาที (5000 points)
- [ ] Live Feed อัปเดตทุก 3 วินาที ไม่ lag
- [ ] ไม่มี console errors ใน browser

### Phase 5: Pipeline Management

- [ ] Email alert ส่งถึง recipients ภายใน 1 นาทีหลัง event
- [ ] Cooldown 30 นาทีทำงาน — ไม่ spam
- [ ] Pre-flight check บล็อก MatchEngine ถ้าข้อมูลไม่พร้อม

### Phase 6: Architecture & Data

- [ ] Dedup Audit สแกน 10,000 rows ได้ภายใน 5 นาที
- [ ] Audit Trail บันทึกทุก CRUD บน M_PERSON/M_PLACE/M_ALIAS
- [ ] SYS_AUDIT_TRAIL ไม่เกิน 50,000 rows (auto-cleanup)

### Phase 7: Security RBAC

- [ ] Viewer ไม่สามารถ approve Q_REVIEW ได้
- [ ] Reviewer ไม่สามารถ run pipeline ได้
- [ ] Admin ทำได้ทุกอย่าง
- [ ] Migration จาก LMDS_ADMINS → ROLE_ASSIGNMENTS ครบ 100%

---

## 14. Appendix: Technical Specifications

### 14.1 New File Structure (after all phases)

```
src/
├── O_core_system/
│   ├── 00_App.gs                    (existing — add menu items)
│   ├── 01_Config.gs                 (existing — add RBAC_CONFIG, ALERT_CONFIG)
│   ├── 02_Schema.gs                 (existing — add SYS_NOTES, SYS_AUDIT_TRAIL, SYS_NEGATIVE_SAMPLES)
│   ├── 03_SetupSheets.gs            (existing — create new sheets)
│   ├── 14_Utils.gs                  (existing — add phonetic helpers)
│   ├── 19_Hardening.gs              (existing — add dedup audit)
│   ├── 22_WebApp.gs                 (existing — add MapAnalytics, LiveFeed endpoints)
│   └── 99_Legacy.gs                 (existing)
├── 1_group1_master_db/
│   ├── 05_NormalizeService.gs       (existing — add Semantic Note Parser)
│   ├── 06_PersonService.gs          (existing — wrap CRUD with audit trail)
│   ├── 07_PlaceService.gs           (existing — wrap CRUD with audit trail)
│   ├── 08_GeoService.gs             (existing — wrap CRUD with audit trail)
│   ├── 09_DestinationService.gs     (existing — wrap CRUD with audit trail)
│   ├── 10_MatchEngine.gs            (existing — add Rule 4.5, dynamic weights, tie-breaker)
│   ├── 16_GeoDictionaryBuilder.gs   (existing)
│   ├── 20_ThGeoService.gs           (existing)
│   └── 21_AliasService.gs           (existing — add createVerifiedAlias_)
├── 2_group2_daily_ops/
│   ├── 04_SourceRepository.gs       (existing)
│   ├── 11_TransactionService.gs     (existing — wrap with audit trail)
│   ├── 12_ReviewService.gs          (existing — add learnAliasFromReviewDecision)
│   ├── 13_ReportService.gs          (existing)
│   ├── 15_GoogleMapsAPI.gs          (existing — used by tie-breaker)
│   ├── 17_SearchService.gs          (existing)
│   ├── 18_ServiceSCG.gs             (existing)
│   ├── 25_AlertService.gs           (NEW — Phase 5)
│   ├── 26_AuditTrailService.gs      (NEW — Phase 6)
│   └── 27_RbacService.gs            (NEW — Phase 7)
├── 3_group3_webapp/
│   ├── Index.html                   (existing — add nav items)
│   ├── css/Styles.html              (existing)
│   ├── js/Auth.html                 (existing — add role check)
│   ├── js/Api.html                  (existing — add new endpoints)
│   ├── js/App.html                  (existing)
│   ├── js/components/               (existing)
│   ├── views/Dashboard.html         (existing)
│   ├── views/FactDelivery.html      (existing)
│   ├── views/QReview.html           (existing — hide approve button for non-Reviewer)
│   ├── views/SourceSheet.html       (existing — hide for non-Reviewer)
│   ├── views/MatchEngine.html       (existing)
│   ├── views/Search.html            (existing)
│   ├── views/Unauthorized.html      (existing)
│   ├── views/MapAnalytics.html      (NEW — Phase 4)
│   └── views/LiveFeed.html          (NEW — Phase 4)
└── 4_group4_pipeline_mgr/
    └── 24_PipelineManager.gs        (existing — add preflight, alert integration)
```

### 14.2 Configuration Constants Summary

```javascript
// 01_Config.gs additions

// V6.0 Phase 1
const SEMANTIC_NOTE_PATTERNS = Object.freeze({ /* ... */ });

// V6.0 Phase 2
const MATCH_WEIGHTS_DEFAULT = Object.freeze({ person: 0.3, place: 0.2, geo: 0.5, phone: 0 });

// V6.0 Phase 3
const SELF_HEALING_ALIAS_CONFIG = Object.freeze({
  CONFIDENCE_HUMAN_REVIEW: 100,
  SOURCE: 'HUMAN_REVIEW'
});

// V6.0 Phase 4
const LIVE_FEED_CONFIG = Object.freeze({
  POLL_INTERVAL_MS: 3000,
  PROGRESS_UPDATE_EVERY_N_ROWS: 10
});

// V6.0 Phase 5
const ALERT_CONFIG = Object.freeze({
  RECIPIENTS_KEY: 'ALERT_RECIPIENTS',
  Q_REVIEW_THRESHOLD: 100,
  COOLDOWN_MS: 30 * 60 * 1000
});

// V6.0 Phase 6
const AUDIT_TRAIL_CONFIG = Object.freeze({
  RETENTION_DAYS: 90,
  MAX_VALUE_LENGTH: 500,
  CLEANUP_TRIGGER_HOUR: 2 // 02:00 weekly
});

// V6.0 Phase 7
const RBAC_CONFIG = Object.freeze({
  ROLES: { VIEWER: 'viewer', REVIEWER: 'reviewer', ADMIN: 'admin' },
  PERMISSIONS: { /* ... see Phase 7 ... */ },
  ROLE_ASSIGNMENTS_KEY: 'ROLE_ASSIGNMENTS'
});
```

### 14.3 Test Strategy

#### Unit Tests

สร้างไฟล์ `tests/` ใหม่ (folder แยก ไม่ deploy ขึ้น Apps Script):

```
tests/
├── 01_SemanticNoteParser.test.gs
├── 02_ThaiDoubleMetaphone.test.gs
├── 03_ContextualDisambiguation.test.gs
├── 04_DynamicWeights.test.gs
├── 05_TieBreaker.test.gs
├── 06_SelfHealingAlias.test.gs
├── 07_AlertService.test.gs
├── 08_DedupAudit.test.gs
├── 09_AuditTrail.test.gs
└── 10_Rbac.test.gs
```

#### Integration Tests

```javascript
// tests/integration/V6_E2E.test.gs
function testE2E_Phase1to3() {
  // 1. Create source row with notes
  // 2. Run normalize — verify notes extracted
  // 3. Run match engine — verify phonetic match works
  // 4. Send to Q_REVIEW manually
  // 5. Admin approves with MERGE
  // 6. Verify alias created in M_ALIAS with source=HUMAN_REVIEW
  // 7. Re-process same source — verify auto-match (no Q_REVIEW)
}
```

### 14.4 Monitoring Metrics

| Metric | Source | Target | Alert Threshold |
|--------|--------|--------|-----------------|
| Match rate | FACT_DELIVERY | ≥90% | <80% |
| Q_REVIEW pending | Q_REVIEW | ≤10% | >25% |
| Audit trail coverage | SYS_AUDIT_TRAIL | ≥95% of CRUD ops | <80% |
| Alert delivery latency | GmailApp | ≤1 min | >5 min |
| Map load time | WebApp | ≤5s | >10s |
| RBAC denials (auth failures) | SYS_LOG | <5/day | >20/day |

---

## 15. Next Steps

หลังจาก review roadmap นี้แล้ว:

1. **Capture baseline metrics** — รัน SQL ใน Apps Script Editor และบันทึกใน `docs/V6.0_baseline_metrics.md`
2. **Commit roadmap นี้เข้า repo** — `docs/roadmap/LMDS_V6.0_Roadmap.md`
3. **เปิด GitHub Issues สำหรับแต่ละ phase** — 7 issues พร้อม label `v6.0`, `phase-N`
4. **เริ่ม Phase 1** — สร้าง branch `feature/v6.0-phase1-cleansing` และ implement
5. **Review & merge PR #26** — Phase 1 complete
6. **ทำซ้ำสำหรับ Phase 2-7**

---

## Changelog

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-07-05 | 6.0.0-draft | LMDS Bot | Initial roadmap creation |

---

**End of Roadmap Document**
