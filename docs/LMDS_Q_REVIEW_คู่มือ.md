# อธิบายชีต Q_REVIEW (22 คอลัมน์) — คิวรอคนตรวจสอบ

> **เอกสารประกอบ LMDS V5.5.034 (DOC-CODE SYNC, 2026-07-03)**
> อธิบายโครงสร้างและวิธีใช้งานชีต Q_REVIEW สำหรับคนตรวจสอบข้อมูล
> เกี่ยวข้องกับ: `02_Schema.gs`, `12_ReviewService.gs`, `10_MatchEngine.gs`, `00_App.gs`

---

## ภาพรวม (แบบเด็ก 5 ขวบ)

**Q_REVIEW = กล่องรับรองข้อมูลที่ "สับสน" ไม่ออก** ก่อนจะให้คนตรวจสอบดู

ลองจินตนาการว่า ระบบ LMDS เป็นเหมือน **สายพานผู้ส่ง** ที่รับข้อมูลมาแล้ว จะเอาชื่อจากสมุดที่อยู่ในสมุดไป (Master Data) มาเทียบกับชื่อในรายการใหม่ ถ้าตรง → ผ่าน ถ้าไม่ตรง → ต้องมีคนมาช่วยดู ก่อน

**ข้อมูลที่ "สับสน" ทั้งหมดจะถูกส่งมาเก็บใน Q_REVIEW รอคนตรวจ**

ชีต Q_REVIEW ทำหน้าที่เป็น "คิวกลาง" ที่ข้อมูลที่ระบบ Match Engine ตัดสินใจไม่ได้ (หรือไม่มั่นใจ) จะถูกส่งมารวมที่นี่ คนตรวจสอบเปิดดูแถวที่รออยู่ ตัดสินใจว่าจะ "อนุมัติ" / "ปฏิเสธ" / "สร้างใหม่" ผ่าน Dropdown แล้วกดปุ่มประมวลผล ระบบจะอ่านการตัดสินใจและอัปเดต Master Data + FACT_DELIVERY ให้ทันที ทำให้รอบการทำงานถัดไประบบเรียนรู้จากการตัดสินใจของคน (Human-in-the-loop Learning)

---

## 22 คอลัมน์ เจาะลึกทุกคอลัมน์

จากโค้ด `02_Schema.gs` (Q_REVIEW_HEADERS) และ `01_Config.gs` (REVIEW_IDX):

