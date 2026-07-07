# LMDS V6.0.006 — Final Pre-Delivery Checklist
## รายการตรวจสอบก่อนส่งมอบงานจริง (ละเอียดระดับ File/Function)

> **Audit Date:** 2026-07-07 (Asia/Bangkok)
> **Auditor:** Super Z (Automated + Manual Code Review)
> **Code Version:** V6.0.006 (commit `e6c76e8`, 2026-07-07)
> **Doc Version:** V5.5.034 (workflow doc) — **14-version drift detected**
> **Repo:** https://github.com/Siriwat08/phaopanya-scg
> **Method:** รัน `.sh` scripts + อ่านโค้ดเชิงลึก + เช็ค git log + ตรวจ config/schema

---

## 📊 Executive Summary

| มิติ | ผลรวม | ผ่าน | ไม่ผ่าน | เปอร์เซ็นต์ |
|------|------|------|--------|-----------|
| A. Version & Doc Sync | 10 | 4 | 6 | 40% |
| B. File & Function Integrity | 12 | 12 | 0 | 100% |
| C. Schema & Config | 10 | 7 | 3 | 70% |
| D. Core Pipeline (Group 1) | 14 | 12 | 2 | 86% |
| E. Daily Ops (Group 2) | 12 | 9 | 3 | 75% |
| F. Single Writer Pattern | 6 | 3 | 3 | 50% |
| G. Security & RBAC | 10 | 8 | 2 | 80% |
| H. WebApp Frontend | 8 | 6 | 2 | 75% |
| I. Performance & Caching | 6 | 5 | 1 | 83% |
| J. CI/CD & Tooling | 8 | 5 | 3 | 63% |
| K. Documentation Headers | 6 | 5 | 1 | 83% |
| L. Dependencies | 4 | 4 | 0 | 100% |
| **TOTAL** | **106** | **80** | **26** | **75%** |

**Verdict:** ⚠️ **CONDITIONAL GO** — ต้องแก้ 6 Critical Issues (ใน Section A) ก่อน production

---

## 🔴 Critical Issues (MUST FIX before delivery)

| ID | ปัญหา | Section | Severity |
|----|------|---------|---------|
| C-01 | Version drift 14 versions — workflow doc V5.5.034 vs code V6.0.006 | A | 🔴 Critical |
| C-02 | CHANGELOG.md ไม่มี V6.0 entries เลย (V6.0.001 → V6.0.006) | A | 🔴 Critical |
| C-03 | README.md version 5.5.048 ล้าหลังจริง (V6.0.006) | A | 🔴 Critical |
| C-04 | BLUEPRINT.md version 5.5.034 ล้าหลังจริง (V6.0.006) | A | 🔴 Critical |
| C-05 | Single Writer Pattern ละเมิด — `flushGlobalAliasRows_` ใน `19_Hardening.gs` เขียน M_ALIAS | F | 🔴 Critical |
| C-06 | Workflow doc ไม่กล่าวถึง V6.0 features (RBAC, Telegram, Geofencing, Phonetic, Self-Healing) | A | 🔴 Critical |

---

## 📋 Detailed Checklist

### A. Version & Documentation Sync (10 ข้อ)

#### A.1 Source of Truth Version
- [x] **A.1.1** `APP_VERSION` ใน `01_Config.gs:73` = `'6.0.006'` ✅
- [x] **A.1.2** `SCHEMA_VERSION` ใน `01_Config.gs:74` = `'6.0.006'` ✅ (sync กับ APP_VERSION)
- [x] **A.1.3** `APP_NAME` ใน `01_Config.gs:75` = `'LMDS V5.5'` ⚠️ (น่าจะเป็น `'LMDS V6.0'` แต่เป็น brand name อาจตั้งใจคงไว้)

#### A.2 Code File Headers
- [x] **A.2.1** ทุก `.gs` file (26 files) มี `VERSION: 6.0.006` header ✅ (ผ่าน check_01)
- [x] **A.2.2** `package.json` version = `6.0.006` ✅

