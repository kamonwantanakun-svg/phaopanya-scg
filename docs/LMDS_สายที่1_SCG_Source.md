# 🟢 สายที่ 1: เริ่มจากชีต "SCGนครหลวงJWDภูมิภาค" (Source Sheet)

> **เอกสารประกอบ LMDS V5.5.022**
> อธิบาย Data Flow สายที่ 1 — จากชีต Source ดิบไปจนถึงการเขียน Master Data และ FACT_DELIVERY
> เกี่ยวข้องกับ: `00_App.gs`, `04_SourceRepository.gs`, `05_NormalizeService.gs`, `06_PersonService.gs`, `07_PlaceService.gs`, `08_GeoService.gs`, `10_MatchEngine.gs`

---

## ภาพรวมแบบเด็ก 5 ขวบ

> นึกว่าชีตนี้เป็น **"กล่องใบงานส่งของ"** ที่คนขับพิมพ์เข้ามาด้วยมือ มักมัว มีเบอร์โทรปนอยู่ มีคำว่า "จำกัด" ปนอยู่ เราต้อง **"ทำความสะอาด"** → **"จับคู่"** กับข้อมูลเดิมที่เราเคยเก็บไว้ → แล้ว **"เก็บผลลัพธ์"** ลงชีตต่างๆ

ชีต **"SCGนครหลวงJWDภูมิภาค"** เป็นจุดเริ่มต้นของสายที่ 1 ซึ่งเป็นสาย "สร้าง Master Data" ของระบบ LMDS ข้อมูลที่คนขับกรอกเข้ามา (ชื่อร้าน ที่อยู่ พิกัด GPS ทะเบียนรถ) จะถูกประมวลผลผ่าน Pipeline 5 ขั้นตอน ได้แก่ การโหลดข้อมูลดิบ, การทำความสะอาดชื่อ, การจับคู่ Person/Place/Geo, การตัดสินใจด้วย 8 กฎ และการเขียนผลลัพธ์ลงชีตปลายทาง 9 ชีต ผลลัพธ์สุดท้ายคือ Master Data ที่ "สะอาดและจับคู่ได้แม่นยำ" ซึ่งจะถูกสายที่ 2 (Daily Job) เรียกใช้ในวันถัดไป

---

## 📍 กดปุ่มอะไร?

กดเมนู: **LMDS > Pipeline > ▶ Run Full Pipeline**

ปุ่มนี้รันฟังก์ชัน `runFullPipeline()` ใน `00_App.gs` ซึ่งทำงาน 2 ขั้นตอนต่อเนื่อง:
1. `runLoadSource()` — โหลดข้อมูลดิบจากชีต Source
2. `runMatchEngine()` — ประมวลผลจับคู่กับ Master DB

ระบบมี Time Guard ที่จะตรวจสอบเวลาทำงาน ถ้าใกล้ 5 นาที (limit ของ Apps Script) จะสร้าง trigger ทำงานต่ออัตโนมัติ (Checkpoint/Resume pattern) ทำให้สามารถประมวลผลแถวได้เป็นพันๆ แถวโดยไม่หลุด

---

## 📥 ขั้นตอนที่ 1: โหลดข้อมูลจากชีต Source (`04_SourceRepository.gs`)

### อ่านคอลัมน์ไหนบ้าง?

ระบบอ่านทั้ง 39 คอลัมน์ แต่ **ใช้จริง** คอลัมน์เหล่านี้:

| คอลัมน์ที่อ่าน | Index | ชื่อในโค้ด | ใช้ทำอะไร |
|---|---|---|---|
| ชื่อปลายทาง | [12] `RAW_PERSON_NAME` | `rawPersonName` | **ชื่อร้าน/คนที่รับของ** (สกปรก เช่น "บริษัท ไทวัสดุ จำกัด มีเบอร์โทร") |
| ที่อยู่ปลายทาง | [18] `RAW_ADDRESS` | `rawPlaceName` | ที่อยู่ดิบจาก SCG (ใช้เป็น backup) |
| ชื่อที่อยู่จาก_LatLong | [24] `RESOLVED_ADDR` | `rawAddress` / `resolvedAddr` | ที่อยู่ที่ Google Maps แปลงจากพิกัด (เชื่อถือได้กว่า) |
| LAT | [14] `LAT` | `rawLat` | ละติจูดจาก GPS คนขับ |
| LONG | [15] `LNG` | `rawLng` | ลองจิจูดจาก GPS คนขับ |
| จุดส่งสินค้าปลายทาง | [4] `LATLNG_COMBINED` | fallback พิกัด | ถ้า LAT/LONG ว่าง จะลองแกะค่า "lat,lng" จากคอลัมน์นี้แทน |
| Invoice No | [8] `INVOICE_NO` | `invoiceNo` | **รหัสใบส่งของ** — ใช้เป็น ID หลัก ป้องกันซ้ำ |
| Shipment No | [7] `SHIPMENT_NO` | `shipmentNo` | รหัสขนส่ง |
| วันที่ส่งสินค้า | [2] `DELIVERY_DATE` | `deliveryDate` | วันที่ |
| เวลาที่ส่งสินค้า | [3] `DELIVERY_TIME` | `deliveryTime` | เวลา |
| ชื่อ - นามสกุล | [5] `DRIVER_NAME` | `driverName` | ชื่อคนขับ |
| ทะเบียนรถ | [6] `TRUCK_LICENSE` | `truckLicense` | ทะเบียนรถ |
| รหัสลูกค้า | [10] `CUSTOMER_CODE` | `soldToCode` | รหัสบริษัทผู้ซื้อ |
| ชื่อเจ้าของสินค้า | [11] `SOLD_TO_NAME` | `soldToName` | ชื่อบริษัทผู้ซื้อ |
| คลังสินค้า | [17] `WAREHOUSE` | `warehouse` | ชื่อคลัง |
| SYNC_STATUS | [36] `SYNC_STATUS` | ตรวจสถานะ | ถ้า = "SUCCESS" หรือ "REVIEW" → **ข้าม** ไม่ประมวลผล |
| ชื่อลูกค้าปลายทางจริง | [37] `DRIVER_VERIFIED_NAME` | `driverVerifiedName` | ชื่อที่คนขับยืนยันว่าถูกต้อง (ถ้ามี) |
| ชื่อสถานที่อยู่จริง | [38] `DRIVER_VERIFIED_ADDR` | `driverVerifiedAddr` | ที่อยู่ที่คนขับยืนยัน (ถ้ามี) |

### กรองอะไรออก?

ก่อนเข้า Match Engine ระบบจะกรองแถวที่ไม่ต้องประมวลผลออก เพื่อประหยัดเวลาและป้องกันการประมวลผลซ้ำ:

- แถวที่ **Invoice No ว่าง** → ข้าม (ไม่มี ID หลัก ใช้งานไม่ได้)
- แถวที่ **SYNC_STATUS = "SUCCESS"** → เคยทำแล้วสำเร็จ ข้าม
- แถวที่ **SYNC_STATUS = "REVIEW"** → อยู่รอคนตรวจสอบ ข้าม (ป้องกันชนกับ Q_REVIEW)
- เทียบกับ **FACT_DELIVERY** แล้ว → ถ้าเลข Invoice ซ้ำ → ข้าม + ปรับสถานะเป็น SUCCESS ให้ (Data Consistency check ตามกฎ V5.5.011)

เงื่อนไขการกรองเหล่านี้ถูก implement ใน `loadSourceData()` ของ `04_SourceRepository.gs` โดยใช้การอ่านแบบ `getValues()` ครั้งเดียว (bulk read) แล้วกรองใน memory เพื่อความเร็ว

---

## 🧠 ขั้นตอนที่ 2: Match Engine ประมวลผลทีละแถว (`10_MatchEngine.gs`)

สำหรับแต่ละแถว ระบบทำ **5 สเต็ป** ต่อเนื่อง ภายใต้ `processOneRow_()`:

### สเต็ป 2.1: ทำความสะอาดชื่อ (`05_NormalizeService.gs`)
เอา `rawPersonName` (ชื่อปลายทางสกปรก) ส่งเข้า `normalizePersonNameFull()` ซึ่งทำ 7 ขั้นตอน:

1. ดึงเบอร์โทรออก (เช่น "081-234-5678") — ด้วย regex `\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}`
2. ดึงเลขเอกสารออก (เช่น "IN-2306-001") — ด้วย regex ของ Invoice/Shipment pattern
3. ดึงคำสั่งส่งออก (เช่น "ฝากป้อม", "COD", "ด่วน") — จาก dictionary ของคำสั่งที่รู้จัก
4. ตรวจว่าเป็นบริษัทไหม → ตัดคำว่า "จำกัด", "บจก.", "หจก." (บริษัทจำกัด, บจก., ห้างหุ้นส่วนจำกัด)
5. ตัดคำนำหน้า (นาย, นาง, นางสาว, บริษัท, ร้าน) — ทำให้ "ร้านสมชาย" และ "สมชาย" จับคู่เจอกัน
6. ล้างช่องว่างและอักขระพิเศษ (multiple spaces → single space, trim, ลบ emoji)
7. ได้ `cleanName` ที่สะอาด เช่น "ไทวัสดุ" จากต้นฉบับ "บริษัท ไทวัสดุ จำกัด (มีเบอร์โทร 081-234-5678)"

