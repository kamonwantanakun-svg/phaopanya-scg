/**
 * VERSION: 6.0.006
 * FILE: 18_ServiceSCG.gs
 * LMDS V5.5 — SCG API Service (Group 2 Commander)
 * ===================================================
 * PURPOSE:
 *   ดึงข้อมูลการจัดส่งจาก SCG API → เขียนลงตารางงานประจำวัน
 *   แล้วเรียก Module 17 จับคู่พิกัด พร้อมสร้างสรุปเจ้าของสินค้า/Shipment
 *   เป็น Commander ของ Group 2 (Daily Ops)
 * ===================================================
 * ===================================================
 * CHANGELOG: See /docs/CHANGELOG.md for full history.
 *   Latest 3 versions:
 *     v5.5.022 (2026-06-26) — CONSISTENCY SYNC + DEEP DIVE FIX (BUG-M01/M02/M03/H02/H03/C01 + 6 cache/config fixes)
 *     v5.5.021 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 *     v5.5.020 (2026-06-22) — REFACTOR_CYCLE6_RESIDUAL (REF-005 cleanup + REF-011 pilot)
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES (Load Order):
 *     - 01_Config.gs          (SHEET.DAILY_JOB, SCG_CONFIG, APP_CONST, DATA_IDX)
 *     - 02_Schema.gs          (SCHEMA[SHEET.DAILY_JOB])
 *     - 03_SetupSheets.gs     (logInfo, logWarn, logError)
 *   CALLS (Invokes):
 *     - applyMasterCoordinatesToDailyJob() → 18_ServiceSCG.gs (self — calls Module 17)
 *     - runLookupEnrichment()              → 17_SearchService.gs
 *   EXPORTS TO:
 *     - 00_App.gs             (fetchDataFromSCGJWD, applyMasterCoordinatesToDailyJob, clearAllSCGSheets_UI)
 *   SHEETS ACCESSED:
 *     - SHEET.DAILY_JOB       (Read+Write: SCG API data + aggregated columns)
 *     - SHEET.INPUT           (Read: Cookie + Shipment numbers)
 *     - SHEET.EMPLOYEE        (Read: Employee data)
 *     - SHEET.OWNER_SUMMARY   (Write: สรุปเจ้าของสินค้า)
 *     - SHEET.SHIPMENT_SUM    (Write: สรุป_Shipment)
 * ===================================================
 * ARCHITECTURE:
 *   ┌───────────────────────────────────────────────────────────────────────┐
 *   │  18_ServiceSCG.gs (Group 2 Commander — SCG Data Pipeline)             │
 *   │  ├── fetchDataFromSCGJWD() — Orchestrator (Lock + steps)              │
 *   │  │   ├── [AuthZ Guard] ป้องกันคนไม่มีสิทธิ์เรียกใช้งาน                     │
 *   │  │   ├── 1. readInputConfig_() → {cookie, shipmentString}             │
 *   │  │   ├── 2. callSCGApi_(cfg) → responseText                           │
 *   │  │   ├── 3. flattenShipmentsToRows_(shipments) → []                   │
 *   │  │   ├── 4. aggregateShopData_(allFlatData) → mutates                 │
 *   │  │   └── 5. writeDailyJobSheet_(ss, allFlatData) [ใช้ clearContent]   │
 *   │  │   ├── 6. applyMasterCoordinatesToDailyJob() [Properties Lock]      │
 *   │  │   ├── 7. buildOwnerSummary()                                       │
 *   │  │   └── 8. buildShipmentSummary()                                    │
 *   │  ├── fetchWithRetry_() — HTTP retry without PII leak in error         │
 *   │  ├── checkIsEPOD_() — E-POD eligibility (ReDoS safe regex)            │
 *   │  ├── getSCGCookie_() — [REVERTED] อ่านจาก B1 ก่อน → fallback Properties │
 *   │  └── clearAllSCGSheets_UI() — ใช้ clearContent() แทน deleteRows()       │
 *   └───────────────────────────────────────────────────────────────────────┘
 * ===================================================
 */

// [RF-01] EPOD_OWNERS ย้ายไป SCG_CONFIG.EPOD_OWNERS ใน 01_Config.gs แล้ว
// ใช้ SCG_CONFIG.EPOD_OWNERS แทน module-level const

// ============================================================
// SECTION 0: Security Helpers (SEC-003 Fix)
// ============================================================

/**
 * sanitizeCookie_ — [SEC-003 / REVERTED v5.5.022-hotfix]
 * ทำความสะอาด Cookie แบบ minimal: ตัด control characters + CRLF เท่านั้น
 * ไม่ตรวจ regex whitelist เพราะ Cookie จริงจาก Browser มักมีอักขระพิเศษ
 * เช่น ! $ & ' ( ) * + - . / : ; < = > ? @ [ ] ^ _ ` { | } ~
 * @param {string} raw - Cookie ดิบจากผู้ใช้
 * @return {string} Cookie ที่ผ่านการ sanitize (เอาเฉพาะ CRLF/control chars ออก)
 * @throws {Error} ถ้า Cookie เป็นค่าว่าง หรือ สั้นเกินไป
 */
function sanitizeCookie_(raw) {
  let clean = String(raw || '').trim();

  if (!clean) {
    throw new Error('Cookie ไม่สามารถเป็นค่าว่าง');
  }

  // [SEC-003] ป้องกัน CRLF Injection — ลบ CR, LF, และ Control Characters (0x00-0x1F, 0x7F)
  // ไม่ throw — ใช้ replace แทน เพื่อรองรับ cookie ที่อาจมี whitespace แปลกๆ จากการ copy
  if (/[\r\n\x00-\x1f\x7f]/.test(clean)) {
    clean = clean.replace(/[\r\n\x00-\x1f\x7f]/g, '');
    logWarn('ServiceSCG', '[sanitizeCookie_] ตรวจพบและลบ Control Characters ออกจาก Cookie');
  }

  // ตรวจความยาวต่ำเกินไป (Cookie ที่ถูกต้องมักยาวกว่า 10 ตัวอักษร)
  if (clean.length < 10) {
    throw new Error(
      'Cookie สั้นเกินไป (' + clean.length + ' ตัวอักษร)\n' + 'Cookie ที่ถูกต้องมักมีความยาวอย่างน้อย 10 ตัวอักษร'
    );
  }

  return clean;
}

// ============================================================
// SECTION 0a: buildShopKey_ — [FIX BUG-AUDIT-014B V5.5.042]
//   Normalize ShopKey ที่ใช้ join ระหว่าง Source sheet กับ DAILY_JOB
//   เดิมใช้แค่ .trim() → ถ้า SCG API ส่ง "SHIP-123|ABC  Store" (double space)
//   หรือ "SHIP-123|abc store" (lowercase) แต่คนขับกรอก "SHIP-123|ABC Store"
//   → join miss แบบเงียบ → DriverVerifiedName/Addr ว่าง
//   แก้โดย: lowercase + collapse internal whitespace ทั้งสองฝั่ง
// ============================================================