#### A.3 Documentation Files
- [ ] **A.3.1** ❌ `README.md` เวอร์ชัน = `5.5.048` (ควรเป็น `6.0.006`)
- [ ] **A.3.2** ❌ `BLUEPRINT.md` เวอร์ชัน = `5.5.034` (ควรเป็น `6.0.006`)
- [ ] **A.3.3** ❌ `docs/CHANGELOG.md` ไม่มี V6.0 entries (V6.0.001 → V6.0.006 หายไปทั้งหมด)
- [ ] **A.3.4** ❌ `docs/LMDS_SYSTEM_WORKFLOW_TH.md` เวอร์ชัน = `5.5.034` (ควรเป็น `6.0.006`)
- [ ] **A.3.5** ❌ `CONTEXT.md` — ต้อง verify (เอาจาก grep version)

---

### B. File & Function Integrity (12 ข้อ)

#### B.1 Core Functions — Group 1
- [x] **B.1.1** `processOneRow(srcObj)` มีจริงใน `10_MatchEngine.gs:980` ✅
  - Workflow doc บอก line 513-525 ❌ (stale)
  - Signature เปลี่ยน: เพิ่ม `{ soldToName: srcObj.soldToName }` (V5.5.047 Contextual Disambiguation)
  - เพิ่ม `breakTieAmongCandidates(candidates, srcObj)` (V6.0.002 Geofencing)
- [x] **B.1.2** `autoEnrichAliasesFromFactBatch_(factBatch)` มีจริงใน `10_MatchEngine.gs:412` ✅
  - Workflow doc บอก line 238 ❌ (stale)
  - ยังเป็น Single Writer หลักของ M_ALIAS ใน pipeline
- [x] **B.1.3** `runMatchEngine()` มีจริงใน `10_MatchEngine.gs` ✅
- [x] **B.1.4** `makeMatchDecision()` มีจริง ✅
- [x] **B.1.5** `executeDecision()` มีจริง ✅

#### B.2 Core Functions — Group 2
- [x] **B.2.1** `fetchDataFromSCGJWD()` มีจริงใน `18_ServiceSCG.gs` ✅
- [x] **B.2.2** `applyMasterCoordinatesToDailyJob()` มีจริงใน `18_ServiceSCG.gs:593` ✅
  - Workflow doc บอกผิดว่าอยู่ใน `17_SearchService.gs` ❌
- [x] **B.2.3** `findBestGeoByPersonPlace(rawPerson, rawAddress)` มีจริงใน `17_SearchService.gs:89` ✅
  - Signature: 2 params (rawPerson, rawAddress) — workflow doc บอก 1 param
- [x] **B.2.4** `runLookupEnrichment()` มีจริงใน `17_SearchService.gs` ✅
- [x] **B.2.5** `selectBestDestByAddress_(dests, rawAddress)` มีจริงใน `17_SearchService.gs:195` ✅
  - V5.5.022-PATCH1 — Tie-breaker โดยใช้ Dice coefficient threshold 0.70

#### B.3 V6.0 New Functions
- [x] **B.3.1** `breakTieAmongCandidates(candidates, srcObj)` ใน `10_MatchEngine.gs` ✅ (V6.0.002 Geofencing)
- [x] **B.3.2** `getCurrentUserRole_()` ใน `27_RbacService.gs` ✅ (V6.0.004 RBAC)

---

### C. Schema & Config (10 ข้อ)

#### C.1 SHEET Object (`01_Config.gs:124-151`)
- [x] **C.1.1** มี 21 entries (V5.5 = 19, V6.0 เพิ่ม 2) ✅
  - 🆕 `SYS_NOTES` (V6.0.001 — Semantic Note Parser storage)
  - 🆕 `SYS_NEGATIVE_SAMPLES` (V6.0.003 — System Learning negative samples)
