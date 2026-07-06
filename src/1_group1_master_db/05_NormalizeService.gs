/**
 * VERSION: 6.0.006
 * FILE: 05_NormalizeService.gs
 * LMDS V5.5 — Thai Name & Place Normalization
 * ===================================================
 * PURPOSE:
 *   ทำความสะอาดและ normalize ชื่อบุคคลและสถานที่
 *   เป็น Single Source of Truth สำหรับการทำความสะอาดข้อมูล
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
 *     - 14_Utils (diceCoefficient, levenshteinDistance) [for scoring in other files]
 *   CALLS (Invokes):
 *     - logInfo() → 03_SetupSheets
 *     - escapeRegex_() → (self)
 *     - buildNormResult_() → (self)
 *   EXPORTS TO:
 *     - 06_PersonService (normalizePersonNameFull)
 *     - 07_PlaceService (normalizePlaceName)
 *     - 17_SearchService (normalizePersonNameFull, normalizePlaceName)
 *     - 10_MatchEngine (all matching)
 *     - 16_GeoDictionaryBuilder (normalizeForCompare)
 *     - 21_AliasService (normalizeForCompare)
 *     - 19_Hardening (normalizeForCompare)
 *     - 20_ThGeoService (normalizeForCompare)
 *   SHEETS ACCESSED:
 *     - None (pure computation module)
 * ===================================================
 * ARCHITECTURE:
 *   Text Cleaner
 *   ┌──────────────────────────────────────────────────────┐
 *   │ normalizePersonNameFull (7 steps):                   │
 *   │   1. extractPhone                                   │
 *   │   2. extractDoc                                     │
 *   │   3. extractDeliveryNotes                           │
 *   │   4. checkCompany                                   │
 *   │   5. stripPrefix                                    │
 *   │   6. cleanSpecialChars                              │
 *   │   7. buildNormResult_                               │
 *   │                                                     │
 *   │ normalizePlaceName (4 steps):                        │
 *   │   1. extractPhone/Doc                               │
 *   │   2. detectType                                     │
 *   │   3. extractDeliveryNotes                           │
 *   │   4. stripSuffix                                    │
 *   │                                                     │
 *   │ buildThaiPhoneticKey → consonant key                │
 *   │ normalizeForCompare → lowercase + strip spaces      │
 *   └──────────────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 1: Dictionaries
// ============================================================

const PERSON_PREFIX_LIST = [
  'พลเอก',
  'พลโท',
  'พลตรี',
  'พันเอก',
  'พันโท',
  'พันตรี',
  'ร้อยเอก',
  'ร้อยโท',
  'ร้อยตรี',
  'จ่าสิบเอก',
  'จ่าสิบโท',
  'จ่าสิบตรี',
  'สิบเอก',
  'สิบโท',
  'สิบตรี',
  'พลทหาร',
  'พลเรือเอก',
  'พลเรือโท',
  'พลเรือตรี',
  'นาวาเอก',
  'นาวาโท',
  'นาวาตรี',
  'เรือเอก',
  'เรือโท',
  'เรือตรี',
  'พลอากาศเอก',
  'พลอากาศโท',
  'พลอากาศตรี',
  'นาวาอากาศเอก',
  'นาวาอากาศโท',
  'นาวาอากาศตรี',
  'เรืออากาศเอก',
  'เรืออากาศโท',
  'เรืออากาศตรี',
  'พลตำรวจเอก',
  'พลตำรวจโท',
  'พลตำรวจตรี',
  'พันตำรวจเอก',
  'พันตำรวจโท',
  'พันตำรวจตรี',
  'ร้อยตำรวจเอก',
  'ร้อยตำรวจโท',
  'ร้อยตำรวจตรี',
  'สิบตำรวจเอก',
  'สิบตำรวจโท',
  'สิบตำรวจตรี',
  'พลตำรวจ',
  'ผู้กำกับ',
  'รองผู้กำกับ',
  'ศาสตราจารย์',
  'รองศาสตราจารย์',
  'ผู้ช่วยศาสตราจารย์',
  'นายแพทย์',
  'แพทย์หญิง',
  'ทันตแพทย์',
  'เภสัชกร',
  'วิศวกร',
  'สถาปนิก',
  'นาย',
  'นาง',
  'นางสาว',
  'น.ส.',
  'คุณ',
  'ครู',
  'อาจารย์',
  'ดร.',
  'ดร',
  'พ.อ.',
  'พ.ต.',
  'ร.อ.',
  'ร.ต.',
  'ส.อ.',
  'พ.ต.อ.',
  'พ.ต.ท.',
  'พ.ต.ต.',
  'ร.ต.อ.',
  'ร.ต.ท.',
  'ร.ต.ต.'
];

/**
 * SORTED_PREFIX_LIST — [ADD v003] Pre-sort ครั้งเดียว
 * แทนการ sort ทุกครั้งที่เรียก normalizePersonNameFull
 */
const SORTED_PREFIX_LIST = PERSON_PREFIX_LIST.slice().sort((a, b) => b.length - a.length);

/**
 * COMPANY_SUFFIX_LIST — [FIX v003] เรียงยาวไปสั้น (longest-first)
 * ป้องกัน "จำกัด" ตัดก่อน "ห้างหุ้นส่วนจำกัด"
 */
const COMPANY_SUFFIX_LIST = [
  'จำกัด(มหาชน)',
  'จำกัด (มหาชน)',
  'ห้างหุ้นส่วนจำกัด',
  'ห้างหุ้นส่วนสามัญ',
  'มหาชน',
  'บริษัท',
  'บมจ.',
  'บจก.',
  'หจก.',
  'หสน.',
  'บจ.',
  'หจ.',
  'บมจ',
  'บจก',
  'หจก',
  'จำกัด',
  '(จำกัด)',
  'จก.',
  'ร้านค้า',
  'กิจการ',
  'ร้าน'
].sort((a, b) => b.length - a.length); // sort ทันทีตอน declare

const CHAIN_STORE_LIST = [
  'ไทวัสดุ',
  'โฮมโปร',
  'โกลบอลเฮ้าส์',
  'สยามโกลบอล',
  'แพลนท์ปูน',
  'ปูนซีเมนต์',
  'ศูนย์บริการ',
  'ไซต์งาน',
  'โครงการ',
  'หน่วยงาน',
  'วัสดุภัณฑ์',
  'วัสดุก่อสร้าง'
];