นอกจากนี้ยังสร้าง `normalizedKey` (lowercase + ลบ spaces ทั้งหมด) สำหรับใช้ในการ match แบบ exact ที่เร็วกว่า fuzzy

### สเต็ป 2.2: จับคู่ Person — หา "ใคร?" (`06_PersonService.gs`)
`resolvePerson()` ลองหาชื่อนี้ใน Master Data 8 วิธี (ตามลำดับ — หากเจอในวิธีก่อนจะไม่ลองวิธีหลัง):

1. ค้น **M_ALIAS** (Global Alias) → O(1) เร็วสุด (Tier 0 Fast Track)
2. ตรงตัวกับชื่อหลัก (`canonical_name`) ใน M_PERSON
3. ตรงตัวกับ `normalized_name` ใน M_PERSON หรือเทียบกับ M_PERSON_ALIAS
4. Fuzzy Match (Dice Coefficient ≥ 0.85) — แบ่งชื่อเป็น bigram แล้วคำนวณความคล้าย
5. Fuzzy Match (Levenshtein Distance ≤ 3) — นับจำนวนตัวอักษรที่ต้องแก้
6. Phonetic Key Match (เสียงพยัญชนะ) — แปลงชื่อเป็น soundex-like key เพื่อจับ "สมชาย" กับ "สมชายย์"
7. ค้นใน Note field ของ M_PERSON — บางครั้งเก็บชื่อเดิมไว้ใน note
8. ไม่เจอ → สร้างใหม่ (CREATE_NEW) โดยใช้ UUID v4 เป็น `master_uuid`

### สเต็ป 2.3: จับคู่ Place — หา "ที่ไหน?" (`07_PlaceService.gs`)
`resolvePlace()` คล้ายกัน แต่เพิ่มเติมการ Enrich ที่อยู่:

- สกัด ตำบล/อำเภอ/จังหวัด/รหัสไปรษณีย์ จากที่อยู่ โดยใช้ **SYS_TH_GEO** (พจนานุกรม 7,537 แถว)
- 3 ชั้นของ Geo Enrichment:
  1. **พจนานุกรม** — ค้นใน SYS_TH_GEO ตรงตัว
  2. **Regex + Fuzzy** — ดึงด้วย regex pattern แล้ว fuzzy match กับ dictionary
  3. **รหัสไปรษณีย์** — ใช้ postcode ดึงจังหวัด/อำเภอ/ตำบล (ถ้ามี postcode อยู่)

### สเต็ป 2.4: จับคู่ GPS — หา "พิกัด?" (`08_GeoService.gs`)
`resolveGeo(lat, lng)` ใช้ **Grid 3×3** ค้นหาจุด GPS ใกล้เคียงที่สุดใน Master:

Grid 3×3 หมายถึงการแบ่งแผนที่เป็นช่อง 9 ช่องรอบจุดที่ค้น แล้วค้นเฉพาะจุดในช่องที่จุดตั้งอยู่ + ช่องรอบข้าง (8 ช่อง) ทำให้ค้นเร็วขึ้นมาก เพราะไม่ต้องสแกนทั้ง M_GEO_POINT ทุกแถว

| ระยะ | ผลลัพธ์ | สีในชีต |
|---|---|---|
| ในรัศมี 50m | FOUND | เขียว |
| 50-80m | NEARBY_YELLOW | เหลือง (รอตรวจ) |
| 80-100m | NEARBY_ORANGE | ส้ม (รอตรวจ) |
| เกิน 100m | NOT_FOUND | แดง |

ระยะทางคำนวณด้วยสูตร **Haversine** ซึ่งคำนวณระยะทางบนทรงกลมโลกได้แม่นยำกว่า Pythagoras

### สเต็ป 2.5: 8 กฎตัดสินใจ (`makeMatchDecision`)