| Index | คอลัมน์ | ชื่อ Header | อธิบายแบบเด็ก 5 ขวบ | ที่มาจากโค้ด |
|:---:|:---:|---|---|---|
| 0 | **A** | `review_id` | เลขบอกกันว่าเป็นแถวที่เท่าไหร่ในคิว (RV + 12 hex) | Auto ใน `addToQReview()` |
| 1 | **B** | `issue_type` | ประเภทปัญหาที่ทำให้เข้าคิว (เช่น `INVALID_LATLNG`, `GEO_PROVINCE_CONFLICT`, `NAME_TOO_SHORT`, `FUZZY_AMBIGUOUS`, `GEO_NEARBY_YELLOW`, `NO_MATCH_NEW_ENTITY`) | คำนวณใน `10_MatchEngine.gs` |
| 2 | **C** | `priority` | ลำดับความสำคัญ: HIGH / MEDIUM / LOW — คำนวณจาก severity ของ issue_type | คำนวณใน `addToQReview()` |
| 3 | **D** | `source_record_id` | ID ระเบียนต้นทาง — ใช้สำหรับอ้างอิงกลับไปยัง Source sheet | จาก Source [1] |
| 4 | **E** | `source_row` | แถวในชีตต้นทางที่ข้อมูลนี้มาจาก | จาก Source sheet row number |
| 5 | **F** | `invoice_no` | รหัส Invoice ของแถวนี้ — ใช้สำหรับอ้างอิงกลับไปยัง Source | จาก Source [8] |
| 6 | **G** | `raw_person_name` | ชื่อบริษัท/บุคคลจากไฟล์ต้นทางที่เข้ามา เช่น "บริษัท สมชาย ขนส่ง" | จาก `rawName` ที่ยังไม่ Normalize |
| 7 | **H** | `raw_place_name` | ชื่อสถานที่/ที่อยู่จากไฟล์ต้นทาง เช่น "123/45 ม.6 ต.ปลากลอย" | จาก `rawAddress` ที่ยังไม่ Normalize |
| 8 | **I** | `raw_system_address` | ที่อยู่ที่ระบบ resolve ได้จาก LatLong | จาก `lookupResult.thName` |
| 9 | **J** | `raw_lat` | ละติจูดดิบจาก Source | จาก Source [14] |
| 10 | **K** | `raw_lng` | ลองจิจูดดิบจาก Source | จาก Source [15] |
| 11 | **L** | `candidate_person_ids` | **ถ้าระบบหาบุคคลที่ตรงกันแล้ว จะแสดง ID ที่นี่** เช่น "P_0042, P_0043" ถ้ายังไม่เจอ → ว่างเปล่า | จาก match `Person_ID` จาก M_PERSON |
| 12 | **M** | `candidate_place_ids` | **ถ้าหาสาขาที่ตรงกันแล้ว จะแสดง ID** เช่น "PL_0088" | จาก match `Place_ID` จาก M_PLACE |
| 13 | **N** | `candidate_geo_ids` | **ถ้าหาพื้นที่/จุด GPS ที่ตรงกันแล้วจะแสดง ID** เช่น "G_0015" | จาก match `Geo_ID` จาก M_GEO |
| 14 | **O** | `candidate_destination_ids` | **ถ้าระบบหา "จุดหมายปลายทาง" (Person + Place + Geo รวมกัน) ที่ตรงกันแล้วจะแสดง ID** เช่น "D_0123" | จาก match `Destination_ID` จาก M_DESTINATION |
| 15 | **P** | `match_score` | คะแนนความมั่นใจ 0-100 — ถ้า 100 = ตรงทุกอย่าง, ถ้าต่ำ = ระบบไม่แน่ใจ ต้องให้คนดู | `matchScore` จาก MatchEngine |
| 16 | **Q** | `recommended_action` | **คอลัมน์สำคัญ!** คำแนะนำของระบบ: CREATE_NEW / MERGE / ESCALATE / IGNORE — คลิกที่ cell แล้วระบบนำทางให้ [V5.5.011] | `recommended_action` จาก MatchEngine |
| 17 | **R** | `status` | สถานะของแถว: **PENDING** (รอตรวจ), **IN_REVIEW** (กำลังตรวจ), **DONE** (เสร็จ), **ESCALATED** (ส่งต่อ) | `status` เริ่มต้นที่ "PENDING" |
| 18 | **S** | `reviewer` | อีเมลผู้ตรวจที่ตรวจแถวนี้ — ระบบกรอกอัตโนมัติ (masked ตาม SEC-007) | จาก `Session.getActiveUser()` |
| 19 | **T** | `reviewed_at` | วันเวลาที่ตรวจสอบเสร็จ | ตอนเรียก `applyReviewDecision()` |
| 20 | **U** | `decision` | **คอลัมน์สำหรับคนกรอกข้อมูล!** Dropdown: APPROVED / REJECTED / CREATE_NEW / SKIP | ใช้ Data Validation Dropdown |
| 21 | **V** | `note` | คนตรวจสอบเขียนหมายเหตุได้ เช่น "ตรงกับ P_0042 แล้ว" หรือ "ชื่อนี้ผิด ต้องแก้เป็น..." | **คอลัมน์สำหรับคนกรอกข้อมูล!** |

> **Note**: ตารางข้างต้นเป็น 22 คอลัมน์ตาม `REVIEW_IDX` ใน `01_Config.gs` (Object.freeze) — ตรงกับ `Q_REVIEW_HEADERS` ใน `02_Schema.gs` 100%

---