const DELIVERY_NOTE_LIST = [
  'ฝากป้อม',
  'ฝากรปภ',
  'ฝากยาม',
  'ฝากรักษาความปลอดภัย',
  'COD',
  'เก็บเงินปลายทาง',
  'ห้ามโยน',
  'ระวังแตก',
  'ระวังหัก',
  'บอบบาง',
  'แช่เย็น',
  'เก็บในที่เย็น',
  'ส่งด่วน',
  'ด่วนมาก',
  'ด่วนพิเศษ',
  'ส่งก่อน',
  'ส่งหลัง',
  'นัดส่ง',
  'โทรก่อนส่ง',
  'โทรนัด',
  'โทร.',
  'โทร',
  'ติดต่อ',
  'เบอร์โทร',
  'เบอร์',
  'เบอร์ติดต่อ'
].sort((a, b) => b.length - a.length); // [FIX v008] เรียงยาวไปสั้น

// ============================================================
// SECTION 2: Regex Patterns
// ============================================================

const PHONE_PATTERN = /(?:\+66|0)[0-9]{1,2}[-.\s]?[0-9]{3,4}[-.\s]?[0-9]{4}/g;
const DOC_NO_PATTERN = /\b[0-9]{13}\b/g; // [Fix #5] จำกัดเป็น 13 หลัก (บัตรประชาชน) ป้องกันตัดเลขที่บ้าน
const REF_NO_PATTERN = /#[0-9]+|No\.?\s*[0-9]+/gi;

// ============================================================
// SECTION 3: normalizePersonNameFull
// ============================================================

/**
 * runNormalize — Entry Point จาก Menu / Pipeline
 * [FIX v003] เพิ่ม comment อธิบายว่า Normalize เกิดใน processOneRow()
 * ไม่ใช่ Batch แยก — ฟังก์ชันนี้เป็น Placeholder สำหรับขยายอนาคต
 */
function runNormalize() {
  // Normalize เกิดใน processOneRow() ของ 10_MatchEngine.gs ต่อทุก row
  // ไม่ต้องทำ Batch แยก เพราะ Source Repository ส่ง srcObj เข้า Engine แล้ว
  logInfo('NormalizeService', 'Normalize ทำงานใน processOneRow() ของ MatchEngine');
}

/**
 * normalizePersonNameFull — ล้างชื่อบุคคลแบบสมบูรณ์
 * @param {string} rawName
 * @return {{ cleanName, isCompany, extractedPhone, extractedDocNo, deliveryNotes, originalName, structuredNotes }}
 *   structuredNotes: [V6.0.001] array of { noteType, noteValue, noteRaw, source, confidence }
 *   ใช้โดย pipeline ในภายหลังเพื่อเขียนไป SYS_NOTES ผ่าน parseAndStoreSemanticNotes()
 */
function normalizePersonNameFull(rawName) {
  const original = String(rawName || '').trim();
  let working = original;
  const notes = [];
  // [V6.0.001] structuredNotes — collected by Semantic Note Parser helpers (no sheet write here)
  const structuredNotes = [];

  if (!working) {
    return buildNormResult_(original, '', false, '', '', [], []);
  }

  // --- Step 1: ดึงเบอร์โทรออก ---
  const phoneResult = normExtractPhone_(working);
  working = phoneResult.working;
  const extractedPhone = phoneResult.phone;
  // [V6.0.001] Add CONTACT structured note for extracted phone
  if (extractedPhone) {
    structuredNotes.push({
      noteType: 'CONTACT',
      noteValue: extractedPhone,
      noteRaw: extractedPhone,
      source: 'SCG_RAW',
      confidence: 100
    });
  }

  // --- Step 2: ดึงเลขเอกสารออก ---
  const docResult = normExtractDocNo_(working);
  working = docResult.working;
  const extractedDoc = docResult.docNo;
  if (docResult.notes.length > 0) notes.push(...docResult.notes);
  // [V6.0.001] Add OTHER structured note for extracted doc numbers
  if (extractedDoc) {
    structuredNotes.push({
      noteType: 'OTHER',
      noteValue: extractedDoc,
      noteRaw: extractedDoc,
      source: 'SCG_RAW',
      confidence: 95
    });
  }

  // [V6.0.001] BEFORE Step 3 — collect structured notes via Semantic Note Parser helpers
  //   ทำก่อน DELIVERY_NOTE_LIST stripping เพื่อจับ raw text ก่อนถูกตัด
  //   ใช้ pure functions (no sheet write) — sheet write เกิดที่ parseAndStoreSemanticNotes()
  //   ข้าม extractContactPhone_ เพราะ Step 1 ด้านบนดึง phone ไปแล้ว
  const semCOD = extractCODNotes_(working);
  semCOD.notes.forEach((n) => structuredNotes.push(n));
  working = semCOD.cleanedText;

  const semTime = extractTimeNotes_(working);
  semTime.notes.forEach((n) => structuredNotes.push(n));
  working = semTime.cleanedText;

  const semFragile = extractFragileNotes_(working);
  semFragile.notes.forEach((n) => structuredNotes.push(n));
  working = semFragile.cleanedText;

  const semInstr = extractInstructionNotes_(working);
  semInstr.notes.forEach((n) => structuredNotes.push(n));
  working = semInstr.cleanedText;

  // --- Step 3: ดึง Delivery Notes ออก (global replace) ---
  // [V6.0.001] ยังคงไว้เพื่อ backward compat — structured notes ด้านบนจับได้ละเอียดกว่า
  DELIVERY_NOTE_LIST.forEach((noteWord) => {
    if (working.includes(noteWord)) {
      notes.push(noteWord);
      const safeNote = escapeRegex_(noteWord);
      working = working.replace(new RegExp(safeNote, 'g'), '').trim();
    }
  });

  // --- Step 4: ตรวจสอบนิติบุคคล ---
  const companyResult = normNormalizeCompany_(working);
  working = companyResult.working;
  const isCompany = companyResult.isCompany;
  if (companyResult.notes.length > 0) notes.push(...companyResult.notes);

  // --- Step 5: ตัดคำนำหน้า + Thai Acronyms ---
  if (!isCompany) {
    const honorificResult = normCleanHonorific_(working);
    working = honorificResult.working;
    if (honorificResult.notes.length > 0) notes.push(...honorificResult.notes);
  }

  // --- Step 6: ล้างช่องว่างและอักขระพิเศษ ---
  working = working
    .replace(/\s+/g, ' ')
    .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, '')
    .trim();

  return buildNormResult_(original, working, isCompany, extractedPhone, extractedDoc, notes, structuredNotes);
}

/**
 * buildNormResult_ — สร้าง Object ผลลัพธ์ Normalize
 * [V6.0.001] เพิ่ม structuredNotes parameter (Semantic Note Parser)
 */
function buildNormResult_(original, cleanName, isCompany, phone, docNo, notes, structuredNotes) {
  return {
    cleanName: cleanName,
    isCompany: isCompany,
    extractedPhone: phone,
    extractedDocNo: docNo,
    deliveryNotes: notes,
    originalName: original,
    // [V6.0.001] Semantic Note Parser — array of { noteType, noteValue, noteRaw, source, confidence }
    structuredNotes: structuredNotes || []
  };
}

