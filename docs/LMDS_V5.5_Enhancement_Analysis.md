# LMDS V5.5 — Deep Analysis & Enhancement Roadmap
### Focus: Data Cleansing · Data Separation · Data Matching (+ WebApp / Pipeline / Architecture / Security)

> Prepared from a full read of the codebase (`Siriwat08/phaopanya-scg`, v5.5.040).
> This document (1) summarizes **how the system works today**, especially the parts you care about
> (Cleansing, Separation, Matching), then (2) turns each of your proposals into a concrete,
> **architecture-compliant** design that respects the project's 21 Immutable Laws (Single-Writer,
> No-Hardcode-Index, Batch-Only, 6-min Time Guard, Security-First, etc.).

---

## PART A — What the system does today (grounded summary)

### A0. The big picture
LMDS is a **Master Data Management + Matching Engine** built entirely on **Google Apps Script (V8) + Google Sheets as an RDBMS**. It ingests "dirty" delivery data (messy names & addresses), cleanses it, matches it against master tables, and returns trustworthy coordinates.

| Layer | Modules | Role |
|---|---|---|
| 🟩 Group 1 — Brain / Master (Single Writer) | `05` Normalize, `06` Person, `07` Place, `08` Geo, `09` Destination, `10` MatchEngine, `16` GeoDict, `20` ThGeo, `21` Alias | Cleanse, Match, own `M_PERSON/M_PLACE/M_GEO_POINT/M_DESTINATION/M_ALIAS` |
| 🟦 Group 2 — Daily Ops / Consumer | `04` Source, `11` Transaction, `12` Review, `13` Report, `15` GoogleMaps, `17` Search, `18` ServiceSCG | Load SCG jobs, geocode, report. **Never writes Master.** |
| 🟪 Group 3 — WebApp | `22_WebApp.gs` + `3_group3_webapp/*.html` | Dashboard (SSR shell + `google.script.run` polling) |
| 🟧 Group 4 — Pipeline Mgr | `24_PipelineManager.gs` | Quota, circuit-breaker, checkpoint/resume, time-based triggers |
| ⚙️ System/Config | `00` App, `01` Config, `02` Schema, `03` Setup, `14` Utils, `19` Hardening | Constants, schema, utilities, security hardening |

### A1. Data Cleansing today — `05_NormalizeService.gs`
`normalizePersonNameFull(rawName)` runs a **7-step pipeline**, `normalizePlaceName(rawPlace)` runs a **4-step** one:

1. **Extract phone** (`PHONE_PATTERN`) → moved to its own field (person) / `notes[]` (place).
2. **Extract doc/ref numbers** (`DOC_NO_PATTERN` = 13-digit ID, `REF_NO_PATTERN`) → `notes[]`.
3. **Delivery notes** — iterates a hard-coded `DELIVERY_NOTE_LIST` (`ฝากป้อม`, `COD`, `ระวังแตก`, `โทรก่อนส่ง`, …). When a keyword is found it is **pushed to `notes[]` and then deleted** from the name via regex.
4. **Company detection** (`COMPANY_SUFFIX_LIST`, `CHAIN_STORE_LIST`) → sets `isCompany`.
5. **Strip honorific prefix** (`SORTED_PREFIX_LIST`, longest-first) + Thai acronym tails.
6. **Clean special chars** — collapse whitespace, drop non-Thai/Latin/digit.
7. **`buildNormResult_`** → `{ cleanName, isCompany, extractedPhone, extractedDocNo, deliveryNotes[], originalName }`.

