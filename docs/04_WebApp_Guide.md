# 📖 คู่มือ LMDS Dashboard Web App (Phase 1)

> **เอกสารประกอบ LMDS V5.5.034**
> คู่มือติดตั้งและใช้งาน Web App สำหรับดูข้อมูล LMDS แบบ real-time

---

## 📋 ภาพรวม

LMDS Dashboard Web App เป็นหน้าเว็บที่ทำงานบน Google Apps Script (HtmlService) สำหรับให้ผู้ใช้ดูข้อมูลใน Google Sheet แบบ real-time โดยไม่ต้องเปิด Sheet ตรงๆ

**คุณสมบัติ Phase 1:**
- ✅ Dashboard หน้าเดียวแสดง 6 สถิติหลัก
- ✅ อัปเดตอัตโนมัติทุก 60 วินาที (polling)
- ✅ แสดงสัดส่วนสถานะการจับคู่ (Match Status Breakdown)
- ✅ แสดง Top 5 ปัญหาที่พบบ่อยใน Q_REVIEW
- ✅ Auth ผ่าน Google Account + whitelist แยก (DASHBOARD_USERS)
- ✅ Session timeout 30 นาที (auto-logout)
- ✅ Toast notifications + loading/error states
- ✅ Responsive design (desktop/tablet/mobile)

---

## 🚀 วิธี Deploy (สำหรับผู้ดูแลระบบ)

### ขั้นตอนที่ 1: ตรวจสอบไฟล์ในโปรเจกต์

ตรวจว่าโปรเจกต์ Apps Script มีไฟล์ต่อไปนี้ครบ:

**โฟลเดอร์ `src/O_core_system/`:**
- `22_WebApp.gs` — Server-side functions (doGet, getDashboardData, etc.)

**โฟลเดอร์ `src/3_group3_webapp/`:**
- `Index.html` — HTML shell (main page)
- `views/Dashboard.html` — Dashboard view template
- `views/Unauthorized.html` — หน้า "ไม่มีสิทธิ์"
- `css/Styles.html` — Custom CSS
- `js/Api.html` — google.script.run wrapper (Promise-based)
- `js/Auth.html` — Session management
- `js/App.html` — Main app logic (router + polling)
- `js/components/StatCard.html` — StatCard component
- `js/components/DataTable.html` — DataTable component (Phase 2)
- `js/components/ChartCard.html` — ChartCard component (Phase 3)

> ⚠️ **สำคัญ:** ใน Apps Script Editor, ไฟล์ทั้งหมดต้องอยู่ในระดับ root (ไม่มีโฟลเดอร์) — หากใช้ clasp ให้ sync จากโฟลเดอร์ src/

### ขั้นตอนที่ 2: ตั้งค่า Auth Whitelist

ใน Apps Script Editor ไปที่ **Project Settings → Script Properties** แล้วเพิ่ม:

| Property | Value | คำอธิบาย |
|----------|-------|---------|
| `DASHBOARD_USERS` | `user1@gmail.com,user2@gmail.com,...` | รายชื่อ email ที่เข้า Dashboard ได้ (คั่นด้วยจุลภาค) |

> 💡 ถ้าไม่ตั้ง `DASHBOARD_USERS` → ระบบจะ fallback ไปใช้ `LMDS_ADMINS` ที่มีอยู่แล้ว
> ถ้าทั้งสองค่าไม่ได้ตั้ง → มีเฉพาะ Script Owner ที่เข้าได้

### ขั้นตอนที่ 3: Deploy เป็น Web App

1. ใน Apps Script Editor ไปที่ **Deploy → New deployment**
2. คลิก **Select type → Web app**
3. ตั้งค่า:
   - **Description:** `LMDS Dashboard V5.5.034`
   - **Execute as:** `Me (your-email@gmail.com)`
   - **Who has access:** `Anyone with Google Account`
4. คลิก **Deploy**
5. คัดลอก URL: `https://script.google.com/macros/s/.../exec`
6. คลิก **Authorize access** แล้วอนุญาต scopes ที่ระบบขอ

### ขั้นตอนที่ 4: แจกจ่าย URL ให้ผู้ใช้