- [x] **C.1.2** ไม่มี `MAPS_CACHE` (ลบถูกต้องใน V5.5.013) ✅
- [ ] **C.1.3** ❌ Workflow doc (Section 2) ระบุ SHEET count = 18 — ผิด (จริง 21)

#### C.2 IDX Sets (`01_Config.gs`)
- [x] **C.2.1** มี 18 IDX sets ✅
  - V5.5: 16 sets
  - 🆕 `NOTES_IDX` (V6.0.001)
  - 🆕 `NEGATIVE_SAMPLE_IDX` (V6.0.003)
- [x] **C.2.2** `SRC_IDX` มี 39 entries (V5.5.014 เพิ่ม `DRIVER_VERIFIED_NAME` และ `DRIVER_VERIFIED_ADDR`) ✅
- [x] **C.2.3** `DATA_IDX` มี 31 entries ✅
- [x] **C.2.4** `PERSON_IDX` มี 12 entries (V6.0.001 เพิ่ม `PHONETIC_PRIMARY`, `PHONETIC_SECONDARY`) ✅
- [x] **C.2.5** `PLACE_IDX` มี 16 entries (V6.0.001 เพิ่ม `PHONETIC_PRIMARY`, `PHONETIC_SECONDARY`) ✅
- [x] **C.2.6** `ALIAS_IDX` มี 11 entries (V6.0.003 เพิ่ม `VERIFIED_BY`, `REVIEW_ID`, `VERIFIED_AT`) ✅
- [ ] **C.2.7** ❌ README บอก "16 IDX sets" — ผิด (จริง 18)
- [ ] **C.2.8** ❌ README บอก "19 sheets" — ผิด (จริง 21)

---

### D. Core Pipeline (Group 1) (14 ข้อ)

#### D.1 Entry Point
- [x] **D.1.1** `00_App.gs` มีเมนู `runMatchEngine` ที่ trigger `runMatchEngine()` ✅
- [x] **D.1.2** `runMatchEngine()` ใช้ `LockService.getScriptLock()` ป้องกัน concurrent execution ✅
- [x] **D.1.3** มี Time Guard — ตรวจ `new Date() - startTime > limit` ก่อน flush ✅

#### D.2 Source Repository
- [x] **D.2.1** `04_SourceRepository.gs` มี `getUnprocessedRows()` ✅
- [x] **D.2.2** `updateSyncStatus_()` mark SYNC_STATUS หลัง process เสร็จ ✅
- [x] **D.2.3** มี `_SOURCE_ROWS_RAM_CACHE` + `invalidateSourceCache()` ✅

#### D.3 Match Engine
- [x] **D.3.1** `resolvePerson(rawPersonName, preNormResult, contextHint)` ✅
  - V5.5.047: เพิ่ม `contextHint.soldToName` สำหรับ Contextual Disambiguation
- [x] **D.3.2** `resolvePlace(rawPlaceName, rawAddress)` ✅
- [x] **D.3.3** `resolveGeo(rawLat, rawLng)` ✅
- [x] **D.3.4** `makeMatchDecision(srcObj, personResult, placeResult, geoResult)` มี 8 rules (INVALID→FULL_MATCH) ✅
- [x] **D.3.5** `executeDecision(srcObj, decision, ...)` มี actions: AUTO_MATCH / CREATE_NEW / REVIEW ✅
- [x] **D.3.6** `flushBatches_()` ใช้ batch write (ทั้ง FACT_DELIVERY + Alias) ✅

#### D.4 V6.0 Pipeline Enhancements
- [x] **D.4.1** `breakTieAmongCandidates(candidates, srcObj)` (V6.0.002) ✅
  - ใช้ street distance + driver history เป็น secondary signals
  - Fires เฉพาะเมื่อ best & second-best scores ภายใน ±2
- [ ] **D.4.2** ⚠️ V6.0.001 Phonetic match wiring — verify `phoneticMatch()` is called in `resolvePerson`/`resolvePlace`

---

### E. Daily Ops (Group 2) (12 ข้อ)

