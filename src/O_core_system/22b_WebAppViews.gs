/**
 * VERSION: 6.0.069
 * FILE: 22b_WebAppViews.gs
 * LMDS V6.0 — Web App View Data Providers
 * ===================================================
 * PURPOSE:
 *   รวม read-only view data providers สำหรับ WebApp views
 *   แยกออกจาก 22_WebApp.gs เพื่อลดขนาดไฟล์ (audit 1.2)
 *   ถูกเรียกโดย frontend ผ่าน google.script.run
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 14_Utils.gs, 03_SetupSheets.gs (core)
 *     - 22_WebApp.gs            (doGet context, session helpers)
 *     - 06_PersonService, 07_PlaceService, 08_GeoService, 09_DestinationService (master counts)
 *     - 11_TransactionService, 13_ReportService (FACT + report metrics)
 *   CALLS: (Invokes)
 *     - getAllSourceRows()                       → 04_SourceRepository.gs
 *     - upsertFactDelivery() read helpers        → 11_TransactionService.gs
 *     - countPersons() / countPlaces() / countGeos() / countDestinations() → master services
 *     - buildFullQualityReport()                 → 13_ReportService.gs
 *   EXPORTS TO:
 *     - 22_WebApp.gs (view dispatcher)
 *     - Frontend views (Dashboard, FACT_DELIVERY, Q_REVIEW, MatchEngine, SourceSheet)
 *   SHEETS ACCESSED:
 *     - SHEET.SOURCE             (Read — SourceSheet view)
 *     - SHEET.FACT_DELIVERY      (Read — FACT_DELIVERY view + dashboard metrics)
 *     - SHEET.Q_REVIEW           (Read — Q_REVIEW view)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 3 — Web frontend server (dashboard, views, actions, mobile menu)
 * ===================================================
 */

/**
 * getDashboardData — คืน JSON สถิติรวมสำหรับ Dashboard view
 *   เรียกจาก frontend ผ่าน google.script.run ทุก 60 วินาที (polling)
 *
 *   สถิติที่คืน:
 *   - factDeliveryTotal: จำนวนระเบียนใน FACT_DELIVERY
 *   - reviewPending: จำนวนระเบียน Q_REVIEW ที่ status=PENDING
 *   - autoMatchRate: % ของ AUTO_MATCH ใน FACT_DELIVERY
 *   - todayDeliveries: จำนวนการจัดส่งวันนี้
 *   - sourceSheetTotal: จำนวนแถวใน Source sheet
 *   - lastUpdated: ISO timestamp
 *
 * @return {Object} { stats, topIssues, lastUpdated, appVersion }
 */
function getDashboardData() {
  // Auth check ทุก call (defense-in-depth)
  if (!isAuthorizedDashboardUser_()) {
    throw new Error('Unauthorized');
  }

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ─── อ่านข้อมูลจากหลายชีตใน batch ───
  const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  const reviewSheet = ss.getSheetByName(SHEET.Q_REVIEW);
  const sourceSheet = ss.getSheetByName(SHEET.SOURCE);

  // ตรวจว่าชีตมีอยู่จริง (Boolean() แทน !! เพื่อความชัดเจน)
  const sheetsExist = {
    fact: factSheet !== null,
    review: reviewSheet !== null,
    source: sourceSheet !== null
  };

  // ─── คำนวณ stats ───
  const stats = {
    factDeliveryTotal: 0,
    reviewPending: 0,
    reviewTotal: 0,
    autoMatchRate: 0,
    todayDeliveries: 0,
    sourceSheetTotal: 0,
    sourcePending: 0,
    matchStatusCounts: {}
  };

  if (sheetsExist.fact) {
    computeFactStats_(factSheet, stats);
  }

  if (sheetsExist.review) {
    computeReviewStats_(reviewSheet, stats);
  }

  if (sheetsExist.source) {
    computeSourceStats_(sourceSheet, stats);
  }

  // ─── Top Issues (จาก Q_REVIEW issue_type) ───
  const topIssues = computeTopIssues_(reviewSheet, 5);

  // ─── Delivery Trend 7 วัน (Phase 3.4) ───
  // คำนวณ trend การจัดส่งย้อนหลัง 7 วัน เพื่อแสดงเป็น line chart บน Dashboard
  const deliveryTrend = computeDeliveryTrend7Days_(factSheet);

  // ─── [V6.0.007] Audit Trail Stats ───
  // แสดง audit activity บน dashboard (เช่น "24 changes today")
  // Failsafe: ถ้า 26_AuditTrailService.gs ไม่ได้โหลด → return empty stats
  let auditStats = { totalRows: 0, last24h: 0, last7d: 0, byAction: {}, byEntityType: {} };
  if (typeof getAuditTrailStats === 'function') {
    try {
      auditStats = getAuditTrailStats();
    } catch (e) {
      logWarn('WebApp', 'getAuditTrailStats failed (non-fatal): ' + e.message);
    }
  }

  const elapsedMs = Date.now() - startTime;
  // [FIX] เพิ่ม reviewTotal ใน log เพื่อ debug ปัญหา review=0
  logInfo(
    'WebApp',
    'getDashboardData served — fact=' +
      stats.factDeliveryTotal +
      ', reviewPending=' +
      stats.reviewPending +
      '/' +
      stats.reviewTotal +
      ', source=' +
      stats.sourceSheetTotal +
      ', trend7d=' +
      deliveryTrend.total +
      ', audit24h=' +
      auditStats.last24h +
      ', elapsed=' +
      elapsedMs +
      'ms'
  );

  return {
    stats: stats,
    topIssues: topIssues,
    deliveryTrend: deliveryTrend,
    auditStats: auditStats,
    sheetsExist: sheetsExist,
    lastUpdated: new Date().toISOString(),
    appVersion: APP_VERSION,
    elapsedMs: elapsedMs
  };
}