/**
 * buildShopKey_ — สร้าง normalized ShopKey สำหรับ join ข้อมูล
 * @param {string} shipmentNo
 * @param {string} shipToName
 * @return {string} "shipmentNo|shipToName" แบบ normalized (lowercase + single-space)
 * @private
 */
function buildShopKey_(shipmentNo, shipToName) {
  const sNo = String(shipmentNo || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const sName = String(shipToName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return sNo + '|' + sName;
}

// ============================================================
// SECTION 1: fetchDataFromSCGJWD — Orchestrator (SRP Split)
// [REFACTOR-01] แยก 7 หน้าที่ออกเป็น 5 helper + orchestrator
// ============================================================

function fetchDataFromSCGJWD() {
  // [FIX v5.5.021 C4] Authorization Guard — ป้องกันคนไม่มีสิทธิ์เรียก API
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ดึงข้อมูลจาก SCG\nกรุณาติดต่อ Admin');
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    // [FIX R12] เปลี่ยน getUi().alert() → safeUiAlert_() — trigger-safe
    safeUiAlert_('⚠️ ระบบคิวทำงาน\nมีผู้ใช้งานอื่นกำลังโหลดข้อมูล Shipment อยู่ กรุณารอสักครู่');
    return;
  }

  const startTime = Date.now();
  const TIME_LIMIT_MS = AI_CONFIG.TIME_LIMIT_MS || 5 * 60 * 1000;

  // [REF-011 V5.5.020 PILOT] Apply withEntryPointGuard_ for standardized error handling
  //   - Preserve Behavior 100%: errorPrefix='เกิดข้อผิดพลาด: ' (same as original alert message)
  //   - finally block (lock release + flushLogBuffer_) handled by guard automatically
  withEntryPointGuard_(
    'ServiceSCG',
    'fetchDataFromSCGJWD',
    function () {
      const ss = SpreadsheetApp.getActiveSpreadsheet();

      // Step 1: อ่าน Cookie + ShipmentNos
      const inputCfg = readInputConfig_(ss);

      // Step 2: เรียก API + retry
      ss.toast('กำลังเชื่อมต่อ SCG Server...', 'System', 10);
      logInfo('ServiceSCG', `Fetching data for ${inputCfg.shipmentString.split(',').length} shipments`);
      const apiResponse = callSCGApi_(inputCfg);

      // Step 3: แปลง JSON → flat row array
      // [FIX v5.5.001] callSCGApi_ ตอนนี้คืน parsed object แล้ว ไม่ต้อง JSON.parse ซ้ำ
      const shipments = apiResponse.data || [];
      if (shipments.length === 0) throw new Error('API Return Success แต่ไม่พบข้อมูล Shipment (Data Empty)');

      ss.toast('กำลังแปลงข้อมูล ' + shipments.length + ' Shipments...', 'Processing', 5);
      const allFlatData = flattenShipmentsToRows_(shipments);

      // Step 4: คำนวณ aggregate per shop
      aggregateShopData_(allFlatData);

      // Step 5: เขียน Sheet
      writeDailyJobSheet_(ss, allFlatData);

      // [FIX B3 v5.5.002] เพิ่ม Time Guard ระหว่าง steps — หยุดจริงถ้าใกล้ timeout
      const elapsedAfterStep5 = Date.now() - startTime;
      if (elapsedAfterStep5 > TIME_LIMIT_MS) {
        logWarn(
          'ServiceSCG',
          `Time Guard: หยุดหลัง Step 5 ใช้เวลา ${Math.round(elapsedAfterStep5 / 1000)}s — ข้าม Step 6-8`
        );
        // [FIX R12] เปลี่ยน ui.alert() → safeUiAlert_() — trigger-safe
        safeUiAlert_(
          `⚠️ ดึงข้อมูลสำเร็จแต่ใกล้ Timeout\n- จำนวนรายการ: ${allFlatData.length} แถว\n- ข้ามการจับคู่พิกัด — กดปุ่ม Enrich แยก`
        );
        return;
      }

      // Step 6-8: Post-processing
      applyMasterCoordinatesToDailyJob();

      // [FIX B6 v5.5.002] อ่าน DAILY_JOB ครั้งเดียว ส่งให้ทั้ง 2 summary functions
      const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
      const dailyData = dataSheet
        .getRange(2, 1, dataSheet.getLastRow() - 1, SCHEMA[SHEET.DAILY_JOB].length)
        .getValues();
      buildOwnerSummary(dailyData);
      buildShipmentSummary(dailyData);

      logInfo('ServiceSCG', `import ${allFlatData.length} records successfully`);

      // [FIX R12] เปลี่ยน ui.alert() → safeUiAlert_() — trigger-safe
      safeUiAlert_(`✅ ดึงข้อมูลสำเร็จ!\n- จำนวนรายการ: ${allFlatData.length} แถว\n- จับคู่พิกัด: เรียบร้อย`);
    },
    { lock: lock, errorPrefix: 'เกิดข้อผิดพลาด: ' }
  );
}

// ============================================================
// SECTION 1a: readInputConfig_ — อ่าน Cookie + ShipmentNos
// ============================================================

/**
 * readInputConfig_ — [REFACTOR-01] อ่านข้อมูล Input จากชีต Input
 * [REVERTED v5.5.022-hotfix] อ่าน Cookie จากเซลล์ B1 ตรงๆ เหมือน V5.0
 *   ผู้ใช้วาง Cookie ใน B1 โดยตรง — ไม่ใช้ PropertiesService migration
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {{cookie: string, shipmentString: string}}
 */
function readInputConfig_(ss) {
  const inputSheet = ss.getSheetByName(SCG_CONFIG.SHEET_INPUT);
  const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
  if (!inputSheet || !dataSheet) throw new Error('CRITICAL: ไม่พบชีต Input หรือ Data');

  // [REVERTED v5.5.022-hotfix] อ่าน Cookie จากเซลล์ B1 ตรงๆ (เหมือน V5.0)
  //   ถ้า B1 ว่าง → ค่อย fallback ไป Script Properties (ยังรองรับ SEC-001 แบบ optional)
  const rawCookie = String(inputSheet.getRange(SCG_CONFIG.COOKIE_CELL).getValue() || '').trim();
  let cookie = '';
  if (rawCookie) {
    // มี Cookie ใน B1 — sanitize minimal แล้วใช้ได้เลย
    cookie = sanitizeCookie_(rawCookie);
  } else {
    // Fallback: อ่านจาก Script Properties (สำหรับผู้ใช้ที่ตั้งผ่านเมนู setSCGCookie_UI)
    const fromProps = PropertiesService.getScriptProperties().getProperty('SCG_COOKIE');
    if (fromProps) {
      cookie = fromProps;
      logInfo('ServiceSCG', 'อ่าน Cookie จาก Script Properties (B1 ว่าง)');
    }
  }
  if (!cookie) {
    throw new Error(
      '❌ กรุณาวาง Cookie ในช่อง ' +
        SCG_CONFIG.COOKIE_CELL +
        ' ของชีต Input หรือตั้งค่าผ่านเมนู LMDS > ระบบ > ตั้งค่า SCG Cookie'
    );
  }

  const lastRow = inputSheet.getLastRow();
  if (lastRow < SCG_CONFIG.INPUT_START_ROW) throw new Error('ℹ️ ไม่พบเลข Shipment ในชีต Input');

  const shipmentNumbers = inputSheet
    .getRange(SCG_CONFIG.INPUT_START_ROW, 1, lastRow - SCG_CONFIG.INPUT_START_ROW + 1, 1)
    .getValues()
    .flat()
    .map((r) => String(r || '').trim())
    .filter(Boolean);

  if (shipmentNumbers.length === 0) throw new Error('ℹ️ รายการ Shipment ว่างเปล่า');

  // เขียนเลข Shipment ต่อกันคั่นด้วยจุลภาคลงในช่อง B3
  const shipmentString = shipmentNumbers.join(',');
  inputSheet.getRange(SCG_CONFIG.SHIPMENT_STRING_CELL).setValue(shipmentString).setHorizontalAlignment('left');

  return { cookie, shipmentString };
}

// ============================================================
// SECTION 1a2: SCG Cookie Management (SEC-001 Fix)
// ============================================================

/**
 * setSCGCookie_UI — [REVERTED v5.5.022-hotfix] ตั้งค่า SCG Cookie ผ่าน UI Prompt
 *   เขียนลงเซลล์ B1 ในชีต Input (เหมือน V5.0) แทน PropertiesService
 *   ผู้ใช้สามารถวาง Cookie ใน B1 โดยตรง หรือใช้เมนูนี้ก็ได้
 */
function setSCGCookie_UI() {
  // [SEC-002] Authorization Guard — เฉพาะ Admin เท่านั้นที่ตั้งค่า Cookie ได้
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ตั้งค่า SCG Cookie\nกรุณาติดต่อ Admin');
    return;
  }
  try {
    const ui = SpreadsheetApp.getUi();
    const result = ui.prompt(
      '🔐 ตั้งค่า SCG Cookie',
      'วาง Cookie จาก Browser (DevTools > Network > Request Headers > cookie):\n\n' +
        '(Cookie จะถูกเก็บในเซลล์ ' +
        SCG_CONFIG.COOKIE_CELL +
        ' ของชีต Input)',
      ui.ButtonSet.OK_CANCEL
    );

    if (result.getSelectedButton() !== ui.Button.OK) return;

    const rawCookie = String(result.getResponseText() || '').trim();
    if (!rawCookie) {
      safeUiAlert_('❌ Cookie ไม่สามารถเป็นค่าว่างได้');
      return;
    }

    // [SEC-003 minimal] Sanitize — เอาเฉพาะ CRLF/control chars ออก
    const cleanCookie = sanitizeCookie_(rawCookie);

    // [REVERTED v5.5.022-hotfix] เขียนลงเซลล์ B1 แทน PropertiesService
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const inputSheet = ss.getSheetByName(SCG_CONFIG.SHEET_INPUT);
    if (!inputSheet) {
      throw new Error('ไม่พบชีต Input');
    }
    inputSheet.getRange(SCG_CONFIG.COOKIE_CELL).setValue(cleanCookie);

    // ล้าง SCG_COOKIE ใน Script Properties ด้วย (กัน conflict)
    try {
      PropertiesService.getScriptProperties().deleteProperty('SCG_COOKIE');
    } catch (e) {
      /* ignore */
    }

    logInfo('ServiceSCG', 'ตั้งค่า SCG Cookie สำเร็จ (เซลล์ ' + SCG_CONFIG.COOKIE_CELL + ')');
    // [FIX v5.5.021 C7] ไม่ echo ค่า cookie กลับให้ User ป้องกัน PII Leak
    safeUiAlert_(
      '✅ ตั้งค่า SCG Cookie สำเร็จ!\n\nCookie ถูกเก็บในเซลล์ ' + SCG_CONFIG.COOKIE_CELL + ' ของชีต Input แล้ว'
    );
  } catch (e) {
    logError('ServiceSCG', 'setSCGCookie_UI ล้มเหลว: ' + e.message, e);
    safeUiAlert_('❌ ตั้งค่า Cookie ล้มเหลว: ' + e.message);
  }
}