// ============================================================
// SECTION 3.1: normalizePersonNameFull — Private Helpers
// ============================================================

/**
 * normExtractPhone_ — extracts phone number from working string
 * @param {string} working - current working string
 * @return {{ working: string, phone: string }}
 */
function normExtractPhone_(working) {
  let phone = '';
  const phoneMatches = working.match(PHONE_PATTERN);
  if (phoneMatches) {
    phone = phoneMatches[0].replace(/[-.\s]/g, '');
    // [UPGRADE v5.2.003] ไม่เก็บลง Note สำหรับ Person (เพราะมีคอลัมน์ Phone แยกแล้ว)
    working = working.replace(PHONE_PATTERN, '').trim();
  }
  return { working: working, phone: phone };
}

/**
 * normExtractDocNo_ — extracts document numbers and ref numbers from working string
 * @param {string} working - current working string
 * @return {{ working: string, docNo: string, notes: string[] }}
 */
function normExtractDocNo_(working) {
  let docNo = '';
  const notes = [];

  const docMatches = working.match(DOC_NO_PATTERN);
  if (docMatches) {
    docNo = docMatches.join(',');
    // [FIX v5.2.002] เก็บลง Note ห้ามทิ้ง
    docMatches.forEach((d) => notes.push(d));
    working = working.replace(DOC_NO_PATTERN, '').trim();
  }
  const refMatches = working.match(REF_NO_PATTERN);
  if (refMatches) {
    const refStr = refMatches.join(',');
    docNo = docNo ? `${docNo},${refStr}` : refStr;
    // [FIX v5.2.002] เก็บลง Note ห้ามทิ้ง
    refMatches.forEach((r) => notes.push(r));
    working = working.replace(REF_NO_PATTERN, '').trim();
  }
  return { working: working, docNo: docNo, notes: notes };
}

/**
 * normNormalizeCompany_ — normalizes company suffixes and chain store names
 * @param {string} working - current working string
 * @return {{ working: string, isCompany: boolean, notes: string[] }}
 */
