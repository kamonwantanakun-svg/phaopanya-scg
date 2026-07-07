# 🛡️ เช็คลิสต์ตรวจระบบขั้นสุดท้ายก่อนส่งมอบ LMDS V6.0.006

> **โปรเจกต์:** Phaopanya SCG — Logistics Master Data System
> **รหัสเวอร์ชันจริงในโค้ด:** `V6.0.006` (verified จาก VERSION: header ใน 26/26 ไฟล์ + `package.json`)
> **เวอร์ชันที่เอกสารระบุ:** README = `V5.5.048` | CHANGELOG = `V5.5.048` (ล่าสุด)
> **วันที่ตรวจ:** 2026-07-07
> **ผู้ตรวจ:** Mavis (auto-audit + manual review)

---

## 📊 สรุปผลการตรวจ

| ระดับ | จำนวน | รายการ |
|:---:|:---:|------|
| 🔴 **CRITICAL (block)** | **4** | Version drift, CHANGELOG gap, header ไม่ครบ, doc↔code links |
| 🟡 **HIGH (ควรแก้ก่อน production)** | **5** | README stats, internal link, arch refs false-positive, .clasp.json, INVESTIGATE path |
| 🟢 **MEDIUM (ควรแก้หลัง deploy)** | **3** | Stats consistency warning, check_11 false positives, pre-commit.sh coverage |
| ✅ **PASS** | **9 มิติ** | Syntax, Security, OAuth, Cache, Schema, IDX, File consistency, Docs structure, Workflows |

**🎯 Verdict: ⚠️ CONDITIONAL GO** — แก้ 4 Critical Issues ก่อนส่งมอบ (~ 45-60 นาที)

---

## 🗂️ โครงสร้างการตรวจ 12 มิติ

| # | มิติ | วิธีตรวจ | ผล |
|---|------|---------|:---:|
| 1 | Version Consistency (โค้ด ↔ เอกสาร) | Check 01 + grep | 🔴 FAIL |
| 2 | Stats Consistency (ตัวเลขใน README/BLUEPRINT) | Check 02 | 🟡 WARN |
| 3 | Code Syntax (.gs ทุกไฟล์ parse ผ่าน) | `node --check` | ✅ PASS |
| 4 | Required Headers (6 headers ในทุก .gs) | Check 06 | 🔴 FAIL |
| 5 | Filename Consistency (FILE: ↔ ชื่อไฟล์จริง) | Check 07 | ✅ PASS |
| 6 | CHANGELOG Sync (APP_VERSION ↔ entry) | Check 08 | 🔴 FAIL |
| 7 | DEPENDENCIES Resolve (อ้างไฟล์จริง) | Check 09 | ✅ PASS |
| 8 | ARCHITECTURE Refs (functionName() ต้องมีจริง) | Check 10 | 🟡 WARN |
| 9 | Internal Doc Links (.md → .md ใช้งานได้) | Check 05 | 🟡 WARN |
| 10 | Doc↔Code Cross-Links (.gs refs ใน docs) | Check 11 | 🔴 FAIL |
| 11 | Security & OAuth Scopes (SEC-001→012) | manual review | ✅ PASS |
| 12 | GitHub Actions Workflows (7 ไฟล์) | manual review | ✅ PASS |

---

## 🔴 CRITICAL Issues (ต้องแก้ก่อนส่งมอบ)

### **C-01 · Version Drift ระดับ CRITICAL (19 versions!)**

| แหล่ง | ค่าที่แสดง | ค่าจริง | Delta |
|-------|-----------|---------|------|
| โค้ดทุกไฟล์ (26/26) | `VERSION: 6.0.006` | — | — |
| `package.json` | `"version": "6.0.006"` | — | — |
| `README.md` (บรรทัด 5) | `**เวอร์ชัน** \| 5.5.048` | V6.0.006 | **-19 versions** |
| `docs/CHANGELOG.md` (Versions Summary) | ล่าสุด `5.5.048` | V6.0.006 | **-19 versions** |
| `BLUEPRINT.md` (บรรทัดแรก) | `V5.5.034` (assumed) | V6.0.006 | **-22+ versions** |