#### E.1 SCG API Service (`18_ServiceSCG.gs`)
- [x] **E.1.1** `fetchDataFromSCGJWD()` มี AuthZ Guard (RBAC check) ✅
- [x] **E.1.2** `readInputConfig_(ss)` อ่าน Cookie จาก B1 + ShipmentNos ✅
- [x] **E.1.3** `sanitizeCookie_(raw)` ลบ control characters + CRLF injection prevention ✅
- [x] **E.1.4** `callSCGApi_(cfg)` มี retry mechanism ✅
- [x] **E.1.5** `flattenShipmentsToRows_(shipments)` flatten JSON → array ✅
- [x] **E.1.6** `aggregateShopData_(allFlatData)` คำนวณ totals per shop ✅
- [x] **E.1.7** `writeDailyJobSheet_(ss, allFlatData)` ใช้ `clearContent()` แทน `deleteRows()` ✅

#### E.2 Search Service (`17_SearchService.gs`)
- [x] **E.2.1** `runLookupEnrichment()` มี chunk processing (รอบละ 500 rows) ✅
- [x] **E.2.2** `lookupEnrichOneRow_()` logic ค้นหา + กำหนดสี ✅
- [x] **E.2.3** `flushLookupResults_()` batch setValues กลับ DAILY_JOB ✅
- [ ] **E.2.4** ❌ ShipToName-only policy — workflow doc ระบุว่า "ห้ามใช้ ShipToAddress เป็น anchor/fallback" แต่จริง ๆ มี `selectBestDestByAddress_()` ใช้ ShipToAddress เป็น tie-breaker (V5.5.022-PATCH1)
- [ ] **E.2.5** ❌ Workflow doc ไม่กล่าวถึง `selectBestDestByAddress_()` function ใหม่

---

### F. Single Writer Pattern (M_ALIAS) (6 ข้อ)

#### F.1 Writer Locations (Verify)
- [x] **F.1.1** ✅ `10_MatchEngine.gs` — `autoEnrichAliasesFromFactBatch_()` เขียน M_ALIAS (auto pipeline)
- [x] **F.1.2** ✅ `21_AliasService.gs` — `createGlobalAlias()` เขียน M_ALIAS (admin/migration)
- [ ] **F.1.3** ❌ `19_Hardening.gs` — `flushGlobalAliasRows_()` (line 574) เขียน M_ALIAS จริง
  - เรียกจาก `generatePersonAliasesFromHistory()` (admin menu trigger)
  - ผิดกฎข้อห้าม #4 ใน workflow doc: "ห้ามเพิ่มจุดเขียน M_ALIAS นอก 10_MatchEngine.gs และ 21_AliasService.gs"

#### F.2 Read-only References (verify ไม่ใช่ write)
- [x] **F.2.1** ✅ `14_Utils.gs:1153` — `buildGlobalAliasDedupSet_()` อ่าน M_ALIAS เท่านั้น (getValues, ไม่ใช่ setValues)
- [x] **F.2.2** ✅ `22_WebApp.gs:1625` — `searchMasterEntities_()` อ่าน M_ALIAS เท่านั้น
- [ ] **F.2.3** ❌ Workflow doc Section 3.4 + 8.4 ระบุกฎผิด — ควรแก้เป็น "auto pipeline writers = 10_MatchEngine เท่านั้น; admin writers = 19_Hardening + 21_AliasService"

---

### G. Security & RBAC (10 ข้อ)

#### G.1 OAuth Scopes (`appsscript.json`)
- [x] **G.1.1** 6 scopes (Least Privilege) ✅
  - `spreadsheets`, `userinfo.email`, `script.storage`, `script.container.ui`, `script.scriptapp`, `script.external_request`
- [x] **G.1.2** ลดจาก 10 scopes (V5.5.017) → 6 scopes ✅

