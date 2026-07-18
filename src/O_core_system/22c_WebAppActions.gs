/**
 * VERSION: 6.0.069
 * FILE: 22c_WebAppActions.gs
 * LMDS V6.0 — Web App Actions
 * ===================================================
 * PURPOSE:
 *   รวม action + search + map functions สำหรับ WebApp
 *   แยกออกจาก 22_WebApp.gs เพื่อลดขนาดไฟล์ (audit 1.2)
 *   ถูกเรียกโดย frontend ผ่าน google.script.run (ping, submitReviewDecision, searchLocations, etc.)
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs, 02_Schema.gs, 14_Utils.gs, 22_WebApp.gs (core)
 *     - 12_ReviewService.gs     (submitReviewDecision, getReviewDetail)
 *     - 17_SearchService.gs     (searchLocations)
 *     - 15_GoogleMapsAPI.gs     (map data + geocoding)
 *   CALLS: (Invokes)
 *     - submitReviewDecision() / getReviewDetail() → 12_ReviewService.gs
 *     - searchLocations()                        → 17_SearchService.gs
 *     - geocode() / reverseGeocode()             → 15_GoogleMapsAPI.gs
 *   EXPORTS TO:
 *     - 22_WebApp.gs (action dispatcher)
 *     - Frontend views (MobileActions, Search, MapAnalytics, LiveFeed)
 *   SHEETS ACCESSED:
 *     - SHEET.SOURCE             (Read — search/list)
 *     - SHEET.FACT_DELIVERY      (Read — search/list)
 *     - SHEET.Q_REVIEW           (Read/Write — submitReviewDecision updates)
 *     - SHEET.M_ALIAS / M_PERSON / M_PLACE / M_DESTINATION (Read — search)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 3 — Web frontend server (dashboard, views, actions, mobile menu)
 * ===================================================
 */

/**
 * ping — ใช้สำหรับ frontend ทดสอบว่า server ตอบสนองได้
 *   และ auth ยังผ่านอยู่
 *
 * @return {Object} { ok: true, timestamp: '...', user: '...' }
 */
function ping() {
  if (!isAuthorizedDashboardUser_()) {
    return { ok: false, error: 'Unauthorized' };
  }
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    appVersion: APP_VERSION,
    user: getCurrentDashboardUser_().email
  };
}

/**
 * safeParseJsonArray_ — parse JSON string เป็น array อย่างปลอดภัย
 * @param {*} val
 * @return {Array}
 * @private
 */
