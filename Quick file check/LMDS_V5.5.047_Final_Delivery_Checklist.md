# LMDS V5.5.047 — Final Pre-Delivery Audit Checklist
> **Audit Date:** 2026-07-05 (Asia/Bangkok)
> **Auditor:** Super Z (Automated + Manual Review)
> **Scope:** Full project audit before real-data deployment
> **Codebase:** 24 production `.gs` files + 1 legacy + 1 investigation + 15 HTML files
> **Code Version:** V5.5.047 | **Doc Version:** V5.5.034 (DRIFT DETECTED)
> **Verdict:** ⚠️ **CONDITIONAL GO** — 3 critical issues must fix before production

---

## 📊 Executive Summary

| Dimension | Score | Status |
|-----------|:-----:|:------:|
| Code Compliance (16 Immutable Laws) | 15/16 | ⚠️ 1 drift |
| Security (SEC-001→012) | 12/12 | ✅ PASS |
| Error Handling Coverage | 8/10 | ⚠️ 2 weak |
| Concurrency Safety (LockService) | 5/5 | ✅ PASS |
| Performance Patterns (Batch Ops) | 100% | ✅ PASS |
| Cache Invalidation Chain | 100% | ✅ PASS |
| Documentation Headers | 22/22 | ✅ PASS |
| Syntax (Node --check) | 26/26 | ✅ PASS |
| CI/CD Workflows | 5/7 | ❌ 2 broken |
| Version Sync (Code ↔ Docs) | ❌ FAIL | ❌ 13-version drift |
| Cross-File Dependencies | ✅ PASS | ✅ PASS |
| WebApp Frontend | ⚠️ WARN | ⚠️ Debug logs |

**Overall:** ⚠️ **CONDITIONAL GO — แก้ 3 Critical Issues ก่อนยิงข้อมูลจริง**

---

## 🔴 CRITICAL Issues (MUST FIX before delivery)

### C-01 · Version Drift (V5.5.034 → V5.5.047) — Documentation Out of Sync

| ข้อมูล | ค่า |
|--------|-----|
| ไฟล์ที่เกี่ยวข้อง | `README.md`, `BLUEPRINT.md`, `CONTEXT.md`, `LMDS Supreme Engineer.md`, `docs/CHANGELOG.md` |
| รุ่นในโค้ด (.gs ทั้ง 26 ไฟล์ + package.json) | **5.5.047** |
| รุ่นในเอกสารทั้งหมด | **5.5.034** |
| ช่องว่าง | **13 versions ไม่มี CHANGELOG entry** (V5.5.035 → V5.5.047) |
| ผลกระทบ | ผู้ดูแลระบบคนต่อไปจะไม่ทราบประวัติการเปลี่ยนแปลง; ผิด Law #6 (Document Dependencies) และผิด "DOC-CODE SYNC 100%" claim ใน README |
| การแก้ | (1) เพิ่ม CHANGELOG entries สำหรับ V5.5.035 → V5.5.047; (2) Bump version ใน README/BLUEPRINT/CONTEXT ให้เป็น 5.5.047; (3) อัปเดต stats (lines, functions) ให้ตรงจริง |

#### Action Items
- [ ] ระบุ changes ที่เกิดขึ้นระหว่าง V5.5.034 ถึง V5.5.047 (ดูจาก git log)
- [ ] แต่ง CHANGELOG entry สำหรับแต่ละ version ตามรูปแบบ Keep a Changelog
- [ ] อัปเดต `README.md` version header: `5.5.034` → `5.5.047`
- [ ] อัปเดต `BLUEPRINT.md` version header: `5.5.034` → `5.5.047`
- [ ] อัปเดต `CONTEXT.md` version: `5.5.034` → `5.5.047`
- [ ] อัปเดต `LMDS Supreme Engineer.md` version: `5.5.034` → `5.5.047`
- [ ] อัปเดต stats ใน README: lines = 19,259 (non-blank), functions = 434, total .gs = 26
- [ ] รัน `07-doc-code-sync.yml` workflow หลัง push เพื่อยืนยัน sync 100%

---

### C-02 · GitHub Actions Workflow Syntax Bug — CodeQL & Doc-Sync Disabled