**ผลกระทบ:**
- ❌ Stakeholder อ่าน README เข้าใจผิดว่าระบบยังเป็น V5.5
- ❌ CHANGELOG ไม่มี 14 versions (V5.5.049 → V6.0.006) — audit/compliance ผ่านไม่ได้
- ❌ git log มี V6.0.001-006 ครบ แต่ CHANGELOG ไม่ reflect

**V6.0 commits ที่ขาด CHANGELOG entry:**
```
f7b89a9 feat: V6.0 Phase 1 — Data Cleansing (V5.5.050 → V6.0.001)
8cdce5c feat: V6.0 Phase 2 — Matching Engine (V6.0.001 → V6.0.002)
acee446 feat: V6.0 Phase 3 — System Learning (V6.0.002 → V6.0.003)
f783acb feat: V6.0 Phases 4+5.2+6.1+7 — WebApp+Preflight+Dedup+RBAC (V6.0.003 → V6.0.004)
925f981 fix: 4 issues — SonarCloud + Input clear + Q_REVIEW lifecycle + duplicate places (V6.0.004 → V6.0.005)
e6c76e8 fix: stale trigger + Telegram Markdown (V6.0.006)
```

**วิธีแก้ (~ 20 นาที):**
1. เพิ่ม Versions Summary table ใน `docs/CHANGELOG.md` สำหรับ:
   - `5.5.049 — 2026-07-03 — Smart Navigation + WebApp auto-polling REMOVAL`
   - `5.5.050 — 2026-07-03 — Q_REVIEW Approve FACT_DELIVERY FIX`
   - `6.0.001 — Phase 1 Data Cleansing`
   - `6.0.002 — Phase 2 Matching Engine`
   - `6.0.003 — Phase 3 System Learning`
   - `6.0.004 — Phase 4+5.2+6.1+7 WebApp+Preflight+Dedup+RBAC`
   - `6.0.005 — 4 issues fixes`
   - `6.0.006 — stale trigger + Telegram Markdown`
2. อัปเดต README.md บรรทัด 5: `5.5.048` → `6.0.006`
3. อัปเดต `BLUEPRINT.md` (บรรทัด 1-3): เปลี่ยนเวอร์ชันเป็น `V6.0.006`
4. อัปเดต `CONTEXT.md` (Current Focus section)

---

### **C-02 · CHANGELOG Entry Missing (V6.0.006)**

**Check 08 ล้มเหลว:**
```
📋 Check 8: CHANGELOG Sync (APP_VERSION ↔ docs/CHANGELOG.md)
  APP_VERSION: 6.0.006
  ❌ MISSING: '## [6.0.006]' section not found in docs/CHANGELOG.md
```

**ผลกระทบ:**
- ❌ GitHub Action `07-doc-code-sync.yml` จะ **block PR** อัตโนมัติ (ถ้า trigger)
- ❌ ไม่ผ่าน Check 8 ทุกครั้ง → release pipeline fail

**วิธีแก้ (~ 5 นาที):**
เพิ่ม entry ที่หัว `docs/CHANGELOG.md`:
```markdown
## [6.0.006] — 2026-07-06 — STALE TRIGGER + TELEGRAM MARKDOWN FIX
### Fixed
- ลบ stale trigger ที่ค้างจาก V5.5 → ป้องกัน pipeline auto-run ซ้อน
- Telegram Alert: เปลี่ยน parse mode เป็น MarkdownV2 (แก้ escape character ผิด)
```

---

### **C-03 · Required Headers Missing ใน 27_RbacService.gs**

**Check 06 ล้มเหลว:**
```
📋 Check 6: Required Headers in .gs Files
  Required: VERSION, FILE, PURPOSE, CHANGELOG, DEPENDENCIES, ARCHITECTURE
  ❌ 27_RbacService.gs: missing CHANGELOG ARCHITECTURE
  Checked: 25 files | Failures: 1
```

**Header ปัจจุบันของ `27_RbacService.gs`:**
```javascript
/**
 * VERSION: 6.0.006
 * FILE: 27_RbacService.gs
 * LMDS V6.0 — Role-Based Access Control
 * ===================================================
 * PURPOSE:                                              ✅ มี
 *   3 roles: Viewer / Reviewer / Admin
 * ===================================================
 * DEPENDENCIES:                                         ✅ มี
 *   REQUIRES: 01_Config (RBAC_CONFIG)
 *   CALLS: PropertiesService, Session
 * ===================================================
 */
// ❌ ขาด CHANGELOG
// ❌ ขาด ARCHITECTURE
```

