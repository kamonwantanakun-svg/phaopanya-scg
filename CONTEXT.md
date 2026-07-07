# 🚀 Project Overview
**Logistics Master Data System (LMDS) V6.0.006** คือระบบจัดการฐานข้อมูลหลักด้านการขนส่ง (Master Data & Matching Engine + RBAC + WebApp) เป็น Full-stack solution บน Google Apps Script + Google Sheets

---

# 🛠️ Tech Stack & Environment
- **Environment:** Google Apps Script (V8 Engine)
- **Database:** Google Sheets (ใช้งานเสมือน RDBMS)
- **APIs:** Google Maps API (Geocoding), Gemini API (AI Reasoning), Telegram Bot API (Alerts)
- **Frontend:** Vanilla JS + Chart.js + Leaflet.js
- **Version Control:** Git (GitHub)

---

# 📂 Architecture & Domain Separation
โปรเจกต์มี **26 ไฟล์** (24 production + 1 legacy `99_Legacy.gs` + 1 investigation `scripts/investigations/`) — รวม 449 ฟังก์ชัน ~22,424 บรรทัด

### Domain Groups

1. **🟩 Group 1 (The Brain & Master DB):** `05` ถึง `10`, `16`, `20`, `21`
   - *หน้าที่:* ทำความสะอาดข้อมูล, จับคู่ (MatchEngine V6.0 + Dynamic Weights + Context Disambiguation), เป็นเจ้าของฐานข้อมูล `M_PERSON`, `M_PLACE`, `M_GEO_POINT`, `M_DESTINATION`, `M_ALIAS`
   - *รวมถึง:* `16_GeoDictionaryBuilder` (พจนานุกรมภูมิศาสตร์ Thai), `20_ThGeoService` (บริการแกะภูมิศาสตร์), `21_AliasService` (Hybrid Alias + UUID crosslink)
   - **Single Writer Rule:** เฉพาะ Group 1 เขียน Master tables

2. **🟦 Group 2 (Daily Ops & Consumers):** `04`, `11`, `12`, `13`, `15`, `17`, `18`
   - *หน้าที่:* โหลดงานประจำวันจาก SCG API (`18_ServiceSCG`), ส่ง `SHIP_TO_NAME` ไปหาพิกัด (`17_SearchService`), อ่าน/คัดแยก Q_REVIEW
   - *กฎเหล็ก:* Group 2 เป็น **ผู้บริโภคเท่านั้น** ห้ามเขียนข้อมูลลง Master tables (ยกเว้น FACT_DELIVERY + Q_REVIEW)
   - **Immutable Rule #2 (SRP):** หากจำเป็นต้องเขียน Master → เรียกผ่าน Group 1 helpers เท่านั้น

3. **⚙️ System & Core:** `00`, `01`, `02`, `03`, `14`, `19`, `22`, `24`, `27`
   - *หน้าที่:* เก็บ Config, โครงสร้างดัชนี (`PERSON_IDX`, `PLACE_IDX`, ...), Utilities, Security, WebApp, Pipeline Manager, RBAC
   - **Single Source of Truth:** ทุก config ต้องมาจาก `01_Config.gs`เท่านั้น

---

# 🔄 Core Workflows

## Daily Flow (Group 2)
```
fetchDataFromSCGJWD()
  ↓
[Read SCG API]
  ↓
[Build DAILY_JOB sheet]
  ↓
applyMasterCoordinatesToDailyJob()
  ↓
[Search Group 1 Master via 17_SearchService]
  ↓
[Write LatLong to DAILY_JOB]
```

## Master Flow (Group 1)
```
runMatchEngine()
  ↓
[Normalize each SOURCE row]
  ↓
[Resolve Person → Place → Geo → Destination]
  ↓
[8-Rules Matrix Decision]
  ↓
[Write to FACT_DELIVERY + Q_REVIEW + M_ALIAS]
  ↓
[Optional] applyAllPendingDecisions()
  ↓
[Admin approves/rejects in Q_REVIEW]
```

---

# 💻 Build, Test & Run Commands
เนื่องจากเป็น Apps Script การรันและทดสอบจะทำผ่านเมนู UI บน Google Sheets:

```bash
# Installation
cp .clasp.json.example .clasp.json
clasb login
clasp push

# After deploy, in Google Sheet:
# - 🟩 กลุ่ม 1 → รัน Full Pipeline (or Step by step)
# - 🟦 กลุ่ม 2 → โหลดข้อมูล Shipment ล่าสุด

# View Logs
# - Sheet: SYS_LOG (auto-clean at 5,000 rows)
```

---

# 🎨 Code Style & Conventions

- **Clean Code:** `camelCase` สำหรับตัวแปร/ฟังก์ชัน, แยกฟังก์ชันให้สั้น (SRP)
- **Namespace:** ป้องกันชื่อฟังก์ชันซ้ำข้ามไฟล์ ใส่ Prefix ตามชื่อโมดูลเสมอ (e.g. `normExtractPhone_`, `searchFuzzyPerson_`)
- **Full File Output (MANDATORY):** ห้ามใช้ `...` หรือละเว้นโค้ดส่วนเดิม AI ต้อง output โค้ดเต็มไฟล์ตั้งแต่ `/*` ถึง `*/` ไม่เอา
- **Error Handling:** ทุก entry point ต้องมี try-catch + logError with stack trace
- **Batch Operations:** ห้ามใช้ setValue/getValue ในลูป → ใช้ setValues/getValues batch

---

# 🚫 Rules (Do Not Break - Zero Tolerance)

## 16 Immutable Laws (อ่านให้ครบก่อน commit)

1. **Clean Code** — ห้า var, ต้อง const/let เท่านั้น, ESLint 0 errors
2. **SRP (Single Responsibility)** — ฟังก์ชันเดียวทำหน้าที่เดียว, ไม่เกิน 100 บรรทัด
3. **No Hardcoded Index** — ห้ามใช้ดัชนีตัวเลขตรงๆ (เช่น `row[28]`) ต้องใช้ Index constants (เช่น `row[FACT_IDX.PERSON_ID]`)
4. **Batch Operations Only** — ห้ามใช้ `setValue()` หรือ `appendRow()` ในลูป ให้ใช้ `setValues()` แบบ batch array เท่านั้น
5. **Checkpoint & Resume** — ฟังก์ชัน >2 นาที ต้องมี Time Guard + auto-resume trigger
6. **Document Dependencies** — ทุกไฟล์ต้องมี DEPENDENCIES section ในหัวไฟล์
7. **No Phantom Calls** — ห้ามเรียกฟังก์ชันที่ไม่มี definition + ห้ามใช้ global variable
8. **Namespace Pattern** — ชื่อฟังก์ชัน ต้องมี prefix + suffix `_` เช่น `personFindCandidates_` (private)
9. **No Global State** — ห้ามเก็บข้อมูลใน global variable แบบกระจาย → ใช้ centralized cache function
10. **Lock Library** — ทุก critical section ต้องมี LockService.tryLock() + release ใน finally
11. **Separate HTML Files** — ห้ามฝัง HTML ในไฟล์ .gs → สร้างไฟล์ .html แยก
12. **Error Handling** — Entry points ทั้งหมด ต้องมี try-catch + logError(moduleName, e.message, e)
13. **Logging with Context** — ทุก error ต้องเก็บ stack trace + context อย่างชัดเจน
14. **Structured File Names** — `00_App.gs`, `01_Config.gs`, ... (นำหน้าด้วยเลข)
15. **Full Files Only** — ห้าม truncate โค้ดระหว่างการแก้ไข
16. **Security-First Design** — Destructive ops ต้องมี AuthZ guard + ไม่เก็บ secret ใน Cell + PII ต้อง mask

---

# ⏳ Execution & Constraints (GAS Limits)

- **6-Minute Limit:** สคริปต์รันได้สูงสุด 6 นาที ฟังก์ชันที่ลูปยาวหรือดึง API เยอะ ต้องมี Time Guard + auto-resume
- **Cache Limit:** `CacheService` เก็บได้ 100KB หากข้อมูลใหญ่ให้เก็บแบบ Chunk หรือใช้ RAM Cache จำกัด ใน global scope
- **API Calls:** UrlFetch quota 20,000/day ต้องระวัง + ใช้ CacheService cache ผล
- **Sheet Size:** Sheets ไม่ควรเกิน 100,000 rows (slow reading) → ใช้ filter + batch