function normNormalizeCompany_(working) {
  let isCompany = false;
  const notes = [];

  const hasCompanySuffix = COMPANY_SUFFIX_LIST.some((s) => {
    const idx = working.indexOf(s);
    if (idx === -1) return false;
    const before = idx > 0 ? working[idx - 1] : ' ';
    return /[\s\(ก-๙a-zA-Z]/.test(before) || idx === 0;
  });
  const hasChainStore = CHAIN_STORE_LIST.some((s) => working.includes(s));

  if (hasCompanySuffix || hasChainStore) {
    isCompany = true;
    // [FIX v5.2.002] เก็บ Suffix ลง Note ก่อนตัดออก
    // [FIX BUG-AUDIT-014A V5.5.042] ใช้ stripCompanySuffixWithBoundary_ แทน raw regex
    //   เพื่อไม่ให้ตัด suffix ที่อยู่กลางคำอื่นแบบเงียบ (เช่น 'ร้าn จำกัดสินค้า' → 'ร้าn สินค้า')
    COMPANY_SUFFIX_LIST.forEach((suffix) => {
      if (working.includes(suffix)) {
        notes.push(suffix);
        working = stripCompanySuffixWithBoundary_(working, suffix);
      }
    });
    // [Fix #4] ไม่ strip CHAIN_STORE_LIST ออกจาก working string — เก็บเป็น isCompany flag เท่านั้น
    //   เหตุผล: ถ้าตัด chain store ออก (เช่น "ไทวัสดุ สาขา 2" → "สาขา 2")
    //   จะเหลือ cleanName สั้นเกินไป ทำให้ match ผิดพลาด/false positive
    //   แค่ push ลง notes เพื่อ audit trail ได้ แต่ไม่ตัดออกจาก working
    if (hasChainStore) {
      CHAIN_STORE_LIST.forEach((chain) => {
        if (working.includes(chain)) {
          notes.push(chain);
        }
      });
    }
  }

  return { working: working, isCompany: isCompany, notes: notes };
}

/**
 * normCleanHonorific_ — removes honorific prefixes and Thai acronyms
 * @param {string} working - current working string
 * @return {{ working: string, notes: string[] }}
 */
function normCleanHonorific_(working) {
  const notes = [];

  // Strip honorific prefixes
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of SORTED_PREFIX_LIST) {
      if (working.startsWith(prefix)) {
        notes.push(prefix);
        working = working.substring(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }

  // --- Step 5.1: หักหัวเขา (Thai Acronyms) ---
  const tailPatterns = [/^\s*ว่าน\s+/, /^\s*โอ๊ะ\s+/, /^\s*ชาย\s+/, /^\s*หญิง\s+/];
  tailPatterns.forEach((pattern) => {
    const match = working.match(pattern);
    if (match) {
      notes.push(match[0].trim()); // [FIX v5.2.002] เก็บลง Note
      working = working.replace(pattern, '').trim();
    }
  });

  return { working: working, notes: notes };
}

// ============================================================
// SECTION 4: normalizePlaceName
// ============================================================

/**
 * normalizePlaceName — ล้างชื่อสถานที่
 * [FIX v003] Regex บ้าน → กัน false positive "บ้านโป่ง" "บ้านนา"
 * [V6.0.001] เพิ่ม structuredNotes array ในผลลัพธ์ (Semantic Note Parser)
 */
function normalizePlaceName(rawPlace) {
  let working = String(rawPlace || '').trim();
  const notes = [];
  // [V6.0.001] structuredNotes — collected by Semantic Note Parser helpers (no sheet write here)
  const structuredNotes = [];
  let placeType = 'other';

  if (!working) {
    return { cleanPlace: '', placeType, notes: [], structuredNotes: [] };
  }

  // --- Step 1: ดึงเบอร์โทรและเลขเอกสารออก (เก็บลง Note) ---
  const phoneMatches = working.match(PHONE_PATTERN);
  if (phoneMatches) {
    phoneMatches.forEach((p) => notes.push(p));
    // [V6.0.001] Add CONTACT structured note
    phoneMatches.forEach((p) => {
      structuredNotes.push({
        noteType: 'CONTACT',
        noteValue: String(p).replace(/[-.\s]/g, ''),
        noteRaw: String(p),
        source: 'SCG_RAW',
        confidence: 100
      });
    });
    working = working.replace(PHONE_PATTERN, '').trim();
  }
  const docMatches = working.match(DOC_NO_PATTERN);
  if (docMatches) {
    docMatches.forEach((d) => notes.push(d));
    // [V6.0.001] Add OTHER structured note for doc numbers
    docMatches.forEach((d) => {
      structuredNotes.push({
        noteType: 'OTHER',
        noteValue: String(d),
        noteRaw: String(d),
        source: 'SCG_RAW',
        confidence: 95
      });
    });
    working = working.replace(DOC_NO_PATTERN, '').trim();
  }

  // --- Step 2: ตรวจจับประเภทสถานที่ ---
  if (/คอนโด|คอนโดมิเนียม|Condo|อาคารชุด/i.test(working)) {
    placeType = 'condo';
  } else if (/ห้างสรรพสินค้า|เซ็นทรัล|เทสโก้|โลตัส|มอลล์|Mall|Plaza|Center|Centre/i.test(working)) {
    placeType = 'mall';
  } else if (/หมู่บ้าน|บ้านเลขที่|^บ้าน\s|Village|Moo\s*[0-9]/i.test(working)) {
    placeType = 'house';
  } else if (/ไซต์งาน|โครงการ|ก่อสร้าง|Site/i.test(working)) {
    placeType = 'site';
  }

  // [V6.0.001] BEFORE Step 3 — collect structured notes via Semantic Note Parser helpers
  //   ทำก่อน DELIVERY_NOTE_LIST stripping เพื่อจับ raw text ก่อนถูกตัด
  const semCOD = extractCODNotes_(working);
  semCOD.notes.forEach((n) => structuredNotes.push(n));
  working = semCOD.cleanedText;

  const semTime = extractTimeNotes_(working);
  semTime.notes.forEach((n) => structuredNotes.push(n));
  working = semTime.cleanedText;

  const semFragile = extractFragileNotes_(working);
  semFragile.notes.forEach((n) => structuredNotes.push(n));
  working = semFragile.cleanedText;

  const semInstr = extractInstructionNotes_(working);
  semInstr.notes.forEach((n) => structuredNotes.push(n));
  working = semInstr.cleanedText;

  // --- Step 3: ดึง Delivery Notes ออก ---
  // [V6.0.001] ยังคงไว้เพื่อ backward compat — structured notes ด้านบนจับได้ละเอียดกว่า
  DELIVERY_NOTE_LIST.forEach((noteWord) => {
    if (working.includes(noteWord)) {
      notes.push(noteWord);
      const safeNote = escapeRegex_(noteWord);
      working = working.replace(new RegExp(safeNote, 'g'), '').trim();
    }
  });

  // --- Step 4: ดึงพวก บจก./จำกัด ออก ---
  // [FIX BUG-AUDIT-014A V5.5.042] ใช้ stripCompanySuffixWithBoundary_ แทน raw regex
  COMPANY_SUFFIX_LIST.forEach((suffix) => {
    if (working.includes(suffix)) {
      notes.push(suffix);
      working = stripCompanySuffixWithBoundary_(working, suffix);
    }
  });

  working = working.replace(/\s+/g, ' ').trim();
  return { cleanPlace: working, placeType, notes, structuredNotes };
}

// ============================================================
// SECTION 5: Phonetic & Compare
// ============================================================

/**
 * buildThaiPhoneticKey — สร้าง Phonetic Key จากชื่อไทย
 * [FIX v003] ลด Regex range ซ้อน: เดิม [\u0E30-\u0E4E\u0E47-\u0E4E]
 *            \u0E47-\u0E4E ซ้อนกับ \u0E30-\u0E4E อยู่แล้ว → ลดเป็นช่วงเดียว
 */
function buildThaiPhoneticKey(thaiName) {
  if (!thaiName) return '';
  // ลบสระและวรรณยุกต์ไทย (U+0E30–U+0E4E) และ space
  const key = thaiName.replace(/[\u0E30-\u0E4E\s]/g, '');
  // [Fix #6] เพิ่ม length check — ถ้า key สั้นเกินไป (< 3 ตัวอักษร) ให้คืน '' เพื่อกัน false positive
  if (key.length < 3) return '';
  return key.substring(0, 6);
}

/**
 * normalizeForCompare — แปลงชื่อเพื่อเปรียบเทียบ
 * [FIX Phase-B #9] เพิ่ม `/` เข้าไปใน regex strip — มิฉะนั้น "123/45 ถ.สุขุมวิท" ≠ "12345ถสุขุมวิท"
 *   `/` พบบ่อยในที่อยู่ไทย (เลขที่บ้าน/หมู่) และในชื่อสถานที่ (บริษัท ก/ข/ค)
 */
function normalizeForCompare(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[.\-/_]/g, '')
    .toLowerCase();
}

// ============================================================
// SECTION 6: Helper
// ============================================================

/**
 * escapeRegex_ — escape special chars สำหรับ new RegExp()
 */
function escapeRegex_(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * stripCompanySuffixWithBoundary_ — ตัด company suffix ออกจาก string
 *   โดยใช้ boundary anchor ที่สอดคล้องกับขั้นตอนตรวจจับ (normNormalizeCompany_)
 *   [FIX BUG-AUDIT-014A V5.5.042] เดิมใช้ new RegExp(safeSuffix, 'gi') ไม่มี boundary
 *   → ตัด suffix ที่อยู่กลางคำที่ไม่เกี่ยวข้องแบบเงียบ เช่น "ร้าน จำกัดสินค้า" → "ร้าน สินค้า"
 *
 *   Boundary rules (mirror ขั้นตอนตรวจจับ normNormalizeCompany_):
 *   - ก่อน suffix ต้องเป็น start-of-string, whitespace, '(', หรือ CJK/Latin letter
 *   - หลัง suffix ต้องเป็น end-of-string, whitespace, ')', หรือ punctuation
 *
 *   ใช้ lookbehind/lookahead ที่ GAS V8 (Chrome 89+) รองรับ
 *   Reference: https://v8.dev/blog/v8-release-89
 *
 * @param {string} working - string ต้นทาง
 * @param {string} suffix - suffix ที่จะตัด
 * @return {string} string หลังตัด suffix (collapsed whitespace)
 * @private
 */
function stripCompanySuffixWithBoundary_(working, suffix) {
  const safeSuffix = escapeRegex_(suffix);
  // (?<=...) = lookbehind; (?=...) = lookahead
  //   ก่อน suffix: start-of-string หรือ whitespace, '(', หรือ CJK/Latin letter
  //
  //   หลัง suffix (lookahead) — ขึ้นกับว่า suffix ลงท้ายด้วย '.' หรือไม่:
  //   - ถ้า suffix ลงท้ายด้วย '.' (เช่น 'บจก.', 'หจก.', 'บมจ.') ให้ยอมรับ letter ตามด้วย
  //     → 'บจก.สมชาย' → 'สมชาย' (เพราะปกติเขียนติดกัน ไม่มี space)
  //   - ถ้า suffix ไม่ลงท้ายด้วย '.' (เช่น 'จำกัด') ให้รับเฉพาะ punctuation/whitespace/end
  //     → 'ไม่จำกัดจำนวน' จะไม่ถูกตัด (เพราะ 'จำกัด' อยู่กลางคำ ไม่ใช่ suffix จริง)
  const endsWithDot = /\.$/.test(suffix);
  const lookAhead = endsWithDot ? '(?=$|[\\s\\)\\.,;:\\u0E00-\\u0E7Fa-zA-Z])' : '(?=$|[\\s\\)\\.,;:])';
  const pattern = '(?<=^|[\\s\\(\\u0E00-\\u0E7Fa-zA-Z])' + safeSuffix + lookAhead;
  return working.replace(new RegExp(pattern, 'gi'), '').replace(/\s+/g, ' ').trim();
}

// [REMOVED V5.5.044] validatePersonName + validateAddress — dead code (mark @deprecated ใน V5.5.043)
//   ทั้ง 2 ฟังก์ชัน design เป็น public API แต่ไม่มี caller ใน .gs หรือ .html ใดเลย
//   หากมี external caller (custom function ใน spreadsheet) ที่ต้องการ restore → ดู git history ของ commit นี้

/**
 * normalizeProvinceForCompare_ — แปลง province alias → canonical ก่อนเปรียบเทียบ
 *   [Fix #14] ใช้ TH_PROVINCES aliases เพื่อ normalize จังหวัด
 *   ตัวอย่าง: "กทม" → "กรุงเทพมหานคร", "โคราช" → "นครราชสีมา"
 *
 * @param {string} province - ชื่อจังหวัด (อาจเป็น alias)
 * @return {string} canonical province name หรือ original ถ้าไม่พบ alias
 */
function normalizeProvinceForCompare_(province) {
  if (province === null || province === undefined || province === '') return '';
  const normalized = String(province).trim();
  if (normalized === '') return '';

  // ตรวจว่าเป็น canonical name อยู่แล้วหรือไม่
  for (let i = 0; i < TH_PROVINCES.length; i++) {
    const entry = TH_PROVINCES[i];
    if (entry.name === normalized) return entry.name;
    // ตรวจ aliases
    if (entry.aliases && entry.aliases.length > 0) {
      for (let j = 0; j < entry.aliases.length; j++) {
        if (entry.aliases[j] === normalized) return entry.name;
      }
    }
  }

  // ถ้าไม่พบใน list คืน original (อาจเป็นจังหวัดที่ยังไม่มีใน list)
  return normalized;
}

// ============================================================
// SECTION 7: [V6.0.001] Semantic Note Parser
//   Extract structured notes (CONTACT/TIME/COD/FRAGILE/INSTRUCTION/OTHER)
//   from raw text and store them in SYS_NOTES sheet for entity enrichment.
//   Helpers are pure (no sheet writes) so they can be safely called from
//   normalizePersonNameFull / normalizePlaceName for in-memory collection;
//   the sheet write happens later via parseAndStoreSemanticNotes().
// ============================================================

/**
 * parseAndStoreSemanticNotes — [V6.0.001] Main entry: extract structured notes
 *   from raw text and write them to SYS_NOTES sheet for the given entity.
 *
 * Extraction order (each step cleans text for the next):
 *   1. CONTACT     → phone numbers (PHONE_PATTERN)
 *   2. COD         → "COD", "เก็บเงินปลายทาง" + optional amounts (฿/B/บาท + digits)
 *   3. TIME        → "ก่อนเที่ยง", "หลัง 5 โมง", "นัดส่ง 9โมง", "ส่งด่วน", "ด่วนพิเศษ"
 *   4. FRAGILE     → "ห้ามโยน", "ระวังแตก", "ระวังหัก", "บอบบาง", "แช่เย็น"
 *   5. INSTRUCTION → "ฝากป้อม", "ฝากยาม", "ฝากรปภ", "ฝากหน้าร้าน"
 *   6. OTHER       → any non-trivial remaining text
 *
 * @param {string} rawText - ข้อความดิบที่จะ extract (เช่น ชื่อ+ที่อยู่+หมายเหตุ)
 * @param {string} entityType - 'PERSON' | 'PLACE' | 'FACT'
 * @param {string} entityId - FK ไปยัง M_PERSON / M_PLACE / FACT_DELIVERY
 * @param {string} [source='SCG_RAW'] - 'SCG_RAW' | 'DRIVER_INPUT' | 'AI_EXTRACTED'
 * @return {{ cleanText: string, notesExtracted: number, notesByType: Object }}
 */
function parseAndStoreSemanticNotes(rawText, entityType, entityId, source) {
  const originalText = String(rawText || '');
  const validSource = source || 'SCG_RAW';
  const notesByType = {
    CONTACT: [],
    TIME: [],
    INSTRUCTION: [],
    COD: [],
    FRAGILE: [],
    OTHER: []
  };
  let working = originalText;
  let notesExtracted = 0;

  // Step 1: CONTACT (phone)
  const contact = extractContactPhone_(working);
  contact.notes.forEach((n) => {
    notesByType.CONTACT.push(n);
    notesExtracted++;
  });
  working = contact.cleanedText;

  // Step 2: COD (amounts + keywords)
  const cod = extractCODNotes_(working);
  cod.notes.forEach((n) => {
    notesByType.COD.push(n);
    notesExtracted++;
  });
  working = cod.cleanedText;

  // Step 3: TIME
  const time = extractTimeNotes_(working);
  time.notes.forEach((n) => {
    notesByType.TIME.push(n);
    notesExtracted++;
  });
  working = time.cleanedText;

  // Step 4: FRAGILE
  const fragile = extractFragileNotes_(working);
  fragile.notes.forEach((n) => {
    notesByType.FRAGILE.push(n);
    notesExtracted++;
  });
  working = fragile.cleanedText;

  // Step 5: INSTRUCTION
  const instr = extractInstructionNotes_(working);
  instr.notes.forEach((n) => {
    notesByType.INSTRUCTION.push(n);
    notesExtracted++;
  });
  working = instr.cleanedText;

  // Step 6: OTHER (remaining non-trivial text)
  const remaining = working.replace(/\s+/g, ' ').trim();
  if (remaining && remaining.length > 0) {
    const otherNote = {
      noteType: 'OTHER',
      noteValue: remaining,
      noteRaw: remaining,
      confidence: 50
    };
    notesByType.OTHER.push(otherNote);
    notesExtracted++;
  }

  // Persist all extracted notes to SYS_NOTES sheet (skip if no entityId)
  if (entityType && entityId) {
    Object.keys(notesByType).forEach((noteType) => {
      notesByType[noteType].forEach((note) => {
        storeNote_(entityType, entityId, note.noteType, note.noteValue, note.noteRaw, validSource, note.confidence);
      });
    });
  }

  return {
    cleanText: remaining,
    notesExtracted,
    notesByType
  };
}

/**
 * getNotesForEntity — [V6.0.001] Query notes for an entity from SYS_NOTES sheet
 * @param {string} entityType - 'PERSON' | 'PLACE' | 'FACT'
 * @param {string} entityId - FK
 * @param {string[]} [noteTypes] - Optional filter (e.g. ['CONTACT', 'COD']); null/undefined = all types
 * @return {Array<Object>} array of note objects (one per SYS_NOTES row that matches)
 */
function getNotesForEntity(entityType, entityId, noteTypes) {
  if (!entityType || !entityId) return [];
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_NOTES);
    if (!sheet || sheet.getLastRow() < 2) return [];

    const data = sheet.getDataRange().getValues();
    const results = [];
    const typeFilter = noteTypes && noteTypes.length > 0 ? new Set(noteTypes) : null;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowEntityType = String(row[NOTES_IDX.ENTITY_TYPE] || '');
      const rowEntityId = String(row[NOTES_IDX.ENTITY_ID] || '');
      const rowNoteType = String(row[NOTES_IDX.NOTE_TYPE] || '');
      const activeFlag = row[NOTES_IDX.ACTIVE_FLAG];
      if (rowEntityType !== entityType || rowEntityId !== entityId) continue;
      if (activeFlag === false || String(activeFlag).toUpperCase() === 'FALSE') continue;
      if (typeFilter && !typeFilter.has(rowNoteType)) continue;

      results.push({
        noteId: String(row[NOTES_IDX.NOTE_ID] || ''),
        entityType: rowEntityType,
        entityId: rowEntityId,
        noteType: rowNoteType,
        noteValue: String(row[NOTES_IDX.NOTE_VALUE] || ''),
        noteRaw: String(row[NOTES_IDX.NOTE_RAW] || ''),
        source: String(row[NOTES_IDX.SOURCE] || ''),
        confidence: Number(row[NOTES_IDX.CONFIDENCE] || 0),
        createdAt: row[NOTES_IDX.CREATED_AT],
        createdBy: String(row[NOTES_IDX.CREATED_BY] || ''),
        activeFlag
      });
    }
    return results;
  } catch (err) {
    logError('NormalizeService', `getNotesForEntity ล้มเหลว: ${err.message}`, err);
    return [];
  }
}