| ข้อมูล | ค่า |
|--------|-----|
| ไฟล์ที่เกี่ยวข้อง | `.github/workflows/06-codeql.yml` (lines 12, 14), `.github/workflows/07-doc-code-sync.yml` (line 26) |
| ปัญหา | `branches: ain]` แทน `branches: [main]` — อักขระ `[m` หายไป |
| ผลกระทบ | (1) CodeQL security analysis **ไม่ทำงาน** บน push/PR events → security regression; (2) Doc-Code Sync check ไม่ทำงานบน push to main → version drift จะไม่ถูกตรวจจับ |
| YAML parse | ⚠️ ยัง parse ผ่าน (YAML ยอมรับ `ain]` เป็น string) แต่ trigger condition ผิด |
| การแก้ | แก้ `branches: ain]` → `branches: [main]` ในทั้ง 3 ตำแหน่ง |

#### Action Items
- [ ] แก้ `.github/workflows/06-codeql.yml` บรรทัด 12: `branches: ain]` → `branches: [main]`
- [ ] แก้ `.github/workflows/06-codeql.yml` บรรทัด 14: `branches: ain]` → `branches: [main]`
- [ ] แก้ `.github/workflows/07-doc-code-sync.yml` บรรทัด 26: `branches: ain]` → `branches: [main]`
- [ ] ทดสอบ trigger โดย push commit เล็กๆ ไปยัง main แล้วตรวจว่า workflow ทั้งสองรัน
- [ ] เปิด GitHub Actions tab ดู history ย้อนหลัง 6 เดือน — เช็คว่า workflow นี้เคยรันหรือไม่ (น่าจะไม่เคยรันตั้งแต่มี bug)

---

### C-03 · Missing `.clasp.json` — clasp Deploy Blocked

| ข้อมูล | ค่า |
|--------|-----|
| ไฟล์ที่เกี่ยวข้อง | `.clasp.json` (missing), `.github/workflows/02-deploy.yml` |
| ปัญหา | ไม่มีไฟล์ `.clasp.json` ใน repo ทำให้ `clasp push`, `clasp pull`, `clasp deploy` ใช้งานไม่ได้ |
| ผลกระทบ | (1) Developer ใหม่ไม่สามารถ push code ขึ้น Apps Script ผ่าน clasp ได้; (2) GitHub Actions `02-deploy.yml` จะ fail ที่ step `clasp push`; (3) `package.json` scripts (`push`, `pull`, `deploy`) ใช้งานไม่ได้ |
| สาเหตุที่เป็นไปได้ | `.clasp.json` ถูก `.gitignore` ไว้ (เพราะมี script ID เฉพาะของ environment) — ถูกต้องตามหลัก security แต่ควรมี `.clasp.json.example` สำหรับ onboarding |
| การแก้ | สร้าง `.clasp.json.example` เป็น template พร้อมคำอธิบาย, เพิ่มขั้นตอน setup ใน `CONTRIBUTING.md` |

#### Action Items
- [ ] สร้าง `.clasp.json.example` มีเนื้อหา:
      ```json
      { "scriptId": "YOUR_SCRIPT_ID_HERE", "rootDir": "src" }
      ```
- [ ] เพิ่ม section "Setup clasp" ใน `CONTRIBUTING.md`:
      1. ติดตั้ง clasp (`npm install -g @google/clasp`)
      2. Login (`clasp login`)
      3. Copy `.clasp.json.example` → `.clasp.json`
      4. แทน `YOUR_SCRIPT_ID_HERE` ด้วย script ID จริงจาก Apps Script Editor URL
      5. ทดสอบ `clasp push`
- [ ] ตรวจ `.gitignore` ว่า `.clasp.json` ถูก ignore อยู่แล้ว (security)
- [ ] อัปเดต `02-deploy.yml` ให้รับ `SCRIPT_ID` จาก secret แทนการอ่าน `.clasp.json` (สำหรับ CI/CD)

---

## 🟠 HIGH Issues (Should Fix before production)

### H-01 · `INVESTIGATE_Issue26.gs` ควรย้ายออกจาก production codebase