function safeParseJsonArray_(val) {
  if (val === null || val === undefined || val === '') return [];
  if (Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(String(val));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * submitReviewDecision — Phase 2: บันทึกการตัดสินใจ Approve/Reject ของ reviewer
 *   wrapper รอบ applyReviewDecision() ใน 12_ReviewService.gs
 *   เพิ่ม auth check + return structured response สำหรับ frontend
 *
 * @param {string} reviewId - review_id ของรายการที่จะตัดสินใจ
 * @param {string} decision - 'CREATE_NEW' (Approve = สร้าง entity ใหม่)
 *                            | 'MERGE_TO_CANDIDATE' (Approve = merge เข้า candidate)
 *                            | 'IGNORE' (Reject = ไม่ action, ปิดไป)
 *                            | 'ESCALATE' (Reject + ส่งต่อ)
 * @param {string} note - หมายเหตุ (optional)
 * @return {Object} { ok, reviewId, decision, message }
 */
function submitReviewDecision(reviewId, decision, note) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  // [V6.0.004] RBAC: require reviewer/admin
  if (typeof requirePermission_ === 'function') requirePermission_('action:approve_review');

  // [V6.0.055] Use centralized input validation (B2 — Security Hardening)
  const validation = validateInput_(
    { reviewId: reviewId, decision: decision, note: note },
    {
      reviewId: { type: 'string', required: true, maxLength: 50, pattern: /^[A-Za-z0-9_-]+$/ },
      decision: {
        type: 'string',
        required: true,
        enum: ['CREATE_NEW', 'MERGE_TO_CANDIDATE', 'IGNORE', 'ESCALATE']
      },
      note: { type: 'string', required: false, maxLength: 500, allowNewlines: true }
    }
  );
  if (!validation.valid) {
    return { ok: false, message: validation.errors.join('; ') };
  }
  reviewId = validation.sanitized.reviewId;
  decision = validation.sanitized.decision;
  note = validation.sanitized.note || '';

  // [V6.0.009 P2.1] LockService guard — ป้องกัน double-submit จาก WebApp
  //   (user กด Approve สองครั้งรวด → ไม่ให้ applyReviewDecision ทำงานซ้อนกัน
  //   ซึ่งอาจทำให้ FACT_DELIVERY มี duplicate rows หรือ Q_REVIEW status inconsistent)
  //   ใช้ WebApp context — ไม่สามารถใช้ acquireScriptLockOrWarn_ ได้เพราะไม่มี UI
  //   ต้อง return error กลับไปที่ frontend แทนการ show alert
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    logWarn('WebApp', 'submitReviewDecision: lock not acquired (another submit in progress) — reviewId=' + reviewId);
    return {
      ok: false,
      message: 'กำลังประมวลผล review อื่นอยู่ กรุณารอสักครู่แล้วลองอีกครั้ง',
      reviewId: reviewId,
      code: 'LOCK_BUSY'
    };
  }

  try {
    // ดึง rowData ล่าสุดจาก sheet (frontend ส่งมาอาจเก่าแล้ว)
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!sheet) {
      return { ok: false, message: 'ไม่พบ sheet Q_REVIEW' };
    }

    // หา row ที่มี reviewId นี้
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return { ok: false, message: 'Q_REVIEW ว่าง' };
    }

    const data = sheet.getRange(2, 1, lastRow - 1, SCHEMA[SHEET.Q_REVIEW].length).getValues();
    let targetRow = -1;
    let rowData = null;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][REVIEW_IDX.REVIEW_ID]).trim() === reviewId) {
        targetRow = i + 2;
        rowData = data[i];
        break;
      }
    }

    if (targetRow === -1 || !rowData) {
      return { ok: false, message: 'ไม่พบ reviewId: ' + reviewId };
    }

    // ตรวจว่ารายการยัง Pending อยู่หรือไม่ (defense-in-depth)
    const currentStatus = String(rowData[REVIEW_IDX.STATUS] || '')
      .trim()
      .toLowerCase();
    if (
      currentStatus === 'approved' ||
      currentStatus === 'rejected' ||
      currentStatus === 'done' ||
      currentStatus === 'escalated'
    ) {
      return {
        ok: false,
        message: 'รายการนี้ถูกตัดสินใจแล้ว (status=' + currentStatus + ') ไม่สามารถเปลี่ยนแปลงได้',
        reviewId: reviewId
      };
    }

    // เพิ่ม note ถ้ามี
    if (note) {
      rowData[REVIEW_IDX.NOTE] = note;
    }

    // [V6.0.008 P1.3 — BUG-WEB-002 atomicity fix from LMDS_Master_Audit_Report]
    //   Capture original status BEFORE applyReviewDecision so we can rollback
    //   Q_REVIEW status if FACT_DELIVERY write fails.
    //   ปัญหาเดิม: applyReviewDecision อัปเดต Q_REVIEW status → 'Done' ก่อน
    //   แล้วค่อยเขียน FACT_DELIVERY — ถ้า FACT write fail, Q_REVIEW จะ "Done"
    //   แต่ไม่มี fact row → data inconsistency (review สำเร็จแต่ไม่มี delivery record)
    //   วิธีแก้: เก็บ original status → applyReviewDecision → ถ้า FACT write fail
    //   ให้ rollback Q_REVIEW status กลับเป็น original + return error
    const originalStatus = String(rowData[REVIEW_IDX.STATUS] || '').trim();

    // เรียกใช้ฟังก์ชันที่มีอยู่แล้วใน 12_ReviewService.gs
    const result = applyReviewDecision(reviewId, decision, rowData, targetRow);

    // [FIX V5.5.049 BUG-QREVIEW] เขียน factRowData ลง FACT_DELIVERY จริง
    //   ปัญหา: applyReviewDecision คืน factRowData แต่ไม่ได้เขียนลง sheet
    //   ใน batch flow (applyAllPendingDecisions) มี batch write แต่ single decision ไม่มี
    //   ทำให้กด Approve แล้วข้อมูลไม่ถูกสร้างใน FACT_DELIVERY
    let factRowWritten = false;
    if (result && result.factRowData) {
      try {
        const factSheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
        if (factSheet) {
          // [FIX BUG-PM-004 V5.5.041] Math.min guard สำหรับ column count mismatch
          const factSchemaLen = SCHEMA[SHEET.FACT_DELIVERY].length;
          const factSheetCols = Math.min(factSchemaLen, factSheet.getLastColumn());
          const rowsToWrite =
            factSheetCols === factSchemaLen ? [result.factRowData] : [result.factRowData.slice(0, factSheetCols)];
          factSheet.getRange(factSheet.getLastRow() + 1, 1, 1, factSheetCols).setValues(rowsToWrite);
          factRowWritten = true;
          logInfo(
            'WebApp',
            'submitReviewDecision: เขียน FACT_DELIVERY สำเร็จ — txId=' + result.factRowData[FACT_IDX.TX_ID]
          );
        }
      } catch (factErr) {
        // [V6.0.008 P1.3] Atomicity rollback — FACT write failed, restore Q_REVIEW status
        //   เพื่อไม่ให้ Q_REVIEW ค้างอยู่ที่ "Done" โดยไม่มี fact row
        //   user สามารถลอง approve ใหม่ได้หลังจากแก้ปัญหาที่ทำให้ FACT write fail
        logError(
          'WebApp',
          'submitReviewDecision: เขียน FACT_DELIVERY ล้มเหลว — กำลัง rollback Q_REVIEW status จาก Done → ' +
            (originalStatus || 'Pending') +
            ' — ' +
            factErr.message,
          factErr
        );
        try {
          // Re-read Q_REVIEW row to get current state (applyReviewDecision may have updated it)
          const currentRowData = sheet.getRange(targetRow, 1, 1, SCHEMA[SHEET.Q_REVIEW].length).getValues()[0];
          currentRowData[REVIEW_IDX.STATUS] = originalStatus || 'Pending';
          currentRowData[REVIEW_IDX.REVIEWED_AT] = '';
          currentRowData[REVIEW_IDX.REVIEWER] = '';
          currentRowData[REVIEW_IDX.DECISION] = '';
          sheet.getRange(targetRow, 1, 1, SCHEMA[SHEET.Q_REVIEW].length).setValues([currentRowData]);
          logInfo('WebApp', 'submitReviewDecision: rollback Q_REVIEW status สำเร็จ — reviewId=' + reviewId);
        } catch (rollbackErr) {
          logError(
            'WebApp',
            'submitReviewDecision: rollback Q_REVIEW status ล้มเหลวด้วย — reviewId=' +
              reviewId +
              ' อาจต้อง manual rollback — ' +
              rollbackErr.message,
            rollbackErr
          );
        }
        return {
          ok: false,
          message:
            'เขียน FACT_DELIVERY ล้มเหลว — ได้ rollback Q_REVIEW status แล้ว กรุณาลองอีกครั้ง (' +
            factErr.message +
            ')',
          reviewId: reviewId
        };
      }
    }

    logInfo(
      'WebApp',
      'submitReviewDecision: ' + reviewId + ' → ' + decision + ' โดย ' + (getCurrentDashboardUser_().email || '?')
    );

    return {
      ok: true,
      reviewId: reviewId,
      decision: decision,
      message: 'บันทึกการตัดสินใจสำเร็จ',
      result: { factRowWritten: factRowWritten }
    };
  } catch (err) {
    logError('WebApp', 'submitReviewDecision ล้มเหลว: ' + err.message, err);
    return { ok: false, message: err.message || 'Unknown error', reviewId: reviewId };
  } finally {
    // [V6.0.009 P2.1] Always release lock — ใช้ shared helper
    releaseScriptLock_(lock);
  }
}