/**
 * extractContactPhone_ — [V6.0.001] Extract phone number(s) from text
 *   Uses PHONE_PATTERN (global). Returns one note per match.
 * @param {string} text
 * @return {{ notes: Array<{noteType,noteValue,noteRaw,confidence}>, cleanedText: string }}
 * @private
 */
function extractContactPhone_(text) {
  const input = String(text || '');
  if (!input) return { notes: [], cleanedText: '' };
  const matches = input.match(PHONE_PATTERN);
  if (!matches) return { notes: [], cleanedText: input };
  const cleanedText = input.replace(PHONE_PATTERN, '').trim();
  const notes = matches.map((m) => ({
    noteType: 'CONTACT',
    noteValue: String(m).replace(/[-.\s]/g, ''),
    noteRaw: String(m),
    confidence: 100
  }));
  return { notes, cleanedText };
}

/**
 * extractCODNotes_ — [V6.0.001] Extract COD amounts and "เก็บเงินปลายทาง" keywords
 *   Patterns (in order):
 *     1. "COD" + amount  → e.g. "COD 1500", "COD ฿1,500 บาท"
 *     2. "เก็บเงินปลายทาง" + optional amount
 *     3. Standalone "COD" (without amount)
 *   Deduplicates by noteRaw before returning.
 * @param {string} text
 * @return {{ notes: Array, cleanedText: string }}
 * @private
 */