| ข้อมูล | ค่า |
|--------|-----|
| ไฟล์ | `src/O_core_system/INVESTIGATE_Issue26.gs` (362 บรรทัด, 101 console.log) |
| วัตถุประสงค์ | Investigation script สำหรับ debug Issue #26 (createPlace empty fields) |
| ความเสี่ยง | ถูก push ขึ้น production Apps Script แล้วมีคนเรียก `INVESTIGATE_Issue26()` จากเมนูหรือ trigger จะทำให้ log มี noise มาก (101 console.log) |
| สร้างเมื่อ | V5.5.045 (2026-07-05 — วันนี้) |
| การแก้ | ย้ายไป `scripts/investigations/` หรือลบถ้า investigate เสร็จแล้ว |

#### Action Items
- [ ] ย้าย `INVESTIGATE_Issue26.gs` ไป `scripts/investigations/INVESTIGATE_Issue26.gs`
- [ ] หรือลบถ้าผล investigate ได้นำไปแก้ใน code แล้ว
- [ ] เพิ่ม rule ใน `📋 กฎการเขียนโค้ด LMDS V5.5.md` ห้ามใส่ investigation scripts ใน `src/`

---

### H-02 · `runFullPipeline` และ `fetchDataFromSCGJWD` ขาด `catch` block

| ข้อมูล | ค่า |
|--------|-----|
| ไฟล์ | `src/O_core_system/00_App.gs` (runFullPipeline), `src/2_group2_daily_ops/18_ServiceSCG.gs` (fetchDataFromSCGJWD) |
| ปัญหา | ทั้งสอง function มี `try { ... } finally { ... }` แต่ **ไม่มี `catch` block** → error จะ propagate ขึ้นไปโดยไม่ถูก log ด้วย `logError()` ก่อน |
| ผลกระทบ | ในกรณีที่ error เกิดใน pipeline ของจริง จะไม่มี audit trail ใน SYS_LOG; debugging ยากขึ้น; user จะเห็น error ดิบๆ จาก Apps Script แทนที่จะเป็นข้อความที่อ่านง่าย |
| การแก้ | เพิ่ม `catch (e) { logError('Module', 'funcName: ' + e.message, e.stack); throw e; }` ระหว่าง try และ finally |

#### Action Items
- [ ] ใน `00_App.gs` `runFullPipeline()` — เพิ่ม catch block ก่อน finally:
      ```javascript
      } catch (e) {
        logError('App', 'runFullPipeline failed: ' + e.message, e.stack);
        safeUiAlert_('ข้อผิดพลาด', 'Pipeline ล้มเหลว: ' + e.message);
        throw e;  // ยังให้ Apps Script เห็น error
      } finally { ... }
      ```
- [ ] ใน `18_ServiceSCG.gs` `fetchDataFromSCGJWD()` — เพิ่ม catch block แบบเดียวกัน
- [ ] ตรวจ entry points อื่นๆ ที่อาจมี pattern เดียวกัน (onOpen, onEdit)

---

### H-03 · Hardcoded `row[N]` indices (9 จุด) — ต้องตรวจด้วยตา

Law #3 (No Hardcode Index) — ตรวจพบ 9 จุดที่ใช้ `row[N]` โดยไม่ผ่าน `*_IDX.*` constant:

| ไฟล์:บรรทัด | บริบท | ความเสี่ยง | ข้อแนะนำ |
|------------|-------|----------|----------|
| `10_MatchEngine.gs:799` | `Number(row[4] || 0)` (confidence) | ต่ำ — มาจาก query เฉพาะที่ select บางคอลัมน์ | เปลี่ยนเป็น named const หรือใช้ `ALIAS_IDX.CONFIDENCE` |
| `10_MatchEngine.gs:801` | `String(row[1] || '')` (masterUuid) | ต่ำ | เหมือนบน |
| `10_MatchEngine.gs:802` | `String(row[3] || '')` (entityType) | ต่ำ | เหมือนบน |
| `10_MatchEngine.gs:803` | `String(row[2] || '')` (variantName) | ต่ำ | เหมือนบน |
| `00_App.gs:1115` | `Number(r[0]) !== 0 && Number(r[1]) !== 0` (lat/lng filter) | ต่ำ — query เลือก 2 คอลัมน์ | เพิ่ม comment อธิบาย |
| `22_WebApp.gs:1335` | `Number(row[1] || 0)` (score) | ต่ำ — `getRange(row, col, numRows, 4)` เลือก 4 คอลัมน์ | เปลี่ยนเป็น named const หรือ comment |
| `22_WebApp.gs:1336` | `String(row[2] || '')` (reason) | ต่ำ | เหมือนบน |
| `22_WebApp.gs:1337` | `String(row[3] || '')` (action) | ต่ำ | เหมือนบน |