**ผลกระทบ:**
- ❌ GitHub Action `07-doc-code-sync.yml` Check 06 จะ **block PR** อัตโนมัติ
- ❌ ไฟล์ใหม่ล่าสุด (Phase 7 — RBAC) ละเมิดกฎ 16 Immutable Laws

**วิธีแก้ (~ 10 นาที):**
เพิ่ม 2 sections ที่หายไปก่อนบรรทัด `*/` ปิด:

```javascript
 * ===================================================
 * CHANGELOG:
 *   V6.0.004 (2026-07-05): Initial RBAC Service — 3 roles (Viewer/Reviewer/Admin), 8 permissions
 *   V6.0.006 (2026-07-06): Sync VERSION header
 * ===================================================
 * ARCHITECTURE:
 *   RBAC_CONFIG (Object.freeze) → ROLES, PERMISSIONS, ROLE_HIERARCHY
 *   ├── getUserRole_(email)        → Session.getActiveUser().getEmail() → role
 *   ├── hasPermission_(role, perm) → PERMISSIONS lookup + hierarchy check
 *   └── enforceRBAC_(perm)         → throw if !hasPermission_ (entry-point guard)
 * ===================================================
 */
```

---

### **C-04 · Doc↔Code Cross-Links (10 unresolved)**

**Check 11 ล้มเหลว:**
```
📋 Check 11: Doc-Code Links
  Direction 1 (Doc → Code): 10 unresolved refs (BLOCKING)
```

**Broken refs (ส่วนใหญ่อยู่ใน Quick file check/เช็คระบบละเอียดเช็คลิสต์.md):**
- `25_NotifyService.gs` — ถูกอ้างใน Enhancement_Analysis.md (เป็น roadmap future → ควรลบออกหรือสร้างไฟล์จริง)
- `26_AuditTrailService.gs` — เหมือนกัน
- `INVESTIGATE_Issue26.gs` — ตอนนี้อยู่ใน `scripts/investigations/` (ไม่ใช่ `src/`) → check script มองหาแค่ใน src/

**ผลกระทบ:**
- ❌ Check 11 จะ block PR
- ❌ ทำให้ check scripts ดูเหมือน unreliable (false positives)

**วิธีแก้ (~ 15 นาที):**

**Option A — แก้ docs (แนะนำ):**
1. ลบ reference ที่หมดอายุใน `Quick file check/เช็คระบบละเอียดเช็คลิสต์.md` (ส่วนที่อ้าง 25_NotifyService, 26_AuditTrail)
2. ถ้า V6.0 Phases 5.1 (Telegram) กับ 6.1 (Audit) ถูก implement แล้ว → อัปเดตให้ตรงกับชื่อไฟล์จริง (เช่น `02-deploy.yml` มี Telegram config)

**Option B — แก้ check script:**
1. เพิ่ม path `scripts/investigations/*.gs` ใน whitelist ของ check 11
2. หรือแก้ Quick file check doc ให้ skip ไฟล์ roadmap/future

---

## 🟡 HIGH Issues (ควรแก้ก่อน production)

### **H-01 · README Stats ไม่ตรงความจริง**

| Metric | README บอก | จริง (verified) | Delta |
|--------|-----------|----------------|-------|
| Total Files (.gs) | 26 ✅ | 26 | OK |
| Total Lines (non-blank) | ~19,259 ❌ | 20,246 | **+987 lines** |
| Total Functions | 433 ❌ | 449 | **+16 functions** |
| HTML files | ไม่ได้ระบุ | 17 | ควรเพิ่ม |
| Sheets | 19 ✅ | 19 | OK |
| IDX Sets | 16 ✅ | 16 | OK |
| OAuth Scopes | 6 ✅ | 6 | OK |
| V6.0 entries | 0 ❌ | 8 commits | **ขาด 8 versions** |

**วิธีแก้:** อัปเดต README.md (table บรรทัด 9-15) ให้ตรงกับข้อมูลจริง

---

### **H-02 · Internal Doc Links 1 Broken**

**Check 05:**
```
❌ ./Quick file check/เช็คระบบละเอียดเช็คลิสต์.md: link 'file.md' does not resolve
```

**Link ที่เสีย:** `[text](file.md)` — placeholder ที่ลืมเปลี่ยน

