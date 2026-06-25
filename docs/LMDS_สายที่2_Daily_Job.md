# 🔵 สายที่ 2: เริ่มจากชีต "ตารางงานประจำวัน"

> **เอกสารประกอบ LMDS V5.5.022**
> อธิบาย Data Flow สายที่ 2 — การดึงข้อมูล SCG JWD รายวัน และการหาพิกัด GPS จาก Master DB
> เกี่ยวข้องกับ: `00_App.gs`, `17_SearchService.gs`, `18_ServiceSCG.gs`, `21_AliasService.gs`, `04_SourceRepository.gs`

---

## ภาพรวมแบบเด็ก 5 ขวบ

> นึกว่าชีตนี้เป็น **"รายการส่งของวันนี้"** ที่เราโหลดมาจากเซิร์ฟเวอร์ SCG ทางอินเทอร์เน็ต แล้วเราต้อง **"หาพิกัด GPS"** ให้ทุกร้าน เพื่อนำไปใช้นำทาง

ชีต **"ตารางงานประจำวัน"** เป็นจุดเริ่มต้นของสายที่ 2 — สาย "ใช้งาน Master Data" ระบบจะดึงข้อมูลการส่งของของวันนี้จาก SCG JWD API แล้วเขียนลงชีตตารางงานประจำวัน จากนั้นใช้ `ShipToName` (ชื่อร้านปลายทาง) ในการค้นหาพิกัด GPS จาก Master DB ที่สายที่ 1 สร้างไว้ พิกัดที่ได้จะถูกเขียนกลับลงคอลัมน์ `LatLong_Actual` พร้อมทั้งระบายสี (เขียว = เจอ, แดง = ไม่เจอ) เพื่อให้คนขับสามารถใช้นำทางได้ทันที

---

## 📍 ต้องทำอะไรก่อน? (Pre-requisites)

### ขั้นตอนที่ 0: ตั้งค่า Cookie (ทำครั้งเดียว หรือเมื่อ Cookie หมดอายุ)

กดเมนู: **LMDS > ระบบ > ตั้งค่า SCG Cookie**

ระบบจะโผล่กล่องให้วาง Cookie → วางแล้วกด OK → Cookie เก็บใน **Script Properties** (ปลอดภัยกว่าเก็บในเซลล์ เพราะไม่ปรากฏในชีตที่ใครเห็นได้)

Cookie ใช้สำหรับ authentication กับเซิร์ฟเวอร์ SCG JWD โดยไม่ต้อง login ใหม่ทุกครั้ง อายุประมาณ 1-7 วัน แล้วแต่นโยบาย SCG — ถ้า API ตอบกลับ 401 Unauthorized ให้มาตั้ง Cookie ใหม่

### ขั้นตอนที่ 1: ใส่เลข Shipment

ไปชีต **"Input"** → ใส่เลข Shipment ที่ต้องการดึง ลงในคอลัมน์ A (เริ่มจาก A4 ลงไป ตาม `SCG_CONFIG.INPUT_START_ROW = 4`) เช่น:

```
A4: SH240624001
A5: SH240624002
A6: SH240624003
```

เลข Shipment มาจากระบบขนส่งของ SCG โดยทั่วไปจะได้มาจากการโทรถาม SCG หรือดูจากใบขนส่ง

> **Note:** ใช้เริ่มต้นที่ A4 เพราะ A1 ใช้สำหรับ Cookie (ย้ายไป Script Properties แล้วใน V5.5.017) และ A3 ใช้สำหรับ ShipmentNos string (ย้ายไป Script Properties แล้วใน V5.5.018) — ปัจจุบันทั้ง Cookie และ ShipmentNos อยู่ใน Script Properties แต่โครงสร้างคอลัมน์ A ยังคงเริ่มที่แถว 4 ตามเดิม

---

## 📥 ขั้นตอนที่ 2: กดปุ่มโหลดงาน

กดเมนู: **LMDS > Daily Ops > 📥 โหลดข้อมูล SCG JWD**

รันฟังก์ชัน `fetchDataFromSCGJWD()` ใน `18_ServiceSCG.gs` ทำ **8 ขั้นตอน**:

### Step 1: อ่านค่า Input (`readInputConfig_`)
- อ่าน **Cookie** จาก Script Properties (key: `SCG_COOKIE`)
- อ่าน **เลข Shipment** จากชีต Input (A4 ลงไป ตาม `SCG_CONFIG.INPUT_START_ROW`)
- รวมเลข Shipment ด้วยคอมมา คั่นด้วยจุลภาค เช่น `"SH001,SH002,SH003"`