function extractCODNotes_(text) {
  const input = String(text || '');
  if (!input) return { notes: [], cleanedText: '' };
  const notes = [];
  let cleanedText = input;

  // Pattern 1: "COD" + amount (e.g. "COD 1500", "COD ฿1,500 บาท", "COD: 1500")
  const codAmountPattern = /\bCOD\s*[:\-]?\s*(?:฿|B|บาท)?\s*([0-9][0-9,]*)\s*(?:บาท|baht)?/gi;
  const amountMatches = [...input.matchAll(codAmountPattern)];
  amountMatches.forEach((m) => {
    const amount = m[1].replace(/,/g, '');
    notes.push({
      noteType: 'COD',
      noteValue: amount,
      noteRaw: m[0].trim(),
      confidence: 95
    });
  });
  cleanedText = cleanedText.replace(codAmountPattern, ' ');

  // Pattern 2: "เก็บเงินปลายทาง" + optional amount
  const codThaiPattern = /เก็บเงินปลายทาง\s*[:\-]?\s*(?:฿|B|บาท)?\s*([0-9][0-9,]*)?\s*(?:บาท)?/g;
  const thaiMatches = [...input.matchAll(codThaiPattern)];
  thaiMatches.forEach((m) => {
    const amount = m[1] ? m[1].replace(/,/g, '') : '';
    notes.push({
      noteType: 'COD',
      noteValue: amount || 'COD',
      noteRaw: m[0].trim(),
      confidence: 95
    });
  });
  cleanedText = cleanedText.replace(codThaiPattern, ' ');

  // Pattern 3: standalone "COD" (no amount following)
  const codStandalonePattern = /\bCOD\b(?![:\s\-]*[0-9])/gi;
  const standaloneMatches = [...cleanedText.matchAll(codStandalonePattern)];
  standaloneMatches.forEach((m) => {
    notes.push({
      noteType: 'COD',
      noteValue: 'COD',
      noteRaw: m[0],
      confidence: 80
    });
  });
  cleanedText = cleanedText.replace(codStandalonePattern, ' ');

  // Deduplicate notes (by noteRaw) — same keyword may match multiple patterns
  const seen = new Set();
  const uniqueNotes = notes.filter((n) => {
    if (seen.has(n.noteRaw)) return false;
    seen.add(n.noteRaw);
    return true;
  });

  return { notes: uniqueNotes, cleanedText: cleanedText.replace(/\s+/g, ' ').trim() };
}

/**
 * extractTimeNotes_ — [V6.0.001] Extract time-related delivery instructions
 *   Patterns: explicit times (09:00, 5ทุ่ม), time keywords (ก่อนเที่ยง, หลัง 5 โมง),
 *   urgency keywords (ส่งด่วน, ด่วนพิเศษ, ส่งก่อน, ส่งหลัง, นัดส่ง, โทรก่อนส่ง, โทรนัด)
 * @param {string} text
 * @return {{ notes: Array, cleanedText: string }}
 * @private
 */