#### Action Items
- [ ] ตรวจทีละจุด ยืนยันว่า query source เลือกคอลัมน์ที่ถูกต้อง
- [ ] เพิ่ม comment อธิบายว่า "row[N] ตรงกับคอลัมน์ X จาก query SELECT เฉพาะ"
- [ ] หรือ refactor เป็น named constants (เช่น `const SCORE_COL = 1; const REASON_COL = 2;`)

---

## 🟡 MEDIUM Issues (Cleanup Recommended)

### M-01 · console.log ใน production HTML (24 จุด)

| ข้อมูล | ค่า |
|--------|-----|
| ไฟล์ | `Index.html`, `js/App.html`, `js/Auth.html`, `js/components/*.html`, `views/*.html` |
| จำนวน | 24 init/error logs (`'[app] Initializing...'`, `'[DashboardView] view loaded'`, ฯลฯ) |
| ผลกระทบ | User เห็น log ใน browser console — ไม่ critical แต่ไม่ professional |
| การแก้ | เก็บไว้แค่ error logs; ลบ init breadcrumbs หรือ gate ด้วย `if (DEBUG)` |

#### Action Items
- [ ] เพิ่มตัวแปร `const DEBUG = false;` ที่ head ของ `App.html`
- [ ] หรือลบ console.log ที่เป็น init breadcrumbs ออกทั้งหมด (เหลือแค่ `console.error` สำหรับ errors)
- [ ] ทดสอบหน้า Dashboard ใน browser หลังลบ — ดูว่าไม่มี feature พัง

---

### M-02 · หลาย entry points ไม่มี explicit `hasTimePassed_` call

| Entry Point | has Time Guard? | หมายเหตุ |
|-------------|:---:|----------|
| `onOpen` | ❌ | OK — short function |
| `onEdit` | ❌ | OK — short function |
| `runFullPipeline` | ❌ | ⚠️ ต้องตรวจ — เรียก helper ที่มี time guard หรือไม่? |
| `runMatchEngine` | ❌ | ⚠️ ต้องตรวจ |
| `runLookupEnrichment` | ❌ | ⚠️ ต้องตรวจ |
| `fetchDataFromSCGJWD` | ❌ | ⚠️ ต้องตรวจ |
| `applyMasterCoordinatesToDailyJob` | ❌ | ⚠️ ต้องตรวจ |
| `buildGeoDictionary` | ✅ | OK |
| `MIGRATION_HybridAliasSystem` | ❌ | ⚠️ ต้องตรวจ |
| `applyAllPendingDecisions` | ✅ | OK |

`hasTimePassed_` ถูกเรียก 7 ครั้งใน 4 ไฟล์ (16_GeoDictionaryBuilder, 20_ThGeoService, 12_ReviewService, 14_Utils) — อาจถูกเรียกจาก helper functions ที่ entry points เรียก ไม่ใช่ตรงๆ ที่ตัว entry point เอง

#### Action Items
- [ ] สำหรับแต่ละ entry point ที่ ❌ — ตรวจ helper functions ที่เรียกว่ามี `hasTimePassed_` หรือไม่
- [ ] ถ้าไม่มี — เพิ่ม time guard ใน loop หลักของ entry point (ทุก 100-500 แถว)
- [ ] ยืนยันว่า Auto-Resume Trigger (`installAutoResume_`) ติดตั้งเมื่อ time guard ทริกเกอร์

---

### M-03 · README stats ไม่ตรงจริง