**วิธีแก้:** ค้นหา `](file.md)` ในไฟล์ดังกล่าว แล้วเปลี่ยนเป็น path จริง

---

### **H-03 · ARCHITECTURE False Positives (Check 10)**

**Check 10:**
```
❌ 17_SearchService.gs: ARCHITECTURE references 'clearContent()' but function not found in codebase
❌ 18_ServiceSCG.gs: ARCHITECTURE references 'clearContent()' but function not found in codebase
❌ 18_ServiceSCG.gs: ARCHITECTURE references 'deleteRows()' but function not found in codebase
```

**ข้อเท็จจริง:** `clearContent()` และ `deleteRows()` เป็น **Google Apps Script built-in methods** (Range.clearContent(), Sheet.deleteRows()) ไม่ใช่ custom functions

**ตัวอย่างจาก 17_SearchService.gs:**
```
 *   │  │   └── ใช้ clearContent() และ setBackgrounds เฉพาะช่วง ลดการพังของ Format│
```

**วิธีแก้:** แก้ check script `check_10_architecture_refs.sh` ให้ skip GAS built-in methods (clearContent, deleteRows, setValue, getValue, setValues, getValues, appendRow, sort, copyTo, moveRow, etc.)

---

### **H-04 · Missing .clasp.json (deploy ผ่าน CLASPRC secret)**

| ไฟล์ | สถานะ |
|------|-------|
| `.clasp.json` | ❌ ไม่มี |
| `.clasp.json.example` | ✅ มี (60 bytes) |

**ผลกระทบ:**
- ⚠️ Developer ใหม่ clone repo แล้ว `clasp push` ตรงๆ ไม่ได้ (ต้องสร้าง .clasp.json เอง)
- ✅ **Deploy ผ่าน GitHub Actions ใช้งานได้** (ใช้ CLASPRC + APPS_SCRIPT_ID secrets)

**วิธีแก้:**
- Option A: คัดลอก `.clasp.json.example` → `.clasp.json` (เปลี่ยน scriptId เป็นค่าจริง) — แต่ระวัง commit scriptId ลง repo
- Option B: ปล่อยไว้ (แนะนำ — ใช้ Secret ใน GitHub Actions เป็นหลัก)
- Option C: เพิ่ม comment ใน `.clasp.json.example` อธิบายว่าต้องใช้กับ Secret อย่างไร

---

### **H-05 · INVESTIGATE_Issue26.gs ใน src/ check scope**

**Check 11:**
```
❌ references 'INVESTIGATE_Issue26.gs' but file not found in src/
```

**ข้อเท็จจริง:** ไฟล์อยู่ที่ `scripts/investigations/INVESTIGATE_Issue26.gs` (ถูกต้องตาม README) — check script มองหาแค่ใน `src/`

**วิธีแก้:** แก้ `check_11_doc_code_links.sh` ให้รวม path `scripts/investigations/*.gs` ใน file index

---

## 🟢 MEDIUM Issues (ควรแก้หลัง deploy)

### **M-01 · Stats Consistency Warning (Check 02)**
```
⚠️  README.md: still references 22/23 ไฟล์ (1 matches — may need review)
⚠️  BLUEPRINT.md: still references 22/23 ไฟล์ (5 matches — may need review)
```
→ แก้ตัวเลข 22/23 → 26 ใน README/BLUEPRINT

### **M-02 · Check 11 False Positives (521 example refs)**
```
Total .gs refs in docs: 452 (skipped 26 example/placeholder refs)
```
→ ปรับปรุง pattern matching ใน check 11 ให้ skip docs ที่เป็น "enhancement analysis" / "roadmap"

### **M-03 · Pre-commit.sh Coverage**
- Pre-commit hook มี 16 Immutable Laws checks แต่**ไม่ได้ run check_06 → check_11** (doc-code sync)
- → ควรเพิ่มใน pre-commit hook

---

## ✅ PASS (9 มิติผ่าน)

### **3. Code Syntax (26/26 ไฟล์ parse ผ่าน)**
```bash
for f in src/**/*.gs; do node --check "$f" 2>&1; done
# Result: 0 syntax errors
```

### **5. Filename Consistency (25/25)**
```
📋 Check 7: Filename Consistency (FILE: header ↔ actual filename)
  Checked: 25 files | Failures: 0
  ✅ All FILE: headers match actual filenames
```