/**
 * computeFactStats_ — คำนวณสถิติจาก FACT_DELIVERY sheet
 *   - นับจำนวนระเบียนทั้งหมด
 *   - นับ match status breakdown
 *   - คำนวณ auto match rate (FULL + GEO + FUZZY)
 *   - นับการจัดส่งวันนี้
 *
 * @param {Sheet} factSheet
 * @param {Object} stats — object ที่จะถูก mutate
 * @private
 */
function computeFactStats_(factSheet, stats) {
  const factData = factSheet.getDataRange().getValues();
  if (factData.length <= 1) return;

  stats.factDeliveryTotal = factData.length - 1; // ลบ header

  const statusCounts = {};
  let autoMatchCount = 0;
  let todayCount = 0;
  const todayStr = formatDateForCompare_(new Date());

  for (let i = 1; i < factData.length; i++) {
    const row = factData[i];
    const status = row[FACT_IDX.MATCH_STATUS] || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (isAutoMatchStatus_(status)) {
      autoMatchCount++;
    }

    const deliveryDate = row[FACT_IDX.DELIVERY_DATE];
    if (deliveryDate instanceof Date && formatDateForCompare_(deliveryDate) === todayStr) {
      todayCount++;
    }
  }

  stats.matchStatusCounts = statusCounts;
  stats.autoMatchRate =
    stats.factDeliveryTotal > 0 ? Math.round((autoMatchCount / stats.factDeliveryTotal) * 1000) / 10 : 0;
  stats.todayDeliveries = todayCount;
}

/**
 * isAutoMatchStatus_ — ตรวจว่า status เป็น auto match หรือไม่
 * @param {string} status
 * @return {boolean}
 * @private
 */
function isAutoMatchStatus_(status) {
  return status === APP_CONST.MATCH_FULL || status === APP_CONST.MATCH_GEO || status === APP_CONST.MATCH_FUZZY;
}

/**
 * computeDeliveryTrend7Days — คำนวณจำนวนการจัดส่งย้อนหลัง 7 วัน
 *   สำหรับแสดงเป็น line chart บน Dashboard (Phase 3.4)
 *
 *   Return:
 *   - labels: array ของ date string 7 ตัว (รูปแบบ 'dd/mm' ภาษาไทย)
 *             เรียงจากเก่า → ใหม่ (ซ้าย → ขวาใน chart)
 *   - data: array ของจำนวนรายการในแต่ละวัน (เรียงตาม labels)
 *   - total: รวมทั้ง 7 วัน
 *   - dailyAvg: ค่าเฉลี่ยรายวัน (1 ตำแหน่งทศนิยม)
 *
 * @param {Sheet} factSheet - FACT_DELIVERY sheet
 * @return {Object} { labels, data, total, dailyAvg }
 * @private
 */
