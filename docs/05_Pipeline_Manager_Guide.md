# ⚡ Pipeline Manager — คู่มือใช้งาน (Standalone Module)

> **เอกสารประกอบ LMDS V5.5.034**
> โมดูลจัดการการรัน `runMatchEngine()` สำหรับข้อมูลหลักหมื่นแถว
> **ไม่ปนกับชุดหลัก** — อยู่ในไฟล์ `src/4_group4_pipeline_mgr/24_PipelineManager.gs` เพียงไฟล์เดียว

---

## 📋 ภาพรวม

Pipeline Manager เป็นโมดูลแยกที่ทำหน้าที่ wrapper ครอบ `runMatchEngine()` เพื่อ:

1. **รันอัตโนมัติ** — ทุก 1 ชม ตั้งแต่ 08:00-22:00 (15 รอบ/วัน)
2. **หยุดเองถ้าเกินลิมิต** — quota 75 นาที/วัน (เหลือ buffer 15 นาที)
3. **รันให้เองเมื่อสิทธิ์เปิด** — รีเซ็ต quota 00:05 น. ทุกวัน → รันต่ออัตโนมัติ
4. **ไม่ error ซ้ำ** — Circuit Breaker หยุดถ้า error ติด 3 ครั้ง

### ทำไมต้องแยกเป็น module ใหม่?

- **ไม่กระทบโค้ดเดิม** — ไม่ต้องกลัว "ไม่ผ่านแล้วแก้ไขกันยาว"
- **Test แยก** — สามารถลบไฟล์นี้ทิ้งได้ทุกเมื่อ โดยระบบหลักยังทำงานปกติ
- **Standalone** — copy ไฟล์เดียวไป Apps Script ใช้ได้เลย

---

## 📊 ข้อจำกัดและการออกแบบ

### Google Apps Script Free Tier Limits

| ทรัพยากร | Limit | ที่ใช้ | เหลือ |
|---------|------|------|------|
| Runtime per day | 90 นาที | 75 นาที | 15 นาที buffer |
| Runtime per run | 6 นาที (hard) | 4 นาที | 2 นาที buffer |
| Trigger calls | 90 นาที total | 15 ครั้ง × 4 นาที | - |

### การคำนวณ throughput

```
รอบละ 4 นาที × ~200 rows/min = ~800 rows/รอบ
15 รอบ/วัน × 800 rows = 12,000 rows/วัน

→ ข้อมูล 15,000 แถว: ~1.25 วัน (ประมาณ 2 วันทำการ)
→ ข้อมูล 18,000 แถว: ~1.5 วัน (ประมาณ 2 วันทำการ)
```

> 💡 ถ้าต้องการเร็วขึ้น ลด `BATCH_RUN_INTERVAL_HOURS` เป็น 0.5 (ทุก 30 นาที) — แต่ระวัง quota

---

## 🚀 วิธีติดตั้ง

### ขั้นตอนที่ 1: อัปโหลดไฟล์ไป Apps Script

copy ไฟล์ `src/4_group4_pipeline_mgr/24_PipelineManager.gs` ไป Apps Script Editor (1 ไฟล์เดียว)

### ขั้นตอนที่ 2: ติดตั้ง triggers (ครั้งเดียว)

ใน Apps Script Editor ไปที่ **Run** → เลือก function `installPipelineTriggers` → กด Run

หรือรันใน console:
```javascript
installPipelineTriggers();
```

ผลที่ได้:
- ✅ Trigger `runPipelineBatch` รันทุก 1 ชม ตั้งแต่ 08:00-22:00 (15 รอบ)
- ✅ Trigger `resetDailyQuotaJob` รันทุกวัน 00:05 น.

### ขั้นตอนที่ 3: เริ่ม pipeline

```javascript
startPipeline();
```

ผล:
- รีเซ็ต state + checkpoint + quota
- รัน batch แรกทันที
- รอบถัดไปจะรันอัตโนมัติตาม trigger