### Step 2: เรียก SCG API (`callSCGApi_`)
- ส่ง POST request ไปที่เซิร์ฟเวอร์ SCG พร้อม Cookie
- Payload: `{ ShipmentNos: "SH001,SH002,SH003" }`
- Retry 3 ครั้ง (1s → 2s → 4s — Exponential Backoff) ถ้าล้มเหลว
- Timeout 30 วินาทีต่อครั้ง ถ้าเกินจะ retry

การ Retry ใช้ `Utilities.sleep()` ระหว่างครั้ง เพื่อรอเซิร์ฟเวอร์กลับมา และ catch error ทั้งหมด (`Exception` และ `URLFetchApp.HTTPError`)

### Step 3: แปลง JSON → แถวข้อมูล (`flattenShipmentsToRows_`)
API ตอบกลับเป็น JSON แบบซ้อน (Shipment → DeliveryNotes → Items) ระบบ "แบน" ให้เป็นแถวๆ ราบ:

```
Shipment 1
  └── DeliveryNote A
       ├── Item 1  → แถวที่ 1 ของตารางงาน
       └── Item 2  → แถวที่ 2
  └── DeliveryNote B
       └── Item 3  → แถวที่ 3
Shipment 2
  └── DeliveryNote C
       └── Item 4  → แถวที่ 4
```

การ flatten ทำใน `flattenShipmentsToRows_()` โดย maintain ลำดับ Shipment → Note → Item และ propagate ค่าระดับบน (ShipmentNo, DriverName) ลงไปทุกแถว Item

### Step 4: คำนวณ Aggregate ต่อร้าน (`aggregateShopData_`)
นับรวมสำหรับแต่ละร้าน (จัดกลุ่มด้วย ShopKey = ShipmentNo|ShipToName):

- จำนวนสินค้ารวมของร้านนี้ → คอลัมน์ [23]
- น้ำหนักสินค้ารวม → คอลัมน์ [24]
- จำนวน Invoice ที่ต้องสแกน (ลบ E-POD ออก) → คอลัมน์ [25]
- ชื่อเจ้าของสินค้า + รวม X บิล → คอลัมน์ [19]

การ Aggregate ใช้ `Map` เพื่อ group แถวตาม ShopKey แล้วคำนวณผลรวม เพื่อให้ได้ข้อมูล "ต่อร้าน" แทน "ต่อ Item" ทำให้คนขับเห็นภาพรวมของแต่ละร้านในแถวเดียว

### Step 5: เขียนลงชีต "ตารางงานประจำวัน" (`writeDailyJobSheet_`)
เขียนทั้ง 31 คอลัมน์ โดย Mapping จาก API:

| คอลัมน์ [index] | ชื่อ | มาจาก API ไหน |
|---|---|---|
| [0] | ID_งานประจำวัน | PurchaseOrder + ลำดับแถว |
| [1] | PlanDelivery | note.PlanDelivery |
| [2] | InvoiceNo | note.PurchaseOrder |
| [3] | ShipmentNo | shipment.ShipmentNo |
| [4] | DriverName | shipment.DriverName |
| [5] | TruckLicense | shipment.TruckLicense |
| [6] | CarrierCode | shipment.CarrierCode |
| [7] | CarrierName | shipment.CarrierName |
| [8] | SoldToCode | note.SoldToCode |
| [9] | SoldToName | note.SoldToName |
| **[10]** | **ShipToName** | **note.ShipToName** ← **คอลัมน์สำคัญที่สุด!** |
| [11] | ShipToAddress | note.ShipToAddress (ไม่น่าเชื่อถือ เพราะ SCG กรอกไม่ครบ) |
| [12] | LatLong_SCG | ShipToLatitude + "," + ShipToLongitude |
| [13] | MaterialName | item.MaterialName |
| [14] | ItemQuantity | item.ItemQuantity |
| [15] | QuantityUnit | item.QuantityUnit |
| [16] | ItemWeight | item.ItemWeight |
| [17] | DeliveryNo | note.DeliveryNo |
| [18] | จำนวนปลายทาง_System | นับจาก ShipToName ไม่ซ้ำ |
| [19] | รายชื่อปลายทาง_System | รายชื่อร้านทั้งหมดคั่นด้วยคอมมา |
| [20] | ScanStatus | "รอสแกน" (ค่าเริ่มต้น) |
| [21] | DeliveryStatus | "ยังไม่ได้ส่ง" (ค่าเริ่มต้น) |
| [22] | Email พนักงาน | จากชีต "ข้อมูลพนักงาน" (lookup ด้วย DriverName) |
| [23] | จำนวนสินค้ารวมของร้านนี้ | Step 4 |
| [24] | น้ำหนักสินค้ารวมของร้านนี้ | Step 4 |
| [25] | จำนวน_Invoice_ที่ต้องสแกน | Step 4 |
| **[26]** | **LatLong_Actual** | **ว่างเปล่า (รอ Step 6)** ← **ผลลัพธ์หลัก** |
| [27] | ชื่อเจ้าของสินค้า... | Step 4 |
| [28] | ShopKey | ShipmentNo + "\|" + ShipToName |
| [29] | ชื่อลูกค้าปลายทางจริง | คัดลอกจาก Source (ถ้ามี) |
| [30] | ชื่อสถานที่อยู่ลูกค้า... | คัดลอกจาก Source (ถ้ามี) |

