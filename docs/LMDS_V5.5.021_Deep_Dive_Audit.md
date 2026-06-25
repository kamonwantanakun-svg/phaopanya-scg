# 🔬 LMDS V5.5.021 — Deep Dive Audit Report (Security + Performance + Cache + Code Review)

> **เอกสารรวบรวมการ Audit เชิงลึก** ของระบบ LMDS V5.5.021
> รวม: V5.5.010 Cache Hotfix root causes + System-wide findings + Deep Dive 17_SearchService + 18_ServiceSCG
> Audit Date: 2026-06-23 | Scope: 22 `.gs` files, ~17,399 lines, 327 functions

---

## 📋 สารบัญ

1. [V5.5.010 — Cache Hotfix Root Causes (3 issues)](#1-v555010--cache-hotfix-root-causes-3-issues)
2. [System-wide Findings (C1-C5, H1-H5, M1-M5)](#2-system-wide-findings-c1-c5-h1-h5-m1-m5)
3. [Deep Dive: 17_SearchService.gs (C1-C3, H1-H2, M1-M2)](#3-deep-dive-17_searchservicegs)
4. [Deep Dive: 18_ServiceSCG.gs (C4-C7, H3-H6, M3-M6)](#4-deep-dive-18_servicescggs)
5. [Pre-flight Audit Summary (V5.5.021)](#5-pre-flight-audit-summary-v555021)
6. [Top 3 Quick Wins](#6-top-3-quick-wins-แก้ก่อนเลย)
7. [Audit Journey (V5.5.006 → V5.5.021)](#7-audit-journey-v555006--v555021)

---

## 1. V5.5.010 — Cache Hotfix Root Causes (3 issues)

> การแก้ปัญหา Cache จริงจาก log ที่ค้างจาก V5.5.007 ที่แก้ไม่ตก

| # | Log Message | ขนาด | Root Cause | วิธีแก้ (V5.5.010) |
|---|---|---|---|---|
| **#1** | `Cache chunk 0/48 write ล้มเหลว: อาร์กิวเมนต์มากเกินไป` | 48 chunks × 90KB = 4.3MB | GAS `putAll` มี limit total payload ~1MB → 4.3MB ล้มเหลว | แบ่ง `putAll` เป็น batch 5 chunks ต่อครั้ง (400KB/call) + ลด chunk size 90KB→80KB |
| **#2** | `M_PLACE Cache เต็ม — data size: 825,234 chars` | ~825 KB | `loadAllPlaces_()` ตกไป fallback ที่ใช้ `cache.put()` ตรง → 825KB > 100KB | ลบ fallback path — บังคับใช้ `saveChunkedCache_` |
| **#3** | `M_PLACE_ALIAS Cache write error: อาร์กิวเมนต์มากเกินไป — data size: 311,885 chars` | ~312 KB | เดียวกับ #2 — fallback ใช้ `cache.put` ตรง → 312KB > 100KB | ลบ fallback path — บังคับใช้ `saveChunkedCache_` |

### ไฟล์ที่แก้
- `14_Utils.gs` — `saveChunkedCache_()` แบ่ง `putAll` เป็น batch 5 chunks + ลด chunk size 90→80KB
- `07_PlaceService.gs` — `loadAllPlaces_()` + `loadAllPlaceAliases_()` ลบ fallback path ที่ใช้ `cache.put()` ตรง

### การตรวจสอบหลังแก้
- ✅ ไม่มี "M_PLACE Cache เต็ม" อีก
- ✅ ไม่มี "M_PLACE_ALIAS Cache write error" อีก
- ✅ ไม่มี "Cache chunk 0/48 write ล้มเหลว" อีก

### Q_REVIEW Post-Processor Integration (V5.5.010 พ่วม)
รวมฟังก์ชันที่มีประโยชน์จากไฟล์ `22_AccuracyPatch.gs` (V5.5.005b) เข้า `12_ReviewService.gs`:
- `extractFirstId_()` — ดึง ID แรกจาก JSON array
- `safeExtractArr_()` — ดึงค่าจาก array อย่างปลอดภัย
- `reprocessReviewQueue()` — auto-resolve Q_REVIEW 3 กลุ่ม (Group A/B/C)
- `analyzeReviewPatterns()` — วิเคราะห์ pattern ก่อนรัน reprocessReviewQueue

---

## 2. System-wide Findings (C1-C5, H1-H5, M1-M5)

### 🔴 Critical (ควรแก้ก่อน Production)

#### C1. `saveChunkedCache_` เป็น Silent Failure เงียบ — `14_Utils.gs:792-911`
ฟังก์ชัน 120 บรรทัด ผสม 3 หน้าที่ (write/read/orphan cleanup) ถ้า single put ล้มเหลว **แค่ logWarn แล้ว return** → caller ไม่รู้ว่า cache ว่าง → downstream จะทำงานผิดเพราะเชื่อ cache ที่ไม่มีจริง

```javascript
} catch (e) {
  logWarn('Utils', 'saveChunkedCache_ single put error: ' + e.message);
  return;  // ← caller ไม่ได้รับ error
}
```

**แนะนำ:** โยน error หรือคืน `{ok: false}` ให้ caller ตัดสินใจ

#### C2. Global mutable state 14 ตัวที่ระดับ module scope — เสี่ยง stale data ข้าม execution

```
01_Config.gs:71-73   _GLOBAL_GEO_DICT_CACHE / _GLOBAL_GEO_DICT_CACHE_PLACE / _GLOBAL_GEO_POINTS_CACHE
03_SetupSheets.gs:59 _LOG_BUFFER  (append ตลอด, flush ไม่ครบ = memory leak)
06_PersonService.gs  _PERSON_NOTE_INVERTED_INDEX / _PERSON_ALIAS_INVERTED_INDEX
07_PlaceService.gs   _PLACE_ALIAS_INVERTED_INDEX
10_MatchEngine.gs    _ALIAS_ENRICHMENT_CONTEXT / _SAME_DAY_DEST_CACHE
16_GeoDictionaryBuilder _GLOBAL_GEO_DICT_PROVINCE_INDEX
20_ThGeoService.gs   _GLOBAL_GEO_DICT_SEARCH_KEY_INDEX
04_SourceRepository  _SOURCE_ROWS_RAM_CACHE
11_TransactionService _FACT_INVOICE_RAM_CACHE / _GEO_LATLNG_RAM_CACHE
```

**ปัญหา:** ถ้ามี trigger รันพร้อมกัน (time-based trigger + onEdit) → state อาจปนกัน → stale alias / wrong match
**แนะนำ:** ห่อ memoization ใน IIFE หรือมี version key + invalidation hook

#### C3. `/input/.../{user-controlled}/` regex ใน NormalizeService — `05_NormalizeService.gs:442`
ตรวจ `escapeRegex_()` ใช้ก่อน `new RegExp()` ครบทุกที่ (✅ ดีมาก) แต่ **`escapeRegex_` ไม่ escape ตัว `-` ใน character class** → ถ้า input เป็น `[a-z` (input ผู้ใช้ผ่านเข้ามา) อาจ parse เป็น range ได้

#### C4. `catch (e) {}` ว่างเปล่า 9 จุด — Silent fail ใน security-critical code
ที่หนักสุดคือ `19_Hardening.gs:687-695` การลบ/เพิ่ม editor ของ sheet protection:

```javascript
try { protection.removeEditor(editor.getEmail()); } catch (e) {}
try { protection.addEditor(me); } catch (e) {}
try { protection.addEditor(email); } catch (e) {}
```

**ความเสี่ยง:** ถ้า `removeEditor` ล้มเหลว (เช่น editor เป็น Group) → sheet **ยังถูกแชร์กับ editor เก่า** → ขัดกับเป้าหมาย SEC-005
**แนะนำ:** เก็บ error ใน array แล้วแจ้ง admin ตอนท้าย

#### C5. Race condition: `getSCGCookie_` + auto-migration — `18_ServiceSCG.gs:277-310`
ถ้า trigger 2 ตัวยิงพร้อมกันช่วง migration:
1. A อ่านจากเซลล์ B1 → sanitize → setProperty → clearContent
2. B อ่านเซลล์ B1 → **ว่างแล้ว** → return `''` → API call fail

**แนะนำ:** ห่อด้วย `LockService` หรือทำ migration เป็น admin-trigger เดียว ไม่ใช่ lazy-load

### 🟠 High (ควรแก้ใน Phase 4-5 ต่อไป)

#### H1. ฟังก์ชัน SRP violator ที่ยังเหลืออยู่ 17 ตัว

| ไฟล์ | ฟังก์ชัน | บรรทัด | Unique calls | หน้าที่ปนกัน |
|------|---------|--------|-----|-----|
| `21_AliasService.gs` | `populateAliasFromFactDelivery_` | **127** | 35 | read + normalize + match + write + cache + report |
| `21_AliasService.gs` | `populateAliasFromSCGRawData_` | 115 | 40 | เหมือนกัน + SCG transform |
| `16_GeoDictionaryBuilder.gs` | `buildGeoDictionary` | 122 | 34 | schema + load + invert + province + cache |
| `12_ReviewService.gs` | `reprocProcessAllRows_` | 113 | 28 | orchestrator + 7 phases |
| `14_Utils.gs` | `saveChunkedCache_` | 120 | 25 | single + chunked + orphan cleanup + log |
| `20_ThGeoService.gs` | `populateGeoMetadata` | 91 | 31 | load + extract + invert + cache + write |
| `10_MatchEngine.gs` | `makeMatchDecision` | 97 | 28 | strategy selection + score + write |
| `12_ReviewService.gs` | `applyAllPendingDecisions` | 100 | 31 | read + apply + write + log + report |
| `12_ReviewService.gs` | `analyzeReviewPatterns` | 99 | 24 | scan + pattern + cluster + report |

#### H2. Nested loops ไม่มี time guard — เสี่ยง 6-min timeout
- `20_ThGeoService.gs:150` — nested depth 3 (loop ซ้อน loop ซ้อน loop) ไม่มี `hasTimePassed_`
- `21_AliasService.gs:319, 334` — `resolveMasterUuidViaGlobalAlias` nested depth 3-4 (มี maxIterations=500 บรรทัด 314 แต่ไม่มี time check)

มีแค่ 7 จุดทั้งโปรเจกต์ที่ใช้ `hasTimePassed_` — เทียบกับ 35 จุดที่เป็น for/while

#### H3. `console.log` หลงเหลือ 2 จุด — ขัด Rule 13 (centralized logging)

```
03_SetupSheets.gs:354   console.log(`[INFO][${module}] ${message}`);
03_SetupSheets.gs:374   console.log(`[DEBUG][${module}] ${message}`);
03_SetupSheets.gs:464   console.log(`[INFO][SetupSheets] clearOldLogs_: ...`);
```

หลงเหลือเพราะเขียนว่า "หลีกเลี่ยง recursion" แต่จริง ๆ คือ bypass audit trail — ตอน crash จะไม่มี log ใน SYS_LOG

#### H4. Magic numbers ทาง business ที่ยังไม่ centralize
- `08_GeoService.gs:92` → `lat ∈ [5.5, 20.5], lng ∈ [97.5, 105.7]` (ขอบเขตประเทศไทย hardcode)
- `14_Utils.gs:856` → `if (chunk.length > 95000)` (95KB safety margin hardcode)
- `19_Hardening.gs:443` → `24 * 60 * 60 * 1000` (checkpoint TTL = 24h magic)

#### H5. `isValidLatLng` ใช้แค่ใน `04_SourceRepository`
แต่ `buildSourceObj_` มี parse logic เองที่ `04_SourceRepository.gs:288-294` ใช้ `parseFloat` แล้ว check `isNaN` แต่ไม่ check range (-90/90, -180/180) → ผ่าน lat=200 ได้ ถ้า parse ได้

### 🟡 Medium / Low

| ID | ปัญหา | แนะนำ |
|----|-------|------|
| **M1** | `var` 455 จุด — V8 รองรับ `let/const` แล้ว | เปลี่ยนเป็น `const` by default |
| **M2** | `PropertiesService.getScriptProperties()` กระจาย 22 จุด — ไม่มี centralized helper | สร้าง `LMDS_PROPS.get('KEY')` |
| **M3** | Cookie plaintext ใน Script Properties — `SCG_COOKIE` | ใช้ Secret Service ใน GCP หรือ encrypt ด้วย KMS key |
| **M4** | Audit log ขาด `console.log` 2 จุด | ดู H3 |
| **M5** | `LockService.tryLock(3000-5000ms)` แต่หลาย batch flow ทำงาน > 30s | ระหว่างที่ user A ล็อก, user B รอ 3s แล้ว fail แต่จริง ๆ งาน A อาจใช้ 30s → user B ลองใหม่ทันที → ชนกัน |

### ✅ สิ่งที่ทำดีแล้ว (ไม่ต้องแก้)

1. **Domain Boundary** — Group 2 ไม่มีการเขียนลง `M_*` sheet โดยตรง ✅ (verified)
2. **Batch Write Pattern** — `setValue()` ในลูปเหลือแค่ setup-time เท่านั้น ✅
3. **API Key via Header** — Gemini ใช้ `x-goog-api-key` header ไม่ใช่ query ✅
4. **AuthZ Guard** — `SEC-002` ครอบทุก destructive op (API key set, bulk write M_ALIAS, etc.) ✅
5. **PII Masking** — `maskReviewerEmail_` ใช้ MD5 ✅
6. **Response Truncation** — `fetchWithRetry_` truncate body ที่ 200 chars ก่อน log (SEC-011) ✅
7. **Cookie Sanitization** — CRLF + charset + length check ✅
8. **Cookie migrate from cell → Properties** — auto-cleanup B1 ดี ✅
9. **`hasTimePassed_` centralized** — มี helper เดียว 7 จุดใช้
10. **`saveChunkedCache_` orphan cleanup** — ลบ chunk เก่าก่อนเขียนใหม่ ✅
11. **Checkpoint/Trigger pattern** — สำหรับ `HARDENING_ALIAS_CHECKPOINT_KEY` + auto-resume ✅
12. **Single Writer Pattern** — `M_ALIAS` เขียนได้แค่ `10_MatchEngine` + `21_AliasService` ✅

### 📊 Severity Summary

| ระดับ | จำนวน | ตัวอย่าง |
|-------|-------|---------|
| 🔴 Critical | 5 | Silent fail in cache, hard protection edge case, cookie race |
| 🟠 High | 5 | SRP violations, missing time guards, console.log leftover |
| 🟡 Medium/Low | 5 | var usage, props scattering, cookie at-rest |
| ✅ Good practices | 12 | — |

---

## 3. Deep Dive: 17_SearchService.gs

**ขนาดจริง:** 389 บรรทัด — เป็น 2% ของโปรเจกต์ทั้งหมด

### ✅ สิ่งที่ทำดีมาก (เก็บไว้)
- ShipToName-Only Policy (ลด dependency, deterministic)
- 3-Tier fallback (Fast Track → Person → NOT_FOUND)
- Time Guard + auto-resume (`installAutoResume_`)
- Batch flush (`flushLookupResults_`) ใช้ทั้ง success/error path
- `isValidLatLng` check ก่อนเขียน (skip row ที่มีพิกัดดีอยู่)
- ไม่เขียน Master sheet (boundary สะอาด)

### 🔴 Critical Issues

#### C1: `findBestGeoByPersonPlace()` — V5.5.011 normalize ทำซ้ำซ้อน (lines 90-114)

```javascript
// [V5.5.011] ทำความสะอาดก่อน
let cleanName = rawName;
let normResult = null;
try {
  if (typeof normalizePersonNameFull === 'function') {
    normResult = normalizePersonNameFull(rawName);  // ← normalize ครั้งแรก
  }
} catch (normErr) { ... }

// ส่งเข้า Tier 0
let fastResult = fastLookupByShipToName(cleanName);
//                       ↑ ↑ ↑
//                       fastLookup ก็ normalize อีกที (เพราะใช้ normalizeForCompare ภายใน)

const personResult = resolvePerson(rawName, normResult);  // ← normalize ครั้งที่ 3
```

**ปัญหา:** 1 row → normalize 2-3 ครั้งในกระบวนการเดียว
**Impact:** Run บน 1,000 rows → 2,000-3,000 normalize call ที่ส่วนใหญ่ไม่จำเป็น ทำให้ runLookupEnrichment เสี่ยง timeout บน dataset ใหญ่
**Patch:** Compute normalize ONCE — pass result around (ส่ง `normResult` เข้า `fastLookupByShipToName`)

#### C2: `lookupEnrichOneRow_()` — switch case ตาย (lines 244-272)

Status มี 3 ค่า success แต่ logic เหมือนกัน → ลด fall-through ได้, `default:` กลืน status ที่ไม่รู้จัก → ไม่ log warning
**Patch:** ใช้ `Set` ของ FOUND_STATUSES + log unknown status

#### C3: `flushLookupResults_()` — ทำลาย background color เดิม (lines 296-335)

`setBackgrounds` กับ **ทุก column** (ไม่ใช่แค่คอลัมน์ที่ track) — ลบสีของคอลัมน์อื่นทั้งหมด
**ผลกระทบ:** ถ้ามีคน mark "completed" ด้วย background color ที่คอลัมน์อื่น → หายทุกครั้งที่ run enrichment
**Patch:** setBackgrounds เฉพาะคอลัมน์ที่ track (เช่น col 1 แค่ Status)

### 🟠 High

#### H1: `runLookupEnrichment()` — memory spike บน dataset ใหญ่ (lines 173-205)

```javascript
const allData = sheet.getRange(2, 1, totalRows, schemaLen).getValues();
// ...
const latActualArr = [];
const bgColorArr   = [];
// เก็บทั้ง 2 array ตลอด loop
```

**Patch:** Process ใน chunk 500 rows + flush batch แต่ละ chunk

#### H2: `lookupSingleRow()` — silent return null (lines 354-385)

ถ้า sheet ไม่มีข้อมูล → return null โดยไม่ log → caller ต้อง handle null ทุกที่
**Patch:** Return object `{status: 'NO_DATA', row: null}` แทน

### 🟡 Medium

#### M1: `result.reason` log — potential PII/credential leak (lines 122, 169)
#### M2: `findBestGeoByPersonPlace()` — guard clause return statement inconsistent (line 90)

---

## 4. Deep Dive: 18_ServiceSCG.gs

**ขนาดจริง:** 812 บรรทัด — เป็น 5% ของโปรเจกต์ทั้งหมด รวมกับ 17 = **1,201 บรรทัด = 14%** ของโปรเจกต์

### ✅ สิ่งที่ทำดีมาก
- 8-step pipeline (`readInputConfig_` → `callSCGApi_` → `flattenShipmentsToRows_` → `aggregateShopData_` → `writeDailyJobSheet_` → `applyMasterCoordinatesToDailyJob` → `copyDriverVerifiedToDailyJob_` → `buildOwnerSummary_` + `buildShipmentSummary_`)
- LockService ป้องกัน concurrent run
- Exponential backoff retry (1s, 2s, 4s)
- Time Guard + auto-resume
- SRP split ดีมาก (V5.5.019 REF-002)

### 🔴 Critical Issues

#### C4: `fetchDataFromSCGJWD()` — **NO Authorization Guard** (lines 113-185)

```javascript
function fetchDataFromSCGJWD() {
  const lock = LockService.getScriptLock();
  // ❌ ไม่มี isAuthorizedUser_() check ก่อนเริ่ม
  if (!lock.tryLock(10000)) { ... }
  // ...
}
```

**ปัญหา:** `setSCGCookie_UI` มี guard ✅, `clearAllSCGSheets_UI` มี guard ✅ แต่ **`fetchDataFromSCGJWD` ไม่มี** → ใครก็ได้ที่ edit sheet เรียก API ด้วย Cookie ที่รั่วจาก log → **SSRF + cost abuse + log injection**

**Patch:** เพิ่ม `isAuthorizedUser_()` check ก่อน LockService

#### C5: `fetchWithRetry_()` — **API key ใน Cookie header ติด log** (lines 462-484)

`throw new Error("HTTP " + ... + truncatedBody)` → caller catches → log error → body ของ response (อาจมี HTML error page ที่ echo cookie) ติดเข้า Stackdriver

**Patch:** Mask response body — log แค่ status + size (`body=${body.length} chars, hidden for PII safety`)

#### C6: `getSCGCookie_()` — **race condition + log leak ใน migration** (lines 277-310)

3-in-1 critical bug:
1. **Race condition:** Trigger A อ่าน B1 → trigger B อ่าน B1 (ยังมี cookie) → A ล้าง B1 → B return cleanCookie แต่ Properties ยังไม่มี
2. **LockService ไม่ใช้** ระหว่าง migration
3. **`logInfo` ไม่ mask cookie** — log event "Migration สำเร็จ" ก็ยัง leak ว่ามี cookie อยู่

**Patch:** ห่อด้วย LockService + double-checked locking + write Properties FIRST, then clear cell

#### C7: `setSCGCookie_UI()` — **PII ผ่าน `ui.prompt()` ที่ไม่ encrypted** (lines 219-270)

`ui.prompt()` ส่งผ่าน client-side → ถ้า user ใช้ public computer → cookie ค้างใน memory/clipboard
Script Properties **at-rest ไม่ encrypt** — Google อาจมี internal access

**ข้อแนะนำเชิงสถาปัตยกรรม:**
- ใช้ Secret Service ใน GCP แทน Properties (AES-256 at rest)
- หรือใช้ OAuth2 flow แทน cookie-based auth (ไม่ต้องเก็บอะไรเลย)

### 🟠 High

#### H3: `callSCGApi_()` — **No timeout** (lines 315-345)
ไม่ได้ตั้ง `muteHttpExceptions: true` และไม่มี `fetchTimeout` ใน options → ถ้า SCG server hang → Apps Script รอ 60s (default) → timeout แต่ไม่มี error message ชัดเจน

#### H4: `writeDailyJobSheet_()` — `dataSheet.clear()` + `setValues` ในฟังก์ชันเดียวกัน (lines 441-457)
`clear()` ลบทั้ง format + data → ถ้า setValues fail หลัง clear → sheet ว่างเปล่า + ไม่มี format → user ต้อง format ใหม่
**Patch:** ใช้ `clearContent()` แทน `clear()` เพื่อ retain format

#### H5: `copyDriverVerifiedToDailyJob_()` — **N+1 sheet read** (lines 510-595)
Loop แต่ละ DailyJob row อ่าน Source sheet ใหม่ → ถ้า DailyJob 1,000 rows + Source 1,000 rows = 1M iterations
**Patch:** Pre-load Source data เข้า Map ครั้งเดียว

#### H6: `applyMasterCoordinatesToDailyJob()` — no time guard, recursive runLookupEnrichment (lines 506-516)
ถ้า `runLookupEnrichment` เสร็จ แล้วเรียก `applyMasterCoordinatesToDailyJob` ซึ่งเรียก `runLookupEnrichment` อีกครั้ง (recursive) → stack overflow risk

### 🟡 Medium

#### M3: `buildDailyJobRow_()` — `new Date()` ไม่ handle invalid (lines 372-405)
#### M4: `aggregateShopData_()` — `invoices.add(r[DATA_IDX.INVOICE_NO])` ไม่ trim (lines 415-432)
#### M5: `clearAllSCGSheets_UI()` — `deleteRows` ช้ามาก (lines 762-790)
#### M6: `checkIsEPOD_()` — ReDoS risk เล็กน้อย (lines 486-502)

### 🎯 Top 3 ที่ควรแก้ก่อน (Severity × Impact × Effort)

1. **C4: `fetchDataFromSCGJWD` AuthZ Guard** — security + 5 นาทีแก้
2. **C5: `fetchWithRetry_` mask body** — PII safety + 10 นาทีแก้
3. **C6: `getSCGCookie_` LockService** — race condition + 15 นาทีแก้

### 🔗 Cross-file coupling concern

`17_SearchService.gs` และ `18_ServiceSCG.gs` เรียกซึ่งกันและกัน:
- `18.applyMasterCoordinatesToDailyJob` → `17.runLookupEnrichment` → `17.findBestGeoByPersonPlace` → `21.fastLookupByShipToName`
- `17.findBestGeoByPersonPlace` → `06.resolvePerson` → `06.findPersonCandidates` → `21_AliasService`

ดังนั้น cache fix ใน `21_AliasService` จะกระทบ `17_SearchService` โดยตรง

---

## 5. Pre-flight Audit Summary (V5.5.021)

> ดูรายละเอียดเพิ่มเติมใน `system_preflight_audit.md` และ `READINESS_AUDIT_FINAL.md`

### โครงสร้างโปรเจกต์
- 22 `.gs` files, ~17,399 lines, 327 functions, 19 sheets, 16 IDX sets
- 3 Domain Groups: Core (6 files), Group 1 Master DB (9 files), Group 2 Daily Ops (7 files)

### สถานะการตรวจสอบ Syntax
✅ 22/22 files ผ่าน syntax check

### วิเคราะห์จุดเสี่ยงจาก Patch ล่าสุด (V5.5.021)
1. **การใช้ `withEntryPointGuard_` (REF-011 Pilot)** — 3 entry points ใช้แล้ว
2. **การลบ Changelog ที่ซ้ำซ้อนออก (REF-005)** — ลบ 109 stale entries

### สถานะ Git Status
- ✅ ไม่มีไฟล์แปลกปลอม
- ✅ โครงสร้างไฟล์สอดคล้องตรงตาม V5.5.021

---

## 6. Top 3 Quick Wins (แก้ก่อนเลย)

| Priority | Issue | Effort | Impact |
|:--------:|-------|:------:|:------:|
| 1 | **C1: `saveChunkedCache_` โยน error แทน silent** — `14_Utils.gs` | ~15 min | ได้ observability ทั้งระบบ |
| 2 | **C4: `19_Hardening.gs:687-695` เก็บ error แทน `catch(e){}`** | ~10 min | เพิ่มความมั่นใจให้ sheet protection |
| 3 | **H3: ลบ `console.log` 3 จุดใน `03_SetupSheets.gs`** | ~5 min | ผ่าน Rule 13 100% |

---

## 7. Audit Journey (V5.5.006 → V5.5.021)

| Version | สิ่งที่แก้ | Issues |
|---------|----------|--------|
| V5.5.006 | Consistency Sync (doc-only) | 28 doc inconsistencies |
| V5.5.007 | CACHE FIX P0+P1 | 9 cache issues (4 P0 + 5 P1) |
| V5.5.008 | CACHE CLEANUP P2 | 6 cache cleanup |
| V5.5.009 | DOC SYNC | DEPENDENCIES/ARCHITECTURE + .md docs |
| V5.5.010 | CACHE HOTFIX + Q_REVIEW Post-Processor | 3 root cause จาก log จริง |
| V5.5.011 | DATA CONSISTENCY + SHIPTONAME CLEAN + Q_REVIEW NAV FIX | 5 issues |
| V5.5.012 | ANTIPATTERN FIX + DOC SYNC | 3 antipattern + 2 doc |
| V5.5.013 | GOOGLE MAPS REFACTOR | ลบ MAPS_CACHE sheet + ฟังก์ชันเก่า 9 ตัว, เพิ่มสูตร Amit Agarwal 7 ตัว |
| V5.5.014 | DRIVER-VERIFIED | +2 driver verified cols ใน FACT_DELIVERY/SOURCE/DAILY_JOB |
| V5.5.015 | CRITICAL-FIX | 2 critical issues fixed |
| V5.5.016 | PERFORMANCE-FIX | 13 performance issues fixed |
| V5.5.017 | SECURITY-POSTFIX | 12 SEC issues fixed (deny-by-default AuthZ, OAuth Least Privilege, PII masking) |
| V5.5.018 | REVIEW15 CLEAN CODE FIX | 14 issues (7 Rule 13 + 3 Rule 1 + 1 Rule 2 + 3 Rule 7) |
| V5.5.019 | REFACTOR_CYCLE6 | 12 REF issues fixed |
| V5.5.020 | REFACTOR_CYCLE6_RESIDUAL + full doc sync | REF-005 residual + REF-011 pilot + version bump |
| **V5.5.021** | **Security & Performance Deep Dive Audit** | **This report** (5 Critical + 5 High + 5 Medium findings — pending fix) |

---

*เอกสารนี้รวบรวมจากการ dive deep ของ V5.5.021 — ดูเอกสารที่เกี่ยวข้อง: [LMDS_V5.5_SECURITY_code_Report.md](LMDS_V5.5_SECURITY_code_Report.md) | [LMDS_V5.5_PERFORMANCE_code_Report.md](LMDS_V5.5_PERFORMANCE_code_Report.md) | [cache_audit.md](cache_audit.md) | [system_preflight_audit.md](system_preflight_audit.md)*