## ขั้นตอนการกดใช้งานระบบ Q_REVIEW (แบบเด็ก 5 ขวบ)

### ขั้นที่ 1: ข้อมูลเข้า Q_REVIEW มาจากไหน?

มี 2 ทางหลัก:

**ทางที่ 1: จากชีต "SCGนครหลวงJWDภูมิภาค"**
1. เปิดชีต "SCGนครหลวงJWDภูมิภาค"
2. กดเมนู → **LMDS V5.5** → **"ประมวลผล SCG → Master DB"** (เรียกฟังก์ชัน `processSCGData()`)
3. ระบบอ่านข้อมูลทีละแถว จากคอลัมน์ในชีต
4. ทีละแถว → ผ่าน `05_NormalizeService` (ทำความสะอาด) → ผ่าน `10_MatchEngine` (จับคู่กับ Master DB 8 กฎ)
5. ถ้าจับคู่ไม่ได้หรือไม่มั่นใจ → ข้อมูลแถวนั้นถูก **ส่งเข้า Q_REVIEW** พร้อมคะแนน Match Result และคะแนนความมั่นใจ

**ทางที่ 2: จากชีต "ตารางงานประจำวัน"**
1. เปิดชีต "ตารางงานประจำวัน"
2. กดเมนู → **LMDS V5.5** → **"โหลดข้อมูล → จับคู่อัตโนมัติ"** (เรียกฟังก์ชัน `autoMatchDaily()`)
3. ระบบอ่านข้อมูลทีละแถว → Normalize → Match → ถ้าไม่แน่ใจ → ส่งเข้า Q_REVIEW

### ขั้นที่ 2: เปิดชีต Q_REVIEW ดู
1. คลิกที่แท็บชื่อ **"Q_REVIEW"** ด้านล่างของ Spreadsheet
2. จะเห็นแถวที่รออยู่พร้อมข้อมูล 22 คอลัมน์ทุกแถว

### ขั้นที่ 3: อ่านข้อมูลใน Q_REVIEW (วิธีดู)

ดูทีละแถวเป็น "สลัก" ครับ:

1. **ดูคอลัมน์ B (issue_type)** ก่อน — บอกทันทีว่าทำไมข้อมูลนี้ถึงเข้าคิว
2. **ดูคอลัมน์ P (match_score)** — ยิ่งสูงยิ่งดี (ใกล้ 100 = ระบบมั่นใจ)
3. **ดูคอลัมน์ L (candidate_person_ids)** — ระบบหาบุคคลที่ตรงกันหรือยัง ถ้ามี ID แสดงว่าเจอแล้ว
4. **ดูคอลัมน์ M (candidate_place_ids)** — ระบบหาสถานที่ที่ตรงกันหรือยัง
5. **ดูคอลัมน์ N (candidate_geo_ids)** — ระบบหาพิกัดที่ตรงกันหรือยัง
6. **ดูคอลัมน์ Q (recommended_action)** — คำแนะนำของระบบว่าควรทำอะไร (CREATE_NEW / MERGE / ESCALATE / IGNORE)
7. **ดูคอลัมน์ G, H (raw_person_name, raw_place_name)** — ข้อมูลดิบจาก Source เทียบกับ candidate ที่ระบบหามาได้
8. **ดูคอลัมน์ I (raw_system_address)** — ที่อยู่ที่ระบบ resolve จาก LatLong อาจชี้จังหวัดที่ไม่ตรงกับที่อยู่ที่กรอก → ดู issue_type `GEO_PROVINCE_CONFLICT`

### ขั้นที่ 4: ตัดสินใจ (กรอกคอลัมน์ V + เลือกคอลัมน์ U)

**สำคัญมาก!** คอลัมน์ U (decision) คือที่คนตรวจต้องเลือก และคอลัมน์ V (note) คือที่ให้เขียนหมายเหตุ:

- ถ้าเห็นว่าข้อมูลถูกจับคู่ถูกต้อง → เลือก **APPROVED** ในคอลัมน์ U และพิมพ์ "ตรงกับ P_0042 แล้ว" ในคอลัมน์ V
- ถ้าเห็นว่า **ผิด** → เลือก **REJECTED** ในคอลัมน์ U และพิมพ์ว่าผิดตรงไหนในคอลัมน์ V
- ถ้าเห็นว่าเป็น **ข้อมูลใหม่** ที่ระบบยังไม่มีใน Master → เลือก **CREATE_NEW** ระบบจะสร้าง Person/Place ใหม่ให้
- ถ้าข้อมูลไม่สมบูรณ์ เช่นขาดชื่อบริษัท → เลือก **SKIP**

> 💡 **Tip [V5.5.011]**: คอลัมน์ Q (recommended_action) สามารถคลิกได้ — ระบบจะนำทางไปยังแถวที่เกี่ยวข้องใน Master sheet อัตโนมัติ

### ขั้นที่ 5: กดปุ่ม "ประมวลผลรายการตรวจสอบ"

1. หลังจากเลือกทุกแถวเรียบร้อยแล้ว
2. กดเมนู → **LMDS V5.5** → **"ประมวลผลรายการตรวจสอบ"** (เรียกฟังก์ชัน `processReviewQueue()`)
3. ระบบจะอ่านทีละแถวใน Q_REVIEW:
   - ถ้าคอลัมน์ U = **APPROVED** → ระบบจะ:
     - สร้าง Destination Node (ถ้ายังไม่มี) หรือใช้ที่มีอยู่
     - เขียนข้อมูลลงในชีต FACT_DELIVERY
     - ลบแถวออกจาก Q_REVIEW (เคลียร์ออก)
   - ถ้าคอลัมน์ U = **CREATE_NEW** → ระบบจะสร้าง Person + Place + Geo ใหม่ใน Master DB แล้วสร้าง Destination และเขียน FACT_DELIVERY
   - ถ้าคอลัมน์ U = **REJECTED** หรือ **SKIP** → ข้ามแถวนั้น ลบออกจาก Q_REVIEW

> **Note**: `processReviewQueue()` มี Time Guard และ Checkpoint/Resume — ถ้า Q_REVIEW มีหลายร้อยแถว ระบบจะแบ่งประมวลผลเป็น batch และสร้าง trigger ทำต่ออัตโนมัติ ไม่ต้องกดซ้ำ (V5.5.018 REVIEW15 R2-01 split)

### ขั้นที่ 6: หลังประมวลผลแล้ว

- ข้อมูลที่ Approved จะไปอยู่ในชีต **FACT_DELIVERY** (รายการจัดส่ง)
- Master Data (M_PERSON, M_PLACE, M_GEO, M_DESTINATION) จะมีข้อมูลใหม่เพิ่มเข้ามา (ถ้ามี CREATE_NEW)
- Alias Tables (M_ALIAS, M_PERSON_ALIAS, M_PLACE_ALIAS) จะถูกอัปเดตให้
- Q_REVIEW จะ **ว่างเปล่า** หรือเหลือแถวที่ยังไม่ได้ตรวจ

---

## 🎯 issue_type ที่พบบ่อย

`issue_type` ในคอลัมน์ B บอกสาเหตุที่ข้อมูลเข้า Q_REVIEW:

| issue_type | ความหมาย | คำแนะนำ |
|---|---|---|
| `INVALID_LATLNG` | พิกัด GPS ไม่ถูกต้อง (เช่น 0,0 หรือ null) | ตรวจที่มาของพิกัด อาจเป็น GPS คนขับเสีย |
| `GEO_PROVINCE_CONFLICT` | พิกัดอยู่จังหวัดต่างจากที่อยู่ | อาจเป็นคนขับส่งผิดที่ หรือพิกัด Master ผิด |
| `NAME_TOO_SHORT` | ชื่อสั้นเกินไปหลัง Normalize (เช่น เหลือแค่ "ร้าน") | คนขับกรอกชื่อไม่ครบ ให้ SKIP หรือตามหาชื่อจริง |
| `FUZZY_AMBIGUOUS` | ชื่อคล้ายหลายร้านใน Master ระบบไม่แน่ใจว่าตัวไหน | ใช้ที่อยู่ + GPS ช่วยตัดสินใจ |
| `GEO_NEARBY_YELLOW` | พิกัดใกล้ 50-80m แต่ไม่ตรง | อาจเป็นจุดส่งจริงที่อยู่ใกล้คลัง ให้ APPROVED ถ้าดูสมเหตุสมผล |
| `GEO_NEARBY_ORANGE` | พิกัดใกล้ 80-100m แต่ไม่ตรง | ระวัง — อาจเป็นร้านอื่นที่อยู่ใกล้กัน |
| `NO_MATCH_NEW_ENTITY` | ไม่เจอเลย แต่มี GPS ที่ดี | CREATE_NEW ถ้าเป็นร้านใหม่จริง |

---

## 🔁 ผลกระทบต่อระบบ (Feedback Loop)

การตัดสินใจใน Q_REVIEW ไม่ใช่แค่ "เคลียร์คิว" แต่เป็นการ **สอนระบบ** ให้เรียนรู้:

```
คนตรวจเลือก CREATE_NEW
    ↓
ระบบสร้าง M_PERSON + M_ALIAS (ชื่อดิบ → normalized_key)
    ↓
ครั้งหน้าคนขับพิมพ์ชื่อมัวๆ เดียวกัน
    ↓
Tier 0 Fast Track (M_ALIAS) เจอ → เขียน FACT_DELIVERY อัตโนมัติ
    ↓
ไม่ต้องเข้า Q_REVIEW อีก
```

> **เป้าหมาย**: ทำไปเรื่อยๆ จน Q_REVIEW มีแถวรอน้อยลงเรื่อยๆ เพราะระบบเรียนรู้จากการตัดสินใจของคน

---

## สรุปสั้นสั้นแบบสั้น

```
ข้อมูลดิบเข้า → Normalize → Match Engine 8 กฎ
     ↓
[FULL_MATCH] → เขียน FACT_DELIVERY เลย (ไม่เข้า Q_REVIEW)
[จับคู่ได้แต่ไม่มั่นใจ] → เข้า Q_REVIEW
[จับคู่ไม่ได้] → เข้า Q_REVIEW (REVIEW / CREATE_NEW)
     ↓
คนตรวจดู Q_REVIEW → กรอกคอลัมน์ T และเลือกคอลัมน์ U
     ↓
กด "ประมวลผลรายการตรวจสอบ" → ระบบประมวลผล
     ↓
APPROVED → ไป FACT_DELIVERY + Master DB อัปเดต
CREATE_NEW → สร้าง Master ใหม่ + ไป FACT_DELIVERY
REJECTED / SKIP → ลบออก
```

---

## 🔗 ความเชื่อมโยงกับเอกสารอื่น

- **สายที่ 1** (`LMDS_สายที่1_SCG_Source.md`) — อธิบายขั้นตอนก่อนเข้า Q_REVIEW
- **สายที่ 2** (`LMDS_สายที่2_Daily_Job.md`) — อธิบายการใช้ Master ที่สร้างจาก Q_REVIEW
- **02_Schema.gs** — นิยาม 22 คอลัมน์ของ Q_REVIEW_HEADERS
- **12_ReviewService.gs** — implementation ของ `addToQReview()` และ `processReviewQueue()`
- **10_MatchEngine.gs** — กฎ 8 ข้อที่ตัดสินใจว่าจะเข้า Q_REVIEW หรือไม่

---

*เอกสารนี้เป็นส่วนหนึ่งของชุดเอกสาร LMDS V5.5.034 — ดูเอกสารที่เกี่ยวข้อง: [LMDS_สายที่1_SCG_Source.md](LMDS_สายที่1_SCG_Source.md) | [LMDS_สายที่2_Daily_Job.md](LMDS_สายที่2_Daily_Job.md)*