/**
 * getReviewDetail — Phase 2: ดึงรายละเอียดเต็มของ review item เพื่อให้ reviewer
 *   ตัดสินใจได้มั่นใจ ประกอบด้วย:
 *   - review row เต็ม (รวม note, reviewer, reviewed_at)
 *   - source row (จาก SOURCE sheet) — ข้อมูลดิบที่ทำให้เกิดการ review
 *   - candidate persons (จาก M_PERSON) — แสดง name, phone, usage_count, status
 *   - candidate places (จาก M_PLACE) — แสดง name, address, usage_count
 *   - candidate destinations (จาก M_DESTINATION) — แสดง lat, lng, route_label
 *   - distance (เมตร) ระหว่าง raw_lat/lng กับ candidate destination lat/lng
 *
 * @param {string} reviewId
 * @return {Object} { review, source, candidates: { persons: [], places: [], destinations: [] } }
 */
function getReviewDetail(reviewId) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  const startTime = Date.now();
  if (!reviewId) {
    return { ok: false, message: 'กรุณาระบุ reviewId' };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ─── 1. ดึง review row ───
    const reviewSheet = ss.getSheetByName(SHEET.Q_REVIEW);
    if (!reviewSheet || reviewSheet.getLastRow() <= 1) {
      return { ok: false, message: 'ไม่พบ sheet Q_REVIEW หรือว่าง' };
    }

    const reviewData = reviewSheet
      .getRange(2, 1, reviewSheet.getLastRow() - 1, SCHEMA[SHEET.Q_REVIEW].length)
      .getValues();
    let reviewRow = null;
    let reviewSheetRow = -1;
    for (let i = 0; i < reviewData.length; i++) {
      if (String(reviewData[i][REVIEW_IDX.REVIEW_ID]).trim() === reviewId) {
        reviewRow = reviewData[i];
        reviewSheetRow = i + 2;
        break;
      }
    }
    if (!reviewRow) {
      return { ok: false, message: 'ไม่พบ reviewId: ' + reviewId };
    }

    const review = {
      reviewId: String(reviewRow[REVIEW_IDX.REVIEW_ID] || ''),
      issueType: String(reviewRow[REVIEW_IDX.ISSUE_TYPE] || ''),
      priority: String(reviewRow[REVIEW_IDX.PRIORITY] || ''),
      sourceRecId: String(reviewRow[REVIEW_IDX.SOURCE_REC_ID] || ''),
      sourceRowNumber: Number(reviewRow[REVIEW_IDX.SOURCE_ROW] || 0),
      invoiceNo: String(reviewRow[REVIEW_IDX.INVOICE_NO] || ''),
      rawPerson: String(reviewRow[REVIEW_IDX.RAW_PERSON] || ''),
      rawPlace: String(reviewRow[REVIEW_IDX.RAW_PLACE] || ''),
      rawAddress: String(reviewRow[REVIEW_IDX.RAW_SYS_ADDR] || ''),
      rawLat: Number(reviewRow[REVIEW_IDX.RAW_LAT] || 0),
      rawLng: Number(reviewRow[REVIEW_IDX.RAW_LNG] || 0),
      matchScore: Number(reviewRow[REVIEW_IDX.MATCH_SCORE] || 0),
      recommend: String(reviewRow[REVIEW_IDX.RECOMMEND] || ''),
      status: String(reviewRow[REVIEW_IDX.STATUS] || 'Pending'),
      reviewer: String(reviewRow[REVIEW_IDX.REVIEWER] || ''),
      decision: String(reviewRow[REVIEW_IDX.DECISION] || ''),
      note: String(reviewRow[REVIEW_IDX.NOTE] || ''),
      _sheetRow: reviewSheetRow
    };

    // ─── 2. ดึง source row (ถ้ามี sourceRowNumber) ───
    let source = null;
    if (review.sourceRowNumber > 1) {
      const srcSheet = ss.getSheetByName(SHEET.SOURCE);
      if (srcSheet && srcSheet.getLastRow() >= review.sourceRowNumber) {
        const srcData = srcSheet.getRange(review.sourceRowNumber, 1, 1, srcSheet.getLastColumn()).getValues()[0];
        source = {
          rowNumber: review.sourceRowNumber,
          sourceId: String(srcData[SRC_IDX.SOURCE_ID] || ''),
          deliveryDate:
            srcData[SRC_IDX.DELIVERY_DATE] instanceof Date
              ? srcData[SRC_IDX.DELIVERY_DATE].toISOString()
              : String(srcData[SRC_IDX.DELIVERY_DATE] || ''),
          deliveryTime: String(srcData[SRC_IDX.DELIVERY_TIME] || ''),
          driverName: String(srcData[SRC_IDX.DRIVER_NAME] || ''),
          truckLicense: String(srcData[SRC_IDX.TRUCK_LICENSE] || ''),
          shipmentNo: String(srcData[SRC_IDX.SHIPMENT_NO] || ''),
          invoiceNo: String(srcData[SRC_IDX.INVOICE_NO] || ''),
          customerCode: String(srcData[SRC_IDX.CUSTOMER_CODE] || ''),
          soldToName: String(srcData[SRC_IDX.SOLD_TO_NAME] || ''),
          rawPersonName: String(srcData[SRC_IDX.RAW_PERSON_NAME] || ''),
          lat: Number(srcData[SRC_IDX.LAT] || 0),
          lng: Number(srcData[SRC_IDX.LNG] || 0),
          warehouse: String(srcData[SRC_IDX.WAREHOUSE] || ''),
          rawAddress: String(srcData[SRC_IDX.RAW_ADDRESS] || ''),
          resolvedAddr: String(srcData[SRC_IDX.RESOLVED_ADDR] || ''),
          remark: String(srcData[SRC_IDX.REMARK] || ''),
          distFromWh: Number(srcData[SRC_IDX.DIST_FROM_WH] || 0),
          driverVerifiedName: String(srcData[SRC_IDX.DRIVER_VERIFIED_NAME] || ''),
          driverVerifiedAddr: String(srcData[SRC_IDX.DRIVER_VERIFIED_ADDR] || '')
        };
      }
    }

    // ─── 3. ดึง candidate persons + places + destinations ───
    const candPersonIds = safeParseJsonArray_(reviewRow[REVIEW_IDX.CAND_PERSONS]);
    const candPlaceIds = safeParseJsonArray_(reviewRow[REVIEW_IDX.CAND_PLACES]);
    const candDestIds = safeParseJsonArray_(reviewRow[REVIEW_IDX.CAND_DESTS]);

    const candidates = {
      persons: [],
      places: [],
      destinations: []
    };

    // 3a. Candidate persons
    if (candPersonIds.length > 0) {
      const personSheet = ss.getSheetByName(SHEET.M_PERSON);
      if (personSheet && personSheet.getLastRow() > 1) {
        const persons = personSheet
          .getRange(2, 1, personSheet.getLastRow() - 1, SCHEMA[SHEET.M_PERSON].length)
          .getValues();
        persons.forEach(function (row) {
          const pid = String(row[PERSON_IDX.PERSON_ID] || '');
          if (candPersonIds.indexOf(pid) !== -1) {
            candidates.persons.push({
              personId: pid,
              canonicalName: String(row[PERSON_IDX.CANONICAL] || ''),
              phone: String(row[PERSON_IDX.PHONE] || ''),
              usageCount: Number(row[PERSON_IDX.USAGE_COUNT] || 0),
              status: String(row[PERSON_IDX.STATUS] || ''),
              lastSeen: row[PERSON_IDX.LAST_SEEN] instanceof Date ? row[PERSON_IDX.LAST_SEEN].toISOString() : ''
            });
          }
        });
      }
    }

    // 3b. Candidate places
    if (candPlaceIds.length > 0) {
      const placeSheet = ss.getSheetByName(SHEET.M_PLACE);
      if (placeSheet && placeSheet.getLastRow() > 1) {
        const places = placeSheet.getRange(2, 1, placeSheet.getLastRow() - 1, SCHEMA[SHEET.M_PLACE].length).getValues();
        places.forEach(function (row) {
          const pid = String(row[PLACE_IDX.PLACE_ID] || '');
          if (candPlaceIds.indexOf(pid) !== -1) {
            candidates.places.push({
              placeId: pid,
              canonicalName: String(row[PLACE_IDX.CANONICAL] || ''),
              placeType: String(row[PLACE_IDX.PLACE_TYPE] || ''),
              subDistrict: String(row[PLACE_IDX.SUB_DISTRICT] || ''),
              district: String(row[PLACE_IDX.DISTRICT] || ''),
              province: String(row[PLACE_IDX.PROVINCE] || ''),
              postcode: String(row[PLACE_IDX.POSTCODE] || ''),
              usageCount: Number(row[PLACE_IDX.USAGE_COUNT] || 0),
              status: String(row[PLACE_IDX.STATUS] || ''),
              lastSeen: row[PLACE_IDX.LAST_SEEN] instanceof Date ? row[PLACE_IDX.LAST_SEEN].toISOString() : ''
            });
          }
        });
      }
    }

    // 3c. Candidate destinations (สำคัญที่สุดเพราะมี lat/lng จริง)
    if (candDestIds.length > 0) {
      const destSheet = ss.getSheetByName(SHEET.M_DESTINATION);
      if (destSheet && destSheet.getLastRow() > 1) {
        const dests = destSheet
          .getRange(2, 1, destSheet.getLastRow() - 1, SCHEMA[SHEET.M_DESTINATION].length)
          .getValues();
        dests.forEach(function (row) {
          const did = String(row[DEST_IDX.DEST_ID] || '');
          if (candDestIds.indexOf(did) !== -1) {
            const lat = Number(row[DEST_IDX.LAT] || 0);
            const lng = Number(row[DEST_IDX.LNG] || 0);
            const distance =
              review.rawLat && review.rawLng && lat && lng
                ? haversineDistanceMeters_(review.rawLat, review.rawLng, lat, lng)
                : null;
            candidates.destinations.push({
              destId: did,
              personId: String(row[DEST_IDX.PERSON_ID] || ''),
              placeId: String(row[DEST_IDX.PLACE_ID] || ''),
              lat: lat,
              lng: lng,
              routeLabel: String(row[DEST_IDX.ROUTE_LABEL] || ''),
              usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0),
              status: String(row[DEST_IDX.STATUS] || ''),
              lastSeen: row[DEST_IDX.LAST_SEEN] instanceof Date ? row[DEST_IDX.LAST_SEEN].toISOString() : '',
              distanceFromRawMeters: distance
            });
          }
        });
      }
    }

    const elapsedMs = Date.now() - startTime;
    logInfo(
      'WebApp',
      'getReviewDetail: ' +
        reviewId +
        ' → candidates: ' +
        candidates.persons.length +
        'p/' +
        candidates.places.length +
        'pl/' +
        candidates.destinations.length +
        'd in ' +
        elapsedMs +
        'ms'
    );

    return {
      ok: true,
      review: review,
      source: source,
      candidates: candidates,
      elapsedMs: elapsedMs
    };
  } catch (err) {
    logError('WebApp', 'getReviewDetail ล้มเหลว: ' + err.message, err);
    return { ok: false, message: err.message || 'Unknown error' };
  }
}

