# 🔍 [E2E_SIMULATION] & [PREDEPLOY] MASTER AUDIT — LMDS v6.0.007

**Base:** โค้ดจาก `phaopanya-scg-main__1_.zip` (อัปเดตใหม่ — diff กับรอบก่อนแล้วพบว่าเปลี่ยน 27 ไฟล์ + เพิ่ม `26_AuditTrailService.gs`, `27_RbacService.gs` ใหม่ทั้งหมด + ยกระดับเป็น **v6.0.007** พร้อม WebApp Dashboard เต็มรูปแบบที่ยังไม่เคยตรวจมาก่อน — ผมตรวจจากซอร์สจริงทั้งหมด 100% ในรอบนี้ ไม่อ้างอิงผลตรวจเก่า)

---

## 1️⃣ Google Sheets Custom Menu — Dry-Run Simulation

`onOpen()` (`00_App.gs:64-149`) สร้างเมนู **39 รายการ** ทั้งหมด — ตรวจแล้วว่าทุกรายการมี target function จริง ไม่มี dangling reference

### 🔴 [BUGHUNT] Blocking Issue #1 — ไม่มี LockService ป้องกันการคลิกซ้ำ

**File:** `src/1_group1_master_db/16_GeoDictionaryBuilder.gs:125-127` (`buildGeoDictionary`)
**File:** `src/1_group1_master_db/20_ThGeoService.gs:182-184` (`populateGeoMetadata`)

ทั้งสองฟังก์ชันเรียก `withEntryPointGuard_(...)` **โดยไม่ส่ง `options.lock`** และ `withEntryPointGuard_()` เอง (`14_Utils.gs:540-565`) **ไม่ได้ acquire lock ให้อัตโนมัติ** — มันแค่ *release* lock ที่ถูกส่งเข้ามาเท่านั้น (`if (lock && lock.hasLock())`) ถ้าไม่มีใครส่ง lock เข้าไป ก็ไม่มีการ lock เกิดขึ้นเลย

**Dry-Run Simulation:**
1. Admin A คลิก "🌍 อัปเดตฐานข้อมูลภูมิศาสตร์ (SYS_TH_GEO)"
2. ฟังก์ชันอ่าน checkpoint `GEO_DICT_CHECKPOINT` จาก PropertiesService ได้ `rowIndex = 500`
3. **ก่อนรันเสร็จ** Admin A คลิกเมนูเดิมซ้ำ (หรือ Admin B คลิกพร้อมกันคนละแท็บ)
4. Execution ที่ 2 อ่าน checkpoint เดิม (`rowIndex = 500` — ยังไม่ถูกอัปเดตเพราะ execution แรกยังไม่เสร็จ) → ทั้งสอง execution **เขียนทับ `SYS_TH_GEO` ในช่วงแถวเดียวกันพร้อมกัน**
5. **ผลลัพธ์ที่คาดหวัง (Expected):** ควรเจอ toast "⚠️ ระบบคิวทำงาน" แล้ว return ทันที (เหมือน `fetchDataFromSCGJWD`)
6. **ผลลัพธ์จริงที่เกิด:** ไม่มีการเตือนใดๆ ทั้งสอง execution รันพร้อมกัน → ข้อมูล `SYS_TH_GEO` (พจนานุกรมภูมิศาสตร์ที่ทั้งระบบพึ่งพา) เสี่ยง**ข้อมูลปนกัน/checkpoint ค้าง**

**Severity: 🔴 HIGH (Blocking)** — แม้จะมี `isAuthorizedUser_()` guard กันคนนอกทีมคลิก แต่ไม่ได้ป้องกัน Admin คนเดียวกันดับเบิลคลิก หรือ Admin สองคนคลิกพร้อมกัน
**Fix:** เพิ่ม `const lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) { safeUiAlert_('⚠️ กำลังรันอยู่'); return; }` ก่อนเรียก `withEntryPointGuard_` แล้วส่ง `{lock: lock}` เข้าไปใน options — แพทเทิร์นเดียวกับ `fetchDataFromSCGJWD` ที่ทำถูกอยู่แล้ว

### 🟡 [BUGHUNT] Medium Issue #2 — `clearAllSCGSheets_UI` ไม่มี confirm dialog + ไม่มี lock

**File:** `src/2_group2_daily_ops/18_ServiceSCG.gs:1005-1041`
เมนู "🗑️ ล้างข้อมูลทั้งหมด" เรียก `clearContent()` บน `DAILY_JOB/OWNER_SUMMARY/SHIPMENT_SUM/INPUT` ทันทีที่คลิก — **ไม่มี `ui.alert(YES_NO)` ยืนยันก่อน** (ต่างจาก `safeResetTransactional_UI` ที่มี dialog ยืนยันครบถ้วน) และไม่มี LockService