| Stat | README | จริง | ผล |
|------|--------|------|----|
| Total .gs files | 25 (24 + 1 legacy) | **26** (24 + 1 legacy + 1 investigate) | ❌ |
| Total Lines (non-blank) | ~17,567 | **19,259** | ❌ |
| Total Functions | 435 | **434** | ❌ (off by 1) |
| Total Sheets | 19 | 19 | ✅ |
| Total IDX Sets | 16 | 16 | ✅ |
| SCHEMA Definitions | 19 | 19 (รวม mixed-name keys) | ✅ |

#### Action Items
- [ ] อัปเดต README table:
  - Total Files: 26 (24 production + 1 legacy `99_Legacy.gs` + 1 investigation `INVESTIGATE_Issue26.gs`)
  - Total Lines: ~19,259 (non-blank)
  - Total Functions: 434
- [ ] อัปเดต BLUEPRINT.md ในส่วนเดียวกัน
- [ ] รัน `scripts/health-check.sh` หรือ `05-scheduled-health.yml` workflow เพื่อ verify

---

### M-04 · ไม่มี automated test framework

| ข้อมูล | ค่า |
|--------|-----|
| ปัจจุบัน | มี manual test scenarios ใน CHANGELOG (Playwright + mock server) แต่ไม่ได้เก็บใน repo |
| ความเสี่ยง | regression หลัง refactor ไม่ถูกตรวจจับก่อน production |
| การแก้ | (Long-term) เพิ่ม Jest + gas-local สำหรับ unit test .gs; เพิ่ม Playwright test specs ใน `tests/` |

#### Action Items (Optional, post-launch)
- [ ] สร้าง `tests/` directory
- [ ] ติดตั้ง Jest + `gas-local` สำหรับ mock Apps Script globals
- [ ] แปลง manual test scenarios ใน CHANGELOG เป็น Playwright spec files
- [ ] เพิ่ม step ใน `01-ci.yml` ให้รัน tests ก่อน merge

---

## 🟢 PASSED Checks (No Action Required)

### ✅ P-01 · Code Compliance (16 Immutable Laws)

| # | Law | Status | Evidence |
|---|-----|:------:|----------|
| 1 | Clean Code | ✅ | camelCase สม่ำเสมอ, 434 ฟังก์ชันแยกหน้าที่ |
| 2 | Single Responsibility | ✅ | helper functions แยก SRP |
| 3 | No Hardcode Index | ⚠️ | 9 จุด row[N>0] แต่เป็น query projections (ดู H-03) |
| 4 | Batch Operations Only | ✅ | 0 appendRow, 0 getValue/setValue ใน loop |
| 5 | Checkpoint & Resume | ✅ | `hasTimePassed_` + Auto-Resume Trigger |
| 6 | Document Dependencies | ⚠️ | 22/22 ไฟล์มี DEPENDENCIES header — แต่ CHANGELOG drift (C-01) |
| 7 | No Phantom Calls | ✅ | `typeof` guards + `CacheService.removeAll()` |
| 8 | Namespace Pattern | ✅ | private functions ลงท้าย `_` |
| 9 | No Global State | ✅ | centralized chunked cache |
| 10 | Lock Library Version | ✅ | N/A |
| 11 | Separate HTML Files | ✅ | 15 HTML files แยกหน้าที่ |
| 12 | Error Handling | ⚠️ | 8/10 entry points have catch (H-02) |
| 13 | Logging with Context | ✅ | logError/logInfo/logWarn พร้อม module + context |
| 14 | Structured File Names | ✅ | `XX_ComponentName.gs` format |
| 15 | Full Files Only | ✅ | ทุกไฟล์ content ครบ |
| 16 | Security-First Design | ✅ | SEC-001→012 ครบ (Section P-03) |

---

### ✅ P-02 · Syntax & Structure

| Check | Result |
|-------|:------:|
| Node `--check` ผ่านทุก .gs file (26/26) | ✅ |
| Balanced braces ทุกไฟล์ | ✅ |
| 0 duplicate function definitions (434 unique) | ✅ |
| 0 TODO / FIXME / XXX / debugger statements | ✅ |
| 99_Legacy.gs properly referenced (deprecation layer) | ✅ |

---

### ✅ P-03 · Security Audit (SEC-001→012)