### Step 6: จับคู่พิกัด GPS (`applyMasterCoordinatesToDailyJob` → `17_SearchService.gs`)

**นี่คือหัวใจของสายที่ 2!**

`runLookupEnrichment()` วนทุกแถวในชีต ตารางงานประจำวัน:

1. อ่านคอลัมน์ **ShipToName [10]**
2. ถ้าคอลัมน์ **LatLong_Actual [26]** มีพิกัดอยู่แล้วและถูกต้อง → **ข้าม** (Idempotency check — ป้องกันการค้นซ้ำ)
3. ส่ง ShipToName เข้า `findBestGeoByPersonPlace()`:

```
ShipToName "บริษัท ไทวัสดุ จำกัด 081-234-5678"
    │
    ▼ normalizePersonNameFull()
"ไทวัสดุ"  (ทำความสะอาด 6 ขั้นตอน เหมือนสายที่ 1)
    │
    ├── Tier 0: fastLookupByShipToName("ไทวัสดุ")
    │   └── ค้น M_ALIAS → เจอ master_uuid → หา M_DESTINATION → ได้ lat,lng
    │       └── เจอ! ✅ ใส่พิกัดลง LatLong_Actual + สีเขียว (#b6d7a8)
    │
    └── Tier 0 ไม่เจอ? → Tier 1:
        └── resolvePerson("ไทวัสดุ") → ได้ personId
            └── getDestsByPersonId(personId) → เรียงตาม usage_count
                └── เอาพิกัดจาก Destination ที่ใช้บ่อยที่สุด
                    └── เจอ! ✅ ใส่พิกัด + สีเขียว
                    └── ไม่เจอ? ❌ ว่างเปล่า + สีแดง (#f4cccc)
```

**Tier 0 (Fast Track)** ใช้ `fastLookupByShipToName()` ของ `21_AliasService.gs` ซึ่งค้น M_ALIAS แบบ O(1) ผ่าน normalized key — เร็วมาก เพราะ M_ALIAS ถูก cache ไว้ใน Chunked Cache (80KB chunks)

**Tier 1 (Fallback)** ใช้ `resolvePerson()` เหมือนสายที่ 1 แต่จะเอา `Destination` ที่ใช้บ่อยสุด (sort by `usage_count` DESC) มาเป็นพิกัด เพราะบางครั้งคนหนึ่งมีหลายสถานที่

### Step 7: คัดลอก "ชื่อจริง" จาก Source (`copyDriverVerifiedToDailyJob_`)
- ใช้ **ShopKey** (ShipmentNo|ShipToName) เป็นกุญแจเชื่อม
- ค้นในชีต Source → ถ้าเจอ → คัดลอกคอลัมน์ [37] [38] ไปยัง Daily Job คอลัมน์ [29] [30]

ขั้นตอนนี้ทำให้คนขับที่เคยยืนยันชื่อ "จริง" ในชีต Source แล้ว ไม่ต้องมาพิมพ์ใหม่ใน Daily Job — ระบบจะดึงข้อมูลที่ verify แล้วมาใช้โดยอัตโนมัติ (Driver Verified Columns pattern ตาม V5.5.011)

### Step 8: สร้างสรุป (`buildOwnerSummary_` + `buildShipmentSummary_`)
- **ชีต "สรุป_เจ้าของสินค้า"** → รวมจำนวนบิล/E-POD ต่อบริษัท (SoldToName)
- **ชีต "สรุป_Shipment"** → รวมจำนวนบิล/E-POD ต่อ Shipment

