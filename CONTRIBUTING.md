# Contributing to LMDS V5.5

ขอบคุณที่สนใจร่วมพัฒนา LMDS (Logistics Master Data System)! 🎉

## 📋 กฎสำคัญ (16 Immutable Laws)

ก่อนเริ่มเขียนโค้ด อ่านและทำความเข้าใจกฎ 16 ข้อที่เป็นหัวใจของโปรเจกต์:
ดูได้ที่ `docs/📋 กฎการเขียนโค้ด LMDS V5.5.md`

### สรุปสั้น:
1. **No Hardcoded Index** — ใช้ `XXX_IDX.NAME` จาก `01_Config.gs`
2. **Single Writer Pattern** — M_ALIAS เขียนโดย `10_MatchEngine` เท่านั้น
3. **Batch Operations** — ใช้ `setValues()` ไม่ใช่ `setValue()` ในลูป
4. **Entry Point มี try-catch** — ป้องกัน silent fail
5. **Log error** — ใช้ `logError('Module', msg, err)`

## 🚀 การเริ่มต้น

### Prerequisites
- Node.js 18+
- `@google/clasp` (สำหรับ deploy ไป Apps Script)
- Google Account ที่มีสิทธิ์เข้า Apps Script project

### Setup
```bash
# Clone repo
git clone https://github.com/Siriwat08/phaopanya-scg.git
cd phaopanya-scg

# Install dev dependencies (optional — สำหรับ linting)
npm install

# Login to clasp (ครั้งแรก)
npx clasp login
```

### Setup clasp

ไฟล์ `.clasp.json` ใช้บอก `clasp` ว่าโค้ดในเครื่องเชื่อมกับ Apps Script project ตัวไหน
เรา **ไม่ commit** `.clasp.json` จริง (เพราะแต่ละ dev อาจใช้ Script ID ของตัวเองในการทดสอบ)
ดังนั้นใน repo จึงมี `.clasp.json.example` เป็น template

```bash
# 1. คัดลอก template → สร้าง .clasp.json ของตัวเอง
cp .clasp.json.example .clasp.json

# 2. เปิดไฟล์ .clasp.json แล้วแทนที่ YOUR_SCRIPT_ID_HERE ด้วย Script ID ของคุณ
#    หา Script ID ได้จาก Apps Script Editor → Project Settings → Script ID
#    (หรือ URL: https://script.google.com/home/projects/<SCRIPT_ID>/edit)

# 3. ทดสอบการเชื่อมต่อ + push โค้ดไป Apps Script
npx clasp status
npx clasp push

# 4. เปิด Apps Script Editor บนเบราว์เซอร์
npx clasp open
```

> **หมายเหตุ**: `.clasp.json` ถูกเพิ่มใน `.gitignore` แล้ว — จะไม่ถูก commit โดย accident
> ใช้ `.clasp.json.example` เป็น reference เท่านั้น

## 🔄 Workflow การพัฒนา

### 1. สร้าง Branch
```bash
# สร้าง branch จาก main
git checkout main
git pull origin main
git checkout -b feat/your-feature-name    # feature
git checkout -b fix/your-bug-fix          # bug fix
git checkout -b docs/your-doc-update      # documentation
```

### 2. เขียนโค้ด
- ทำตาม 16 Immutable Laws
- ใช้ `const`/`let` ไม่ใช้ `var`
- ไม่มี nested ternary (ใช้ if/else หรือ helper function)
- Cognitive Complexity ≤ 15 ต่อฟังก์ชัน

### 3. ตรวจสอบ
```bash
# Lint (ถ้าติดตั้ง npm dependencies)
npm run lint

# Format
npm run format
```

### 4. Commit
ใช้ [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: เพิ่มฟีเจอร์ใหม่
fix: แก้บั๊ก
docs: อัปเดตเอกสาร
refactor: ปรับโครงสร้างโค้ด
chore: งานบำรุงรักษา
```

### 5. สร้าง Pull Request
```bash
git push origin your-branch-name
```
แล้วสร้าง PR บน GitHub โดยใช้ PR template ที่มีอยู่

### 6. Review + Merge
- ต้องมี 1 approval (จาก CODEOWNERS)
- CI/CD ต้องผ่าน
- ใช้ Squash merge

## 📁 โครงสร้างโปรเจกต์

```
src/
├── O_core_system/          # Core: Config, Schema, App, Utils, Hardening
├── 1_group1_master_db/     # Master DB: Person, Place, Geo, Destination, Alias, Match
├── 2_group2_daily_ops/     # Daily Ops: Source, Transaction, Review, Report, Search, SCG
├── 3_group3_webapp/        # Web App: Dashboard frontend (HTML/CSS/JS)
└── 4_group4_pipeline_mgr/  # Pipeline Manager: Auto-run + Quota tracking
```

## 🧪 การทดสอบ

- ทดสอบใน Apps Script Editor ด้วยข้อมูลจริง
- ตรวจ `SYS_LOG` sheet หลังรัน — ไม่ควรมี error
- ทดสอบ WebApp โดยเปิด URL และคลิกทุกหน้า

## 📝 Code Style

- **Language**: Google Apps Script (JavaScript ES6+)
- **Naming**: `camelCase` สำหรับฟังก์ชัน/ตัวแปร, `UPPER_SNAKE_CASE` สำหรับ constants
- **Private functions**: เติม `_` ต่อท้ายชื่อ (เช่น `helperFunction_`)
- **Comments**: ใช้ JSDoc สำหรับฟังก์ชันสาธารณะ
- **Language**: คอมเมนต์เป็นภาษาไทยหรืออังกฤษก็ได้

## ❓ คำถาม?

- สร้าง [GitHub Issue](https://github.com/Siriwat08/phaopanya-scg/issues)
- อ่านเอกสารเพิ่มเติมใน `docs/`