function computeDeliveryTrend7Days_(factSheet) {
  // Default return — ถ้า sheet ไม่มีหรือว่าง
  const emptyResult = { labels: [], data: [], total: 0, dailyAvg: 0 };
  if (factSheet === null) return emptyResult;

  const lastRow = factSheet.getLastRow();
  if (lastRow <= 1) return emptyResult;

  // สร้าง map ของ 7 วันย้อนหลัง — key = 'YYYY-MM-DD'
  // เรียงจาก 6 วันก่อน → วันนี้ (รวม 7 วัน)
  const today = new Date();
  today.setHours(0, 0, 0, 0); // normalize เป็นเที่ยงคืน

  const labels = [];
  const dateKeys = [];
  const dayCounts = {};

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = formatDateForCompare_(d);
    dateKeys.push(key);
    dayCounts[key] = 0;
    // Label รูปแบบ 'dd/mm' ภาษาไทย (เช่น '01/07')
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    labels.push(dd + '/' + mm);
  }

  // อ่านเฉพาะคอลัมน์ DELIVERY_DATE จาก FACT_DELIVERY เพื่อลด payload
  // FACT_IDX.DELIVERY_DATE = 4 → 1-based = 5
  const dateCol = FACT_IDX.DELIVERY_DATE + 1;
  const dateData = factSheet.getRange(2, dateCol, lastRow - 1, 1).getValues();

  let total = 0;
  for (let i = 0; i < dateData.length; i++) {
    const cellValue = dateData[i][0];
    if (cellValue instanceof Date) {
      const key = formatDateForCompare_(cellValue);
      // [SonarCloud S3531] ใช้ in operator แทน hasOwnProperty — กระชับกว่า
      if (key in dayCounts) {
        dayCounts[key]++;
        total++;
      }
    } else if (typeof cellValue === 'string' && cellValue.length > 0) {
      // ถ้าเก็บเป็น string พยายาม parse
      const parsed = new Date(cellValue);
      if (!isNaN(parsed.getTime())) {
        const key = formatDateForCompare_(parsed);
        if (key in dayCounts) {
          dayCounts[key]++;
          total++;
        }
      }
    }
  }

  // สร้าง data array ตามลำดับ labels
  const data = dateKeys.map(function (key) {
    return dayCounts[key];
  });
  const dailyAvg = Math.round((total / 7) * 10) / 10;

  return {
    labels: labels,
    data: data,
    total: total,
    dailyAvg: dailyAvg
  };
}

/**
 * computeReviewStats_ — คำนวณสถิติจาก Q_REVIEW sheet
 * @param {Sheet} reviewSheet
 * @param {Object} stats
 * @private
 */
function computeReviewStats_(reviewSheet, stats) {
  const reviewData = reviewSheet.getDataRange().getValues();
  if (reviewData.length <= 1) return;

  stats.reviewTotal = reviewData.length - 1;
  for (let i = 1; i < reviewData.length; i++) {
    const status = reviewData[i][REVIEW_IDX.STATUS];
    // [FIX] Q_REVIEW STATUS ใช้ค่า 'Pending' (title case) จาก setupReviewDropdowns_
    //   เดิมเช็คแค่ 'PENDING' (uppercase) จึงไม่ match → count เป็น 0
    //   แก้: เปลี่ยนเป็น case-insensitive และรองรับทั้ง 'Pending' และ 'PENDING'
    const statusUpper = String(status || '')
      .trim()
      .toUpperCase();
    const isPending = statusUpper === 'PENDING' || status === '' || status === null || status === undefined;
    if (isPending) {
      stats.reviewPending++;
    }
  }
}

/**
 * computeSourceStats_ — คำนวณสถิติจาก Source sheet
 * @param {Sheet} sourceSheet
 * @param {Object} stats
 * @private
 */
function computeSourceStats_(sourceSheet, stats) {
  const sourceData = sourceSheet.getDataRange().getValues();
  if (sourceData.length <= 1) return;

  stats.sourceSheetTotal = sourceData.length - 1;
  for (let i = 1; i < sourceData.length; i++) {
    const syncStatus = sourceData[i][SRC_IDX.SYNC_STATUS];
    const isDone = String(syncStatus || '').toUpperCase() === SCG_CONFIG.SYNC_DONE_VALUE;
    if (syncStatus !== null && syncStatus !== undefined && syncStatus !== '' && !isDone) {
      stats.sourcePending++;
    }
  }
}

/**
 * computeTopIssues_ — นับ issue_type จาก Q_REVIEW แล้วคืน top N
 *
 * @param {Sheet} reviewSheet
 * @param {number} limit - จำนวน top issues ที่ต้องการ
 * @return {Array<{issueType: string, count: number}>}
 * @private
 */