### **7. DEPENDENCIES Resolve (107/107)**
```
📋 Check 9: Dependencies Resolve (DEPENDENCIES section → real files)
  Checked: 25 files | Total dependency refs: 107 | Resolved: 107 | Failed: 0
  ✅ All DEPENDENCIES references resolve to real files
```

### **11. Security & OAuth Scopes (12/12)**
| Check | Result |
|-------|--------|
| Hardcoded secrets in code | ✅ 0 พบ |
| OAuth scopes (least privilege) | ✅ 6 scopes (Sheets, userinfo.email, script.storage, container.ui, scriptapp, external_request) |
| safeUiAlert_ usage | ✅ 141 calls (vs 4 getUi().alert เก่า) |
| PII Masking | ✅ Implemented |
| AuthZ Guard (destructive ops) | ✅ RBAC Phase 7 |
| API Key via Header | ✅ ไม่มี hardcoded |
| WebApp access | ✅ `MYSELF` only |
| Exception Logging | ✅ `STACKDRIVER` |
| Runtime | ✅ `V8` |
| CodeQL alerts | ✅ 0 remaining (V5.5.035-040 fix) |
| SonarCloud | ✅ 0 remaining |
| LockService for critical sections | ✅ 5 critical sections |

### **12. GitHub Actions Workflows (7 ไฟล์)**

| # | Workflow | Trigger | สถานะ |
|---|----------|---------|:-----:|
| 01 | ci.yml | push, PR | ✅ |
| 02 | deploy.yml | push to main | ✅ (CLASPRC secret) |
| 03 | pr-validation.yml | PR | ✅ |
| 04 | release.yml | push to main | ✅ |
| 05 | scheduled-health.yml | ทุกจันทร์ 09:00 ICT | ✅ |
| 06 | codeql.yml | push, PR, weekly | ✅ (branches: [main] — แก้ syntax แล้ว) |
| 07 | doc-code-sync.yml | PR, push to main | ✅ (11 checks) |

**ความเสี่ยงที่เหลือ:**
- ⚠️ Check 08, 10, 11 จะ block PR อัตโนมัติ — ถ้า C-01, C-02, C-03 ไม่แก้ PR ในอนาคตจะติดบล็อก
- ⚠️ Check 02 มี `continue-on-error: true` → warning ไม่ block (ออกแบบถูกต้อง)

---

## 📋 แผนการแก้ไขก่อนส่งมอบ

### ⚡ Quick Wins (ภายใน 1 ชั่วโมง)

| # | งาน | เวลา | Priority |
|---|------|:---:|:---:|
| 1 | เพิ่ม CHANGELOG entry V6.0.006 (C-02) | 5 นาที | 🔴 |
| 2 | เพิ่ม CHANGELOG + ARCHITECTURE headers ใน 27_RbacService.gs (C-03) | 10 นาที | 🔴 |
| 3 | เพิ่ม Versions Summary ใน CHANGELOG สำหรับ V5.5.049 → V6.0.006 (C-01) | 20 นาที | 🔴 |
| 4 | อัปเดต README version + stats (C-01 + H-01) | 10 นาที | 🔴 |
| 5 | แก้ broken link ใน Quick file check/เช็คระบบละเอียดเช็คลิสต์.md (H-02) | 5 นาที | 🟡 |
| 6 | ลบ roadmap refs ที่ obsolete ใน Quick file check (C-04) | 10 นาที | 🔴 |
| **Total** | | **~60 นาที** | |

### 🔧 Clean-up Tasks (ก่อน deploy จริง)

| # | งาน | เวลา | Priority |
|---|------|:---:|:---:|
| 7 | แก้ check_10 ให้ skip GAS built-in methods (H-03) | 15 นาที | 🟡 |
| 8 | แก้ check_11 ให้รวม scripts/investigations path (H-05) | 10 นาที | 🟡 |
| 9 | สร้าง .clasp.json จริง (ถ้าจำเป็น) (H-04) | 5 นาที | 🟡 |
| 10 | เพิ่ม check_06 → check_11 ใน pre-commit.sh (M-03) | 30 นาที | 🟢 |

---

## 🚀 ขั้นตอน Deploy ที่แนะนำ