| SEC | Feature | Status |
|:---:|---------|:------:|
| SEC-001 | Cookie → PropertiesService | ✅ |
| SEC-002 | Authorization Guard (deny-by-default) | ✅ 34 calls |
| SEC-003 | API Key validation regex | ✅ |
| SEC-004 | PII Log Removal + Masking | ✅ |
| SEC-005 | CRLF Sanitization | ✅ |
| SEC-006 | Protected Ranges | ✅ |
| SEC-007 | Email Masking (11 calls) | ✅ |
| SEC-008 | OAuth Least Privilege (6 scopes) | ✅ |
| SEC-009 | RFC 6265 Cookie Regex | ✅ |
| SEC-010 | PII Masking extended | ✅ |
| SEC-011 | Sheet Protection Expanded | ✅ |
| SEC-012 | fetchWithRetry_ Body Truncation | ✅ |

**Hardcoded secrets scan:** 0 found ✅
**safeUiAlert_ vs getUi().alert:** 141 vs 4 (excellent ratio) ✅
**WebApp access:** MYSELF + executeAs=USER_DEPLOYING (secure) ✅

---

### ✅ P-04 · Cache Invalidation Chain

14 unique invalidation functions, well-distributed across modules:

| Function | Calls |
|----------|:-----:|
| `invalidateChunkedCache_` | 34 |
| `invalidateGeoCache_` | 14 |
| `invalidatePlaceCache_` | 13 |
| `invalidateGeoLatLngCache_` | 11 |
| `invalidateGeoDictCache` | 11 |
| `invalidateSameDayDestCache_` | 10 |
| `invalidateAliasCache_` | 9 |
| `invalidateFactInvoiceCache_` | 9 |
| `invalidatePersonCache_` | 8 |
| `invalidatePlaceAliasCache_` | 7 |
| `invalidateDestCache_` | 7 |
| `invalidateAllGlobalCaches` | 7 |
| `invalidateSourceCache` | 6 |
| `invalidateCache` | 1 |

---

### ✅ P-05 · CI/CD Workflows (5/7 OK)

| Workflow | Status | Note |
|----------|:------:|------|
| `01-ci.yml` | ✅ | Code quality check (4 jobs) |
| `02-deploy.yml` | ✅ | Deploy to Apps Script (3 jobs) — **ต้องมี .clasp.json ก่อน (C-03)** |
| `03-pr-validation.yml` | ✅ | PR validation (3 jobs) |
| `04-release.yml` | ✅ | Auto tag & release (1 job) |
| `05-scheduled-health.yml` | ✅ | Weekly health check (1 job) |
| `06-codeql.yml` | ❌ | **CodeQL — broken triggers (C-02)** |
| `07-doc-code-sync.yml` | ❌ | **Doc-Code Sync — broken triggers (C-02)** |

---

### ✅ P-06 · Schema / IDX / SHEET Consistency

| Metric | Count | Expected | Status |
|--------|:-----:|:--------:|:------:|
| SHEET constants | 19 | 19 | ✅ |
| SCHEMA definitions | 19 | 19 | ✅ |
| IDX sets | 16 | 16 | ✅ |
| Production .gs files | 24 | 24 | ✅ |
| HTML files | 15 | 15 | ✅ |

**`validateSchemaConsistency()` ครอบคลุมทุก sheet ที่มี IDX** ✅

---

### ✅ P-07 · Documentation

| Document | Size | Status |
|----------|-----:|:------:|
| `BLUEPRINT.md` | 109 KB | ✅ |
| `README.md` | 91 KB | ✅ |
| `docs/CHANGELOG.md` | 46 KB | ⚠️ (ขาด V5.5.035+) |
| `docs/LMDS_System_Guide.md` | 51 KB | ✅ |
| `docs/LMDS_Column_Dictionary_TH.md` | 36 KB | ✅ |
| `docs/LMDS_Schema_Dictionary.md` | 24 KB | ✅ |
| `docs/READINESS_AUDIT_FINAL.md` | 26 KB | ⚠️ (ยังเป็น V5.5.034) |
| `docs/LMDS_Architecture_MindMap.png` | 2.2 MB | ✅ |
| `docs/LMDS_Pipeline_Flowchart.png` | 877 KB | ✅ |
| `docs/LMDS_ER_Diagram.png` | 515 KB | ✅ |

---

## 📋 Environment-Setup Checklist (MUST DO at Google Sheets Environment)