function computeTopIssues_(reviewSheet, limit) {
  if (!reviewSheet) return [];
  const data = reviewSheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const counts = {};
  for (let i = 1; i < data.length; i++) {
    const status = data[i][REVIEW_IDX.STATUS];
    const isPending = status === 'PENDING' || status === '' || status === null || status === undefined;
    // นับเฉพาะที่ยัง PENDING
    if (isPending) {
      const issueType = data[i][REVIEW_IDX.ISSUE_TYPE] || 'UNKNOWN';
      counts[issueType] = (counts[issueType] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([issueType, count]) => ({ issueType: issueType, count: count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * formatDateForCompare_ — แปลง Date เป็น string YYYY-MM-DD สำหรับเทียบวัน
 *
 * @param {Date} date
 * @return {string}
 * @private
 */
function formatDateForCompare_(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/**
 * getFactDeliveryPage — Phase 2 (FACT_DELIVERY pagination + filter)
 *   คืนข้อมูล FACT_DELIVERY แบบ pagination + filter
 *
 * @param {number} offset - แถวเริ่มต้น (0-based, หลัง header)
 * @param {number} limit - จำนวนแถวต่อหน้า (default 50)
 * @param {Object} filter - { status, dateFrom, dateTo, searchText }
 * @return {Object} { rows, total, offset, limit }
 */
function getFactDeliveryPage(offset, limit, filter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);

  if (!sheet) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      statusCounts: {},
      elapsedMs: 0,
      error: 'ไม่พบ sheet FACT_DELIVERY'
    };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      statusCounts: {},
      elapsedMs: 0
    };
  }

  // [V6.0.009 P2.4] Performance optimization — read status column ONLY for counting
  //   (was reading ALL columns just to count statuses + paginate)
  //   Step 1: read only MATCH_STATUS column to build statusCounts + filtered row indices
  //   Step 2: read only the page rows (offset..offset+limit) full columns
  //   This reduces API payload from N×25 to N×1 + limit×25 (10-50x reduction for large sheets)
  const statusColIdx = FACT_IDX.MATCH_STATUS + 1; // 1-based column number
  const totalRows = lastRow - 1;
  const statusValues = sheet.getRange(2, statusColIdx, totalRows, 1).getValues();

  // Build statusCounts + filtered row indices in single pass
  const statusCounts = {};
  const filterObj = filter || {};
  const hasStatusFilter = filterObj.status && filterObj.status !== 'all' && filterObj.status !== '';
  const hasStatusesFilter = Array.isArray(filterObj.statuses) && filterObj.statuses.length > 0;
  const filteredRowIndices = []; // 0-based indices into statusValues (which maps to sheet row - 2)

  for (let i = 0; i < statusValues.length; i++) {
    const s = String(statusValues[i][0] || 'UNKNOWN').trim();
    statusCounts[s] = (statusCounts[s] || 0) + 1;

    // Check if this row matches the filter
    let matches = true;
    if (hasStatusFilter) {
      matches = s === filterObj.status;
    } else if (hasStatusesFilter) {
      matches = filterObj.statuses.indexOf(s) !== -1;
    }
    if (matches) {
      filteredRowIndices.push(i);
    }
  }

  // Pagination on filtered indices
  // [V6.0.069] DRY — use parsePaginationParams_ helper (was duplicated 3x)
  const { offset: safeOffset, limit: safeLimit } = parsePaginationParams_(offset, limit);
  const pageIndices = filteredRowIndices.slice(safeOffset, safeOffset + safeLimit);
  const totalFiltered = filteredRowIndices.length;

  // [V6.0.009 P2.4] Read only the page rows (full columns) — not the entire sheet
  //   pageIndices are 0-based into the data array; sheet row = pageIndex + 2
  //   Use getRangeList for non-contiguous rows (efficient batch read)
  let pageRows = [];
  if (pageIndices.length > 0) {
    const schemaLen = SCHEMA[SHEET.FACT_DELIVERY].length;
    // Build A1 notations for each row (column A to column corresponding to schemaLen)
    const lastColLetter = columnNumberToLetter_(schemaLen);
    const a1Notations = pageIndices.map(function (idx) {
      return 'A' + (idx + 2) + ':' + lastColLetter + (idx + 2); // +2 because data starts at row 2
    });
    const rangeList = sheet.getRangeList(a1Notations);
    const ranges = rangeList.getRanges();
    // getValues on each range — returns array of arrays (one per range)
    // Combine into single 2D array
    const allValues = [];
    for (let r = 0; r < ranges.length; r++) {
      const vals = ranges[r].getValues();
      if (vals.length > 0) allValues.push(vals[0]);
    }
    pageRows = allValues;
  }

  // แปลง rows เป็น objects
  const rows = pageRows.map(function (row) {
    return {
      txId: String(row[FACT_IDX.TX_ID] || ''),
      deliveryDate:
        row[FACT_IDX.DELIVERY_DATE] instanceof Date
          ? row[FACT_IDX.DELIVERY_DATE].toISOString()
          : String(row[FACT_IDX.DELIVERY_DATE] || ''),
      deliveryTime: String(row[FACT_IDX.DELIVERY_TIME] || ''),
      invoiceNo: String(row[FACT_IDX.INVOICE_NO] || ''),
      shipmentNo: String(row[FACT_IDX.SHIPMENT_NO] || ''),
      driverName: String(row[FACT_IDX.DRIVER_NAME] || ''),
      truckLicense: String(row[FACT_IDX.TRUCK_LICENSE] || ''),
      soldToName: String(row[FACT_IDX.SOLD_TO_NAME] || ''),
      shipToName: String(row[FACT_IDX.SHIP_TO_NAME] || ''),
      shipToAddress: String(row[FACT_IDX.SHIP_TO_ADDR] || ''),
      geoResolvedAddr: String(row[FACT_IDX.GEO_RESOLVED_ADDR] || ''),
      personId: String(row[FACT_IDX.PERSON_ID] || ''),
      placeId: String(row[FACT_IDX.PLACE_ID] || ''),
      destId: String(row[FACT_IDX.DEST_ID] || ''),
      warehouse: String(row[FACT_IDX.WAREHOUSE] || ''),
      rawLat: Number(row[FACT_IDX.RAW_LAT] || 0),
      rawLng: Number(row[FACT_IDX.RAW_LNG] || 0),
      matchStatus: String(row[FACT_IDX.MATCH_STATUS] || ''),
      matchConfidence: Number(row[FACT_IDX.MATCH_CONF] || 0),
      matchReason: String(row[FACT_IDX.MATCH_REASON] || ''),
      matchAction: String(row[FACT_IDX.MATCH_ACTION] || ''),
      resolvedLat: Number(row[FACT_IDX.RESOLVED_LAT] || 0),
      resolvedLng: Number(row[FACT_IDX.RESOLVED_LNG] || 0),
      driverVerifiedName: String(row[FACT_IDX.DRIVER_VERIFIED_NAME] || ''),
      driverVerifiedAddr: String(row[FACT_IDX.DRIVER_VERIFIED_ADDR] || '')
    };
  });

  const elapsedMs = Date.now() - startTime;
  logInfo(
    'WebApp',
    'getFactDeliveryPage: status=' +
      (filterObj.status || 'all') +
      ' offset=' +
      safeOffset +
      ' limit=' +
      safeLimit +
      ' → ' +
      rows.length +
      '/' +
      totalFiltered +
      ' rows in ' +
      elapsedMs +
      'ms'
  );

  return {
    rows: rows,
    total: totalFiltered,
    offset: safeOffset,
    limit: safeLimit,
    filter: filterObj,
    statusCounts: statusCounts,
    elapsedMs: elapsedMs
  };
}

/**
 * getQReviewPage — Phase 2: ดึงรายการ Q_REVIEW แบบ pagination + filter
 *   เรียกจาก frontend ผ่าน google.script.run
 *
 * @param {number} offset - แถวเริ่มต้น (0-based, หลัง header) — default 0
 * @param {number} limit - จำนวนแถวต่อหน้า — default 50
 * @param {string} statusFilter - 'Pending' | 'Approved' | 'Rejected' | 'Escalated' | 'Done' | 'all'
 *                                ถ้าไม่ระบุ จะใช้ 'Pending' เป็น default
 * @return {Object} { rows, total, offset, limit, statusFilter, statusCounts }
 *   - rows: array ของ review objects (เลือกเฉพาะ field ที่ frontend ต้องการ เพื่อลด payload)
 *   - total: จำนวนรายการทั้งหมดที่ match filter (ไม่ใช่ทั้ง sheet)
 *   - statusCounts: จำนวนรายการแต่ละ status ทั้งหมด (สำหรับ filter tabs)
 */
function getQReviewPage(offset, limit, statusFilter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.Q_REVIEW);

  if (!sheet) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      statusFilter: statusFilter || 'Pending',
      statusCounts: {},
      elapsedMs: 0,
      error: 'ไม่พบ sheet Q_REVIEW'
    };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      statusFilter: statusFilter || 'Pending',
      statusCounts: {},
      elapsedMs: 0
    };
  }

  // อ่านข้อมูลทั้งหมด (GAS อ่าน batch เร็วกว่า row-by-row)
  const data = sheet.getRange(2, 1, lastRow - 1, SCHEMA[SHEET.Q_REVIEW].length).getValues();

  // นับ status ทั้งหมด (สำหรับ filter tabs)
  const statusCounts = { Pending: 0, Approved: 0, Rejected: 0, Escalated: 0, Done: 0, Other: 0 };
  data.forEach(function (row) {
    const s = String(row[REVIEW_IDX.STATUS] || '').trim();
    if (s === 'Pending' || s === 'PENDING' || s === '') statusCounts['Pending']++;
    else if (s === 'Approved' || s === 'APPROVED') statusCounts['Approved']++;
    else if (s === 'Rejected' || s === 'REJECTED') statusCounts['Rejected']++;
    else if (s === 'Escalated' || s === 'ESCALATED') statusCounts['Escalated']++;
    else if (s === 'Done' || s === 'DONE') statusCounts['Done']++;
    else statusCounts['Other']++;
  });

  // Filter
  const wantStatus = (statusFilter || 'Pending').toLowerCase();
  const filtered = data.filter(function (row) {
    if (wantStatus === 'all') return true;
    const s = String(row[REVIEW_IDX.STATUS] || '')
      .trim()
      .toLowerCase();
    if (wantStatus === 'pending') return s === '' || s === 'pending';
    return s === wantStatus;
  });

  // Pagination
  // [V6.0.069] DRY — use parsePaginationParams_ helper (was duplicated 3x)
  const { offset: safeOffset, limit: safeLimit } = parsePaginationParams_(offset, limit);
  const pageRows = filtered.slice(safeOffset, safeOffset + safeLimit);

  // แปลง rows เป็น objects (เลือกเฉพาะ field ที่ frontend ใช้)
  const rows = pageRows.map(function (row, idx) {
    return {
      reviewId: String(row[REVIEW_IDX.REVIEW_ID] || ''),
      issueType: String(row[REVIEW_IDX.ISSUE_TYPE] || ''),
      priority: String(row[REVIEW_IDX.PRIORITY] || ''),
      invoiceNo: String(row[REVIEW_IDX.INVOICE_NO] || ''),
      rawPerson: String(row[REVIEW_IDX.RAW_PERSON] || ''),
      rawPlace: String(row[REVIEW_IDX.RAW_PLACE] || ''),
      rawAddress: String(row[REVIEW_IDX.RAW_SYS_ADDR] || ''),
      rawLat: Number(row[REVIEW_IDX.RAW_LAT] || 0),
      rawLng: Number(row[REVIEW_IDX.RAW_LNG] || 0),
      matchScore: Number(row[REVIEW_IDX.MATCH_SCORE] || 0),
      recommend: String(row[REVIEW_IDX.RECOMMEND] || ''),
      status: String(row[REVIEW_IDX.STATUS] || 'Pending'),
      reviewer: String(row[REVIEW_IDX.REVIEWER] || ''),
      decision: String(row[REVIEW_IDX.DECISION] || ''),
      note: String(row[REVIEW_IDX.NOTE] || ''),
      candPersonIds: safeParseJsonArray_(row[REVIEW_IDX.CAND_PERSONS]),
      candPlaceIds: safeParseJsonArray_(row[REVIEW_IDX.CAND_PLACES]),
      sourceRowNumber: Number(row[REVIEW_IDX.SOURCE_ROW] || 0),
      // ส่ง row index (1-based ใน sheet) กลับไป เพื่อใช้ตอน applyReviewDecision
      _sheetRow: idx + safeOffset + 2
    };
  });

  const elapsedMs = Date.now() - startTime;
  logInfo(
    'WebApp',
    'getQReviewPage: status=' +
      (statusFilter || 'Pending') +
      ' offset=' +
      safeOffset +
      ' limit=' +
      safeLimit +
      ' → ' +
      rows.length +
      '/' +
      filtered.length +
      ' rows in ' +
      elapsedMs +
      'ms'
  );

  return {
    rows: rows,
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
    statusFilter: statusFilter || 'Pending',
    statusCounts: statusCounts,
    elapsedMs: elapsedMs
  };
}