หลังจากได้ผล match ของ Person, Place, และ Geo แล้ว ระบบจะใช้ 8 กฎต่อไปนี้ตัดสินใจ (ตามลำดับ — กฎไหนเข้าเงื่อนไขก่อนจะใช้กฎนั้น):

| กฎ | เงื่อนไข | ผลลัพธ์ |
|---|---|---|
| Rule 1 | ไม่มีพิกัด GPS เลย | ❌ REVIEW (รอคนตรวจ) |
| Rule 2 | ชื่อสกปรกเกินไป (normalize แล้วยังสั้นมาก) | ❌ REVIEW |
| Rule 3 | พิกัดอยู่จังหวัดต่างกับที่อยู่ (Geo Province Conflict) | ❌ REVIEW |
| Rule 3.5 | พิกัดใกล้แต่ไม่ตรง (50-100m) | ❌ REVIEW |
| **Rule 4** | **เจอครบ 3 อย่าง (คน+สถานที่+GPS)** | ✅ **AUTO_MATCH** (สั้นที่สุด เรียก FULL_MATCH) |
| **Rule 5** | **เจอ GPS + อย่างใดอย่างหนึ่ง** | ✅ **AUTO_MATCH** (Geo Anchor) |
| Rule 6 | ชื่อคล้ายๆ กัน (Fuzzy) แต่ไม่มั่นใจพอ | ❌ REVIEW |
| **Rule 7** | **ทุกอย่างใหม่ แต่มี GPS ที่มั่นใจ** | ✅ **CREATE_NEW** (สร้าง Master ใหม่) |
| Rule 8 | อื่นๆ (catch-all) | ❌ REVIEW |

Rule 4 และ Rule 5 คือกฎ "รอด" ที่ทำให้ข้อมูลเข้า FACT_DELIVERY ได้โดยอัตโนมัติ ส่วน Rule 7 ทำให้ระบบเรียนรู้ร้านใหม่ได้เอง (Self-Learning Master Data)

---

## 📤 ขั้นตอนที่ 3: ผลลัพธ์ไปอยู่ชีตไหนบ้าง?

### กรณี AUTO_MATCH (Rule 4, 5) → ข้อมูลไป 3 ชีต:

**3a. ชีต `FACT_DELIVERY`** (34 คอลัมน์) — บันทึก "ใบส่งของ" ทุกรายการ

| คอลัมน์ใน FACT | มาจากไหน |
|---|---|
| `tx_id` [0] | สร้างใหม่อัตโนมัติ (TX + 8 ตัวอักษร) |
| `source_sheet` [1] | ค่าคงที่ "SCGนครหลวงJWDภูมิภาค" |
| `source_row_number` [2] | แถวที่ของชีต Source |
| `source_record_id` [3] | ID_SCG จาก Source [1] |
| `delivery_date` [4] | วันที่ส่ง จาก Source [2] |
| `delivery_time` [5] | เวลา จาก Source [3] |
| `invoice_no` [6] | Invoice จาก Source [8] |
| `shipment_no` [7] | Shipment จาก Source [7] |
| `driver_name` [8] | ชื่อคนขับ จาก Source [5] |
| `truck_license` [9] | ทะเบียนรถ จาก Source [6] |
| `sold_to_code` [10] | รหัสลูกค้า จาก Source [10] |
| `sold_to_name` [11] | ชื่อเจ้าของสินค้า จาก Source [11] |
| `ship_to_name` [12] | ชื่อปลายทาง **ดิบ** จาก Source [12] |
| `ship_to_address` [13] | ที่อยู่ดิบ จาก Source [18] |
| `geo_resolved_addr` [14] | ที่อยู่จาก Google Maps จาก Source [24] |
| `person_id` [15] | **ผล Match** จาก M_PERSON |
| `place_id` [16] | **ผล Match** จาก M_PLACE |
| `geo_id` [17] | **ผล Match** จาก M_GEO_POINT |
| `dest_id` [18] | **ผล Match** จาก M_DESTINATION (Trinity) |
| `warehouse` [19] | คลัง จาก Source [17] |
| `raw_lat` [20] | ละติจูดดิบ จาก Source [14] |
| `raw_lng` [21] | ลองจิจูดดิบ จาก Source [15] |
| `match_status` [22] | "FULL_MATCH" หรือ "GEO_ANCHOR" |
| `match_confidence` [23] | คะแนนความมั่นใจ (0-100) |
| `match_reason` [24] | เหตุผล (เช่น "Rule 4: Trinity Match") |
| `match_action` [25] | "AUTO_MATCH" หรือ "CREATE_NEW" |
| `resolved_lat` [26] | ละติจูดที่ได้จาก Master (ไม่ใช่ดิบ) |
| `resolved_lng` [27] | ลองจิจูดที่ได้จาก Master |
| `created_at` [28] | เวลาสร้าง |
| `updated_at` [29] | เวลาอัปเดต |
| `record_status` [30] | "ACTIVE" |
| `match_evidence` [31] | "name\|place\|geo" หรือ "name\|geo" |
| `driver_verified_name` [32] | ชื่อจริง จาก Source [37] |
| `driver_verified_addr` [33] | ที่อยู่จริง จาก Source [38] |