function extractTimeNotes_(text) {
  const input = String(text || '');
  if (!input) return { notes: [], cleanedText: '' };
  const notes = [];
  let cleanedText = input;

  const timePatterns = [
    /\b\d{1,2}[:.]\d{2}\s*(?:น\.?|AM|PM|am|pm)?/g, // 09:00, 09.00น, 2:30pm — no trailing \b (Thai-safe)
    /\b\d{1,2}\s*(?:โมงเช้า|โมงเย็น|ทุ่ม|น\.?|AM|PM|am|pm)/g, // 9โมง, 5ทุ่ม, 2pm
    /ก่อนเที่ยง/g,
    /หลังเที่ยง/g,
    /ก่อน\s*\d{1,2}\s*โมง/g,
    /หลัง\s*\d{1,2}\s*โมง/g,
    /นัดส่ง\w*/g, // นัดส่ง, นัดส่ง 9โมง — Latin \w only, no false match on Thai
    /ส่งด่วน/g,
    /ด่วนมาก/g,
    /ด่วนพิเศษ/g,
    /ส่งก่อน/g,
    /ส่งหลัง/g,
    /โทรก่อนส่ง/g,
    /โทรนัด/g
  ];

  timePatterns.forEach((pattern) => {
    const matches = [...cleanedText.matchAll(pattern)];
    matches.forEach((m) => {
      notes.push({
        noteType: 'TIME',
        noteValue: m[0].trim(),
        noteRaw: m[0].trim(),
        confidence: 85
      });
    });
    cleanedText = cleanedText.replace(pattern, ' ');
  });

  // Deduplicate
  const seen = new Set();
  const uniqueNotes = notes.filter((n) => {
    if (seen.has(n.noteRaw)) return false;
    seen.add(n.noteRaw);
    return true;
  });

  return { notes: uniqueNotes, cleanedText: cleanedText.replace(/\s+/g, ' ').trim() };
}

/**
 * extractFragileNotes_ — [V6.0.001] Extract fragile/handling warnings
 *   Patterns: ห้ามโยน, ระวังแตก, ระวังหัก, บอบบาง, แช่เย็น, เก็บในที่เย็น, Fragile
 * @param {string} text
 * @return {{ notes: Array, cleanedText: string }}
 * @private
 */
function extractFragileNotes_(text) {
  const input = String(text || '');
  if (!input) return { notes: [], cleanedText: '' };
  const notes = [];
  let cleanedText = input;

  const fragilePatterns = [/ห้ามโยน/g, /ระวังแตก/g, /ระวังหัก/g, /บอบบาง/g, /แช่เย็น/g, /เก็บในที่เย็น/g, /Fragile/gi];

  fragilePatterns.forEach((pattern) => {
    const matches = [...cleanedText.matchAll(pattern)];
    matches.forEach((m) => {
      notes.push({
        noteType: 'FRAGILE',
        noteValue: m[0].trim(),
        noteRaw: m[0].trim(),
        confidence: 90
      });
    });
    cleanedText = cleanedText.replace(pattern, ' ');
  });

  // Deduplicate
  const seen = new Set();
  const uniqueNotes = notes.filter((n) => {
    if (seen.has(n.noteRaw)) return false;
    seen.add(n.noteRaw);
    return true;
  });

  return { notes: uniqueNotes, cleanedText: cleanedText.replace(/\s+/g, ' ').trim() };
}

/**
 * extractInstructionNotes_ — [V6.0.001] Extract delivery instructions
 *   Patterns: ฝากป้อม, ฝากรปภ, ฝากยาม, ฝากรักษาความปลอดภัย,
 *             ฝากหน้าป้อม, ฝากหน้าร้าน, ฝากเพื่อนบ้าน, ฝากคนขับรถ
 * @param {string} text
 * @return {{ notes: Array, cleanedText: string }}
 * @private
 */
function extractInstructionNotes_(text) {
  const input = String(text || '');
  if (!input) return { notes: [], cleanedText: '' };
  const notes = [];
  let cleanedText = input;

  const instrPatterns = [
    /ฝากป้อม/g,
    /ฝากรปภ/g,
    /ฝากยาม/g,
    /ฝากรักษาความปลอดภัย/g,
    /ฝากหน้าป้อม/g,
    /ฝากหน้าร้าน/g,
    /ฝากเพื่อนบ้าน/g,
    /ฝากคนขับรถ/g
  ];

  instrPatterns.forEach((pattern) => {
    const matches = [...cleanedText.matchAll(pattern)];
    matches.forEach((m) => {
      notes.push({
        noteType: 'INSTRUCTION',
        noteValue: m[0].trim(),
        noteRaw: m[0].trim(),
        confidence: 90
      });
    });
    cleanedText = cleanedText.replace(pattern, ' ');
  });

  // Deduplicate
  const seen = new Set();
  const uniqueNotes = notes.filter((n) => {
    if (seen.has(n.noteRaw)) return false;
    seen.add(n.noteRaw);
    return true;
  });

  return { notes: uniqueNotes, cleanedText: cleanedText.replace(/\s+/g, ' ').trim() };
}

/**
 * storeNote_ — [V6.0.001] Write a single note to SYS_NOTES sheet
 *   Generates note_id (N+12 hex via generateShortId), stamps created_at + created_by,
 *   and appends a new row to SYS_NOTES.
 * @param {string} entityType - 'PERSON' | 'PLACE' | 'FACT'
 * @param {string} entityId - FK to M_PERSON / M_PLACE / FACT_DELIVERY
 * @param {string} noteType - 'CONTACT' | 'TIME' | 'INSTRUCTION' | 'COD' | 'FRAGILE' | 'OTHER'
 * @param {string} noteValue - structured value (e.g. phone, COD amount, time string)
 * @param {string} noteRaw - original text snippet that was extracted
 * @param {string} source - 'SCG_RAW' | 'DRIVER_INPUT' | 'AI_EXTRACTED'
 * @param {number} confidence - 0-100
 * @return {string|null} note_id หรือ null ถ้าล้มเหลว / ไม่มี entityId
 * @private
 */
function storeNote_(entityType, entityId, noteType, noteValue, noteRaw, source, confidence) {
  try {
    if (!entityType || !entityId) return null;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.SYS_NOTES);
    if (!sheet) {
      logWarn('NormalizeService', 'storeNote_: ไม่พบชีต SYS_NOTES — ข้ามการบันทึก');
      return null;
    }

    const noteId = generateShortId('N');
    const now = new Date();
    // [V6.0.001] Capture current user email for audit trail (fallback to 'system')
    let userEmail = 'system';
    try {
      if (typeof Session !== 'undefined' && Session.getActiveUser) {
        const email = Session.getActiveUser().getEmail();
        if (email) userEmail = email;
      }
    } catch (_e) {
      // GAS may throw in some contexts (e.g. custom function) — fallback to 'system'
    }

    const newRow = [
      noteId,
      entityType,
      entityId,
      noteType,
      String(noteValue || ''),
      String(noteRaw || ''),
      source || 'SCG_RAW',
      Number(confidence) || 0,
      now,
      userEmail,
      true
    ];

    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, newRow.length).setValues([newRow]);
    return noteId;
  } catch (err) {
    logError('NormalizeService', `storeNote_ ล้มเหลว: ${err.message}`, err);
    return null;
  }
}