/**
 * getMatchEngineMetrics — Phase 3: สถิติ Match Engine สำหรับหน้า dashboard
 *   วิเคราะห์ข้อมูลจาก FACT_DELIVERY sheet เพื่อให้ภาพรวมคุณภาพการ match
 *
 * Metrics ที่ส่งกลับ:
 *   - summary: { total, autoMatchedCount, autoMatchRate, avgScore, maxScore, minScore, withScoreCount }
 *   - statusCounts: { FULL_MATCH, GEO_ANCHOR, FUZZY_MATCH, CREATE_NEW, NEEDS_REVIEW, ERROR, ... }
 *   - scoreDistribution: array ขนาด 10 — count ของ score ในแต่ละ bin (0-9, 10-19, ..., 90-100)
 *   - scoreBins: labels ของ bins (สำหรับ chart)
 *   - matchReasons: array เรียงตาม count desc — [{ reason, count }]
 *   - matchActions: array เรียงตาม count desc — [{ action, count }]
 *
 * @return {Object} { summary, statusCounts, scoreDistribution, scoreBins, matchReasons, matchActions, elapsedMs }
 */
function getMatchEngineMetrics() {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);

  if (!sheet || sheet.getLastRow() <= 1) {
    return {
      summary: {
        total: 0,
        autoMatchedCount: 0,
        autoMatchRate: 0,
        avgScore: 0,
        maxScore: 0,
        minScore: 0,
        withScoreCount: 0
      },
      statusCounts: {},
      scoreDistribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      scoreBins: ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100'],
      matchReasons: [],
      matchActions: [],
      elapsedMs: 0
    };
  }

  // อ่านเฉพาะคอลัมน์ที่จำเป็น เพื่อลด payload — match_status, match_confidence, match_reason, match_action
  // ใช้ getRange(row, col, numRows, numCols) เพื่อดึงเฉพาะ 4 คอลัมน์
  const startCol = FACT_IDX.MATCH_STATUS + 1; // 1-based
  const numCols = 4; // MATCH_STATUS, MATCH_CONF, MATCH_REASON, MATCH_ACTION
  const data = sheet.getRange(2, startCol, sheet.getLastRow() - 1, numCols).getValues();

  // ─── Summary + Status counts ───
  const total = data.length;
  let autoMatchedCount = 0;
  let withScoreCount = 0;
  let sumScore = 0;
  let maxScore = 0;
  let minScore = 101; // start higher than max possible
  const statusCounts = {};

  // ─── Score distribution (10 bins: 0-9, 10-19, ..., 90-100) ───
  const scoreDistribution = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  // ─── Reason + Action counts ───
  const reasonCounts = {};
  const actionCounts = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const status = String(row[0] || '').trim();
    const score = Number(row[1] || 0);
    const reason = String(row[2] || '').trim();
    const action = String(row[3] || '').trim();

    // Status counts
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    // Auto-match (FULL + GEO + FUZZY)
    if (isAutoMatchStatus_(status)) {
      autoMatchedCount++;
    }

    // Score stats
    if (score > 0) {
      withScoreCount++;
      sumScore += score;
      if (score > maxScore) maxScore = score;
      if (score < minScore) minScore = score;

      // Bin index: 0-9 → 0, 10-19 → 1, ..., 90-100 → 9
      let binIdx = Math.floor(score / 10);
      if (binIdx > 9) binIdx = 9; // 100 → bin 9
      if (binIdx < 0) binIdx = 0;
      scoreDistribution[binIdx]++;
    }

    // Reason counts (skip empty)
    if (reason) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    // Action counts (skip empty)
    if (action) {
      actionCounts[action] = (actionCounts[action] || 0) + 1;
    }
  }

  // ─── Sort reasons + actions ───
  const matchReasons = Object.keys(reasonCounts)
    .map(function (r) {
      return { reason: r, count: reasonCounts[r] };
    })
    .sort(function (a, b) {
      return b.count - a.count;
    })
    .slice(0, 15); // top 15

  const matchActions = Object.keys(actionCounts)
    .map(function (a) {
      return { action: a, count: actionCounts[a] };
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });

  const elapsedMs = Date.now() - startTime;
  logInfo('WebApp', 'getMatchEngineMetrics: ' + total + ' rows analyzed in ' + elapsedMs + 'ms');

  return {
    summary: {
      total: total,
      autoMatchedCount: autoMatchedCount,
      autoMatchRate: total > 0 ? Math.round((autoMatchedCount / total) * 1000) / 10 : 0,
      avgScore: withScoreCount > 0 ? Math.round((sumScore / withScoreCount) * 10) / 10 : 0,
      maxScore: maxScore,
      minScore: minScore === 101 ? 0 : minScore,
      withScoreCount: withScoreCount
    },
    statusCounts: statusCounts,
    scoreDistribution: scoreDistribution,
    scoreBins: ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100'],
    matchReasons: matchReasons,
    matchActions: matchActions,
    elapsedMs: elapsedMs
  };
}