**3b. ชีต `M_PERSON`** (ถ้าเป็น CREATE_NEW) — สร้างคนใหม่

| คอลัมน์ | ค่า |
|---|---|
| `person_id` [0] | P + 8 ตัวอักษร |
| `canonical_name` [1] | ชื่อที่สะอาดแล้ว (จาก normalizePersonNameFull) |
| `normalized_name` [2] | ชื่อ lowercase ล้างスペース |
| `phone` [3] | เบอร์โทรที่ดึงออกมา |
| `master_uuid` [9] | UUID v4 |

**3c. ชีต `M_PLACE`** (ถ้าเป็น CREATE_NEW) — สร้างสถานที่ใหม่

| คอลัมน์ | ค่า |
|---|---|
| `place_id` [0] | PL + 8 ตัวอักษร |
| `canonical_name` [1] | ที่อยู่ที่สะอาดแล้ว |
| `sub_district` [4] | ตำบล (จาก SYS_TH_GEO) |
| `district` [5] | อำเภอ |
| `province` [6] | จังหวัด |
| `postcode` [7] | รหัสไปรษณีย์ |
| `master_uuid` [13] | UUID v4 |

**3d. ชีต `M_GEO_POINT`** (ถ้าเป็น CREATE_NEW หรือ GPS ใหม่) — สร้างจุด GPS

| คอลัมน์ | ค่า |
|---|---|
| `geo_id` [0] | G + 8 ตัวอักษร |
| `lat` [1] | ละติจูด |
| `lng` [2] | ลองจิจูด |
| `resolved_address` [4] | ที่อยู่ที่แก้ไขแล้ว |
| `province` [5] | จังหวัด |
| `source` [7] | "driver" (มาจากคนขับ) |
| `coord_confidence` [8] | 80 (driver) หรือ 90 (maps) |

**3e. ชีต `M_DESTINATION`** (Trinity — ผูกทั้ง 3 เข้าด้วยกัน)

M_DESTINATION คือ "Trinity" ที่ผูก Person + Place + Geo เป็น "จุดหมายปลายทาง" เดียว เพื่อให้สายที่ 2 ค้นได้รวดเร็ว โดยไม่ต้อง join 3 ตาราง

| คอลัมน์ | ค่า |
|---|---|
| `dest_id` [0] | D + 8 ตัวอักษร |
| `person_id` [1] | จาก 3b |
| `place_id` [2] | จาก 3c |
| `geo_id` [3] | จาก 3d |
| `lat` [4] | ละติจูด |
| `lng` [5] | ลองจิจูด |

**3f. ชีต `M_ALIAS` + `M_PERSON_ALIAS` + `M_PLACE_ALIAS`** — สร้าง "ชื่อเล่น" อัตโนมัติ

- ชื่อดิบที่คนขับพิมพ์ → ถ้าต่างจากชื่อที่สะอาด → สร้างเป็น Alias
- ทำให้ครั้งหน้าคนขับพิมพ์ชื่อมัวๆ ระบบยังจับคู่เจอผ่าน Alias ได้

การ Enrich Alias เกิดขึ้นใน `autoEnrichAliasesFromFactBatch_()` ของ `21_AliasService.gs` ซึ่งเป็น **Single Writer** ของ M_ALIAS ตามกฎ REF-001 (Module Boundary) เพื่อป้องกันการเขียนซ้ำซ้อน

### กรณี REVIEW (Rule 1, 2, 3, 3.5, 6, 8) → ข้อมูลไป 2 ชีต:

**3g. ชีต `Q_REVIEW`** (22 คอลัมน์) — คิวรอคนตรวจสอบ