/**
 * haversineDistanceMeters_ — คำนวณระยะทางระหว่าง 2 พิกัด (เมตร)
 *   [FIX Static Audit Issue 4] delegate ไป haversineDistanceM() ใน 14_Utils.gs
 *   แทนการ re-implement Haversine formula ซ้ำ — Single Source of Truth
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @return {number} ระยะทางในหน่วยเมตร (rounded)
 * @private
 */
function haversineDistanceMeters_(lat1, lng1, lat2, lng2) {
  if (typeof haversineDistanceM === 'function') {
    return Math.round(haversineDistanceM(lat1, lng1, lat2, lng2));
  }
  // Fallback: re-implement (กรณี 14_Utils.gs ยังไม่ถูกโหลด)
  const R = 6371000;
  const toRad = function (deg) {
    return (deg * Math.PI) / 180;
  };
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * searchLocations — ค้นหาพิกัดจากชื่อ/ที่อยู่/เบอร์โทร
 *   ค้นหาใน M_PERSON (canonical_name, phone)
 *   ค้นหาใน M_PLACE (canonical_name, sub_district, district, province, postcode)
 *   ค้นหาใน M_ALIAS (variant_name) → map กลับไป person/place
 *   รวมผลลัพธ์ + ดึงพิกัดจาก M_DESTINATION
 *
 * @param {string} query - คำค้นหา (ชื่อ/ที่อยู่/เบอร์โทร/รหัสไปรษณีย์)
 * @param {number} limit - จำนวนผลลัพธ์สูงสุด (default 20)
 * @return {Object} { results, total, query, elapsedMs }
 */
function searchLocations(query, limit) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  // [V6.0.055] Use centralized input validation (B2 — Security Hardening)
  const validation = validateInput_(
    { query: query, limit: limit },
    {
      query: { type: 'string', required: true, minLength: 2, maxLength: 200 },
      limit: { type: 'number', required: false, min: 1, max: 100, default: 20 }
    }
  );
  if (!validation.valid) {
    return {
      results: [],
      total: 0,
      query: String(query || ''),
      elapsedMs: 0,
      message: validation.errors.join('; ')
    };
  }

  const startTime = Date.now();
  const maxResults = validation.sanitized.limit;
  const rawQuery = validation.sanitized.query;

  const normQuery = rawQuery.toLowerCase().replace(/\s+/g, '');
  const isPhoneQuery = /^\d{6,}$/.test(normQuery.replace(/[-\s]/g, ''));
  const isPostcodeQuery = /^\d{5}$/.test(normQuery);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // โหลดข้อมูลจาก 4 sheets แบบ batch
    const personSheet = ss.getSheetByName(SHEET.M_PERSON);
    const placeSheet = ss.getSheetByName(SHEET.M_PLACE);
    const aliasSheet = ss.getSheetByName(SHEET.M_ALIAS);
    const destSheet = ss.getSheetByName(SHEET.M_DESTINATION);

    const persons =
      personSheet && personSheet.getLastRow() > 1
        ? personSheet.getRange(2, 1, personSheet.getLastRow() - 1, SCHEMA[SHEET.M_PERSON].length).getValues()
        : [];
    const places =
      placeSheet && placeSheet.getLastRow() > 1
        ? placeSheet.getRange(2, 1, placeSheet.getLastRow() - 1, SCHEMA[SHEET.M_PLACE].length).getValues()
        : [];
    const aliases =
      aliasSheet && aliasSheet.getLastRow() > 1
        ? aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, SCHEMA[SHEET.M_ALIAS].length).getValues()
        : [];
    const dests =
      destSheet && destSheet.getLastRow() > 1
        ? destSheet.getRange(2, 1, destSheet.getLastRow() - 1, SCHEMA[SHEET.M_DESTINATION].length).getValues()
        : [];

    // สร้าง index maps
    const personMap = buildPersonMap_(persons);
    const placeMap = buildPlaceMap_(places);
    const destByPerson = buildDestIndexByPerson_(dests);
    const destByPlace = buildDestIndexByPlace_(dests);

    // ค้นหา
    const matchedPersonIds = new Set();
    const matchedPlaceIds = new Set();

    // 1. ค้นจาก M_PERSON
    persons.forEach(function (row) {
      const name = String(row[PERSON_IDX.CANONICAL] || '').toLowerCase();
      const phone = String(row[PERSON_IDX.PHONE] || '')
        .toLowerCase()
        .replace(/[-\s]/g, '');
      const status = String(row[PERSON_IDX.STATUS] || '');
      if (status === APP_CONST.STATUS_ARCHIVED || status === APP_CONST.STATUS_MERGED) return;

      if (name.includes(normQuery) || (isPhoneQuery && phone.includes(normQuery.replace(/[-\s]/g, '')))) {
        matchedPersonIds.add(String(row[PERSON_IDX.PERSON_ID]));
      }
    });

    // 2. ค้นจาก M_PLACE
    places.forEach(function (row) {
      const name = String(row[PLACE_IDX.CANONICAL] || '').toLowerCase();
      const subDistrict = String(row[PLACE_IDX.SUB_DISTRICT] || '').toLowerCase();
      const district = String(row[PLACE_IDX.DISTRICT] || '').toLowerCase();
      const province = String(row[PLACE_IDX.PROVINCE] || '').toLowerCase();
      const postcode = String(row[PLACE_IDX.POSTCODE] || '');
      const status = String(row[PLACE_IDX.STATUS] || '');
      if (status === APP_CONST.STATUS_ARCHIVED || status === APP_CONST.STATUS_MERGED) return;

      const haystack = name + ' ' + subDistrict + ' ' + district + ' ' + province;
      if (haystack.includes(normQuery) || (isPostcodeQuery && postcode === normQuery)) {
        matchedPlaceIds.add(String(row[PLACE_IDX.PLACE_ID]));
      }
    });

    // 3. ค้นจาก M_ALIAS → map กลับไป person/place
    aliases.forEach(function (row) {
      const variant = String(row[ALIAS_IDX.VARIANT_NAME] || '').toLowerCase();
      const masterUuid = String(row[ALIAS_IDX.MASTER_UUID] || '');
      const entityType = String(row[ALIAS_IDX.ENTITY_TYPE] || '');
      const active = String(row[ALIAS_IDX.ACTIVE_FLAG] || '');
      if (active !== 'true' && active !== 'TRUE') return;

      if (variant.includes(normQuery)) {
        if (entityType === 'PERSON') {
          const personId = findPersonIdByUuid_(persons, masterUuid);
          if (personId) matchedPersonIds.add(personId);
        } else if (entityType === 'PLACE') {
          const placeId = findPlaceIdByUuid_(places, masterUuid);
          if (placeId) matchedPlaceIds.add(placeId);
        }
      }
    });

    // 4. สร้างผลลัพธ์
    const results = [];
    matchedPersonIds.forEach(function (personId) {
      const person = personMap[personId];
      if (!person) return;
      const dest = destByPerson[personId];
      if (dest && dest.lat && dest.lng) {
        results.push({
          name: person.canonicalName,
          phone: person.phone,
          address: '',
          lat: dest.lat,
          lng: dest.lng,
          destId: dest.destId,
          source: 'PERSON',
          usageCount: dest.usageCount || person.usageCount || 0
        });
      }
    });

    matchedPlaceIds.forEach(function (placeId) {
      const place = placeMap[placeId];
      if (!place) return;
      const dest = destByPlace[placeId];
      if (dest && dest.lat && dest.lng) {
        results.push({
          name: place.canonicalName,
          phone: '',
          address: buildAddressStr_(place),
          lat: dest.lat,
          lng: dest.lng,
          destId: dest.destId,
          source: 'PLACE',
          usageCount: dest.usageCount || place.usageCount || 0
        });
      }
    });

    // เรียงตาม usageCount  descending + จำกัดจำนวน
    results.sort(function (a, b) {
      return (b.usageCount || 0) - (a.usageCount || 0);
    });
    const trimmed = results.slice(0, maxResults);

    const elapsedMs = Date.now() - startTime;
    logInfo('WebApp', 'searchLocations("' + rawQuery + '") → ' + trimmed.length + ' results in ' + elapsedMs + 'ms');

    return {
      results: trimmed,
      total: results.length,
      query: rawQuery,
      elapsedMs: elapsedMs
    };
  } catch (err) {
    logError('WebApp', 'searchLocations ล้มเหลว: ' + err.message, err);
    throw err;
  }
}