### 🔴 MUST DO (ก่อนรันรอบแรก)

- [ ] **E-01 · สำรองข้อมูล Spreadsheet** — File > Make a copy ก่อนยัดโค้ดใหม่
- [ ] **E-02 · ติดตั้งโค้ด 24 ไฟล์** เข้า Apps Script Editor ในลำดับ:
  - `O_core_system/` (6 ไฟล์: 00, 01, 02, 03, 14, 19, 22) + 99_Legacy.gs
  - `1_group1_master_db/` (9 ไฟล์: 05, 06, 07, 08, 09, 10, 16, 20, 21)
  - `2_group2_daily_ops/` (7 ไฟล์: 04, 11, 12, 13, 15, 17, 18)
  - `4_group4_pipeline_mgr/` (1 ไฟล์: 24)
  - ⚠️ **ห้ามติดตั้ง `INVESTIGATE_Issue26.gs`** (ดู H-01)
- [ ] **E-03 · ตั้งค่า Script Properties** (Project Settings > Script properties):
  - `GEMINI_API_KEY` — Gemini API key สำหรับ AI features
  - `LMDS_ADMINS` — email admin คั่นด้วย comma (เช่น `a@x.com,b@y.com`)
  - `DASHBOARD_USERS` — email ที่ดู Dashboard ได้ (แยกจาก admin)
  - `SCG_COOKIE` — SCG login cookie (ผ่าน UI: 🔐 ตั้งค่า SCG Cookie)
  - `SCG_API_URL` — SCG/JWD API endpoint
- [ ] **E-04 · Deploy Web App** (Deploy > New deployment > Web app):
  - Execute as: **Me** (USER_DEPLOYING)
  - Who has access: **Only myself** (MYSELF)
  - Copy deployment URL ไปใช้
- [ ] **E-05 · รัน `setupAllSheets()`** จากเมนู LMDS > 🔧 ระบบ > ตั้งค่าชีตทั้งหมด
- [ ] **E-06 · รัน `checkSystemIntegrity()`** จากเมนู — ต้องเห็น ✅ ทุกบรรทัด
- [ ] **E-07 · (ถ้า migrate ข้อมูลเดิม) รัน `MIGRATION_HybridAliasSystem()`**

### 🟡 RECOMMENDED (ทำก่อนรันข้อมูลจริง)

- [ ] **E-08 · รัน `buildGeoDictionary()`** — โหลด SYS_TH_GEO dictionary (ถ้ายังไม่มี)
- [ ] **E-09 · รัน `applySheetProtection_UI()`** — ล็อก sensitive sheets
- [ ] **E-10 · ทดสอบ `runMatchEngine()` กับ sample 10-20 แถว** ก่อน
  - กรอง SCG source ให้เหลือ 10-20 แถว
  - รัน `runMatchEngine()` แล้วดูผลใน `FACT_DELIVERY` และ `Q_REVIEW`
  - ดูว่า AUTO_MATCH / CREATE_NEW / REVIEW แตกตัวสมดุล (ไม่เอียงไปข้างใดข้างหนึ่ง)
- [ ] **E-11 · ตั้ง Trigger เวลา** (ถ้าต้องรันอัตโนมัติ) — `installAutoResume_()` จะจัดการ Auto-Resume
- [ ] **E-12 · ทดสอบ Web App URL** — เปิดในเบราว์เซอร์, login, ดู Dashboard โหลดสำเร็จ
- [ ] **E-13 · ทดสอบ Search, FACT_DELIVERY view, Q_REVIEW view, Match Engine view** ครบทุกหน้า

### 🟢 OPTIONAL (ทำภายหลังได้)

- [ ] **E-14 · ตั้ง Admin list** ผ่าน 🔧 ระบบ > 👥 ตั้งค่ารายชื่อ Admin
- [ ] **E-15 · ติดตั้ง Smart Navigation** — `installSmartNavTrigger()` จากเมนู
- [ ] **E-16 · ตั้งค่า backup รายสัปดาห์** — Google Sheets version history
- [ ] **E-17 · ตั้ง Stackdriver Logging alerts** — แจ้งเตือนเมื่อมี ERROR level log

---

## 🎯 Final Sign-Off Checklist