---

## 🎛️ ฟังก์ชันที่ใช้บ่อย (Admin Actions)

| Function | หน้าที่ | เรียกเมื่อไหร่ |
|----------|--------|--------------|
| `startPipeline()` | เริ่ม pipeline ใหม่ | ครั้งแรก / หลัง reset |
| `pausePipeline()` | หยุดชั่วคราว | ต้องการหยุดรับ batch ใหม่ |
| `resumePipeline()` | ทำต่อ | หลัง pause / หลัง reset circuit breaker |
| `resetPipeline()` | รีเซ็ตทั้งหมด | เริ่มใหม่จากศูนย์ |
| `showPipelineStatus()` | ดูสถานะ | ตรวจสอบยอด quota / errors |
| `resetCircuitBreakerMenu()` | รีเซ็ต circuit breaker | หลังแก้ปัญหาที่ทำให้ error ซ้ำ |
| `uninstallPipelineTriggers()` | ลบ triggers | หยุดใช้ Pipeline Manager |

---

## 📊 สถานะ Pipeline (Pipeline States)

| State | ความหมาย | รอบถัดไปทำอะไร |
|-------|---------|---------------|
| `IDLE` | ยังไม่เริ่ม | รอ trigger หรือ `startPipeline()` |
| `RUNNING` | กำลังรัน | รอบถัดไปรันต่อ |
| `PAUSED_QUOTA` | quota เต็ม | รอ 00:05 น. → auto reset → `RUNNING` |
| `PAUSED_ERRORS` | error ซ้ำ 3 ครั้ง | รอ admin → `resetCircuitBreakerMenu()` → `resumePipeline()` |
| `PAUSED_MANUAL` | admin หยุด | รอ admin → `resumePipeline()` |
| `COMPLETED` | เสร็จหมด | รอข้อมูลใหม่เข้ามา → `startPipeline()` ใหม่ |

---

## 🔧 Configuration (ปรับแต่ง)

แก้ในส่วน `PIPELINE_CONFIG` ในไฟล์ `24_PipelineManager.gs`:

```javascript
const PIPELINE_CONFIG = Object.freeze({
  // === Quota Limits ===
  MAX_RUNTIME_MS_PER_DAY:   75 * 60 * 1000,   // 75 นาที (Free tier 90 - 15 buffer)
  MAX_RUNTIME_MS_PER_RUN:   4 * 60 * 1000,    // 4 นาที (hard limit 6 - 2 buffer)
  MAX_RUNS_PER_DAY:         15,                // 15 รอบ/วัน

  // === Circuit Breaker ===
  MAX_CONSECUTIVE_ERRORS:   3,                 // error 3 ครั้งติด → pause
  ERROR_COOLDOWN_MS:        60 * 60 * 1000,    // 1 ชม

  // === Trigger Schedule ===
  BATCH_RUN_INTERVAL_HOURS: 1,                 // ทุก 1 ชม
  BATCH_RUN_START_HOUR:     8,                 // 08:00 น.
  BATCH_RUN_END_HOUR:       22,                // 22:00 น.

  // === Behavior ===
  CLEAN_MATCH_ENGINE_TRIGGERS: true,           // ลบ MatchEngine auto-resume triggers
  LOG_TO_SYS_LOG:               true,          // log ไป SYS_LOG
});
```

### สูตรปรับแต่ง

| ต้องการ | แก้ค่า |
|--------|------|
| รันเร็วขึ้น | `BATCH_RUN_INTERVAL_HOURS: 0.5` (ทุก 30 นาที) |
| รอบละนานขึ้น | `MAX_RUNTIME_MS_PER_RUN: 5 * 60 * 1000` (5 นาที) |
| Workspace Business (6 ชม/วัน) | `MAX_RUNTIME_MS_PER_DAY: 5 * 60 * 60 * 1000` (5 ชม) |
| รอบน้อยลง (กลัวเกิน) | `MAX_RUNS_PER_DAY: 10` + `BATCH_RUN_END_HOUR: 18` |
| ปิด circuit breaker | `MAX_CONSECUTIVE_ERRORS: 999` |