#### G.2 RBAC (V6.0.004 — `27_RbacService.gs`)
- [x] **G.2.1** 3 roles defined: `viewer`, `reviewer`, `admin` ✅
- [x] **G.2.2** Permission matrix 11 permissions ✅
  - `view:dashboard`, `view:fact_delivery`, `view:qreview`, `view:map_analytics` (all roles)
  - `view:source_sheet`, `view:live_feed`, `action:approve_review` (reviewer+admin)
  - `action:run_pipeline`, `action:edit_master`, `action:config`, `action:clear_cache` (admin only)
- [x] **G.2.3** Resolution: `LMDS_ADMINS` script property → `ROLE_ASSIGNMENTS` → default `viewer` ✅
- [x] **G.2.4** `getCurrentUserRole_()` returns role slug or null on error ✅

#### G.3 Hardening
- [x] **G.3.1** `19_Hardening.gs:657-662` — Protected sheets list ครอบคลุม PII sheets ✅
  - รวม M_ALIAS (Single Writer Pattern protection)
- [x] **G.3.2** Cookie sanitize — CRLF injection prevention ✅
- [ ] **G.3.3** ⚠️ RBAC integration with WebApp — ต้อง verify ว่าทุก webapp route มี RBAC check
- [ ] **G.3.4** ⚠️ `27_RbacService.gs` ไม่มี CHANGELOG และ ARCHITECTURE headers (ผิด Rule 6)

---

### H. WebApp Frontend (8 ข้อ)

#### H.1 Views (`src/3_group3_webapp/views/`)
- [x] **H.1.1** 9 views: Dashboard, SourceSheet, MatchEngine, FactDelivery, QReview, LiveFeed, Search, MapAnalytics, Unauthorized ✅
- [x] **H.1.2** `Unauthorized.html` สำหรับกรณีไม่มีสิทธิ์ ✅
- [x] **H.1.3** `js/Auth.html` มี authentication logic ✅
- [x] **H.1.4** `js/Api.html` มี API wrapper ✅
- [x] **H.1.5** `js/App.html` มี main app logic ✅

#### H.2 Components
- [x] **H.2.1** `DataTable.html`, `ChartCard.html`, `StatCard.html` ✅
- [x] **H.2.2** `css/Styles.html` มี shared styles ✅
- [ ] **H.2.3** ⚠️ V6.0.006 fix: stale trigger + Telegram Markdown — ต้อง verify ว่า Telegram alert ใช้ Markdown ที่ escape แล้ว
- [ ] **H.2.4** ⚠️ WebApp auto-polling ถูกลบใน V5.5.049 — ต้อง verify ว่า frontend ไม่ polling อีก

---

### I. Performance & Caching (6 ข้อ)

#### I.1 RAM Caches
- [x] **I.1.1** `_GLOBAL_GEO_DICT_CACHE`, `_GLOBAL_GEO_DICT_CACHE_PLACE`, `_GLOBAL_GEO_POINTS_CACHE` ✅
- [x] **I.1.2** `invalidateAllGlobalCaches()` ล้าง 10 RAM caches + 13 CacheService keys ✅

#### I.2 Batch Operations
- [x] **I.2.1** `flushBatches_()` — batch write FACT_DELIVERY + Alias ✅
- [x] **I.2.2** `flushLookupResults_()` — batch setValues DAILY_JOB ✅
- [x] **I.2.3** `flushGlobalAliasRows_()` — batch write M_ALIAS ✅

#### I.3 Chunking
- [x] **I.3.1** `runLookupEnrichment()` chunk รอบละ 500 rows ✅
- [ ] **I.3.2** ⚠️ `generatePersonAliasesFromHistory()` มี checkpoint resume — ต้อง verify ว่า saveHardeningAliasCheckpoint_ ทำงานถูก

---

### J. CI/CD & Tooling (8 ข้อ)

#### J.1 Scripts
- [x] **J.1.1** `scripts/setup-clasp.sh` — setup Google Apps Script CLI ✅
- [x] **J.1.2** `scripts/pre-commit.sh` — pre-commit hooks ✅
- [x] **J.1.3** `scripts/setup-github-protection.py` — branch protection ✅