---

# 🛡️ Error Handling & Logging

- Entry Point ทุกตัว (เมนู/Trigger) ต้องหุ้มด้วย `try-catch` เสมอ
- ใน block catch ต้องบันทึก log ด้วย: `logError('ModuleName', e.message, e)` ห้ามเกิด Silent Fail (Rule 12 — V5.5.034)
- ฟังก์ชัน Helper ไม่ต้องมี try-catch (caller รับผิดชอบ)
- ห้ามใส่ PII (email, phone, ชื่อ) ใน log ตรงๆ → mask ด้วย MD5 hash

---

# 🎯 Current Focus & Known Issues

- **Focus:** V6.0.006 Production Ready — โค้ด ↔ เอกสารตรง 100% — 18 audit cycles complete
- **Status:** 96% Ready (Roadmap 68% → Target 100% by Phase completion)
- **Pending Features:** SYS_AUDIT_TRAIL (design ready), Semantic Note Parser (design ready)
- **Gotchas:** ถ้าระบบขึ้นสีแดง `NOT_FOUND` ตอนโหลดงาน มักเกิดจาก Schema หัวคอลัมน์ในชีตไม่ตรงกับ `SCHEMA` ใน 02_Schema.gs

---

# ⚖️ The 16 Immutable Laws (รัฐธรรมนูญของโปรเจกต์)

ห้ามเขียนหรือแก้ไขโค้ดใดๆ จนกว่าคุณจะได้อ่านและทำความเข้าใจกฎทั้ง 16 ข้อ

1. ให้ดูสรุปกฎแบบตารางที่ไฟล์: [`docs/📋 กฎการเขียนโค้ด LMDS V5.5.md`](docs/📋%20กฎการเขียนโค้ด%20LMDS%20V5.5.md)
2. ให้ดูคำอธิบายเชิงลึกและข้อห้าม (Anti-patterns) ที่ไฟล์: [`docs/Code Reviewer สำหรับโปรเจกต์ LMDS.md`](docs/Code%20Reviewer%20สำหรับโปรเจกต์%20LMDS.md)
3. หากคุณละเมิดกฎแม้แต่ข้อเดียว (เช่น แอบใช้ Hardcode Index, แอบตัดทอนโค้ดด้วยจุด..., หรือเก็บ secret ใน Cell) — ระบบจะ **REJECT** Pull Request ทันที
4. **กฎข้อ 16 (Security-First Design):** ห้ามเก็บ Secret ใน Cell, Destructive Op ต้องมี AuthZ Guard, PII ต้อง Masking, API Key ส่งผ่าน Header

---

# 🛠️ โหมดการสั่งงานพิเศษ (AI Execution Commands)

โปรเจกต์นี้มีคู่มือการตรวจสอบโค้ดฉบับเต็ม (Master SOP) อยู่ที่ไฟล์:
👉 [`docs/Code Reviewer สำหรับโปรเจกต์ LMDS.md`](docs/Code%20Reviewer%20สำหรับโปรเจกต์%20LMDS.md)

เมื่อ User พิมพ์คำสั่งเหล่านี้ ให้คุณดึงกฎจาก SOP มาบังคับใช้และตอบกลับตามคำสั่ง:

- `[CMD: BUGHUNT]` = สแกนโค้ดหาความเสี่ยง Critical & Performance ✅ ผ่านแล้ว
- `[CMD: REVIEW15]` = ประเมินตามกฎ 16 Immutable Laws อย่างละเอียด ✅ 16/16 COMPLIANT
- `[CMD: REFACTOR]` = วิเคราะห์ฟังก์ชันที่ยาวเกินไปและเสนอแผนการหั่นโค้ด ✅ Complete
- `[CMD: PREDEPLOY]` = เช็คสถานะระบบครั้งสุดท้ายก่อนขึ้น Production ✅ PASSED (96% readiness)
