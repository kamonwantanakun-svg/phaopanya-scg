# 🔍 รายงานการตรวจสอบระบบความจำสำรอง (Cache Audit Report) — LMDS V5.5.022

เราได้ทำการตรวจสอบโค้ดการจัดการ **Cache** ทั้งหมดในระบบจากประวัติการแก้ไขและจุดเสี่ยงต่าง ๆ ที่เคยพบ เพื่อป้องกันไม่ให้เกิดปัญหา Error ซ้ำอีก ผลลัพธ์จากการตรวจสอบมีดังนี้ครับ:

---

## 1. 💡 ปัญหา Cache ในอดีต และการแก้ไขในปัจจุบัน

ในเวอร์ชันก่อนหน้านี้ (ต่ำกว่า V5.5.007) ระบบเคยประสบปัญหาด้าน Cache ทั้งหมด 3 รูปแบบหลัก ซึ่งได้รับการแก้ไขอย่างสมบูรณ์แล้วในเวอร์ชัน **V5.5.022**:

### 🚫 ปัญหาที่ 1: ขนาดข้อมูลเกินขีดจำกัด (100KB Size Limit Exception)
* **สาเหตุ:** `CacheService` ของ Google Apps Script จำกัดขนาดข้อมูลสูงสุด 100KB ต่อ 1 Cache Key หากมีจำนวนข้อมูลพนักงาน (Person) หรือจุดส่งมอบ (Place) จำนวนมาก ระบบจะเด้ง Error ทันทีตอนเซฟ Cache
* **วิธีแก้ปัจจุบัน:** ใช้ระบบ **Chunked Cache** (ประกาศใน [14_Utils.gs](file:///g:/ไดรฟ์ของฉัน/แชร์ไฟล์_Kamonwantanakun/สร้างระบบฐานข้อมูล/23_06_2026/phaopanya-scgjwd-final-test-tong/src/0_core_system/14_Utils.gs#L771))
  * ฟังก์ชัน `saveChunkedCache_` จะแปลงข้อมูลเป็น JSON และคำนวณแบ่งเก็บเป็นบล็อกเล็ก ๆ (Chunk 0, Chunk 1, ...) และบันทึกจำนวนบล็อกทั้งหมดไว้ที่ `key_CHUNKS`
  * เมื่อโหลดข้อมูล ฟังก์ชัน `loadChunkedCache_` จะดึง chunks ทั้งหมดมาประกอบร่างคืนกลับเป็นข้อมูลเต็มโดยอัตโนมัติ

### 🚫 ปัญหาที่ 2: ข้อมูลไม่อัปเดต/ค้าง (Stale Cache & Missing Invalidation)
* **สาเหตุ:** เมื่อระบบบันทึกพิกัดใหม่ หรือเพิ่มคนขับใหม่ แต่ไม่มีการล้าง Cache ในหน่วยความจำ RAM และ CacheService ทำให้ระบบประมวลผลด้วยข้อมูลเดิม ส่งผลให้ข้อมูลล่าสุดไม่ถูกจับคู่
* **วิธีแก้ปัจจุบัน:** ติดระบบ **Invalidation Chain** (ห่วงโซ่การเคลียร์ Cache)
  * ทุกฟังก์ชันการเขียนข้อมูล (Write Operations) เช่น `createPerson()`, `createPlace()`, `createGeoPoint()` จะเรียกใช้ฟังก์ชันเคลียร์ Cache เฉพาะตัวของมันเสมอ (เช่น `invalidatePersonCache_()`)
  * รวมศูนย์คำสั่งไว้ที่ `invalidateAllGlobalCaches()` ใน [01_Config.gs](file:///g:/ไดรฟ์ของฉัน/แชร์ไฟล์_Kamonwantanakun/สร้างระบบฐานข้อมูล/23_06_2026/phaopanya-scgjwd-final-test-tong/src/0_core_system/01_Config.gs#L88) ซึ่งจะสั่งล้าง RAM Cache 11 ตัว และเคลียร์ CacheService Key ทั้งหมด 13 ตัวพร้อมกัน เพื่อให้ระบบดึงข้อมูลจากตารางจริงใหม่ทั้งหมดเมื่อเริ่มทำ pipeline รอบถัดไป

### 🚫 ปัญหาที่ 3: ระบบล่มจาก Quota Exceeded หรือข้อจำกัดชั่วคราว (Transient Errors)
* **สาเหตุ:** บางครั้งเซิร์ฟเวอร์ของ Google เกิดการขัดข้องชั่วคราว ทำให้คำสั่ง `cache.get()` หรือ `cache.put()` ปล่อย Exception ออกมาขัดจังหวะการทำงานจนโปรเจกต์หยุดทำงานกลางคัน
* **วิธีแก้ปัจจุบัน:** พัฒนา **Safe Cache Wrappers** (ใน [14_Utils.gs](file:///g:/ไดรฟ์ของฉัน/แชร์ไฟล์_Kamonwantanakun/สร้างระบบฐานข้อมูล/23_06_2026/phaopanya-scgjwd-final-test-tong/src/0_core_system/14_Utils.gs#L1051))
  * ครอบคำสั่งด้วย `safeCacheGet_()`, `safeCachePut_()` และ `safeCacheRemoveAll_()` ซึ่งมี `try-catch` คอยดักจับ Error และเปลี่ยนไปใช้การเขียนคำเตือนลง `logWarn` แทนการสั่งสคริปต์หยุดทำงาน (Fail-safe)

---

## 2. 🗺️ โครงสร้างฟังก์ชันการเคลียร์ Cache (Invalidation Map)

ตารางแสดงความเชื่อมโยงของการเขียนข้อมูลกับการล้าง Cache (เพื่อให้มั่นใจว่าระบบไม่มีจุดอับข้อมูลค้าง):

| จุดที่มีการเขียนข้อมูล (Write Operation) | ฟังก์ชันล้าง Cache ที่เรียกใช้งาน | RAM Cache ที่ถูกล้าง | CacheService Key ที่ถูกล้าง |
|---|---|---|---|
| `createPerson()` <br>(06_PersonService) | `invalidatePersonCache_()` <br>`invalidateAliasCache_()` | `_PERSON_NOTE_INVERTED_INDEX`<br>`_PERSON_ALIAS_INVERTED_INDEX` | `M_PERSON_ALL`<br>`M_PERSON_ALIAS_ALL` |
| `createPlace()` <br>(07_PlaceService) | `invalidatePlaceCache_()` <br>`invalidatePlaceAliasCache_()` | `_GLOBAL_GEO_DICT_CACHE_PLACE`<br>`_PLACE_ALIAS_INVERTED_INDEX` | `M_PLACE_ALL`<br>`M_PLACE_ALIAS_ALL` |
| `createGeoPoint()` <br>(08_GeoService) | `invalidateGeoCache_()` | `_GLOBAL_GEO_POINTS_CACHE` | `M_GEO_ALL` |
| `populateGeoMetadata()` <br>(20_ThGeoService) | `invalidateGeoDictCache()` <br>`invalidatePlaceCache_()` | `_GLOBAL_GEO_DICT_CACHE`<br>`_GLOBAL_GEO_DICT_PROVINCE_INDEX`<br>`_GLOBAL_GEO_DICT_SEARCH_KEY_INDEX` | `TH_GEO_PROVINCES`<br>`TH_GEO_DISTRICTS`<br>`TH_GEO_POSTCODE_TOTAL`<br>`TH_GEO_POSTCODE_*` |
| `applyAllPendingDecisions()` <br>(12_ReviewService) | `invalidateFactInvoiceCache_()` <br>`invalidateSameDayDestCache_()` | `_FACT_INVOICE_RAM_CACHE`<br>`_SAME_DAY_DEST_CACHE` | (เป็น Local RAM Cache ไม่มีใน CacheService) |

---

## 3. 🛡️ สรุปความปลอดภัยและคำแนะนำสำหรับการรัน
* **ความเสี่ยงในปัจจุบัน:** 🟢 **ต่ำมาก**
* **ข้อแนะนำ:** หากใช้งานไปเรื่อย ๆ แล้วพบว่าการเปลี่ยนแปลงบนหน้าชีตไม่ส่งผลลัพธ์ในการประมวลผลทันที ให้เข้าไปกดเมนู:
  👉 **`LMDS` > `ระบบ` > `ล้างข้อมูลในระบบ (Clear Cache)`**
  เมนูนี้จะเรียกฟังก์ชัน `invalidateAllGlobalCaches()` เพื่อบังคับล้างความจำสำรองทุกอย่างในระบบทันที และนำเข้าข้อมูลใหม่จากตารางชีตทั้งหมดในรอบการรันต่อไป