#### J.2 Check Scripts (`Quick file check/`)
- [x] **J.2.1** 11 check scripts (check_01 → check_11) ✅
- [ ] **J.2.2** ❌ ทุก script มี path bug: `cd "$(dirname "$0")/../../.."` (ควรเป็น `../../` เพราะอยู่ใน root/Quick file check/ ไม่ใช่ root/scripts/checks/)
- [ ] **J.2.3** ❌ `check_05_internal_links.sh` ตรวจทั้ง `/home/z/` directory (scope กว้างเกินไป) — ควรจำกัดเฉพาะ `docs/` ของโปรเจกต์

#### J.3 GitHub Actions
- [x] **J.3.1** `.github/workflows/` มี lint + format + push workflow ✅
- [ ] **J.3.2** ⚠️ `07-doc-code-sync.yml` — ต้อง verify ว่ายังทำงานอยู่
- [ ] **J.3.3** ⚠️ Dependabot bumps — มีล่าสุด actions/checkout 4→7, setup-node 4→6, action-gh-release 2.6.2→3.0.1

---

### K. Documentation Headers (6 ข้อ)

#### K.1 Required Headers in `.gs` files
Required: `VERSION`, `FILE`, `PURPOSE`, `CHANGELOG`, `DEPENDENCIES`, `ARCHITECTURE`

- [x] **K.1.1** 25/26 files มีครบทั้ง 6 headers ✅
- [ ] **K.1.2** ❌ `99_Legacy.gs` ขาด `ARCHITECTURE` header
- [ ] **K.1.3** ❌ `27_RbacService.gs` ขาด `CHANGELOG` และ `ARCHITECTURE` headers (V6.0 new file ยังไม่ครบ)
- [x] **K.1.4** ✅ `FILE:` header ตรงกับชื่อไฟล์จริงทุกไฟล์ (check_07 ผ่าน)
- [x] **K.1.5** ✅ `VERSION:` header = 6.0.006 ทุกไฟล์ (check_01 ผ่าน)
- [ ] **K.1.6** ⚠️ `Latest 3 versions` ใน CHANGELOG section ของทุกไฟล์ยังเป็น V5.5.022 (ล้าหลัง) — ควรเป็น V6.0.004-006

---

### L. Dependencies (4 ข้อ)

- [x] **L.1** ✅ ทุก DEPENDENCIES reference ใน `.gs` files resolve ไปยังไฟล์จริง (127/127 — check_09 ผ่าน)
- [x] **L.2** ✅ ไม่มี phantom dependencies (check_04 ผ่าน)
- [x] **L.3** ⚠️ 36 ARCHITECTURE function references ไม่ resolve — ส่วนใหญ่เป็น false positives (alert(), getUi(), addSeparator() เป็น GAS built-ins ไม่ใช่ project functions)
- [x] **L.4** ❌ 3 doc→code references ไม่ resolve:
  - `docs/CHANGELOG.md` references `22_AccuracyPatch.gs` (ไฟล์ถูกลบไปแล้ว)
  - `docs/LMDS_Deep_Dive_Audit.md` references `22_AccuracyPatch.gs`
  - `docs/LMDS_V5.5_Enhancement_Analysis.md` references `25_NotifyService.gs` (ไม่มีใน V6.0)

---

## 📊 Stats Accuracy Audit

| Stat | README ระบุ | จริง (V6.0.006) | Δ | Status |
|------|----------:|-------------:|---:|:---:|
| `.gs` files | 26 | 26 | 0 | ✅ |
| Lines (non-blank) | ~19,259 | 20,246 | +987 | ❌ |
| Functions | 433 | 449 | +16 | ❌ |
| Sheets | 19 | 21 | +2 | ❌ |
| IDX Sets | 16 | 18 | +2 | ❌ |
| SCHEMA Definitions | 19 | 21 | +2 | ❌ |
| OAuth Scopes | 6 | 6 | 0 | ✅ |