function buildPersonMap_(persons) {
  const map = {};
  persons.forEach(function (row) {
    const id = String(row[PERSON_IDX.PERSON_ID] || '');
    if (id) {
      map[id] = {
        personId: id,
        canonicalName: String(row[PERSON_IDX.CANONICAL] || ''),
        phone: String(row[PERSON_IDX.PHONE] || ''),
        usageCount: Number(row[PERSON_IDX.USAGE_COUNT] || 0)
      };
    }
  });
  return map;
}

function buildPlaceMap_(places) {
  const map = {};
  places.forEach(function (row) {
    const id = String(row[PLACE_IDX.PLACE_ID] || '');
    if (id) {
      map[id] = {
        placeId: id,
        canonicalName: String(row[PLACE_IDX.CANONICAL] || ''),
        subDistrict: String(row[PLACE_IDX.SUB_DISTRICT] || ''),
        district: String(row[PLACE_IDX.DISTRICT] || ''),
        province: String(row[PLACE_IDX.PROVINCE] || ''),
        postcode: String(row[PLACE_IDX.POSTCODE] || ''),
        usageCount: Number(row[PLACE_IDX.USAGE_COUNT] || 0)
      };
    }
  });
  return map;
}

function buildDestIndexByPerson_(dests) {
  const map = {};
  dests.forEach(function (row) {
    const personId = String(row[DEST_IDX.PERSON_ID] || '');
    const status = String(row[DEST_IDX.STATUS] || '');
    if (personId && status !== APP_CONST.STATUS_ARCHIVED && status !== APP_CONST.STATUS_MERGED) {
      const lat = Number(row[DEST_IDX.LAT] || 0);
      const lng = Number(row[DEST_IDX.LNG] || 0);
      if (lat && lng && personId) {
        map[personId] = {
          destId: String(row[DEST_IDX.DEST_ID] || ''),
          lat: lat,
          lng: lng,
          usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0)
        };
      }
    }
  });
  return map;
}