/**
 * getSCGCookie_ — [REVERTED v5.5.022-hotfix] อ่าน Cookie
 *   Priority: เซลล์ B1 (Input sheet) → Script Properties (fallback)
 *   ไม่ migrate — ไม่ clearContent B1 (กัน Cookie "หาย" จากเซลล์)
 *   เก็บฟังก์ชันนี้ไว้สำหรับ backward compatibility (ถ้ามี code อื่นยังเรียกใช้)
 * @return {string} Cookie value
 */
function getSCGCookie_() {
  // 1. Priority: อ่านจากเซลล์ B1 (ผู้ใช้วางตรงนี้)
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const inputSheet = ss.getSheetByName(SCG_CONFIG.SHEET_INPUT);
    if (inputSheet) {
      const fromCell = String(inputSheet.getRange(SCG_CONFIG.COOKIE_CELL).getValue() || '').trim();
      if (fromCell) {
        // Sanitize minimal (CRLF/control chars only) แล้วคืน
        return sanitizeCookie_(fromCell);
      }
    }
  } catch (e) {
    logWarn('ServiceSCG', 'อ่าน Cookie จาก B1 ล้มเหลว: ' + e.message);
  }

  // 2. Fallback: Script Properties (สำหรับผู้ที่ตั้งผ่าน setSCGCookie_UI ใน V5.5.017-021)
  try {
    const fromProps = PropertiesService.getScriptProperties().getProperty('SCG_COOKIE');
    if (fromProps) return fromProps;
  } catch (e) {
    logWarn('ServiceSCG', 'อ่าน Cookie จาก Script Properties ล้มเหลว: ' + e.message);
  }

  return ''; // ไม่พบ Cookie ทั้ง 2 แหล่ง
}