ส่ง URL ให้ผู้ใช้ในรายชื่อ `DASHBOARD_USERS` — พวกเขาจะ:
1. เปิด URL ในเบราว์เซอร์
2. Google ขอให้ login (ถ้ายังไม่ได้ login)
3. ระบบตรวจ auth → แสดง Dashboard หรือหน้า "ไม่มีสิทธิ์"

---

## 📊 การใช้งาน Dashboard

### หน้า Dashboard หลัก

แสดง 6 สถิติหลัก:

| การ์ด | ความหมาย |
|------|---------|
| **FACT_DELIVERY** | จำนวนระเบียนในชีต FACT_DELIVERY ทั้งหมด |
| **Q_REVIEW (รอตรวจ)** | จำนวนระเบียนใน Q_REVIEW ที่ status = PENDING |
| **Auto Match Rate** | % ของการจับคู่อัตโนมัติ (FULL_MATCH + GEO_ANCHOR + FUZZY_MATCH) |
| **การจัดส่งวันนี้** | จำนวนระเบียนที่ DELIVERY_DATE = วันนี้ |
| **Source Sheet (ดิบ)** | จำนวนแถวใน Source sheet (SCGนครหลวงJWDภูมิภาค) |
| **Source รอประมวลผล** | จำนวนแถวที่ SYNC_STATUS ≠ SUCCESS |

### ส่วนอื่นๆ ในหน้า

- **สัดส่วนสถานะการจับคู่** — bar chart แนวนอนแสดง % ของแต่ละ MATCH_STATUS
- **Top 5 ปัญหาที่พบบ่อย** — issue_type ที่พบบ่อยที่สุดใน Q_REVIEW (เฉพาะ PENDING)
- **⚠️ ชีตที่หายไป** — แสดงเตือนถ้ามี sheet ที่จำเป็นหายไป

### การอัปเดต

- ระบบอัปเดตอัตโนมัติทุก **60 วินาที**
- ดู countdown ได้ที่แถบบน "refresh in 47s"
- กดปุ่ม 🔄 ที่มุมขวาบนเพื่อ refresh ทันที
- เมื่อ tab ไม่ active (เปลี่ยน tab) → polling หยุดอัตโนมัติ และจะ refresh ทันทีเมื่อกลับมา

### การออกจากระบบ

- Session หมดอายุอัตโนมัติหลัง **30 นาที** ไม่ได้ใช้งาน
- เมื่อหมดอายุจะแสดง toast notification ให้รีโหลดหน้า

---

## 🔧 การแก้ไขปัญหา (Troubleshooting)

### ปัญหา: เปิด URL แล้วเจอหน้า "ไม่มีสิทธิ์เข้าถึง"

**สาเหตุ:** Email ของคุณไม่อยู่ในรายชื่อ `DASHBOARD_USERS` หรือ `LMDS_ADMINS`

**วิธีแก้:**
1. ติดต่อผู้ดูแลระบบ
2. ขอให้เพิ่ม email ใน Script Properties → `DASHBOARD_USERS`
3. รีโหลดหน้า

---

### ปัญหา: เปิด URL แล้วเจอหน้า "เกิดข้อผิดพลาด"

**สาเหตุ:** Server-side error (อาจเป็น sheet หาย, สิทธิ์ scope ไม่ครบ, ฯลฯ)

**วิธีแก้:**
1. ลองรีโหลดหน้า
2. ถ้ายังไม่ได้ → ติดต่อผู้ดูแลให้ดู Stackdriver Logs
   - Apps Script Editor → ⚡ Executions หรือ Logs
3. ตรวจว่ามีชีตที่จำเป็นครบ: FACT_DELIVERY, Q_REVIEW, SCGนครหลวงJWDภูมิภาค

---

### ปัญหา: ตัวเลขไม่อัปเดต

**สาเหตุ:** Polling หยุดทำงาน (อาจเป็นเพราะ tab ไม่ active หรือ session หมดอายุ)

**วิธีแก้:**
1. ตรวจ "Live indicator" ที่แถบบน — ถ้าเป็น "Paused" แสดงว่า polling หยุด
2. กดปุ่ม 🔄 เพื่อ refresh ทันที
3. ถ้ามี toast "Session หมดอายุ" → รีโหลดหน้า

---

### ปัญหา: หน้าโหลดช้ามาก (มากกว่า 5 วินาที)