**Key observation for your proposals:** the delivery-note keywords **are captured** into `deliveryNotes[]`, and `createPerson()` even joins them into the `NOTE` column (`allNotes.join(',')`). But:
- The list is a **flat keyword blacklist** — it recognizes `โทร`/`ส่งก่อน` as *tokens to remove*, not as *semantic instructions to parse* (there's no "send before noon → time window 00:00–12:00", no extracted phone-as-contact, no free-text remainder). So it is closer to **"delete + dump into one NOTE cell"** than **structured separation**.
- Free-form instructions that aren't in the list (e.g. "ส่งก่อนเที่ยง", "อย่าซ้อนของ") **survive into `cleanName`** and become noise for matching — exactly the problem you describe in **1.1**.

### A2. Phonetic key today — `buildThaiPhoneticKey()`
```js
function buildThaiPhoneticKey(thaiName) {
  if (!thaiName) return '';
  const key = thaiName.replace(/[\u0E30-\u0E4E\s]/g, ''); // strip vowels+tone marks
  if (key.length < 3) return '';
  return key.substring(0, 6);                              // consonant skeleton, first 6
}
```
It is a **consonant-skeleton truncation**, not a phonetic algorithm. Consequences:
- `พรรณ` → `พรรณ`(consonants) vs `พัน` → `พน` → **different keys → no match** (your example in **1.2**).
- No handling of Thai homophones (`ทร`→/s/, `จ/ฉ/ช` clusters, initial `ห`+low-class, final consonant sound classes `กขค→ก`, `ดจชซ→ด`, `บพฟ→บ`). So genuinely different spellings that *sound identical* fail to collide.
- Used in `accumulateByPhoneticMatch_()` (Person Strategy 4) as a **candidate-gathering** step; the actual score still comes from `calculateNameScore_()` (Levenshtein + Dice + containment).

### A3. Data Matching today — `10_MatchEngine.gs`
The engine is an **8-rule decision tree** (`makeMatchDecision`) fed by three resolvers (`resolvePerson`, `resolvePlace`, `resolveGeo`):

| Rule | Condition | Action |
|---|---|---|
| 1 | No geo in source | REVIEW `INVALID_LATLNG` |
| 2 | Low-quality name/place | REVIEW `LOW_QUALITY_DATA` |
| 3 | Geo-province ≠ source-province | REVIEW `GEO_PROVINCE_CONFLICT` |
| 3.5 | Geo `NEARBY_PENDING` (51–100 m) | REVIEW yellow/orange |
| 4 | geo + person + place all in master | AUTO_MATCH (`matchCalcFullScore_`) |
| 5 | geo + (person **or** place) | AUTO_MATCH (`matchCalcGeoAnchorScore_`) |
| 6 | fuzzy NEEDS_REVIEW | REVIEW |
| 7 | all-new but driver sent geo | CREATE_NEW |
| 8 | default | REVIEW |

**Scoring is fixed-weight:**
```js
matchCalcFullScore_   = geo*0.5 + person*0.3 + place*0.2
matchCalcGeoAnchorScore_ = min(95, geo*0.60 + person*0.25 + place*0.15)
```
- **Person scoring** (`scorePersonCandidate` → `calculateNameScore_`): Levenshtein + Dice + substring, with a phone-match gate (phone+name→95, phone-only→nameScore). Weights switch on name length (<4 chars favors Levenshtein).
- **Place scoring** (`scorePlaceCandidate`): name similarity + a **province filter** (`tryMatchBranch` requires province match when known).
- **Geo scoring** (`resolveGeo` → `geoClassifyDistance_`): 3×3 grid pre-filter → Haversine → tiered bands (≤radius = FOUND with `100−(d/r)*30`; ≤80 m yellow; ≤100 m orange; >100 m NOT_FOUND). **`resolveGeo` returns only the single nearest point**; `candidateGeoIds` (all within 100 m) is collected but only used to populate the review row — there is **no tie-breaker logic**.

**Disambiguation gap (your 2.1):** `SOLD_TO_NAME` exists in the schema (`FACT_IDX.SOLD_TO_NAME = 11`, `SRC_IDX.SOLD_TO_NAME = 11`) and is written to FACT, **but it is never consulted during matching.** Two different "คุณสมชาย" belonging to different `SoldTo` groups can collide.

### A4. Self-learning / aliases today — `10` + `21` + `19`
- **Single Writer:** only `autoEnrichAliasesFromFactBatch_()` writes `M_ALIAS`. It auto-creates canonical(100)+variant(95/90) aliases from every successful FACT row, and `DRIVER_VERIFIED_NAME/ADDR` (cols 32/33) become confidence-100 aliases tagged `DRIVER_VERIFIED`.
- **Human-in-the-loop:** `12_ReviewService.gs` (`applyReviewDecision`, `submitReviewDecision` in WebApp) lets an admin approve MERGE / CREATE_NEW from `Q_REVIEW`. On approval it re-resolves and upserts FACT, which *indirectly* triggers alias enrichment.
- **Gap (your 3.1):** when the admin *edits* the raw name in `Q_REVIEW` and approves, the corrected string is not explicitly captured as a **"human-verified alias"** back to the master UUID. Enrichment is a side-effect of the FACT write, not a deliberate "learn this typo" step, and it is tagged `AUTO_ENRICH_FACT` (95), not a durable `VERIFIED_BY_HUMAN` (100) flag.

### A5. WebApp, Pipeline, Security today
- **WebApp (`22`):** `doGet` → `Index.html`; views for Dashboard, FactDelivery, MatchEngine, QReview, Search, SourceSheet. Data via `getDashboardData()`, `getFactDeliveryPage()`, `getQReviewPage()`, `getMatchEngineMetrics()`, `submitReviewDecision()`. **Charts + tables only — no map.** Dashboard polls (`getDashboardData` every 60 s) but there is **no live match-progress feed.**
- **Pipeline (`24`):** robust quota (75 min/day, 15 runs), **circuit breaker** (3 consecutive errors → PAUSE), checkpoint/resume, time-based triggers 08:00–22:00. **No outbound alerting** (no `UrlFetchApp`/LINE/Chat/`MailApp` anywhere for notifications) and **no source-readiness pre-check** before running MatchEngine.
- **Security (`19` + `14`):** `isAuthorizedUser_()` = **binary** admin check against a `LMDS_ADMINS` script property (deny-by-default, PII-masked logs). Sheet-level protection, preflight audit, dedupe helpers. **No role tiers** (viewer vs approver vs admin) — it's all-or-nothing.

---

## PART B — Enhancement designs (mapped to your proposals)

For each item: **Verdict** (is it really missing?), **Where it plugs in**, **Design**, **Schema/Config deltas**, **Compliance notes**, **Effort/Risk**.

### 1.1 — Semantic Note Parser  ✅ *High value, low risk*
**Verdict:** Genuinely missing. Today notes are *deleted*, not *parsed into structured fields*, and out-of-list instructions leak into `cleanName`.

**Where:** New private helpers in `05_NormalizeService.gs`, called as **Step 3.5** inside `normalizePersonNameFull` / `normalizePlaceName`, *before* the final `cleanSpecialChars`. Output added to `buildNormResult_`.

**Design — extract *then* structure (not just delete):**
```
parseSemanticNotes_(working) → {
  cleanRemainder,            // name with instructions removed
  structured: {
    timeWindow: {start,end}, // "ส่งก่อนเที่ยง"→{null,'12:00'}, "หลังบ่าย2"→{'14:00',null}
    contactPhones: [...],    // all phones found (kept as contact, not just stripped)
    handling: [...],         // ระวังแตก/ห้ามโยน/แช่เย็น  (enum-tagged)
    access:   [...],         // ฝากป้อม/ฝากรปภ            (enum-tagged)
    payment:  [...],         // COD/เก็บเงินปลายทาง
    freeText: "..."          // anything left that looks instructional
  }
}
```
- Implement as an **ordered rule table** (regex + tag + capture), longest-match-first — mirrors the existing `DELIVERY_NOTE_LIST.sort()` pattern. Thai number words (`เที่ยง`, `บ่าย`, `โมงเช้า`, `ทุ่ม`) → normalized 24h times via a small dictionary.
- Store the JSON in a **new `STRUCTURED_NOTES` column** on `M_PERSON`/`M_PLACE` and on `FACT_DELIVERY`, so ops sees it and matching never sees it.

**Schema/Config deltas (Rule 3 & 17 — must update both in the same change):**
- `01_Config.gs`: add `PERSON_IDX.STRUCTURED_NOTES = 10`, `PLACE_IDX.STRUCTURED_NOTES = 14`, `FACT_IDX.STRUCTURED_NOTES = 34` (append to end — **never reorder** existing indices).
- `02_Schema.gs`: add matching header cells; bump `SCHEMA_VERSION`.
- `03_SetupSheets.gs`: `validateSchemaConsistency()` will enforce the new length automatically.

**Compliance:** pure function (no try/catch needed, Rule 12); no hardcoded index; write via existing batch `setValues`. Keep `deliveryNotes[]` for backward compatibility, add `structuredNotes` alongside.

**Effort:** ~1 day. **Risk:** Low — additive; matching quality *improves* because `cleanName` gets cleaner.

---

### 1.2 — Thai Double Metaphone  ✅ *High value, medium effort*
**Verdict:** Real gap. `buildThaiPhoneticKey` is consonant-truncation, not phonetic.

**Where:** Rewrite/extend in `05_NormalizeService.gs`; `06_PersonService.accumulateByPhoneticMatch_` and `07_PlaceService` consume it. **Keep the old function name as a thin wrapper** (Rule 8 namespace + backward compat) and add `buildThaiDoubleMetaphone(name) → [primaryKey, altKey]`.

**Design — Thai-tuned phonetic normalization → two keys:**
1. **Initial-consonant sound classes** — collapse homophonic initials:
   `[กข ค ฆ]→K`, `[จ]→J`, `[ฉ ช ฌ]→CH`, `[ซ ศ ษ ส ทร]→S`, `[ต ฏ]→T`, `[ถ ท ธ ฐ ฑ ฒ]→TH`, `[ด ฎ]→D`, `[บ]→B`, `[ป]→P`, `[ผ พ ภ]→PH`, `[ฝ ฟ]→F`, `[น ณ]→N`, `[ล ฬ]→L`, `[ร]→R`, `[ม]→M`, `[ห ฮ]→H`, silent-`ห` cluster (`หง หญ หน หม หย หร หล หว`) → drop `ห`.
2. **Final-consonant sound classes** (แม่กก/กด/กบ/กน/กง/กม/เกย/เกอว):
   final `[กขคฆ]→K`, `[ดจชซฎฏฐฑฒตถทธศษส]→T`, `[บปพฟภ]→P`, `[นณญรลฬ]→N`, `[ง]→NG`, `[ม]→M`, `[ย]→Y`, `[ว]→W`.
3. **Vowel length/tone folding** for the *alt* key (fold long↔short, drop tone marks) so `พรรณ`≈`พัน`, `สมชาย`≈`สมชัย` collide on the secondary key while the primary key stays stricter.
4. Return `[primary, alt]`; two names are a **phonetic candidate** if *any* of their keys intersect.

**Integration:** in `loadAllPersons_`, precompute a **`Map<phoneticKey, Set<personId>>` inverted index** (same pattern as the existing `_PERSON_ALIAS_INVERTED_INDEX` / `_PERSON_NOTE_INVERTED_INDEX`) so candidate lookup stays **O(1)**, not O(N). Scoring is unchanged (`calculateNameScore_` still decides AUTO vs REVIEW), so precision is protected — this only *widens recall*.

**Compliance:** pure function; RAM-cached index invalidated by `invalidatePersonCache_`; no schema change required (keys are computed, not stored) — optionally store `PHONETIC_KEY` column for auditing.

**Effort:** ~2–3 days incl. a test corpus of known Thai homophone pairs. **Risk:** Medium — must **unit-test against a labeled pair-set** to confirm it doesn't over-merge; keep it as candidate-gen only (never auto-accept on phonetic alone).

---

### 2.1 — Contextual Disambiguation (SoldTo / CustomerGroup)  ✅ *High value, low risk*
**Verdict:** Real gap — `SOLD_TO_NAME` is stored but never used in matching.

**Where:** `10_MatchEngine.processOneRow` passes `srcObj.soldToName` into `resolvePerson`/`resolvePlace`; scoring gets a **context bonus/penalty**. Requires threading `SOLD_TO_NAME` from `04_SourceRepository` into `srcObj` (it already reads the source row).

**Design — soft context signal, not a hard filter:**
- Add a lightweight `context_group` (normalized SoldTo/CustomerGroup) to each **alias/FACT** record so a master entity accumulates the set of SoldTo groups it has legitimately appeared under.
- In `scorePersonCandidate`, after the base `nameScore`:
  - **+8 to +10** if candidate has been seen under the same SoldTo group (disambiguates the two "สมชาย").
  - **−15 (cap, never below REVIEW band)** if the candidate has *only ever* appeared under a *different* SoldTo group and names are merely similar → pushes borderline cases to REVIEW instead of a wrong AUTO_MATCH.
- Keep it a **bonus/penalty**, not a filter, so a legitimately shared customer isn't blocked. Make the weight a config knob (`AI_CONFIG.CONTEXT_BONUS`, `AI_CONFIG.CONTEXT_PENALTY`).

**Schema/Config:** add `context_group` to `M_ALIAS` (or a `CONTEXT_GROUP` col on `M_PERSON`); add tunables to `AI_CONFIG`. Update `*_IDX` + `SCHEMA` together (Rule 17).

**Compliance:** no new writers to `M_ALIAS` (still enriched inside the Single Writer); pure scoring change otherwise.

**Effort:** ~1–2 days. **Risk:** Low, and it *directly reduces false matches* — arguably the highest ROI item on the list.

---

### 2.2 — Dynamic Weighting  ✅ *Medium value, low risk*
**Verdict:** Confirmed — weights are hard-coded in `matchCalcFullScore_` / `matchCalcGeoAnchorScore_`.

**Design — completeness-aware reweighting:**
- Compute a **field-quality vector** per row: `qName`, `qPlace`, `qPhone`, `qGeo` ∈ [0,1] from length/noise (reuse `validatePersonName`, `validateAddress`, phone length ≥9, geo tier).
- Replace fixed weights with a normalized function:
  `w_i = base_i × q_i`, then renormalize so `Σw = 1`. e.g. a very short/noisy address auto-shifts weight to phone & person, as you described.
- Guard rails: floor/ceiling per weight so geo never drops below (say) 0.4 when a driver-verified geo exists; keep everything in `AI_CONFIG` (`BASE_WEIGHTS`, `WEIGHT_FLOOR`, `WEIGHT_CEIL`) so it's tunable without code edits.
- Log the effective weights into `FACT_IDX.EVIDENCE` for auditability.

**Compliance:** refactor the two `matchCalc*` helpers to call one `matchComputeDynamicWeights_(quality)` — SRP preserved (Rule 2). Deterministic (no ML at runtime → safe for the 6-min budget).

**Effort:** ~1 day. **Risk:** Low if you **shadow-run** it (log new score next to old for a week before switching thresholds).

---

### 2.3 — Geofencing Multi-Candidate Tie-breaker  ⚠️ *Medium value; do the offline half first*
**Verdict:** Confirmed — `resolveGeo` already collects `candidateGeoIds` (all points ≤100 m) but never uses them to break ties.

**Design — two tiers, pick the cheap one first:**
1. **Historical-destination tie-breaker (no API, do this now):** when ≥2 geo candidates are within a few metres, prefer the one that the **same driver** (`FACT_IDX.DRIVER_NAME`) or same `person/place` has visited before. `getSameDayDestinations()` already builds a FACT index by `date::geoId`; generalize it to a `Map<driverId, Set<geoId>>` / `Map<placeId, Set<geoId>>` frequency index and add a small bonus to the historically-visited candidate.
2. **Street-distance (optional, API-gated):** only when historical signal is absent *and* candidates straddle a road, call the Distance Matrix / Routes API via `15_GoogleMapsAPI.gs`. **Must** be wrapped in the 6-min `hasTimePassed_` guard, cached (results are effectively immutable), and rate-limited — otherwise it will blow the GAS quota. Feature-flag it (`AI_CONFIG.USE_STREET_DISTANCE=false` by default).

**Compliance:** tie-breaker runs inside Group 1 resolvers; the API path reuses the existing Maps module + document cache; never blocks the pipeline (fallback = current nearest-point behavior).

**Effort:** history tie-breaker ~1 day; street-distance ~2–3 days + quota testing. **Risk:** history = Low; street-distance = **Medium-High** (quota/latency) — ship it behind a flag.

---

### 3.1 — Self-Healing Alias (Verified-by-Human)  ✅ *High value, low risk*
**Verdict:** Partially present (enrichment is a side-effect) but the **explicit "learn this human correction as a permanent 100%-confidence alias"** step is missing, and there's no `VERIFIED_BY_HUMAN` provenance.

**Design:**
- In `12_ReviewService.applyReviewDecision` (and `submitReviewDecision` in WebApp), when the admin approves a MERGE/correction, capture **the original dirty string from `Q_REVIEW` (`RAW_PERSON`/`RAW_PLACE`)** and register it as an alias to the chosen master UUID with `confidence=100, source='VERIFIED_BY_HUMAN'`.
- **Route it through the Single Writer** — add a `source` parameter path in `autoEnrichAliasesFromFactBatch_` / `matchEnrichEntityAliases_` (they already support a `source` field; `DRIVER_VERIFIED` uses the same mechanism). Do **not** add a second writer to `M_ALIAS` (Rule 2).
- Protect these rows in `cleanupStaleCanonicalAliases_` — it already preserves non-`AUTO_ENRICH` sources, so `VERIFIED_BY_HUMAN` will survive canonical churn. Result: the next identical dirty string hits the M_ALIAS fast-path (`findCandidatesByAliasFastPath_`, score ≥95) → **guaranteed match**.

**Compliance:** Single Writer intact; provenance recorded for MDM audit; cache invalidation via existing `invalidateAliasCache_`.

**Effort:** ~1 day. **Risk:** Low — it strengthens exactly the fast-path that already exists.

---

### 4.1 — Interactive Map Analytics (Heatmap / Cluster)  ✅ *High value, medium effort*
**Verdict:** Confirmed missing — dashboard is charts+tables only.

**Design:**
- New backend endpoint in `22_WebApp.gs`: `getDeliveryGeoPoints(filters)` returning a **downsampled** `[{lat,lng,weight}]` from `FACT_DELIVERY` (`RESOLVED_LAT/LNG` or `RAW_LAT/LNG`). **Aggregate server-side into grid buckets** (reuse the `AI_CONFIG.GEO_GRID_SIZE` idea) so you ship thousands of buckets, not 100k raw points — keeps payload under CacheService/`google.script.run` limits.
- New view `views/MapAnalytics.html` using **Leaflet + Leaflet.heat** (or Google Maps JS heatmap layer with the existing Maps key). Add a menu tab in `Index.html`.
- Respect auth in `doGet`; cache the aggregated buckets (6 h TTL) since history is stable.

**Compliance:** Rule 11 (separate `.html`); read-only (Group 3 consumer, no Master writes); PII-safe (coordinates only, no names in the heat payload).

**Effort:** ~2–3 days. **Risk:** Low-Medium (payload sizing is the main concern → solved by server-side bucketing).

---

### 4.2 — Real-time Matching Monitor (Live Feed)  ✅ *Medium value, medium effort*
**Verdict:** Confirmed missing.

**Design (GAS-friendly, no websockets):**
- MatchEngine already loops in batches and flushes every `AI_CONFIG.BATCH_SIZE`. In `flushBatches_`/`finalizeMatchEngine_`, write a compact **progress heartbeat** to a Script Property or a small `SYS_PIPELINE_STATUS` sheet: `{runId, processed, total, autoMatched, created, queued, errors, lastRowSummary, ts}`.
- New WebApp endpoint `getMatchProgress()` returns that heartbeat; a `views/LiveMonitor.html` **polls every 3–5 s** (same polling pattern as the dashboard) and renders a progress bar + rolling feed of the last N decisions.
- Reuse `24_PipelineManager` state (`getPipelineState_`, quota, circuit-breaker) so the monitor also shows RUNNING/PAUSED_QUOTA/PAUSED_ERRORS.

**Compliance:** heartbeat write is tiny (1 property/cell per batch — Rule 4 batch-friendly); polling is client-side; auth via `doGet`.

**Effort:** ~2 days. **Risk:** Low.

---

### 5.1 — Smart Failure Alerts (LINE / Google Chat)  ✅ *High value, low effort*
**Verdict:** Confirmed missing — **no outbound notification anywhere** in the codebase.

**Design:**
- New module `25_NotifyService.gs` (Group 4) exposing `notifyOps_(level, title, body)` that POSTs to a **LINE Notify token** and/or **Google Chat webhook** via `UrlFetchApp` (scope `script.external_request` is already granted in `appsscript.json`). Store secrets in Script Properties (`LINE_NOTIFY_TOKEN`, `GCHAT_WEBHOOK_URL`) — **never in cells** (Rule 16).
- Wire triggers:
  - `24_PipelineManager` circuit-breaker trip (`recordBatchError_` → 3 consecutive) → CRITICAL alert.
  - `PAUSED_QUOTA` reached → INFO alert.
  - A threshold check on `Q_REVIEW` backlog (`getReviewStats()`); if pending > `PIPELINE_CONFIG.QREVIEW_ALERT_LIMIT` → WARN alert.
  - Optionally hook `logError` (rate-limited/deduped) for fatal MatchEngine failures.
- **Rate-limit & dedupe** (store last-sent hash+timestamp in a property) so a failing batch doesn't spam ops.

**Compliance:** secrets via Properties; every entry point try/catch (Rule 12); notification failure must **never** break the pipeline (swallow+log).

**Effort:** ~1 day. **Risk:** Low. This is the single easiest "professional polish" win.

---

### 5.2 — Dependency-aware Pipeline (source readiness gate)  ✅ *High value, low risk*
**Verdict:** Confirmed missing — MatchEngine runs regardless of whether today's SCG load finished.

**Design:**
- Add `checkSourceReadiness_()` (Group 4 / `04_SourceRepository` helper): verify (a) today's expected source rows exist, (b) `SYNC_STATUS` isn't mid-load, (c) row count vs. a recent baseline isn't suspiciously low, (d) key columns (LAT/LNG/RAW_ADDRESS) populated above a min fill-rate.
- `runMatchEngine`/`24_PipelineManager` calls it **first**; if not ready → **skip the run**, set state `PAUSED_DEPENDENCY`, and fire a `notifyOps_` WARN (ties into 5.1). This prevents polluting Master Data with half-loaded data.
- Make thresholds config (`PIPELINE_CONFIG.MIN_FILL_RATE`, `EXPECTED_MIN_ROWS`).

**Compliance:** read-only check; integrates with existing state machine + checkpoint; no Master writes.

**Effort:** ~1 day. **Risk:** Low (fail-safe = skip, never corrupt).

---

### 6.1 — Master Data Health Check (Dedup Audit)  ✅ *High value, low risk*
**Verdict:** Building blocks exist (`19_Hardening` has dedupe helpers, `detectDoubleProcessing`) but a **near-duplicate Master finder for admins** is not exposed.

**Design:**
- New `auditMasterDuplicates()` in `19_Hardening.gs`: for `M_PERSON`/`M_PLACE`, **block by phonetic key** (from 1.2) to avoid O(N²), then within each block compute `levenshteinDistance` (already in `14_Utils`) and flag pairs with distance < 2 (or Dice > 0.9) that are **not already aliased**.
- Output to a `RPT_MASTER_DEDUP` sheet: `[idA, nameA, idB, nameB, distance, suggestedAction]` with a one-click "merge" (calls the existing `mergePersonRecords`, which is admin-guarded).
- **Time-guarded + checkpointed** (Rule 5) since it scans the whole Master; run on a schedule and alert via 5.1 when candidates appear.

**Compliance:** reuses `mergePersonRecords` (already Single-Writer + AuthZ); read-heavy but batched; blocking keeps it within budget.

**Effort:** ~2 days. **Risk:** Low (produces *suggestions*; merge stays a human action).

---

### 6.2 — Audit Trail / Data Versioning for Master  ✅ *High value (MDM-critical), medium effort*
**Verdict:** `SYS_LOG` records system events/errors but there is **no field-level edit history** for Master (who changed a canonical name / coordinates, when, old→new).

**Design:**
- New append-only `M_AUDIT_TRAIL` sheet: `[auditId, ts, actor(masked/role), entityType, entityId, field, oldValue, newValue, source]`.
- Emit an audit row from **every Master mutation path**: `createPerson/createPlace/createGeoPoint`, `mergePersonRecords`, `updatePersonStats` (optional), review-driven edits, and canonical-name changes. Centralize as `logAudit_(...)` in `14_Utils` so callers stay one-liners.
- For coordinates specifically, snapshot old `LAT/LNG` before overwrite.
- Surface a per-entity "history" panel in the WebApp (read-only).

**Compliance:** append-only via batch `setValues` (Rule 4); actor from `Session` masked like `maskReviewerEmail_` (Rule 16 PII); never blocks the write (audit failure logs but doesn't throw).

**Effort:** ~2–3 days (touches every writer). **Risk:** Medium (breadth) — introduce `logAudit_` once, then wire callers incrementally.

---

### 7.1 — Granular RBAC  ✅ *High value, medium effort*
**Verdict:** Confirmed — auth is **binary** (`isAuthorizedUser_` = admin-or-nothing). No viewer/approver tiers.

**Design — role tiers with least privilege:**
- Define roles: `VIEWER` (dashboard/reports read-only), `OPERATOR` (view + run daily loads), `APPROVER` (Q_REVIEW approve/merge), `ADMIN` (config, protection, admin lists, merges).
- Store `LMDS_ROLES` as JSON in Script Properties (`{ "a@x.com":"APPROVER", ... }`) **or** reuse the existing `EMPLOYEE_IDX.ROLE` column (col 7) already in `ข้อมูลพนักงาน`. Add `getUserRole_()` + `requireRole_(minRole)` in `14_Utils` (keep `isAuthorizedUser_` as `requireRole_('ADMIN')` for backward compat).
- **Backend enforcement (authoritative):** guard every sensitive server function — `submitReviewDecision` → `APPROVER`; `applySheetProtection_UI`, `setupAdminList_UI`, merges, notify config → `ADMIN`. Never trust the client.
- **Frontend UX:** `getCurrentDashboardUser_()` already returns the user; extend it to return `role`, and have `Auth.html`/views hide buttons the role can't use (defense-in-depth, not the security boundary).

**Compliance:** Rule 16 (Security-First) — server-side checks on every destructive/approval op; deny-by-default preserved; PII-masked logging.

**Effort:** ~3 days. **Risk:** Medium — must audit **every** `google.script.run`-exposed function so none bypass the new gate.

---

## PART C — Prioritized rollout plan

Ordered by **(value ÷ risk)** and dependency:

| Wave | Items | Why first |
|---|---|---|
| **Wave 1 — Quick wins** | 5.1 Alerts, 1.1 Note Parser, 3.1 Verified Alias, 5.2 Readiness gate | Low risk, high ops value, mostly additive; 5.1 unblocks alerting for 5.2/6.1 |
| **Wave 2 — Matching accuracy** | 2.1 Context disambiguation, 2.2 Dynamic weights, 1.2 Thai metaphone | The core of your ask; ship 2.1 first (biggest false-match reduction), shadow-run 2.2 before flipping thresholds |
| **Wave 3 — Governance** | 6.2 Audit trail, 6.1 Dedup audit, 7.1 RBAC | MDM/compliance; 6.1 depends on 1.2's phonetic blocking |
| **Wave 4 — Frontend & advanced** | 4.1 Map, 4.2 Live monitor, 2.3 Geo tie-breaker (history first, street-distance behind flag) | Higher effort / API-quota sensitivity; do the offline history tie-breaker, gate the API path |

### Cross-cutting rules to honor in every change (from `docs/📋 กฎการเขียนโค้ด LMDS V5.5.md` + `CONTEXT.md`)
1. **Rule 3/17 — No hardcoded index & Schema truthfulness:** any new column ⇒ append to `*_IDX` (never reorder) **and** `SCHEMA` in the same commit, bump `SCHEMA_VERSION`, let `validateSchemaConsistency()` verify.
2. **Rule 2 — Single Writer:** all `M_ALIAS` writes stay inside `autoEnrichAliasesFromFactBatch_` / `21_AliasService` (applies to 3.1, 2.1 context).
3. **Rule 4 — Batch only:** notifications, audit rows, heatmap buckets all via batch `setValues`/single property writes.
4. **Rule 5 + 6-min guard:** dedup audit (6.1), street-distance (2.3), audit backfills must be checkpointed + `hasTimePassed_`-wrapped.
5. **Rule 12/13 — Error handling:** every new entry point try/catch → `logError`; notifications and audit must never break the pipeline.
6. **Rule 16 — Security-first:** secrets (LINE/Chat tokens) in Script Properties only; RBAC enforced server-side; PII masked in logs.
7. **Full-file output & GenSpark git flow:** commit each change on `genspark_ai_developer`, then PR to `main`.

### Suggested config additions (single source of truth in `01_Config.gs`)
```
AI_CONFIG.CONTEXT_BONUS / CONTEXT_PENALTY          // 2.1
AI_CONFIG.BASE_WEIGHTS / WEIGHT_FLOOR / WEIGHT_CEIL // 2.2
AI_CONFIG.USE_STREET_DISTANCE (default false)      // 2.3
PIPELINE_CONFIG.QREVIEW_ALERT_LIMIT                 // 5.1
PIPELINE_CONFIG.MIN_FILL_RATE / EXPECTED_MIN_ROWS   // 5.2
Script Properties: LINE_NOTIFY_TOKEN, GCHAT_WEBHOOK_URL, LMDS_ROLES // 5.1, 7.1
New sheets: SYS_PIPELINE_STATUS (4.2), RPT_MASTER_DEDUP (6.1), M_AUDIT_TRAIL (6.2)
New modules: 25_NotifyService.gs (5.1); views MapAnalytics.html (4.1), LiveMonitor.html (4.2)
```

---

## PART D — Summary table

| # | Proposal | Really missing? | Value | Effort | Risk | Key file(s) |
|---|---|---|---|---|---|---|
| 1.1 | Semantic Note Parser | Yes (delete≠structure) | High | 1d | Low | `05_Normalize`, `01/02` schema |
| 1.2 | Thai Double Metaphone | Yes | High | 2–3d | Med | `05_Normalize`, `06/07` |
| 2.1 | Contextual (SoldTo) disambiguation | Yes (stored, unused) | **Very High** | 1–2d | Low | `10_Match`, `06`, `04` |
| 2.2 | Dynamic weighting | Yes (fixed weights) | Med-High | 1d | Low | `10_Match` |
| 2.3 | Geo tie-breaker | Partial (ids collected, unused) | Med | 1d / 2–3d | Low / Med-High | `08_Geo`, `10`, `15` |
| 3.1 | Self-healing verified alias | Partial (no provenance) | High | 1d | Low | `12_Review`, `10`, `22` |
| 4.1 | Map heatmap/cluster | Yes | High | 2–3d | Low-Med | `22_WebApp`, new view |
| 4.2 | Live match monitor | Yes | Med | 2d | Low | `10`, `24`, `22`, new view |
| 5.1 | LINE/Chat failure alerts | Yes (none exist) | High | 1d | Low | new `25_Notify`, `24` |
| 5.2 | Dependency-aware pipeline | Yes | High | 1d | Low | `24`, `04` |
| 6.1 | Master dedup audit | Partial | High | 2d | Low | `19_Hardening` |
| 6.2 | Audit trail / versioning | Yes (only SYS_LOG) | High (MDM) | 2–3d | Med | `14`, all writers, `22` |
| 7.1 | Granular RBAC | Yes (binary only) | High | 3d | Med | `14`, `19`, `22`, views |

**Bottom line:** every proposal targets a *real* gap — none of them duplicate existing behavior. The architecture is already unusually disciplined (Single-Writer, layered caches, time-guarded pipeline, deny-by-default auth), which means these features can be added **cleanly along the existing seams** (resolvers, the Single-Writer enrichment path, the WebApp polling pattern, the pipeline state machine) without violating the 21 Laws. Start with **2.1 (context disambiguation)** and **5.1 (alerts)** for the fastest, highest-confidence impact.