---

## 📋 Flow การทำงานแบบละเอียด

### สถานการณ์ปกติ: ข้อมูล 16,000 แถว

```
วันที่ 1 (06:00 น.) — quota = 0
─────────────────────────────────
[08:15] Trigger runPipelineBatch()
        ├── state=IDLE → ตั้งเป็น RUNNING
        ├── quota check: 0/75 นาที → OK
        ├── circuit breaker: 0 errors → OK
        ├── ลบ MatchEngine auto-resume triggers (ถ้ามี)
        ├── เรียก runMatchEngine() — รัน 4 นาที ประมวลผล ~800 แถว
        ├── บันทึก quota: 4 นาที, 1 run
        ├── บันทึก checkpoint: runCount=1, totalRuntime=4m
        └── state=RUNNING (ยังมีงานเหลือ)

[09:15] Trigger → runMatchEngine() อีก 4 นาที → ~1,600 แถวสะสม
[10:15] ... 4 นาที → ~2,400 แถว
...
[22:15] Trigger → runMatchEngine() อีก 4 นาที → ~12,000 แถวสะสม
        quota ใช้ไป: 60 นาที / 75 นาที

วันที่ 2 (00:05 น.)
─────────────────
[00:05] Trigger resetDailyQuotaJob()
        ├── รีเซ็ต quota: 0 นาที, 0 runs
        └── state ยังเป็น RUNNING

[08:15] Trigger runPipelineBatch()
        ├── quota check: 0/75 → OK
        ├── เรียก runMatchEngine() — ~12,800 แถวสะสม
        ...
[12:15] ประมวลผลครบ 16,000 แถว
        ├── checkHasMoreWork_() → false (no pending rows)
        ├── state=COMPLETED
        └── ล้าง checkpoint
```

### สถานการณ์ Error ซ้ำ: Sheet หาย

```
[10:15] Trigger runPipelineBatch()
        ├── runMatchEngine() throws "Sheet not found"
        ├── recordBatchError_("Sheet not found") → errors=1/3
        └── state=RUNNING (ยังไม่ pause)

[11:15] Trigger → error อีก → errors=2/3 → state=RUNNING
[12:15] Trigger → error อีก → errors=3/3 → CIRCUIT BREAKER TRIPPED
        ├── state=PAUSED_ERRORS
        ├── ลบ MatchEngine auto-resume triggers
        └── รอ admin

[14:00] Admin แก้ Sheet กลับมา
        ├── resetCircuitBreakerMenu() → errors=0
        └── resumePipeline() → รัน batch ทันที
```

---

## 🛡️ การป้องกันปัญหา

### 1. กัน run ซ้อน (Lock Service)

```javascript
const lock = LockService.getScriptLock();
const lockAcquired = lock.tryLock(30000); // รอ 30 วิ
if (lockAcquired === false) {
  // มี batch อื่นรันอยู่ → skip รอบนี้
  return { action: 'SKIP', reason: 'LOCK_BUSY' };
}
```

### 2. กัน MatchEngine auto-resume trigger ซ้อน

`runMatchEngine()` มี auto-resume trigger ของตัวเอง — Pipeline Manager จะลบทิ้งทุกรอบหลังรันเสร็จ:

```javascript
removeMatchEngineAutoResumeTriggers_(); // ลบก่อน + หลังรัน
```

### 3. กัน quota บวกเกิน

```javascript
// ก่อนรันทุก batch
const quotaCheck = isQuotaAvailable_();
if (quotaCheck.available === false) {
  setPipelineState_(PIPELINE_STATES.PAUSED_QUOTA, quotaCheck.reason);
  return;
}
```