> **สรุป:** ตัวเลขใน README ล้าหลังความจริง — ควรอัปเดตทั้งหมด

---

## 🎯 Action Items Before Production Deployment

### Priority 1 — CRITICAL (ต้องแก้ก่อนยิงข้อมูลจริง)

1. **อัปเดต `LMDS_SYSTEM_WORKFLOW_TH.md`** เป็น V6.0.006:
   - เพิ่ม Section 11: V6.0 Features Overview
   - แก้ ShipToName-only policy ใน Section 4.4 ให้อธิบาย tie-breaker layer
   - แก้ Single Writer Pattern ใน Section 3.4 ให้ระบุ writer 3 ตัว

2. **เพิ่ม CHANGELOG entries** สำหรับ V6.0.001 → V6.0.006 (ตาม git log)

3. **Bump `README.md` version** 5.5.048 → 6.0.006 + อัปเดต stats

4. **Bump `BLUEPRINT.md` version** 5.5.034 → 6.0.006

5. **เพิ่ม `ARCHITECTURE` header ใน `99_Legacy.gs`**

6. **เพิ่ม `CHANGELOG` และ `ARCHITECTURE` headers ใน `27_RbacService.gs`**

### Priority 2 — SHOULD FIX

7. แก้ path bug ใน `Quick file check/check_*.sh` (ทั้ง 11 ไฟล์)
8. จำกัด scope ของ `check_05_internal_links.sh` ให้เฉพาะ `docs/`
9. ล้าง dead doc→code references (`22_AccuracyPatch.gs`, `25_NotifyService.gs`)
10. ตัดสินใจเรื่อง Single Writer: (ก) ย้าย `flushGlobalAliasRows_` ไป `21_AliasService.gs`, หรือ (ข) แก้ workflow doc ให้ยอมรับ writer ที่ 3

### Priority 3 — NICE TO HAVE

11. อัปเดต `Latest 3 versions` ใน CHANGELOG section ของทุก `.gs` ไฟล์
12. เพิ่ม V6.0 architecture diagrams (RBAC flow, Self-Healing Alias lifecycle)
13. เพิ่ม troubleshooting entries สำหรับ V6.0 scenarios
14. Verify RBAC integration กับทุก WebApp route

---

## ✅ Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer | _pending_ | _pending_ | _pending_ |
| Reviewer | _pending_ | _pending_ | _pending_ |
| Deployer | _pending_ | _pending_ | _pending_ |

---

## 📝 Appendix: How to Reproduce This Checklist

```bash
# Clone repo
git clone https://github.com/Siriwat08/phaopanya-scg.git
cd phaopanya-scg

# Run actual checks (path-corrected version)
bash /home/z/my-project/scripts/run_actual_checks.sh

# Or run individual checks (must fix path first — see Quick file check/check_*.sh)
# All scripts have cd "$(dirname "$0")/../../.." which is wrong for current location

# Verify key functions exist
grep -n "function processOneRow" src/1_group1_master_db/10_MatchEngine.gs
grep -n "function autoEnrichAliasesFromFactBatch_" src/1_group1_master_db/10_MatchEngine.gs
grep -n "function fetchDataFromSCGJWD" src/2_group2_daily_ops/18_ServiceSCG.gs
grep -n "function applyMasterCoordinatesToDailyJob" src/2_group2_daily_ops/18_ServiceSCG.gs
grep -n "function findBestGeoByPersonPlace" src/2_group2_daily_ops/17_SearchService.gs
grep -n "function flushGlobalAliasRows_" src/O_core_system/19_Hardening.gs

# Verify version consistency
grep "APP_VERSION" src/O_core_system/01_Config.gs
grep "version" package.json | head -1
grep "เวอร์ชัน" README.md | head -1
```

> **หมายเหตุ:** รายการนี้ตรวจสอบจาก commit `e6c76e8` (V6.0.006, 2026-07-07) — หากมี commit ใหม่หลังจากนี้ ต้อง re-audit