// ============================================================
// SECTION 1b: callSCGApi_ — HTTP call + retry
// ============================================================

/**
 * callSCGApi_ — [REFACTOR-01] เรียก SCG API เท่านั้น
 * @param {{cookie: string, shipmentString: string}} inputCfg
 * @return {Object} parsed API response
 */
function callSCGApi_(inputCfg) {
  const payload = {
    DeliveryDateFrom: '',
    DeliveryDateTo: '',
    TenderDateFrom: '',
    TenderDateTo: '',
    CarrierCode: '',
    CustomerCode: '',
    OriginCodes: '',
    ShipmentNos: inputCfg.shipmentString
  };

  const options = {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true,
    headers: { cookie: inputCfg.cookie }
  };

  const responseText = fetchWithRetry_(SCG_CONFIG.API_URL, options, APP_CONST.MAX_RETRIES || 3);

  // [FIX v5.5.001] try-catch รอบ JSON.parse เพื่อ handle non-JSON responses
  try {
    return JSON.parse(responseText);
  } catch (parseErr) {
    // [SEC-004] ไม่บันทึก Response Preview ลง SYS_LOG เพื่อป้องกัน PII Leakage
    logError(
      'ServiceSCG',
      `callSCGApi_ JSON.parse ล้มเหลว: ${parseErr.message}. Response length: ${String(responseText).length} chars`,
      parseErr
    );
    throw new Error(`SCG API ตอบกลับไม่ใช่ JSON ที่ถูกต้อง: ${parseErr.message}`);
  }
}

// ============================================================
// SECTION 1c: flattenShipmentsToRows_ — JSON → flat rows
// ============================================================

/**
 * flattenShipmentsToRows_ — [REFACTOR-01] แปลง Shipments JSON → flat row array
 * @param {Array} shipments - ข้อมูล shipments จาก API
 * @return {Array[]} allFlatData - array ของ row arrays
 */
function flattenShipmentsToRows_(shipments) {
  const allFlatData = [];
  let runningRow = 2;

  shipments.forEach((shipment) => {
    const destSet = new Set();
    (shipment.DeliveryNotes || []).forEach((n) => {
      if (n.ShipToName) destSet.add(n.ShipToName);
    });
    const destListStr = Array.from(destSet).join(', ');

    (shipment.DeliveryNotes || []).forEach((note) => {
      (note.Items || []).forEach((item) => {
        allFlatData.push(buildDailyJobRow_(shipment, note, item, destSet.size, destListStr, runningRow));
        runningRow++;
      });
    });
  });

  return allFlatData;
}

/**
 * buildDailyJobRow_ — [REFACTOR-01] สร้าง 1 row ของตารางงานประจำวัน
 * ใช้ DATA_IDX.* แทน hardcode index (Law 3 compliance)
 * @return {Array} row array
 */
function buildDailyJobRow_(shipment, note, item, destCount, destListStr, rowNum) {
  const row = new Array(SCHEMA[SHEET.DAILY_JOB].length).fill('');
  row[DATA_IDX.JOB_ID] = (note.PurchaseOrder || '') + '-' + rowNum;
  // [FIX v5.5.021 M3] ป้องกัน Date('invalid')
  const pd = note.PlanDelivery ? new Date(note.PlanDelivery) : null;
  row[DATA_IDX.PLAN_DELIVERY] = pd && !isNaN(pd.getTime()) ? pd : null;
  row[DATA_IDX.INVOICE_NO] = String(note.PurchaseOrder || '');
  row[DATA_IDX.SHIPMENT_NO] = String(shipment.ShipmentNo || '');
  row[DATA_IDX.DRIVER_NAME] = shipment.DriverName || '';
  row[DATA_IDX.TRUCK_LICENSE] = shipment.TruckLicense || '';
  row[DATA_IDX.CARRIER_CODE] = String(shipment.CarrierCode || '');
  row[DATA_IDX.CARRIER_NAME] = shipment.CarrierName || '';
  row[DATA_IDX.SOLD_TO_CODE] = String(note.SoldToCode || '');
  row[DATA_IDX.SOLD_TO_NAME] = note.SoldToName || '';
  row[DATA_IDX.SHIP_TO_NAME] = note.ShipToName || '';
  row[DATA_IDX.SHIP_TO_ADDR] = note.ShipToAddress || '';
  row[DATA_IDX.LATLNG_SCG] =
    note.ShipToLatitude != null && note.ShipToLongitude != null
      ? note.ShipToLatitude + ', ' + note.ShipToLongitude
      : '';
  row[DATA_IDX.MATERIAL] = item.MaterialName || '';
  row[DATA_IDX.QTY] = item.ItemQuantity || 0;
  row[DATA_IDX.QTY_UNIT] = item.QuantityUnit || '';
  row[DATA_IDX.WEIGHT] = item.ItemWeight || 0;
  row[DATA_IDX.DELIVERY_NO] = String(note.DeliveryNo || '');
  row[DATA_IDX.DEST_COUNT] = destCount;
  row[DATA_IDX.DEST_LIST] = destListStr;
  row[DATA_IDX.SCAN_STATUS] = 'รอสแกน';
  row[DATA_IDX.DELIVERY_STATUS] = 'ยังไม่ได้ส่ง';
  row[DATA_IDX.SHOP_KEY] = buildShopKey_(shipment.ShipmentNo, note.ShipToName); // [FIX BUG-AUDIT-014B V5.5.042] normalize ด้วย buildShopKey_
  return row;
}

// ============================================================
// SECTION 1d: aggregateShopData_ — คำนวณ qty/weight/epod per shop
// ============================================================

/**
 * aggregateShopData_ — [REFACTOR-01] คำนวณสรุปร้านค้า (mutates allFlatData)
 * @param {Array[]} allFlatData - flat row array (จะถูกแก้ไขโดยตรง)
 */
function aggregateShopData_(allFlatData) {
  if (!allFlatData || allFlatData.length === 0) return;

  const shopAgg = {};
  allFlatData.forEach((r) => {
    const key = r[DATA_IDX.SHOP_KEY];
    if (!shopAgg[key]) shopAgg[key] = { qty: 0, weight: 0, invoices: new Set(), epod: 0 };
    shopAgg[key].qty += Number(r[DATA_IDX.QTY]) || 0;
    shopAgg[key].weight += Number(r[DATA_IDX.WEIGHT]) || 0;
    // [FIX v5.5.021 M4] trim invoice ก่อนใส่ Set
    shopAgg[key].invoices.add(String(r[DATA_IDX.INVOICE_NO] || '').trim());
    if (checkIsEPOD_(r[DATA_IDX.SOLD_TO_NAME], r[DATA_IDX.INVOICE_NO])) shopAgg[key].epod++;
  });

  allFlatData.forEach((r) => {
    const agg = shopAgg[r[DATA_IDX.SHOP_KEY]];
    const scanInv = agg.invoices.size - agg.epod;
    r[DATA_IDX.TOT_QTY] = agg.qty;
    r[DATA_IDX.TOT_WEIGHT] = Number(agg.weight.toFixed(2));
    r[DATA_IDX.SCAN_INV] = scanInv;
    r[DATA_IDX.OWNER_LABEL] = `${r[DATA_IDX.SOLD_TO_NAME]} / รวม ${scanInv} บิล`;
  });
}