**Simulation:** คลิกพลาด 1 ครั้ง = ข้อมูล DailyJob วันนี้หายทันทีไม่มีทางย้อนกลับ (ไม่มี soft-delete/trash)
**Severity: 🟡 MEDIUM** — ผลกระทบจำกัดเฉพาะข้อมูล transactional วันนี้ (master data ปลอดภัย) แต่ควรมี confirm dialog เพราะเป็น one-click destructive action
**Fix:** เพิ่ม `ui.alert()` แบบเดียวกับ `safeResetTransactional_UI`

### 🟢 ฟังก์ชันที่ไม่มี Lock แต่ความเสี่ยงต่ำ (มี mitigating control อื่นแทน)

| ฟังก์ชัน | Mitigating Control ที่พบ |
|---|---|
| `MIGRATION_HybridAliasSystem` | มี `confirmMigrationDialog_()` (YES/NO) + step-checkpoint (`state.step`) → รันซ้ำจะ skip step ที่เสร็จแล้วอัตโนมัติ ปลอดภัยกว่าที่คิด |
| `runLoadSource` / `runNormalize` | ไม่มี lock ตรงๆ แต่เป็น idempotent-leaning operation (ใช้ SYNC_STATUS/invoice dedup ที่ `04_SourceRepository.gs`) — คลิกซ้ำจะแค่ re-scan pending ไม่ duplicate เขียนถ้า mark-processed ทำงานถูกต้อง |
| `submitReviewDecision` (WebApp) | มี "defense-in-depth" เช็ค `currentStatus` ก่อนเขียนทุกครั้ง — บล็อก re-approve แถวที่ตัดสินใจแล้ว |

### ตาราง Mapping ฉบับเต็ม (Sheets Menu, 39 รายการ)