function buildDestIndexByPlace_(dests) {
  const map = {};
  dests.forEach(function (row) {
    const placeId = String(row[DEST_IDX.PLACE_ID] || '');
    const status = String(row[DEST_IDX.STATUS] || '');
    if (placeId && status !== APP_CONST.STATUS_ARCHIVED && status !== APP_CONST.STATUS_MERGED) {
      const lat = Number(row[DEST_IDX.LAT] || 0);
      const lng = Number(row[DEST_IDX.LNG] || 0);
      if (lat && lng) {
        map[placeId] = {
          destId: String(row[DEST_IDX.DEST_ID] || ''),
          lat: lat,
          lng: lng,
          usageCount: Number(row[DEST_IDX.USAGE_COUNT] || 0)
        };
      }
    }
  });
  return map;
}

function findPersonIdByUuid_(persons, uuid) {
  for (let i = 0; i < persons.length; i++) {
    if (String(persons[i][PERSON_IDX.MASTER_UUID] || '') === uuid) {
      return String(persons[i][PERSON_IDX.PERSON_ID] || '');
    }
  }
  return '';
}

function findPlaceIdByUuid_(places, uuid) {
  for (let i = 0; i < places.length; i++) {
    if (String(places[i][PLACE_IDX.MASTER_UUID] || '') === uuid) {
      return String(places[i][PLACE_IDX.PLACE_ID] || '');
    }
  }
  return '';
}