**สาเหตุ:** ข้อมูลใน Sheet เยอะมาก (>10,000 แถว) — server ต้องอ่านทั้งหมด

**วิธีแก้:**
- Phase 2 จะมี pagination + caching เพื่อแก้ปัญหานี้
- ชั่วคราว: ลบข้อมูลเก่าใน FACT_DELIVERY ที่ไม่จำเป็นออก

---

## 🏗️ สถาปัตยกรรม

```
┌─────────────────────────────────────────────────────┐
│  Browser (ผู้ใช้)                                    │
│  └── https://script.google.com/macros/s/.../exec    │
└─────────────────────────────────────────────────────┘
                      ↕
                      │  HTTPS (HtmlService)
                      │
┌─────────────────────────────────────────────────────┐
│  Google Apps Script Web App                         │
│  ├── 22_WebApp.gs (server-side)                     │
│  │   ├── doGet() → return Index.html (SSR)          │
│  │   ├── getDashboardData() → JSON                  │
│  │   ├── isAuthorizedDashboardUser_()               │
│  │   └── ping() (health check)                      │
│  └── Index.html (frontend)                          │
│      ├── Tailwind CSS (CDN)                         │
│      ├── Chart.js (CDN)                             │
│      ├── Lucide Icons (CDN)                         │
│      ├── Inter Font (Google Fonts)                  │
│      ├── js/Api.html (google.script.run wrapper)    │
│      ├── js/Auth.html (session management)          │
│      ├── js/App.html (router + polling 60s)         │
│      └── js/components/ (StatCard, DataTable, etc.) │
└─────────────────────────────────────────────────────┘
                      ↕
                      │  SpreadsheetApp.getActiveSpreadsheet()
                      │
┌─────────────────────────────────────────────────────┐
│  Google Sheet (LMDS V5.5)                           │
│  ├── FACT_DELIVERY (34 cols)                        │
│  ├── Q_REVIEW (22 cols)                             │
│  └── SCGนครหลวงJWDภูมิภาค (39 cols)                │
└─────────────────────────────────────────────────────┘
```

---

## 🔐 Security Model

| Layer | Mechanism |
|-------|-----------|
| **Transport** | HTTPS (Google default) |
| **Authentication** | Google Account (OAuth 2.0) |
| **Authorization** | `DASHBOARD_USERS` whitelist (Script Properties) |
| **Defense-in-depth** | Server-side auth check ในทุก function (`isAuthorizedDashboardUser_()`) |
| **PII Protection** | Email masking ใน logs (`maskEmailSafe_`) |
| **Session Timeout** | 30 นาที (frontend-side, defense-in-depth) |
| **XSS Protection** | HtmlService sandbox mode (CSP enforced) |

---

## 📈 ข้อจำกัด Phase 1

- ❌ ยังไม่มี pagination — อ่าน Sheet ทั้งหมดทุกครั้ง (เหมาะสำหรับ <5,000 แถว)
- ❌ ยังไม่มี filter/search (Phase 2)
- ❌ ยังไม่มี charts (Phase 3)
- ❌ ยังไม่มีหน้า FACT_DELIVERY / Q_REVIEW / Source Sheet / Match Engine / Search (Phase 2-3)
- ❌ ไม่รองรับ real-time push (ต้องรอ polling 60 วิ)

---

## 🗺️ Roadmap ต่อ

| Phase | สิ่งที่จะได้ | ระยะเวลา |
|-------|------------|---------|
| **Phase 2** | หน้า FACT_DELIVERY, Q_REVIEW, Source Sheet พร้อม filter + pagination + search | 4-5 วัน |
| **Phase 3** | หน้า Match Engine Metrics พร้อม charts + หน้า Search ข้ามชีต | 3-4 วัน |
| **Phase 4** | Polish + responsive + dark mode + production deployment | 2-3 วัน |

---

## 📞 ติดต่อ

- **ปัญหาการใช้งาน:** ติดต่อผู้ดูแลระบบ LMDS
- **Bug report:** สร้าง issue ที่ [GitHub Repository](https://github.com/Siriwat08/phaopanya-scg)
- **เอกสารเพิ่มเติม:** ดูในโฟลเดอร์ `docs/`

---

*เอกสารนี้เป็นส่วนหนึ่งของชุดเอกสาร LMDS V5.5.034 — Phase 1 Web App*