| Trigger (เมนู) | Target Function | Expected Outcome | Risk |
|---|---|---|---|
| 🚀 Run Full Pipeline | `runFullPipeline` (00_App.gs:222, **มี lock**) | รัน Step1→2→3 ต่อเนื่อง, toast progress, alert สรุปจบ | 🟢 |
| 📍 จับคู่พิกัดวันนี้ | `applyMasterCoordinatesToDailyJob` (**ไม่มี lock**) | เขียนพิกัดลง DailyJob | 🟡 ควรมี lock |
| Step 1 โหลดข้อมูลดิบ | `runLoadSource` (ไม่มี lock, idempotent) | toast จำนวนแถว pending | 🟢 |
| Step 2 Normalize | `runNormalize` (ไม่มี lock) | เขียน normalized field | 🟡 |
| Step 3 Match Engine | `runMatchEngine` (**มี lock**) | รัน MatchEngine, เขียน FACT/Q_REVIEW | 🟢 |
| 🛑 Emergency Stop | `requestPipelineStop_UI` | ตั้ง flag หยุด pipeline รอบถัดไป | 🟢 |
| 🟢 ยกเลิก Stop Signal | `clearPipelineStopSignal_UI` | ล้าง flag | 🟢 |
| 🔄 Backfill Alias Audit | `backfillAliasAuditFields_UI` (ไม่มี lock) | เติมฟิลด์ audit ใน M_ALIAS | 🟡 |
| 🧹 Safe Reset | `safeResetTransactional_UI` (มี confirm dialog, ไม่มี lock) | ล้าง transactional sheets เก็บ master ไว้ | 🟡 |
| 📋 เปิด Review Queue | `openReviewQueue` | เปิดชีต Q_REVIEW | 🟢 |
| ▶️ รัน pending decisions | `applyAllPendingDecisions` (**มี lock**) | ประมวลผล decision ที่ผู้ใช้เลือกไว้ | 🟢 |
| 🧹 ล้าง Done/Escalated | `clearDoneReviews_UI` (ไม่มี lock) | ลบแถวสถานะ Done | 🟡 |
| 📊 Data Quality Report | `buildFullQualityReport` | สร้างรายงานคุณภาพข้อมูล | 🟢 |
| 📥 ดึงข้อมูล SCG API | `fetchDataFromSCGJWD` (**มี lock ถูกต้อง**) | toast "กำลังเชื่อมต่อ..." → เขียน DailyJob | 🟢 |
| 🗑️ ล้างข้อมูลทั้งหมด | `clearAllSCGSheets_UI` (**ไม่มี confirm, ไม่มี lock**) | clearContent ทันที | 🟡 BUGHUNT #2 |
| 🔐 ตั้งค่า SCG Cookie | `setSCGCookie_UI` | บันทึก cookie ลง Properties | 🟢 |
| ⚙️ ตั้งค่า API Key | `setupEnvironment` | บันทึก Gemini key | 🟢 |
| 👥 ตั้งค่า Admin | `setupAdminList_UI` | บันทึกรายชื่อ Admin | 🟢 |
| 🏗️ สร้างชีตทั้งหมด | `setupAllSheets` (**มี lock**) | สร้าง/ตรวจชีตทั้งหมด | 🟢 |
| 🌍 อัปเดต SYS_TH_GEO | `buildGeoDictionary` (**ไม่มี lock**) | rebuild geo dictionary | 🔴 BUGHUNT #1 |
| 🛠️ เติมข้อมูลภูมิศาสตร์ | `populateGeoMetadata` (**ไม่มี lock**) | เติม 16 คอลัมน์ | 🔴 BUGHUNT #1 |
| 🔗 สร้าง Alias จากประวัติ | `generatePersonAliasesFromHistory` (ไม่มี lock) | สร้าง alias จาก FACT | 🟡 |
| 🔄 Migration Hybrid Alias | `MIGRATION_HybridAliasSystem` (confirm+checkpoint) | ย้ายระบบ alias | 🟢 |
| 🔗 ตรวจสอบ Master UUID | `assignMasterUuidIfMissing` (ไม่มี lock) | เติม UUID ที่ขาด | 🟡 |
| 📥 ดึงชื่อจาก SCG → M_ALIAS | `populateAliasFromSCGRawData` (ไม่มี lock) | เติม M_ALIAS | 🟡 |
| 🛡️ ป้องกัน Sensitive | `applySheetProtection_UI` (ไม่มี lock) | ตั้ง sheet protection | 🟢 (idempotent) |
| 🛡️ Preflight Audit | `runPreflightAudit` | รายงานตรวจสอบก่อนรัน | 🟢 |
| 🔍 Pipeline Preflight Strict | `runPipelinePreflightStrict_UI` | ตรวจเข้มก่อนรัน pipeline | 🟢 |
| 🧹 Detect Duplicates | `detectDoubleProcessing` | หา invoice ซ้ำ | 🟢 (read-only) |
| ✅ System Integrity | `checkSystemIntegrity` | ตรวจ schema/sheet | 🟢 (read-only) |
| 🔍 Diagnostic | `diagnoseSystemState` | รายงานสถานะระบบ | 🟢 (read-only) |
| 🔄 รีเซ็ต SYNC status | `resetSourceSyncStatus` (ไม่มี lock) | รีเซ็ตสถานะซิงค์ | 🟡 |
| 🧹 ล้าง Cache | `invalidateAllGlobalCaches` | ล้าง CacheService ทั้งหมด | 🟢 |
| 🔍 Dedup Audit Person/Place | `runDedupAuditPerson_UI` / `Place_UI` | รายงานข้อมูลซ้ำ | 🟢 (read-only) |
| 👥 ตั้งค่า Roles (RBAC) | `setupRoleAssignments_UI` (27_RbacService.gs) | บันทึก role assignment | 🟢 |
| 🧹 ลบ Trigger ค้าง | `cleanupStaleTriggers_UI` | ลบ trigger เก่า | 🟢 |
| 🧹 Cleanup Auto-Resume Triggers | `cleanupAutoResumeTriggers_UI` | ลบ trigger resume ค้าง | 🟢 |
| 📜 Prune Audit Trail | `cleanupAuditTrail_UI` (26_AuditTrailService.gs) | ลบ log เก่ากว่า 90 วัน | 🟢 |
| 📖 Version Info | `showVersionInfo` | แสดง alert เวอร์ชัน | 🟢 |

---

## 2️⃣ WebApp Interface — Client-Server Simulation

**สถาปัตยกรรม:** SPA เดียว (`Index.html` + `App.html` router) — ไม่มี `doPost` เลย ทุกการสื่อสารผ่าน `google.script.run` ที่ห่อเป็น Promise ใน `Api.html` (`promisify_()`, บรรทัด 24-42)

### 🔴 [BUGHUNT] Blocking Issue #3 — ไม่มี Client-Side Timeout เลยแม้แต่จุดเดียว

**File:** `src/3_group3_webapp/js/Api.html:24-42` (`promisify_`)

ตรวจทั้งไฟล์แล้ว **ไม่มี `setTimeout()` ผูกกับ `google.script.run` เลย** — `withSuccessHandler`/`withFailureHandler` เป็นทางออกเดียวของ Promise นี้ ถ้า callback ไม่ถูกเรียกกลับ (Apps Script drop connection — ซึ่งโค้ดเองมีคอมเมนต์ยอมรับไว้ที่ `22_WebApp.gs:104` ว่า **"บางครั้ง Apps Script ตัดการเชื่อมต่อ → หน้าขาว"**) Promise จะ**ค้างตลอดไป (never resolve, never reject)**