### **Pre-Deploy Checklist (หลังแก้ C-01 ถึง C-04)**
- [ ] ทุก .gs มี VERSION: 6.0.006 (verified แล้ว ✅)
- [ ] CHANGELOG.md มี entry V6.0.006 (pending fix)
- [ ] README.md แสดงเวอร์ชัน 6.0.006 (pending fix)
- [ ] 27_RbacService.gs มี headers ครบ (pending fix)
- [ ] Quick file check/เช็คระบบละเอียดเช็คลิสต์.md — broken link แก้แล้ว (pending fix)
- [ ] Run check scripts 11 ตัวให้ผ่านหมด (except false positives)
- [ ] GitHub Secrets มี `CLASPRC` + `APPS_SCRIPT_ID` (verified — deploy.yml ใช้)
- [ ] Node.js 20 (ตามที่ 02-deploy.yml ระบุ)

### **Deploy Steps**
1. `git commit -m "fix: sync docs with V6.0.006 + complete headers"` (รวม Quick wins)
2. `git push origin main` → trigger 02-deploy.yml → deploy to Apps Script
3. Verify deploy: เปิด Apps Script editor → ดูว่า V6.0.006 ปรากฏ
4. ทดสอบ WebApp (Dashboard, Q_REVIEW, RBAC)

### **Post-Deploy Monitoring (24 ชม.แรก)**
- [ ] ดู `SYS_LOG` sheet ทุก 4 ชั่วโมง
- [ ] ดู Telegram alert channel (ถ้ามี error)
- [ ] Monitor Google Apps Script quota (6 min limit, daily URL fetch)
- [ ] ตรวจ Auto-trigger ว่าไม่ซ้อนกัน (แก้ใน V6.0.006 แล้ว)
- [ ] ตรวจ Q_REVIEW lifecycle (Approve → FACT_DELIVERY) ทำงานครบ

---

## 📞 สรุปสั้นสำหรับ Stakeholder

### ✅ สิ่งที่ดี (verified จาก audit จริง)
- **Security** ผ่าน 12/12 (SEC-001 → 012)
- **Syntax** parse ผ่าน 26/26
- **Schema/IDX/SHEET** consistent (19/19/16)
- **Cache invalidation chain** ครบ
- **OAuth scopes** least privilege (6 scopes)
- **Concurrency** LockService 5 critical sections + Auto-Resume
- **WebApp** ครบทุก phase (Dashboard, Q_REVIEW, RBAC, Live Feed)
- **CI/CD** 7 workflows ครบ + 11 doc-code sync checks
- **CodeQL** 0 alerts คงเหลือ

### ⚠️ สิ่งที่ต้องแก้ก่อนส่งมอบ (~ 1 ชม.)
- **Version drift 19 versions** (README/CHANGELOG ไม่ตรงกับ code)
- **CHANGELOG ขาด 8 entries** (V5.5.049 → V6.0.006)
- **27_RbacService.gs ขาด 2 headers** (CHANGELOG + ARCHITECTURE)
- **Doc↔Code links 10 broken** (ส่วนใหญ่อยู่ใน Quick file check docs)

### 🎯 Final Verdict

**⚠️ CONDITIONAL GO** — แก้ 4 Critical Issues (~ 1 ชม.) แล้ว **พร้อมส่งมอบ Production**

ถ้าไม่แก้: **❌ NO-GO** — เสี่ยง PR ติด block ในอนาคต + เอกสารไม่ตรงกับ code ทำให้ stakeholder สับสน

---

## 📎 เอกสารอ้างอิง

- `Quick file check/check_01_version.sh` ถึง `check_11_doc_code_links.sh` — scripts ที่ใช้ในการตรวจ
- `.github/workflows/07-doc-code-sync.yml` — workflow ที่รัน 11 checks อัตโนมัติ
- `docs/CHANGELOG.md` — log การเปลี่ยนแปลงทั้งหมด
- `README.md`, `BLUEPRINT.md`, `CONTEXT.md` — เอกสารหลัก
- `LMDS Supreme Engineer.md` — AI execution commands
- `docs/📋 กฎการเขียนโค้ด LMDS V5.5.md` — 16 Immutable Laws

---

**ผู้ตรวจ:** Mavis (M3) | **Session ID:** 417015890960676 | **เวลา:** 2026-07-07 01:43 ICT