function buildAddressStr_(place) {
  const parts = [];
  if (place.canonicalName) parts.push(place.canonicalName);
  if (place.subDistrict) parts.push(place.subDistrict);
  if (place.district) parts.push(place.district);
  if (place.province) parts.push(place.province);
  if (place.postcode) parts.push(place.postcode);
  return parts.join(' ');
}

/**
 * getMapAnalyticsData — [V6.0.004] Get delivery data for map visualization
 * @param {number} [days=30] - number of days to look back
 * @param {string} [filterStatus=''] - filter by match status
 * @return {Array} array of { lat, lng, count, matchStatus, personId, destId }
 */
function getMapAnalyticsData(days, filterStatus) {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');

  // [V6.0.055] Use centralized input validation (B2 — Security Hardening)
  const validation = validateInput_(
    { days: days, filterStatus: filterStatus },
    {
      days: { type: 'number', required: false, min: 1, max: 365, default: 30 },
      filterStatus: { type: 'string', required: false, maxLength: 50 }
    }
  );
  if (!validation.valid) {
    return { error: validation.errors.join('; ') };
  }

  const lookbackDays = validation.sanitized.days;
  const statusFilter = validation.sanitized.filterStatus || '';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.FACT_DELIVERY);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const cols = Math.min(SCHEMA[SHEET.FACT_DELIVERY].length, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols).getValues();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const points = [];
  const seen = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const deliveryDate = row[FACT_IDX.DELIVERY_DATE];
    if (deliveryDate && new Date(deliveryDate) < cutoff) continue;

    const status = String(row[FACT_IDX.MATCH_STATUS] || '');
    if (statusFilter && status !== statusFilter) continue;

    const lat = Number(row[FACT_IDX.RESOLVED_LAT] || 0);
    const lng = Number(row[FACT_IDX.RESOLVED_LNG] || 0);
    if (lat === 0 || lng === 0) continue;

    const key = Math.round(lat * 1000) / 1000 + ',' + Math.round(lng * 1000) / 1000;
    if (seen[key]) {
      seen[key].count++;
    } else {
      seen[key] = {
        lat: lat,
        lng: lng,
        count: 1,
        matchStatus: status,
        personId: String(row[FACT_IDX.PERSON_ID] || ''),
        destId: String(row[FACT_IDX.DEST_ID] || '')
      };
      points.push(seen[key]);
    }
  }

  return points.slice(0, 5000);
}

/**
 * getMatchEngineLiveStatus — [V6.0.004] Get current MatchEngine progress
 * @return {Object} { isRunning, currentRow, totalRows, recentMatches, errorCount, startedAt }
 */
function getMatchEngineLiveStatus() {
  if (!isAuthorizedDashboardUser_()) throw new Error('Unauthorized');
  const props = PropertiesService.getScriptProperties();
  return {
    isRunning: props.getProperty('MATCH_ENGINE_RUNNING') === 'true',
    currentRow: Number(props.getProperty('MATCH_ENGINE_CURRENT_ROW') || 0),
    totalRows: Number(props.getProperty('MATCH_ENGINE_TOTAL_ROWS') || 0),
    startedAt: props.getProperty('MATCH_ENGINE_STARTED_AT'),
    lastMatchAt: props.getProperty('MATCH_ENGINE_LAST_MATCH'),
    errorCount: Number(props.getProperty('MATCH_ENGINE_ERRORS') || 0),
    recentMatches: JSON.parse(props.getProperty('MATCH_ENGINE_RECENT') || '[]')
  };
}