/**
 * getSourcePage — Phase 2.4: ดึงรายการจาก SOURCE sheet (SCGนครหลวงJWDภูมิภาค)
 *   แสดงข้อมูลดิบจาก SCG API + SYNC_STATUS ว่าประมวลผลแล้วหรือยัง
 *
 * @param {number} offset - 0-based (หลัง header)
 * @param {number} limit - rows per page (default 50, max 200)
 * @param {Object} filter - { syncStatus: 'SUCCESS' | 'PENDING' | 'ERROR' | 'all' }
 * @return {Object} { rows, total, offset, limit, filter, syncStatusCounts, elapsedMs }
 */
function getSourcePage(offset, limit, filter) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.SOURCE);

  if (!sheet) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      syncStatusCounts: {},
      elapsedMs: 0,
      error: 'ไม่พบ sheet SOURCE'
    };
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      rows: [],
      total: 0,
      offset: 0,
      limit: limit || 50,
      filter: filter || {},
      syncStatusCounts: {},
      elapsedMs: 0
    };
  }

  // [V6.0.009 P2.4] Performance optimization — read SYNC_STATUS column ONLY for counting
  //   (was reading ALL 39 columns just to count statuses + paginate)
  //   Step 1: read only SYNC_STATUS column to build syncStatusCounts + filtered row indices
  //   Step 2: read only the page rows (offset..offset+limit) full columns
  //   This reduces API payload from N×39 to N×1 + limit×39 (10-50x reduction for large sheets)
  const bucketSyncStatus_ = function (rawStatus) {
    const s = String(rawStatus || '')
      .trim()
      .toUpperCase();
    if (s === SCG_CONFIG.SYNC_DONE_VALUE) return 'SUCCESS';
    if (s === '') return 'EMPTY';
    if (s.indexOf('ERROR') !== -1 || s.indexOf('FAIL') !== -1) return 'ERROR';
    return 'PENDING';
  };

  const syncStatusColIdx = SRC_IDX.SYNC_STATUS + 1; // 1-based column number
  const totalRows = lastRow - 1;
  const syncStatusValues = sheet.getRange(2, syncStatusColIdx, totalRows, 1).getValues();

  // Build syncStatusCounts + filtered row indices in single pass
  const syncStatusCounts = { SUCCESS: 0, PENDING: 0, ERROR: 0, EMPTY: 0 };
  const filterObj = filter || {};
  const wantSync = (filterObj.syncStatus || 'all').toUpperCase();
  const hasSyncFilter = wantSync !== 'ALL' && wantSync !== '';
  const filteredRowIndices = [];

  for (let i = 0; i < syncStatusValues.length; i++) {
    const bucket = bucketSyncStatus_(syncStatusValues[i][0]);
    syncStatusCounts[bucket] = (syncStatusCounts[bucket] || 0) + 1;
    if (!hasSyncFilter || bucket === wantSync) {
      filteredRowIndices.push(i);
    }
  }

  // Pagination on filtered indices
  // [V6.0.069] DRY — use parsePaginationParams_ helper (was duplicated 3x)
  const { offset: safeOffset, limit: safeLimit } = parsePaginationParams_(offset, limit);
  const pageIndices = filteredRowIndices.slice(safeOffset, safeOffset + safeLimit);
  const totalFiltered = filteredRowIndices.length;

  // [V6.0.009 P2.4] Read only the page rows (full columns) — not the entire sheet
  const lastCol = Math.max(SRC_IDX.DRIVER_VERIFIED_ADDR + 1, sheet.getLastColumn());
  let pageRows = [];
  if (pageIndices.length > 0) {
    const lastColLetter = columnNumberToLetter_(lastCol);
    const a1Notations = pageIndices.map(function (idx) {
      return 'A' + (idx + 2) + ':' + lastColLetter + (idx + 2);
    });
    const rangeList = sheet.getRangeList(a1Notations);
    const ranges = rangeList.getRanges();
    const allValues = [];
    for (let r = 0; r < ranges.length; r++) {
      const vals = ranges[r].getValues();
      if (vals.length > 0) allValues.push(vals[0]);
    }
    pageRows = allValues;
  }

  // แปลง rows เป็น objects (เลือก field ที่ frontend ใช้)
  const rows = pageRows.map(function (row, idx) {
    return {
      _sheetRow: pageIndices[idx] + 2,
      rowId: Number(row[SRC_IDX.ROW_ID] || 0),
      sourceId: String(row[SRC_IDX.SOURCE_ID] || ''),
      deliveryDate:
        row[SRC_IDX.DELIVERY_DATE] instanceof Date
          ? row[SRC_IDX.DELIVERY_DATE].toISOString()
          : String(row[SRC_IDX.DELIVERY_DATE] || ''),
      deliveryTime: String(row[SRC_IDX.DELIVERY_TIME] || ''),
      driverName: String(row[SRC_IDX.DRIVER_NAME] || ''),
      truckLicense: String(row[SRC_IDX.TRUCK_LICENSE] || ''),
      shipmentNo: String(row[SRC_IDX.SHIPMENT_NO] || ''),
      invoiceNo: String(row[SRC_IDX.INVOICE_NO] || ''),
      customerCode: String(row[SRC_IDX.CUSTOMER_CODE] || ''),
      soldToName: String(row[SRC_IDX.SOLD_TO_NAME] || ''),
      rawPersonName: String(row[SRC_IDX.RAW_PERSON_NAME] || ''),
      lat: Number(row[SRC_IDX.LAT] || 0),
      lng: Number(row[SRC_IDX.LNG] || 0),
      warehouse: String(row[SRC_IDX.WAREHOUSE] || ''),
      rawAddress: String(row[SRC_IDX.RAW_ADDRESS] || ''),
      resolvedAddr: String(row[SRC_IDX.RESOLVED_ADDR] || ''),
      remark: String(row[SRC_IDX.REMARK] || ''),
      month: String(row[SRC_IDX.MONTH] || ''),
      distFromWh: Number(row[SRC_IDX.DIST_FROM_WH] || 0),
      syncStatus: String(row[SRC_IDX.SYNC_STATUS] || ''),
      syncStatusBucket: bucketSyncStatus_(row[SRC_IDX.SYNC_STATUS]),
      driverVerifiedName: String(row[SRC_IDX.DRIVER_VERIFIED_NAME] || ''),
      driverVerifiedAddr: String(row[SRC_IDX.DRIVER_VERIFIED_ADDR] || ''),
      qcResult: String(row[SRC_IDX.QC_RESULT] || ''),
      qcIssue: String(row[SRC_IDX.QC_ISSUE] || '')
    };
  });

  const elapsedMs = Date.now() - startTime;
  logInfo(
    'WebApp',
    'getSourcePage: sync=' +
      (filterObj.syncStatus || 'all') +
      ' offset=' +
      safeOffset +
      ' limit=' +
      safeLimit +
      ' → ' +
      rows.length +
      '/' +
      totalFiltered +
      ' rows in ' +
      elapsedMs +
      'ms'
  );

  return {
    rows: rows,
    total: totalFiltered,
    offset: safeOffset,
    limit: safeLimit,
    filter: filterObj,
    syncStatusCounts: syncStatusCounts,
    elapsedMs: elapsedMs
  };
}