// ============================================================
// SECTION 1e: writeDailyJobSheet_ — เขียน Sheet
// ============================================================

/**
 * writeDailyJobSheet_ — [REFACTOR-01] เขียนข้อมูลลงตารางงานประจำวัน
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array[]} allFlatData - flat row array
 */
function writeDailyJobSheet_(ss, allFlatData) {
  const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
  if (!dataSheet) throw new Error('CRITICAL: ไม่พบชีต Data');

  const headers = SCHEMA[SHEET.DAILY_JOB];

  // [FIX v5.5.021 H4 / FIX-TYPO v5.5.022-hotfix] ใช้ clearContents() (มี s) สำหรับ Sheet
  //   Sheet.clearContent() ไม่มี — เป็น Range.clearContent() ที่ไม่มี s
  //   Sheet ใช้ clearContents() รักษา Conditional Formatting ไว้ (intention เดียวกับ H4)
  dataSheet.clearContents();
  // Clear เฉพาะ Background ของข้อมูล ไม่ล้างหมด เพื่อเผื่อมี format ตกค้าง
  if (dataSheet.getLastRow() > 1) {
    dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, dataSheet.getMaxColumns()).setBackground(null);
  }
  dataSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  if (allFlatData.length > 0) {
    dataSheet.getRange(2, 1, allFlatData.length, headers.length).setValues(allFlatData);
    dataSheet.getRange(2, DATA_IDX.PLAN_DELIVERY + 1, allFlatData.length, 1).setNumberFormat('dd/mm/yyyy');
    dataSheet.getRange(2, DATA_IDX.INVOICE_NO + 1, allFlatData.length, 1).setNumberFormat('@');
    dataSheet.getRange(2, DATA_IDX.DELIVERY_NO + 1, allFlatData.length, 1).setNumberFormat('@');
  }
}

// ============================================================
// SECTION 2: fetchWithRetry_ — ดึงข้อมูลพร้อมกลไก Retry
// ============================================================

function fetchWithRetry_(url, options, maxRetries) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() === 200) return response.getContentText();
      // [FIX v5.5.021 C5] ไม่แสดง HTTP body ในข้อความ Error ป้องกัน API Key/Cookie รั่วไหลลง Stackdriver
      throw new Error('HTTP ' + response.getResponseCode());
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      Utilities.sleep(1000 * Math.pow(2, i));
      logWarn('ServiceSCG', `Retry attempt ${i + 1} failed. Retrying...`);
    }
  }
}

// ============================================================
// SECTION 3: checkIsEPOD_ — [REF-019] ตรวจสอบ E-POD ตามเงื่อนไขเจ้าของงาน
// เพิ่ม _ suffix ตามกฎ Private Function (Rule 8 — ใช้ภายในโมดูลเท่านั้น)
// ============================================================

function checkIsEPOD_(ownerName, invoiceNo) {
  if (!ownerName || !invoiceNo) return false;
  const owner = String(ownerName).toUpperCase();
  const inv = String(invoiceNo);

  if (SCG_CONFIG.EPOD_OWNERS.some((w) => owner.includes(w.toUpperCase()))) return true;

  if (owner.includes('DENSO') || owner.includes('เด็นโซ่')) {
    if (inv.includes('_DOC')) return false;
    // [FIX v5.5.021 M6] เปลี่ยน regex capture group เพื่อป้องกัน ReDoS
    if (/^\d+(?:-.*)?$/.test(inv)) return true;
    return false;
  }

  return false;
}

// ============================================================
// SECTION 4: applyMasterCoordinatesToDailyJob
// ============================================================

/**
 * applyMasterCoordinatesToDailyJob
 * เรียก runLookupEnrichment จาก 17_SearchService.gs
 */