// ============================================================
// SECTION 8: [V6.0.001] Double Metaphone Thai
//   Upgrades buildThaiPhoneticKey with primary + secondary keys
//   for more robust fuzzy name matching (handles ล/ร confusion).
// ============================================================

/**
 * buildThaiDoubleMetaphone — [V6.0.001] Compute Double Metaphone keys for Thai name
 *   Algorithm:
 *     1. Remove vowels + tone marks + symbols (U+0E30-U+0E7F) + spaces
 *     2. Phonetic substitutions per consonant class
 *     3. Collapse consecutive duplicate consonants
 *     4. Truncate to 8 chars
 *
 *   Primary vs Secondary difference:
 *     - ล/ร collapse to 'L' in primary, 'R' in secondary
 *       (handles the common Thai spelling variation ล↔ร)
 *     - All other consonants map identically in both keys
 *
 * @param {string} thaiName - Thai name (with or without vowels/tone marks)
 * @return {{ primary: string, secondary: string }} max 8 chars each (may be '' for empty input)
 */
function buildThaiDoubleMetaphone(thaiName) {
  const input = String(thaiName || '').trim();
  if (!input) return { primary: '', secondary: '' };

  // Step 1: Remove vowels + tone marks + symbols (U+0E30-U+0E7F covers both ranges) + spaces
  //   U+0E30-U+0E4E: Thai vowels + tone marks
  //   U+0E4F-U+0E7F: Thai symbols, digits, punctuation (kept out for clean consonant key)
  const consonantsOnly = input.replace(/[\u0E30-\u0E7F\s]/g, '');

  if (!consonantsOnly) return { primary: '', secondary: '' };

  // Step 2: Phonetic substitutions per consonant class
  //   Primary and Secondary differ only in ล/ร handling
  let primary = '';
  let secondary = '';

  for (let i = 0; i < consonantsOnly.length; i++) {
    const ch = consonantsOnly[i];
    const p = phoneticSubstitute_(ch, true);
    const s = phoneticSubstitute_(ch, false);
    if (p) primary += p;
    if (s) secondary += s;
  }

  // Step 3: Collapse consecutive duplicate consonants (e.g. "KKL" → "KL")
  primary = collapseDuplicates_(primary);
  secondary = collapseDuplicates_(secondary);

  // Step 4: Truncate to 8 chars
  return {
    primary: primary.substring(0, 8),
    secondary: secondary.substring(0, 8)
  };
}

/**
 * phoneticSubstitute_ — [V6.0.001] Map a single Thai consonant to its phonetic letter
 *   Mapping (per task spec):
 *     ศ/ษ/ส/ซ → S
 *     จ → J  | ฉ/ช/ฌ → C
 *     ฎ/ด/ฏ/ต/ฑ/ท/ธ → D
 *     บ/ป/พ/ฟ/ภ → B
 *     ก/ข/ค/ฃ/ฅ/ฆ/ง → K
 *     ม → M  | น/ณ/ญ/ฬ → N
 *     ย → Y  | ล/ร → L (primary) / R (secondary)
 *     ว → W  | ห/ฮ → H  | อ → A
 * @param {string} ch - single Thai consonant character
 * @param {boolean} isPrimary - true for primary key, false for secondary
 * @return {string} phonetic letter (uppercase) or '' if unmapped
 * @private
 */
function phoneticSubstitute_(ch, isPrimary) {
  switch (ch) {
    case 'ศ':
    case 'ษ':
    case 'ส':
    case 'ซ':
      return 'S';
    case 'จ':
      return 'J'; // จ → J (alternative: C)
    case 'ฉ':
    case 'ช':
    case 'ฌ':
      return 'C';
    case 'ฎ':
    case 'ด':
    case 'ฏ':
    case 'ต':
    case 'ฑ':
    case 'ท':
    case 'ธ':
      return 'D';
    case 'บ':
    case 'ป':
    case 'พ':
    case 'ฟ':
    case 'ภ':
      return 'B';
    case 'ก':
    case 'ข':
    case 'ค':
    case 'ฃ':
    case 'ฅ':
    case 'ฆ':
    case 'ง':
      return 'K';
    case 'ม':
      return 'M';
    case 'น':
    case 'ณ':
    case 'ญ':
    case 'ฬ':
      return 'N';
    case 'ย':
      return 'Y';
    case 'ล':
    case 'ร':
      // [V6.0.001] ล/ร → L (primary), R (secondary) — handles common ล↔ร spelling confusion
      return isPrimary ? 'L' : 'R';
    case 'ว':
      return 'W';
    case 'ห':
    case 'ฮ':
      return 'H';
    case 'อ':
      return 'A';
    default:
      return '';
  }
}

/**
 * collapseDuplicates_ — [V6.0.001] Collapse consecutive duplicate characters
 *   e.g. "KKL" → "KL", "BBLD" → "BLD"
 * @param {string} str
 * @return {string}
 * @private
 */
function collapseDuplicates_(str) {
  if (!str) return '';
  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (i === 0 || str[i] !== str[i - 1]) {
      result += str[i];
    }
  }
  return result;
}

/**
 * phoneticMatch — [V6.0.001] Compare two names using Double Metaphone keys
 *   Match rules (highest score wins):
 *     - primary1 == primary2                          → score 100, matchedKey 'primary'
 *     - primary1 == secondary2 OR secondary1 == primary2 → score 90, matchedKey 'cross'
 *     - secondary1 == secondary2                      → score 80, matchedKey 'secondary'
 *     - No match                                       → score 0, matchedKey ''
 *
 *   Note: Match requires non-empty keys on both sides. If either side has empty
 *   primary, the comparison falls back to cross/secondary matching.
 *
 * @param {string} name1
 * @param {string} name2
 * @return {{ match: boolean, score: number, matchedKey: string }}
 *   matchedKey: 'primary' | 'cross' | 'secondary' | '' (empty if no match)
 */
function phoneticMatch(name1, name2) {
  const a = buildThaiDoubleMetaphone(name1);
  const b = buildThaiDoubleMetaphone(name2);

  // Both primaries present and equal → score 100
  if (a.primary && b.primary && a.primary === b.primary) {
    return { match: true, score: 100, matchedKey: 'primary' };
  }

  // Cross-match: primary↔secondary
  if (a.primary && b.secondary && a.primary === b.secondary) {
    return { match: true, score: 90, matchedKey: 'cross' };
  }
  if (a.secondary && b.primary && a.secondary === b.primary) {
    return { match: true, score: 90, matchedKey: 'cross' };
  }

  // Secondary == secondary
  if (a.secondary && b.secondary && a.secondary === b.secondary) {
    return { match: true, score: 80, matchedKey: 'secondary' };
  }

  return { match: false, score: 0, matchedKey: '' };
}