### 4. กัน error ลูป

```javascript
const tripped = recordBatchError_(errorMsg);
if (tripped) {
  setPipelineState_(PIPELINE_STATES.PAUSED_ERRORS, 'Circuit breaker tripped');
  return;
}
```

---

## 🔍 การ Debug

### ดู log

ใน Apps Script Editor → **⚡ Executions** หรือ **Logs**

หรือรัน:
```javascript
showPipelineStatus();  // แสดงสถานะปัจจุบันใน console
```

### ดู Script Properties

```javascript
const props = PropertiesService.getScriptProperties().getProperties();
console.log(JSON.stringify({
  STATE: props.PIPELINE_STATE,
  CHECKPOINT: props.PIPELINE_CHECKPOINT,
  QUOTA: props.PIPELINE_DAILY_QUOTA,
  CIRCUIT: props.PIPELINE_CIRCUIT_BREAKER,
  HISTORY: props.PIPELINE_HISTORY,
}, null, 2));
```

### ดู triggers

```javascript
const triggers = ScriptApp.getProjectTriggers();
triggers.forEach(t => console.log(t.getHandlerFunction(), t.getTriggerSource(),
  t.getEventType(), t.getUniqueId()));
```

---

## ❓ คำถามที่พบบ่อย

### Q: ถ้าหยุด Apps Script กลางคัน จะเกิดอะไรขึ้น?
**A:** Pipeline Manager บันทึก checkpoint ทุก batch — รอบถัดไปจะรันต่อจากที่หยุดอัตโนมัติ (ข้อมูลที่ประมวลผลแล้วจะมี SYNC_STATUS=SUCCESS อยู่แล้ว)

### Q: ถ้ารันซ้อนกัน (trigger ทำงานพร้อมกัน) จะเกิดอะไรขึ้น?
**A:** LockService ป้องกัน — batch ที่มาทีหลังจะ skip ถ้า acquire lock ไม่ได้ภายใน 30 วิ

### Q: ถ้าอยากหยุดใช้ Pipeline Manager ถาวร?
**A:**
```javascript
uninstallPipelineTriggers();  // ลบ triggers
pausePipeline();              // ตั้ง state เป็น PAUSED_MANUAL
```
แล้วจะไม่มี batch รันอีก — สามารถใช้ `runMatchEngine()` แบบ manual ได้ตามปกติ

### Q: ถ้าเปลี่ยนจาก Free เป็น Workspace Business?
**A:** แก้ `MAX_RUNTIME_MS_PER_DAY` เป็น `5 * 60 * 60 * 1000` (5 ชม — เหลือ 1 ชม buffer) — pipeline จะรันเร็วขึ้นมาก

### Q: จะรู้ได้ยังไงว่า pipeline เสร็จแล้ว?
**A:** state = `COMPLETED` — ดูได้จาก:
```javascript
getPipelineState_().state;  // คืน 'COMPLETED'
```

### Q: จะรู้ได้ยังไงว่า error ซ้ำ?
**A:** state = `PAUSED_ERRORS` + circuit breaker `pausedAt !== null`:
```javascript
const cb = getCircuitBreaker_();
console.log('Tripped:', cb.pausedAt !== null);
console.log('Last error:', cb.lastError);
```

---

## 📦 ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
|------|--------|
| `src/4_group4_pipeline_mgr/24_PipelineManager.gs` | โค้ด Pipeline Manager (1,124 บรรทัด) |
| `docs/05_Pipeline_Manager_Guide.md` | คู่มือนี้ |

**ไม่กระทบไฟล์อื่นใน repo** — Pipeline Manager เป็น standalone module ที่เรียกใช้ `runMatchEngine()` แบบ wrapper

---

*เอกสารนี้เป็นส่วนหนึ่งของชุดเอกสาร LMDS V5.5.034 — Pipeline Manager Module*