function applyMasterCoordinatesToDailyJob() {
  // [FIX v5.5.021 H6] PropertiesService lock ป้องกัน Recursive runLookupEnrichment
  const prop = PropertiesService.getScriptProperties();
  if (prop.getProperty('LOCK_ENRICHMENT') === '1') {
    logWarn('ServiceSCG', 'applyMasterCoordinatesToDailyJob is already running. Skipped.');
    return;
  }
  prop.setProperty('LOCK_ENRICHMENT', '1');

  try {
    logInfo('ServiceSCG', 'applyMasterCoordinates → เรียก Module 17');
    runLookupEnrichment();
    // [ADD v5.5.014] คัดลอก "ชื่อจริง" + "ที่อยู่จริง" จาก Source sheet → DAILY_JOB
    copyDriverVerifiedToDailyJob_();
    // [ADD v5.5.022-PATCH1] Restore Email พนักงาน logic จาก Service_SCG.gs (V5.0)
    //   โหลด EMPLOYEE sheet → map driver name → email → batch write ลง DAILY_JOB col 22
    enrichEmployeeEmailsToDailyJob_();
    logInfo('ServiceSCG', 'applyMasterCoordinates เสร็จสิ้น');
  } catch (err) {
    logError('ServiceSCG', 'applyMasterCoordinates ล้มเหลว: ' + err.message, err);
    // [FIX B4 v5.5.002] เปลี่ยน getUi().alert() → safeUiAlert_() — trigger-safe
    safeUiAlert_('เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    prop.deleteProperty('LOCK_ENRICHMENT');
  }
}

/**
 * enrichEmployeeEmailsToDailyJob_ — [ADD v5.5.022-PATCH1]
 * Restore logic จาก Service_SCG.gs (V5.0) บรรทัด 218-270 ที่หายไปใน refactor
 *
 * Logic:
 *   1. อ่านชีต "ข้อมูลพนักงาน" → สร้าง empMap[normalizedFullName] = email
 *      ใช้ normalizePersonNameFull เพื่อตัดคำนำหน้า (นาย/นาง/บริษัท) และช่องว่าง
 *   2. อ่าน DAILY_JOB ทุกแถว (batch read ครั้งเดียว)
 *   3. สำหรับแต่ละแถว: normalize driver name → lookup email ใน empMap
 *   4. Batch write email ลง DAILY_JOB col DATA_IDX.EMAIL (col 22)
 *
 * @private
 */
function enrichEmployeeEmailsToDailyJob_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const empSheet = ss.getSheetByName(SHEET.EMPLOYEE);
    const djSheet = ss.getSheetByName(SHEET.DAILY_JOB);
    if (!empSheet || !djSheet) {
      logWarn('ServiceSCG', 'enrichEmployeeEmailsToDailyJob_: ไม่พบชีต EMPLOYEE หรือ DAILY_JOB');
      return;
    }
    if (djSheet.getLastRow() < 2) return;

    // 1. โหลด EMPLOYEE → empMap (normalized name → email)
    const empMap = {};
    if (empSheet.getLastRow() >= 2) {
      // ใช้ SCHEMA width (8 cols) ป้องกัน over-read
      const empCols = SCHEMA[SHEET.EMPLOYEE].length;
      const empData = empSheet.getRange(2, 1, empSheet.getLastRow() - 1, empCols).getValues();
      empData.forEach(function (r) {
        const fullName = String(r[EMPLOYEE_IDX.FULL_NAME] || '').trim();
        const email = String(r[EMPLOYEE_IDX.EMAIL] || '').trim();
        if (fullName && email) {
          // Normalize driver name เหมือน Sheet1 — ตัดคำนำหน้า (นาย/นาง/บริษัท) และช่องว่าง
          let normName = fullName;
          try {
            if (typeof normalizePersonNameFull === 'function') {
              const nr = normalizePersonNameFull(fullName);
              if (nr && nr.cleanName && nr.cleanName.length >= 2) {
                normName = nr.cleanName;
              }
            }
          } catch (e) {
            /* fallback ใช้ fullName เดิม */
          }

          // Key ใน empMap ใช้ normalizeForCompare เพื่อ match แบบ forgiving (ไม่สนใจ case/spacing)
          if (typeof normalizeForCompare === 'function') {
            const key = normalizeForCompare(normName);
            if (key) empMap[key] = email;
          } else {
            empMap[String(normName).toLowerCase()] = email;
          }
        }
      });
    }
    logInfo('ServiceSCG', 'enrichEmployeeEmailsToDailyJob_: โหลด EMPLOYEE ' + Object.keys(empMap).length + ' คน');

    // 2. อ่าน DAILY_JOB → lookup email → batch write col EMAIL
    const djCols = SCHEMA[SHEET.DAILY_JOB].length;
    const djData = djSheet.getRange(2, 1, djSheet.getLastRow() - 1, djCols).getValues();

    let updated = 0;
    const emailValues = [];
    djData.forEach(function (r) {
      const driverName = String(r[DATA_IDX.DRIVER_NAME] || '').trim();
      let email = '';
      if (driverName) {
        // Normalize driver name เหมือนตอนโหลด empMap เพื่อ match
        let normName = driverName;
        try {
          if (typeof normalizePersonNameFull === 'function') {
            const nr = normalizePersonNameFull(driverName);
            if (nr && nr.cleanName && nr.cleanName.length >= 2) {
              normName = nr.cleanName;
            }
          }
        } catch (e) {
          /* fallback ใช้ driverName เดิม */
        }

        let key;
        if (typeof normalizeForCompare === 'function') {
          key = normalizeForCompare(normName);
        } else {
          key = String(normName).toLowerCase();
        }
        if (key && empMap[key]) {
          email = empMap[key];
          updated++;
        }
      }
      emailValues.push([email]);
    });

    // 3. Batch write email ลง col DATA_IDX.EMAIL (1-based = EMAIL + 1)
    const emailCol = DATA_IDX.EMAIL + 1;
    djSheet.getRange(2, emailCol, emailValues.length, 1).setValues(emailValues);
    logInfo(
      'ServiceSCG',
      'enrichEmployeeEmailsToDailyJob_: เติม Email พนักงาน ' + updated + '/' + emailValues.length + ' แถว'
    );
  } catch (e) {
    logError('ServiceSCG', 'enrichEmployeeEmailsToDailyJob_ ล้มเหลว: ' + e.message, e);
  }
}

/**
 * copyDriverVerifiedToDailyJob_ — [ADD v5.5.014]
 * คัดลอก "ชื่อลูกค้าปลายทางจริง" + "ชื่อสถานที่อยู่ลูกค้าปลายทางจริง" จาก Source sheet → DAILY_JOB
 * ใช้ ShopKey (ShipmentNo|ShipToName) เป็น lookup key ระหว่าง 2 ชีต
 * ถ้า Source sheet ไม่มีข้อมูลจริง → DAILY_JOB col 29-30 จะว่าง (ไม่ error)
 */