| คอลัมน์ | ค่า |
|---|---|
| `review_id` [0] | R + 8 ตัวอักษร |
| `issue_type` [1] | เหตุผล (เช่น INVALID_LATLNG, GEO_PROVINCE_CONFLICT) |
| `priority` [2] | 1 (สูง) 2 (กลาง) 3 (ต่ำ) |
| `invoice_no` [5] | Invoice จาก Source |
| `raw_person_name` [6] | ชื่อดิบ |
| `raw_place_name` [7] | ที่อยู่ดิบ |
| `raw_lat` [9] | ละติจูดดิบ |
| `raw_lng` [10] | ลองจิจูดดิบ |
| `candidate_person_ids` [11] | Person ที่คล้าย (ถ้ามี) |
| `recommended_action` [16] | CREATE_NEW / MERGE / ESCALATE / IGNORE |
| `status` [17] | "Pending" |

> 📋 ดูรายละเอียดครบ 22 คอลัมน์ของ Q_REVIEW ได้ในเอกสาร `LMDS_Q_REVIEW_คู่มือ.md`

**3h. ชีต Source เอง** — อัปเดตสถานะ

- คอลัมน์ `SYNC_STATUS` [36] → เปลี่ยนเป็น **"SUCCESS"** (เขียว) หรือ **"ERROR"** (แดง) หรือ **"REVIEW"** (เหลือง)

การอัปเดต SYNC_STATUS ใช้ `setValues()` แบบ batch (เขียนทีเดียวทุกแถวที่ประมวลผล) เพื่อลดจำนวน API calls ไปยัง Google Sheets ซึ่งเป็น bottleneck หลักของ Apps Script

---

## 📊 สรุปภาพ Data Flow สายที่ 1

```
ชีต "SCGนครหลวงJWDภูมิภาค"
    │
    ▼ (กด Run Full Pipeline)
04_SourceRepository.gs → อ่าน + กรอง + สร้าง Source Object
    │
    ▼
10_MatchEngine.gs → ทีละแถว:
    ├── resolvePerson()     → เทียบ M_PERSON, M_PERSON_ALIAS, M_ALIAS
    ├── resolvePlace()      → เทียบ M_PLACE, M_PLACE_ALIAS + SYS_TH_GEO
    ├── resolveGeo()        → ค้น Grid 3×3 ใน M_GEO_POINT
    ├── makeMatchDecision() → 8 กฎ
    └── executeDecision()   → เขียนผลลัพธ์
         │
         ├──→ FACT_DELIVERY      (ทุกกรณี ยกเว้น REVIEW)
         ├──→ M_PERSON           (CREATE_NEW)
         ├──→ M_PLACE            (CREATE_NEW)
         ├──→ M_GEO_POINT        (CREATE_NEW)
         ├──→ M_DESTINATION      (CREATE_NEW หรือ ไม่มีใน Master)
         ├──→ M_ALIAS            (AUTO_ENRICH อัตโนมัติ)
         ├──→ M_PERSON_ALIAS     (AUTO_ENRICH)
         ├──→ M_PLACE_ALIAS      (AUTO_ENRICH)
         ├──→ Q_REVIEW           (REVIEW เท่านั้น)
         └──→ Source SYNC_STATUS (SUCCESS/ERROR/REVIEW)
```

---

## 🔁 Pattern สำคัญที่ใช้ในสายที่ 1

1. **Time Guard + Checkpoint/Resume** — ถ้าใกล้ 5 นาที บันทึกตำแหน่งที่ทำถึง แล้วสร้าง trigger ทำต่อ
2. **Chunked Cache Pattern** — M_PERSON / M_PLACE ขนาดใหญ่ถูกแบ่งเป็น chunk 80KB ใน CacheService
3. **Single Writer Pattern** — `autoEnrichAliasesFromFactBatch_()` เป็นที่เดียวที่เขียน M_ALIAS (กฎ REF-001)
4. **Module Boundary** — Group 2 ใช้ผ่าน gateway function `resolveAndPersist_()` ไม่เรียก Group 1 CRUD ตรงๆ
5. **Authorization Guards** — ฟังก์ชัน destructive (ลบข้อมูล) มี guard ตรวจสิทธิ์ก่อนทำงาน

---

*เอกสารนี้เป็นส่วนหนึ่งของชุดเอกสาร LMDS V5.5.022 — ดูเอกสารที่เกี่ยวข้อง: [LMDS_สายที่2_Daily_Job.md](LMDS_สายที่2_Daily_Job.md) | [LMDS_Q_REVIEW_คู่มือ.md](LMDS_Q_REVIEW_คู่มือ.md)*
