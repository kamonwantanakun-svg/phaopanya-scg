# LMDS_FIX_04 — Add LockService to 11 Unprotected State-Mutators

**Audit source:** `LMDS_AUDIT_REPORT.md` Section 6 (FIX #3)
**Strategy:** Apply identical `tryLock + finally releaseLock` pattern to 11 functions that currently lack protection.

---

## Template (Apply to Each Function)

For each function below, replace the body wrapper as follows:

```javascript
function <FN_NAME>() {
  // [FIX BUGHUNT-0X from LMDS_PREDEPLOY_AUDIT 2026-07-08] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS || 10000)) {
    safeUiAlert_('⚠️ มีการรันอื่นกำลังทำงานอยู่ กรุณารอสักครู่');
    return;
  }
  try {
    // ========== EXISTING BODY (unchanged) ==========
    // ... paste existing function body here ...
    // ========== END EXISTING BODY ==========
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

## Patches to Apply

### Patch 4.1 — `src/2_group2_daily_ops/04_SourceRepository.gs:93` — `runLoadSource`

**BUGHUNT-04:** No LockService — rapid click may corrupt SOURCE SYNC_STATUS.

Insert at top of function body, wrap existing `try` in `try { ... } finally { lock.releaseLock(); }`.

```javascript
function runLoadSource() {
  // [FIX BUGHUNT-04] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS || 10000)) {
    safeUiAlert_('⚠️ มีการโหลด Source อื่นกำลังทำงานอยู่ กรุณารอสักครู่');
    return;
  }
  try {
    // existing body unchanged
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // ... (keep all existing code) ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.2 — `src/1_group1_master_db/21_AliasService.gs:812` — `MIGRATION_HybridAliasSystem`

**BUGHUNT-05:** One-shot migration has no lock — double-click may duplicate M_ALIAS rows.

```javascript
function MIGRATION_HybridAliasSystem() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {  // longer timeout for migration
    safeUiAlert_('⚠️ Migration กำลังทำงานอยู่');
    return;
  }
  try {
    // ... existing migration body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

Add **idempotency check** before migration body:
```javascript
// Idempotency guard — skip if already migrated
const aliasSheet = ss.getSheetByName(SHEET.M_ALIAS);
if (aliasSheet && aliasSheet.getLastRow() > 1) {
  const sourceCol = ALIAS_IDX.SOURCE + 1;
  const sample = aliasSheet.getRange(2, sourceCol, Math.min(50, aliasSheet.getLastRow() - 1), 1).getValues();
  const migratedCount = sample.filter(r => String(r[0]) === 'HYBRID_AUTO').length;
  if (migratedCount >= sample.length * 0.8) {
    logWarn('AliasService', 'MIGRATION_HybridAliasSystem: already migrated (skip)');
    return { skipped: true, reason: 'ALREADY_MIGRATED' };
  }
}
```

---

### Patch 4.3 — `src/O_core_system/19_Hardening.gs:223` — `generatePersonAliasesFromHistory`

**BUGHUNT-06:** Bulk M_PERSON_ALIAS write without lock — double-click duplicates aliases.

```javascript
function generatePersonAliasesFromHistory() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_CONST.LOCK_TIMEOUT_MS)) {
    safeUiAlert_('⚠️ การสร้าง Alias กำลังทำงานอยู่');
    return;
  }
  try {
    // ... existing body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

Add **dedup check** before each `appendRow`:
```javascript
// Inside the loop, before writing to M_PERSON_ALIAS:
const existingKey = normalizeForCompare(name + '|' + personId);
const aliasSheet = ss.getSheetByName(SHEET.M_PERSON_ALIAS);
const aliasData = aliasSheet.getDataRange().getValues();
// Build Set once outside loop for performance
if (!existsSet) {
  existsSet = new Set();
  for (let i = 1; i < aliasData.length; i++) {
    existsSet.add(normalizeForCompare(aliasData[i][0] + '|' + aliasData[i][1]));
  }
}
if (existsSet.has(existingKey)) continue;
existsSet.add(existingKey);
```

---

### Patch 4.4 — `src/1_group1_master_db/21_AliasService.gs:1325` — `populateAliasFromSCGRawData_`

Same pattern as 4.3 (it's a bulk writer).

---

### Patch 4.5 — `src/1_group1_master_db/16_GeoDictionaryBuilder.gs:116` — `buildGeoDictionary`

```javascript
function buildGeoDictionary() {
  // [FIX BUGHUNT-??] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {  // longer — geo data is large
    safeUiAlert_('⚠️ Geo Dictionary กำลังถูกสร้างอยู่');
    return;
  }
  try {
    // ... existing body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.6 — `src/1_group1_master_db/20_ThGeoService.gs:173` — `populateGeoMetadata`

```javascript
function populateGeoMetadata() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    safeUiAlert_('⚠️ Geo Metadata กำลังถูกเติมอยู่');
    return;
  }
  try {
    // ... existing body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.7 — `src/2_group2_daily_ops/18_ServiceSCG.gs:1084` — `safeResetTransactional_UI`

Already has YES_NO confirm. Just add LockService:

```javascript
function safeResetTransactional_UI() {
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ล้างข้อมูล\nกรุณาติดต่อ Admin');
    return;
  }
  // [FIX BUGHUNT-??] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    safeUiAlert_('⚠️ มีการ Reset อื่นกำลังทำงานอยู่');
    return;
  }
  try {
    // ... existing confirm + clear body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.8 — `src/2_group2_daily_ops/12_ReviewService.gs:1775` — `clearDoneReviews_UI`

```javascript
function clearDoneReviews_UI() {
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ล้าง Review\nกรุณาติดต่อ Admin');
    return;
  }
  // [FIX BUGHUNT-??] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    safeUiAlert_('⚠️ มีการล้าง Review อื่นกำลังทำงานอยู่');
    return;
  }
  try {
    // ... existing body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.9 — `src/O_core_system/14_Utils.gs:135` — `resetSourceSyncStatus`

**HIGH RISK** — re-enables pipeline. Add YES_NO confirm + LockService:

```javascript
function resetSourceSyncStatus() {
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์รีเซ็ต SYNC\nกรุณาติดต่อ Admin');
    return;
  }
  // [FIX BUGHUNT-??] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    safeUiAlert_('⚠️ มีการรีเซ็ต SYNC อื่นกำลังทำงานอยู่');
    return;
  }
  try {
    // [FIX BUGHUNT-??] Add YES_NO confirm (was missing!)
    const ui = SpreadsheetApp.getUi();
    const confirm = ui.alert(
      '🔄 รีเซ็ตสถานะ SYNC',
      'กำลังจะเคลียร์ SYNC_STATUS ทุกแถวใน Source\n\n' +
        '⚠️ Pipeline จะประมวลผลแถวทั้งหมดใหม่ตั้งแต่ต้น\n\n' +
        'ยืนยันการรีเซ็ต?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) {
      safeUiAlert_('ℹ️ ยกเลิก');
      return;
    }
    // ... existing reset body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.10 — `src/2_group2_daily_ops/13_ReportService.gs:69` — `buildFullQualityReport`

```javascript
function buildFullQualityReport() {
  // [FIX BUGHUNT-??] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    safeUiAlert_('⚠️ มีการสร้างรายงาน Quality อื่นกำลังทำงานอยู่');
    return;
  }
  try {
    // ... existing body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

### Patch 4.11 — `src/1_group1_master_db/21_AliasService.gs:719` — `assignMasterUuidIfMissing`

```javascript
function assignMasterUuidIfMissing() {
  if (typeof isAuthorizedUser_ === 'function' && !isAuthorizedUser_()) {
    safeUiAlert_('🔒 คุณไม่มีสิทธิ์ตรวจสอบ UUID\nกรุณาติดต่อ Admin');
    return;
  }
  // [FIX BUGHUNT-??] LockService guard
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    safeUiAlert_('⚠️ มีการตรวจสอบ UUID อื่นกำลังทำงานอยู่');
    return;
  }
  try {
    // ... existing body ...
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    if (typeof flushLogBuffer_ === 'function') flushLogBuffer_();
  }
}
```

---

## Verification Script

After applying all 11 patches, run from terminal:

```bash
cd /workspace/audit/phaopanya-scg-main

echo "=== Lock coverage check ==="
for fn in runLoadSource MIGRATION_HybridAliasSystem generatePersonAliasesFromHistory \
          populateAliasFromSCGRawData buildGeoDictionary populateGeoMetadata \
          safeResetTransactional_UI clearDoneReviews_UI resetSourceSyncStatus \
          buildFullQualityReport assignMasterUuidIfMissing; do
  loc=$(grep -rn "^function ${fn}\b" src/ --include="*.gs" | head -1)
  if [ -n "$loc" ]; then
    file=$(echo "$loc" | cut -d: -f1)
    line=$(echo "$loc" | cut -d: -f2)
    has_lock=$(sed -n "${line},$((line+15))p" "$file" | grep -c "LockService\|tryLock")
    status=$([ $has_lock -ge 2 ] && echo "✅" || echo "❌")
    printf "%-45s %s:%-4s lock=%s %s\n" "$fn" "$file" "$line" "$has_lock" "$status"
  fi
done
```

**Expected output:** All 11 functions show `lock=2` (or more) and `✅`.

---

## Post-Deployment Checklist

1. [ ] Apply all 11 patches in Apps Script editor
2. [ ] Run verification script (above) — expect 11/11 ✅
3. [ ] Test rapid-click scenario on each menu item
4. [ ] Run `clasp push` → `clasp deploy`
5. [ ] Open new deployment URL → check menu works
6. [ ] Smoke test: open Review Queue → click decision → verify row updates
7. [ ] Re-run `LMDS_AUDIT_REPORT.md` scoring — target ≥ 95%