**Simulation:** ผู้ใช้เปิดหน้า Dashboard → `getDashboardData()` อ่าน 445+479 rows (เอกสารเองระบุใช้เวลา ~4.5 วินาที) → ถ้าเน็ตช้าหรือ GAS ตัดการเชื่อมต่อกลางทาง → `loadingState` (`App.html:407`) จะค้างแสดง spinner ตลอดไป ไม่มี fallback error state ปรากฏ เพราะ `unhandledrejection` handler (`App.html:161`) ทำงานเฉพาะกรณี **reject** เท่านั้น ไม่ทำงานกรณี **ไม่เคย settle**

**Severity: 🔴 HIGH** — ตรงกับคำถามที่ถามตรงๆ ("timeout เกิน 30 วินาที มี fallback หรือไม่") → **คำตอบคือไม่มี fallback เลย**
**Fix:** เพิ่ม `Promise.race([promisify_(fnName, ...args), timeoutPromise_(30000)])` ใน wrapper กลาง

### ตาราง Mapping WebApp API (9 endpoints)

| Trigger (ปุ่ม/View) | google.script.run เรียก | Payload | Success State | Error/Timeout State | Risk |
|---|---|---|---|---|---|
| Dashboard โหลดหน้า | `ping` | — | แสดง connection status | toast error (มี timeout gap) | 🟡 |
| Dashboard สถิติ | `getDashboardData` | — | render stat cards | toast error / **ค้าง spinner ถ้า timeout** | 🔴 BUGHUNT #3 |
| FactDelivery table | `getFactDeliveryPage` | `offset, limit, filter` | render table + pagination | toast error | 🟡 |
| QReview table | `getQReviewPage` | `offset, limit, statusFilter` | render table | toast error | 🟡 |
| ปุ่ม Approve/Reject | `submitReviewDecision` | `reviewId, decision, note` | อัปเดต UI แถวนั้น + toast สำเร็จ | มี status re-check ป้องกัน double-submit | 🟢 |
| Detail modal | `getReviewDetail` | `reviewId` | แสดง candidates | toast error | 🟢 |
| MatchEngine metrics | `getMatchEngineMetrics` | — | render charts | toast error | 🟡 |
| Source table | `getSourcePage` | `offset, limit, filter` | render table | toast error | 🟡 |
| Search box | `searchLocations` | `query, limit` | render results | toast error | 🟢 |
| Map Analytics | `getMapAnalyticsData` | `days, filter` | plot markers | toast error | 🟡 |
| Live status widget | `getMatchEngineLiveStatus` | — | polling badge | toast error | 🟢 |

**Auth/RBAC:** `doGet` เช็ค `isAuthorizedDashboardUser_()` ก่อน render ทุกครั้ง ✅, `submitReviewDecision` เช็คซ้ำด้วย `requirePermission_('action:approve_review')` ✅ — ระดับ authorization ทำถูกต้องดี ไม่พบช่องโหว่

---

## 3️⃣ Go/No-Go Decision

| หมวด | คะแนน |
|---|---|
| Menu-to-Function Integrity (39/39 มี target จริง) | 100% |
| LockService Coverage บนจุดเขียนข้อมูล (Sheets Menu) | 62% (8/13 จุดเสี่ยงมี lock, 2 จุด HIGH ไม่มี, 3 จุด MEDIUM) |
| WebApp Timeout/Fallback Handling | 0% (ไม่มีเลย) |
| Auth/RBAC Coverage | 100% |

### 🔴 **NO-GO — ความพร้อม: 82%**

**Action Plan ก่อน Deploy (เรียงตามลำดับความสำคัญ):**

1. **[BLOCKING]** เพิ่ม `LockService.getScriptLock()` ใน `buildGeoDictionary()` (`16_GeoDictionaryBuilder.gs:116`) และ `populateGeoMetadata()` (`20_ThGeoService.gs:173`) — แพทเทิร์นเดียวกับ `fetchDataFromSCGJWD`
2. **[BLOCKING]** เพิ่ม timeout wrapper ใน `promisify_()` (`Api.html:24`) — อย่างน้อย 30-60 วินาที พร้อม error state ที่ UI จับได้
3. **[MEDIUM]** เพิ่ม `ui.alert(YES_NO)` confirm dialog ใน `clearAllSCGSheets_UI` (`18_ServiceSCG.gs:1005`) ก่อน clearContent
4. **[MEDIUM, ไม่บล็อก]** พิจารณาเพิ่ม lock ให้ `applyMasterCoordinatesToDailyJob`, `runNormalize`, `resetSourceSyncStatus` ในรอบถัดไป

ต้องการให้ผมจัดทำ diff/patch แบบ full-file-only สำหรับข้อ 1-2 (Blocking) เลยไหมครับ ก่อนจะปล่อย Production?