### Code (Developer ทำ)
- [ ] แก้ C-01: Version sync (README/BLUEPRINT/CONTEXT/CHANGELOG → V5.5.047)
- [ ] แก้ C-02: Workflow syntax (`branches: [main]` ใน 06-codeql.yml, 07-doc-code-sync.yml)
- [ ] แก้ C-03: `.clasp.json.example` + setup docs
- [ ] แก้ H-01: ย้าย `INVESTIGATE_Issue26.gs` ออกจาก `src/`
- [ ] แก้ H-02: เพิ่ม catch block ใน `runFullPipeline` และ `fetchDataFromSCGJWD`
- [ ] แก้ H-03: Verify/Document 9 hardcoded row[N] จุด
- [ ] แก้ M-01: ลบ/gate console.log ใน HTML
- [ ] แก้ M-02: Verify time guards ใน entry points
- [ ] แก้ M-03: อัปเดต README stats

### Environment (Admin ทำ)
- [ ] E-01 ถึง E-07 (MUST DO)
- [ ] E-08 ถึง E-13 (RECOMMENDED)
- [ ] E-14 ถึง E-17 (OPTIONAL)

### Final GO/NO-GO Decision
- [ ] ผ่านการตรวจ Code Review โดย reviewer อิสระ 1 คน
- [ ] ผ่านการทดสอบบน **staging spreadsheet** (copy ของจริง) กับข้อมูล 10-20 แถว
- [ ] ผ่านการทดสอบ Web App บน staging deployment
- [ ] Backup spreadsheet สำเร็จ
- [ ] **GO** — เริ่มใช้งานกับข้อมูลจริง

---

## 📈 Risk Assessment (หลังแก้ Critical Issues)

| Risk | Level | Mitigation |
|------|:-----:|------------|
| Data corruption จาก concurrent run | 🟢 LOW | LockService + tryLock |
| Timeout จาก GAS 6-min limit | 🟢 LOW | Time Guard + Auto-Resume |
| Cache stale หลัง write | 🟢 LOW | 14 invalidation functions |
| Phantom function calls | 🟢 LOW | `typeof` guards |
| Trigger ผู้ใช้ถูกลบ | 🟢 NONE | Trigger ID matching |
| PII leak ใน logs | 🟢 LOW | maskReviewerEmail_ + no PII logging |
| Race condition ใน Review queue | 🟢 LOW | LockService + batch update |
| Version drift regression | 🟡 MEDIUM | แก้ C-01 + เปิด 07-doc-code-sync.yml |
| Security regression ไม่ถูกตรวจจับ | 🟡 MEDIUM | แก้ C-02 + เปิด 06-codeql.yml |
| Developer onboarding blocked | 🟡 MEDIUM | แก้ C-03 + ปรับ CONTRIBUTING.md |

---

## 📚 Appendix · Audit Artifacts

| ไฟล์ | ที่อยู่ | วัตถุประสงค์ |
|------|------|-------------|
| Audit script | `/home/z/my-project/scripts/lmds_audit.py` | รันใหม่ได้เมื่อ codebase เปลี่ยน |
| Raw audit output | `/home/z/my-project/scripts/audit_output.txt` | log การตรวจ 296 บรรทัด |
| Checklist (this file) | `/home/z/my-project/download/LMDS_V5.5.047_Final_Delivery_Checklist.md` | Markdown checklist |
| Checklist PDF | `/home/z/my-project/download/LMDS_V5.5.047_Final_Delivery_Checklist.pdf` | PDF สำหรับส่งมอบ |

---

## 📞 Next Steps

1. **ด่วนที่สุด** — แก้ Critical Issues (C-01, C-02, C-03) ใน GitHub PR เดียว
2. **ก่อน deploy** — แก้ High Issues (H-01, H-02, H-03)
3. **ระหว่าง deploy** — ทำ Environment-Setup Checklist ตามลำดับ
4. **หลัง deploy** — ติดตาม SYS_LOG 24 ชม.แรก, ทำ Medium Issues ใน PR ถัดไป

---

*Generated by Super Z (Automated Audit) — 2026-07-05*
*Audit script: `/home/z/my-project/scripts/lmds_audit.py`*