สรุปเหล่านี้ใช้สำหรับ Reporting และให้ผู้จัดการเห็นภาพรวมประจำวัน

---

## 📊 สรุปภาพ Data Flow สายที่ 2

```
ชีต "Input" (Cookie + เลข Shipment)
    │
    ▼ (กด "โหลดข้อมูล SCG JWD")
18_ServiceSCG.gs → fetchDataFromSCGJWD()
    │
    ├── Step 1-2: อ่าน Input → เรียก SCG API (retry 3 ครั้ง)
    ├── Step 3: แปลง JSON → แถวราบ (flattenShipmentsToRows_)
    ├── Step 4: คำนวณ aggregate ต่อร้าน (aggregateShopData_)
    ├── Step 5: เขียนลง "ตารางงานประจำวัน" (31 คอลัมน์)
    ├── Step 6: จับคู่พิกัด GPS
    │   └── 17_SearchService.gs → runLookupEnrichment()
    │       └── อ่าน ShipToName [10] ทุกแถว
    │           └── normalizePersonNameFull() → ทำความสะอาด
    │               └── Tier 0: M_ALIAS Fast Track → M_DESTINATION → lat,lng
    │               └── Tier 1: resolvePerson → getDestsByPersonId → lat,lng
    │               └── เขียน ลง LatLong_Actual [26] + สีเขียว/แดง
    ├── Step 7: คัดลอก "ชื่อจริง" จาก Source → Daily Job [29][30]
    └── Step 8: สรุป → "สรุป_เจ้าของสินค้า" + "สรุป_Shipment"

ผลลัพธ์ที่ได้กลับ:
├── ตารางงานประจำวัน: มีพิกัด GPS ทุกแถวที่เจอ (เขียว) หรือว่าง (แดง)
├── สรุปเจ้าของสินค้า: รายชื่อบริษัท + จำนวนบิล
└── สรุป_Shipment: รายชื่อขนส่ง + จำนวนบิล
```

---

## 🔁 Pattern สำคัญที่ใช้ในสายที่ 2

1. **Exponential Backoff Retry** — API call ล้มเหลว จะ retry ที่ 1s, 2s, 4s
2. **Idempotency Check** — ถ้า LatLong_Actual มีพิกัดอยู่แล้ว จะข้าม ไม่ค้นซ้ำ
3. **Two-Tier Lookup** — Tier 0 (Fast Track via Alias) → Tier 1 (Fallback via resolvePerson)
4. **Driver Verified Propagation** — ชื่อที่คนขับยืนยันใน Source จะถูก propagate ไป Daily Job อัตโนมัติ
5. **Chunked Cache** — M_ALIAS ขนาดใหญ่ถูกแบ่งเป็น chunk 80KB ใน CacheService (V5.5.016 Performance)
6. **Module Boundary** — Group 2 (Search) เรียก Group 1 (Alias) ผ่าน `fastLookupByShipToName()` ไม่เข้าไปจัดการ cache เอง (กฎ REF-001)

---

## 🔗 ความเชื่อมโยงกับสายที่ 1

| สายที่ 1 (Source → Master) | สายที่ 2 (Daily Job → Lookup) |
|---|---|
| สร้าง M_PERSON + M_PLACE + M_GEO_POINT + M_DESTINATION | อ่าน M_DESTINATION เพื่อหา lat,lng |
| สร้าง M_ALIAS อัตโนมัติ (Single Writer) | ใช้ M_ALIAS เป็น Tier 0 Fast Track |
| Normalize ชื่อดิบ → cleanName + normalizedKey | ใช้ normalizedKey เดียวกันในการ lookup |
| บันทึก FACT_DELIVERY | ไม่เขียน Master (อ่านอย่างเดียว) |
| ทำงานแบบ batch (ทุกแถวใน Source) | ทำงานแบบ batch (ทุกแถวใน Daily Job) |

> **Note**: สายที่ 2 ไม่เขียน Master Data — เป็น read-only consumer ของ Master ที่สายที่ 1 สร้างไว้ ทำให้ Daily Job ทำงานเร็วและปลอดภัย (ไม่มี risk ของการ corrupt Master)

---

*เอกสารนี้เป็นส่วนหนึ่งของชุดเอกสาร LMDS V5.5.022 — ดูเอกสารที่เกี่ยวข้อง: [LMDS_สายที่1_SCG_Source.md](LMDS_สายที่1_SCG_Source.md) | [LMDS_Q_REVIEW_คู่มือ.md](LMDS_Q_REVIEW_คู่มือ.md)*