function copyDriverVerifiedToDailyJob_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(SHEET.SOURCE);
    const dailyJobSheet = ss.getSheetByName(SHEET.DAILY_JOB);
    if (!sourceSheet || !dailyJobSheet) return;

    // อ่าน Source sheet: ShipmentNo(7), ShipToName(12), DriverVerifiedName(37), DriverVerifiedAddr(38)
    const srcLastRow = sourceSheet.getLastRow();
    if (srcLastRow < 2) return;
    const srcCols = Math.max(SRC_IDX.DRIVER_VERIFIED_ADDR + 1, sourceSheet.getLastColumn());
    const srcData = sourceSheet.getRange(2, 1, srcLastRow - 1, srcCols).getValues();

    // สร้าง lookup: "ShipmentNo|ShipToName" → { driverVerifiedName, driverVerifiedAddr }
    const lookup = {};
    srcData.forEach(function (r) {
      const shipmentNo = String(r[SRC_IDX.SHIPMENT_NO] || '').trim();
      const shipToName = String(r[SRC_IDX.RAW_PERSON_NAME] || '').trim();
      const dvName = String(r[SRC_IDX.DRIVER_VERIFIED_NAME] || '').trim();
      const dvAddr = String(r[SRC_IDX.DRIVER_VERIFIED_ADDR] || '').trim();
      if (shipmentNo && shipToName) {
        // [FIX BUG-AUDIT-014B V5.5.042] ใช้ buildShopKey_ เพื่อ normalize
        //   ให้ตรงกับฝั่ง buildDailyJobRow_ → กัน join miss แบบเงียบ
        const key = buildShopKey_(shipmentNo, shipToName);
        // [FIX CRIT-003] merge mode — เติม field ที่ว่าง แทน one-shot
        if (!lookup[key]) lookup[key] = { name: '', addr: '' };
        if (dvName && !lookup[key].name) lookup[key].name = dvName;
        if (dvAddr && !lookup[key].addr) lookup[key].addr = dvAddr;
      }
    });

    // อ่าน DAILY_JOB และเติม col 29-30
    const djLastRow = dailyJobSheet.getLastRow();
    if (djLastRow < 2) return;
    const djCols = SCHEMA[SHEET.DAILY_JOB].length;
    const djData = dailyJobSheet.getRange(2, 1, djLastRow - 1, djCols).getValues();

    let updated = 0;
    const nameCol = DATA_IDX.DRIVER_VERIFIED_NAME + 1; // 1-based for setValues
    const addrCol = DATA_IDX.DRIVER_VERIFIED_ADDR + 1;

    djData.forEach(function (r, i) {
      const shopKey = String(r[DATA_IDX.SHOP_KEY] || '').trim();
      const dv = lookup[shopKey];
      if (dv) {
        let changed = false;
        if (dv.name && !r[DATA_IDX.DRIVER_VERIFIED_NAME]) {
          r[DATA_IDX.DRIVER_VERIFIED_NAME] = dv.name;
          changed = true;
        }
        if (dv.addr && !r[DATA_IDX.DRIVER_VERIFIED_ADDR]) {
          r[DATA_IDX.DRIVER_VERIFIED_ADDR] = dv.addr;
          changed = true;
        }
        if (changed) updated++;
      }
    });

    if (updated > 0) {
      // เขียนเฉพาะ col 29-30 (ไม่เขียนทั้งแถว เพื่อลด API calls)
      const nameRange = dailyJobSheet.getRange(2, nameCol, djLastRow - 1, 1);
      const addrRange = dailyJobSheet.getRange(2, addrCol, djLastRow - 1, 1);

      // [FIX v5.5.021 H5] Map ครั้งเดียวลด Overhead
      const nameValues = [];
      const addrValues = [];
      djData.forEach(function (r) {
        nameValues.push([r[DATA_IDX.DRIVER_VERIFIED_NAME] || '']);
        addrValues.push([r[DATA_IDX.DRIVER_VERIFIED_ADDR] || '']);
      });

      nameRange.setValues(nameValues);
      addrRange.setValues(addrValues);
      logInfo('ServiceSCG', 'copyDriverVerifiedToDailyJob_: คัดลอกข้อมูลจริง ' + updated + ' แถว');
    }
  } catch (e) {
    logError('ServiceSCG', 'copyDriverVerifiedToDailyJob_ ล้มเหลว: ' + e.message, e);
  }
}

// ============================================================
// SECTION 5: buildOwnerSummary — [REF-017] thin wrapper
// ============================================================

function buildOwnerSummary(optData) {
  // [FIX R12] เพิ่ม try-catch — menu entry point ต้องมี error handling
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
    if (!dataSheet || dataSheet.getLastRow() < 2) return;

    const data =
      optData || dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, SCHEMA[SHEET.DAILY_JOB].length).getValues();

    // [REF-017] ใช้ buildSummarySheet_() แทน duplicate logic
    buildSummarySheet_(
      data,
      SHEET.OWNER_SUMMARY,
      ss,
      // groupKeyFn: รวมตาม SoldToName
      function (r) {
        const ownerName = r[DATA_IDX.SOLD_TO_NAME];
        return ownerName || null;
      },
      // rowBuildFn: สร้าง row จาก aggregated map entry
      function (owner, agg, numCols) {
        const row = new Array(numCols).fill('');
        row[OWNER_SUM_IDX.SOLD_TO] = owner;
        row[OWNER_SUM_IDX.QTY_ALL] = agg.all.size;
        row[OWNER_SUM_IDX.QTY_EPOD] = agg.epod.size;
        row[OWNER_SUM_IDX.LAST_UPDATE] = new Date();
        return row;
      },
      // formatFn: จัด number format
      // [FIX v5.5.022-PATCH1] แยก setNumberFormat ทีละคอลัมน์ เพื่อหลีกเลี่ยง GAS error
      //   "โปรดเลือกภายในคอลัมน์เดียวเพื่อดำเนินการระดับคอลัมน์" เมื่อใช้ range 2 cols กับ format "#,##0"
      //   ที่ GAS runtime บางครั้งแยกตาม comma เป็น array หลาย format
      function (summarySheet, rows, numCols) {
        if (rows.length > 0) {
          summarySheet.getRange(2, OWNER_SUM_IDX.QTY_ALL + 1, rows.length, 1).setNumberFormat('#,##0');
          summarySheet.getRange(2, OWNER_SUM_IDX.QTY_EPOD + 1, rows.length, 1).setNumberFormat('#,##0');
          summarySheet.getRange(2, OWNER_SUM_IDX.LAST_UPDATE + 1, rows.length, 1).setNumberFormat('dd/mm/yyyy HH:mm');
        }
      }
    );
  } catch (e) {
    logError('ServiceSCG', 'buildOwnerSummary ล้มเหลว: ' + e.message, e);
  }
}

// ============================================================
// SECTION 6: buildShipmentSummary — [REF-017] thin wrapper
// ============================================================

function buildShipmentSummary(optData) {
  // [FIX R12] เพิ่ม try-catch — menu entry point ต้องมี error handling
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
    if (!dataSheet || dataSheet.getLastRow() < 2) return;

    const data =
      optData || dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, SCHEMA[SHEET.DAILY_JOB].length).getValues();

    // [REF-017] ใช้ buildSummarySheet_() แทน duplicate logic
    buildSummarySheet_(
      data,
      SHEET.SHIPMENT_SUM,
      ss,
      // groupKeyFn: รวมตาม ShipmentNo + TruckLicense
      function (r) {
        const shipmentNo = r[DATA_IDX.SHIPMENT_NO];
        const truckLicense = r[DATA_IDX.TRUCK_LICENSE];
        if (!shipmentNo || !truckLicense) return null;
        return shipmentNo + '_' + truckLicense;
      },
      // rowBuildFn: สร้าง row จาก aggregated map entry
      function (key, agg, numCols) {
        const row = new Array(numCols).fill('');
        row[SHIPMENT_SUM_IDX.SHIPMENT_KEY] = key;
        row[SHIPMENT_SUM_IDX.SHIPMENT_NO] = agg.shipmentNo;
        row[SHIPMENT_SUM_IDX.TRUCK] = agg.truck;
        row[SHIPMENT_SUM_IDX.QTY_ALL] = agg.all.size;
        row[SHIPMENT_SUM_IDX.QTY_EPOD] = agg.epod.size;
        row[SHIPMENT_SUM_IDX.LAST_UPDATE] = new Date();
        return row;
      },
      // formatFn: จัด number format
      // [FIX v5.5.022-PATCH1] แยก setNumberFormat ทีละคอลัมน์ เพื่อหลีกเลี่ยง GAS error
      //   "โปรดเลือกภายในคอลัมน์เดียวเพื่อดำเนินการระดับคอลัมน์" เมื่อใช้ range 2 cols กับ format "#,##0"
      //   ที่ GAS runtime บางครั้งแยกตาม comma เป็น array หลาย format
      function (summarySheet, rows, numCols) {
        if (rows.length > 0) {
          summarySheet.getRange(2, SHIPMENT_SUM_IDX.QTY_ALL + 1, rows.length, 1).setNumberFormat('#,##0');
          summarySheet.getRange(2, SHIPMENT_SUM_IDX.QTY_EPOD + 1, rows.length, 1).setNumberFormat('#,##0');
          summarySheet
            .getRange(2, SHIPMENT_SUM_IDX.LAST_UPDATE + 1, rows.length, 1)
            .setNumberFormat('dd/mm/yyyy HH:mm');
        }
      },
      // extraInitFn: เพิ่ม extra fields ใน map entry สำหรับ Shipment
      function (r, key) {
        return {
          shipmentNo: r[DATA_IDX.SHIPMENT_NO],
          truck: r[DATA_IDX.TRUCK_LICENSE],
          all: new Set(),
          epod: new Set()
        };
      }
    );
  } catch (e) {
    logError('ServiceSCG', 'buildShipmentSummary ล้มเหลว: ' + e.message, e);
  }
}

// ============================================================
// SECTION 6a: buildSummarySheet_ — [REF-017] Generic summary builder
// ============================================================

/**
 * buildSummarySheet_ — [REF-017] สร้าง summary sheet แบบ generic
 * รวม logic ร่วมระหว่าง buildOwnerSummary และ buildShipmentSummary:
 *   1. อ่าน sourceData → aggregate by groupKey → { all: Set(invoices), epod: Set(invoices) }
 *   2. เขียนลง summary sheet
 *
 * @param {Array[]} sourceData - ข้อมูลจาก DAILY_JOB
 * @param {string} sheetName - ชื่อ summary sheet (เช่น SHEET.OWNER_SUMMARY)
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {function(Object): string|null} groupKeyFn - ฟังก์ชันดึง key จาก row (คืน null = ข้าม)
 * @param {function(string, Object, number): Array} rowBuildFn - ฟังก์ชันสร้าง row array จาก (key, agg, numCols)
 * @param {function(Object, Array[], number): void} formatFn - ฟังก์ชันจัด number format บน sheet
 * @param {function(Object, string): Object} [extraInitFn] - ฟังก์ชันสร้าง initial map value (default: {all: Set, epod: Set})
 */
function buildSummarySheet_(sourceData, sheetName, ss, groupKeyFn, rowBuildFn, formatFn, extraInitFn) {
  const summarySheet = ss.getSheetByName(sheetName);
  if (!summarySheet) {
    safeUiAlert_('❌ ไม่พบชีต ' + sheetName);
    return;
  }

  // Aggregate
  const aggMap = {};
  sourceData.forEach((r) => {
    const key = groupKeyFn(r);
    if (key === null) return;

    if (!aggMap[key]) {
      aggMap[key] = extraInitFn ? extraInitFn(r, key) : { all: new Set(), epod: new Set() };
    }

    const invoiceNo = r[DATA_IDX.INVOICE_NO];
    if (!invoiceNo) return;

    const ownerName = r[DATA_IDX.SOLD_TO_NAME];
    if (checkIsEPOD_(ownerName, invoiceNo)) {
      aggMap[key].epod.add(invoiceNo);
    } else {
      aggMap[key].all.add(invoiceNo);
    }
  });

  // Clear old data
  const schemaCols = SCHEMA[sheetName].length;
  const summaryLastRow = summarySheet.getLastRow();
  if (summaryLastRow > 1)
    summarySheet
      .getRange(2, 1, summaryLastRow - 1, schemaCols)
      .clearContent()
      .setBackground(null);

  // Build rows
  const rows = [];
  Object.keys(aggMap)
    .sort()
    .forEach((key) => {
      rows.push(rowBuildFn(key, aggMap[key], schemaCols));
    });

  // Write
  if (rows.length > 0) {
    summarySheet.getRange(2, 1, rows.length, schemaCols).setValues(rows);
  }

  // Apply format
  formatFn(summarySheet, rows, schemaCols);
}

// ============================================================
// SECTION 7: Clear Functions
// ============================================================

function clearAllSCGSheets_UI() {
  // [SEC-002] Authorization Guard
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ล้างข้อมูล\nกรุณาติดต่อ Admin');
    return;
  }
  // [FIX B4 v5.5.002] เพิ่ม try-catch — menu entry point ต้องมี error handling
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.toast('🗑️ กำลังล้างข้อมูลชีตที่เลือก...', APP_NAME, -1);

    let cleared = 0;

    // [FIX V6.0.005] เพิ่ม SHEET.INPUT ในรายการชีตที่ต้องล้าง
    const sheetsToClear = [SHEET.DAILY_JOB, SHEET.OWNER_SUMMARY, SHEET.SHIPMENT_SUM, SHEET.INPUT];
    sheetsToClear.forEach((name) => {
      const sheet = ss.getSheetByName(name);
      if (sheet && sheet.getLastRow() > 1) {
        // [FIX v5.5.021 M5] ใช้ clearContent แทน deleteRows เพื่อความรวดเร็วและไม่กระทบโครงสร้างตาราง
        sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getMaxColumns()).clearContent();
        cleared++;
      } else if (sheet && name === SHEET.INPUT) {
        // Input sheet อาจมีข้อมูลใน B1 (COOKIE) และ B3 (ShipmentNos) ไม่ได้อยู่ใน row 2+
        // ล้างเฉพาะข้อมูลในคอลัมน์ B (ไม่ล้าก label ในคอลัมน์ A)
        const lastRow = sheet.getLastRow();
        if (lastRow >= 1) {
          sheet.getRange(1, 2, lastRow, 1).clearContent();
          cleared++;
        }
      }
    });

    logInfo('ServiceSCG', `clearAllSCGSheets_UI: ล้าง ${cleared} ชีต`);
    // [RF-03] เปลี่ยน ui.alert() → safeUiAlert_() — trigger-safe
    safeUiAlert_(`✅ ล้างข้อมูล ${cleared} ชีตเรียบร้อย`);
  } catch (e) {
    logError('ServiceSCG', 'clearAllSCGSheets_UI ล้มเหลว: ' + e.message, e);
    safeUiAlert_('เกิดข้อผิดพลาดในการล้างข้อมูล: ' + e.message);
  }
}

// [REMOVED V5.5.044] clearDailyJobLatLng — dead code (mark @deprecated ใน V5.5.043, ไม่มี caller ใน .gs ใด)
//   หากมี external caller ที่ต้องการ restore → ดู git history ของ commit นี้
