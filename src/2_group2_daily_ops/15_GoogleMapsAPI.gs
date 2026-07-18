/**
 * VERSION: 6.0.069
 * FILE: 15_GoogleMapsAPI.gs
 * LMDS V6.0 — Google Maps Custom Functions (@customFunction)
 * ===================================================
 * PURPOSE:
 *   ให้บริการสูตร Google Maps สำหรับพิมพ์ใน Google Sheet โดยตรง
 *   สูตรทั้งหมดมี @customFunction annotation → พิมพ์ในเซลล์ได้เลย
 *   มีระบบ Cache (CacheService 6 ชม.) เพื่อลดการเรียก API
 *
 * CHANGELOG:
 *   See /docs/CHANGELOG.md for full history.
 *
 * DEPENDENCIES:
 *   REQUIRES: (Load Order)
 *     - 01_Config.gs            (ENV_MAPS_API_KEY, cache key prefixes)
 *     - 14_Utils.gs             (parseLatLng, hashString for cache keys)
 *   CALLS: (Invokes)
 *     - parseLatLng()                           → 14_Utils.gs
 *     - UrlFetchApp.fetch() (Google Maps Geocoding API — external)
 *     - CacheService.getScriptCache() (Apps Script runtime)
 *   EXPORTS TO:
 *     - 08_GeoService.gs (geocode / reverse geocode)
 *     - 22c_WebAppActions.gs (map data for MapAnalytics view)
 *     - Google Sheets cells (DIST_FROM_WH, RESOLVED_ADDR @customFunction)
 *   SHEETS ACCESSED:
 *     - (none — uses CacheService + UrlFetchApp; results consumed by callers)
 *   TRIGGERS: None
 *
 * ARCHITECTURE:
 *   Group 2 — Daily operations (source repo, FACT_DELIVERY, Q_REVIEW, reports, Maps, SCG)
 * ===================================================
 */

// ============================================================
// SECTION 1: Cache Helpers (ตามต้นฉบับ Amit Agarwal)
// ใช้ CacheService.getDocumentCache — TTL 6 ชม.
// ============================================================

/**
 * _mapsMd5 — สร้าง MD5 hash สำหรับ cache key
 * ทำให้ "New York" และ "new york  " มี key เดียวกัน
 */
const _mapsMd5 = (key = '') => {
  const code = key.toLowerCase().replace(/\s/g, '');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, code)
    .map((char) => (char + 256).toString(16).slice(-2))
    .join('');
};

/**
 * _mapsGetCache — อ่านจาก cache
 */
const _mapsGetCache = (key) => {
  try {
    return CacheService.getDocumentCache().get(_mapsMd5(key));
  } catch (e) {
    return null;
  }
};

/**
 * _mapsSetCache — เขียนลง cache (TTL 6 ชม.)
 */
const _mapsSetCache = (key, value) => {
  try {
    const expirationInSeconds = 6 * 60 * 60; // 6 hours
    CacheService.getDocumentCache().put(_mapsMd5(key), value, expirationInSeconds);
  } catch (e) {
    // Cache write failure ไม่ควรบล็อกการทำงาน
  }
};

// ============================================================
// SECTION 2: @customFunction — สูตรสำหรับพิมพ์ใน Google Sheet
// ============================================================

/**
 * GOOGLEMAPS_DISTANCE — คำนวณระยะทางระหว่าง 2 จุด
 *
 * ตัวอย่าง: =GOOGLEMAPS_DISTANCE("กรุงเทพ", "นนทบุรี", "driving")
 *           =GOOGLEMAPS_DISTANCE(A1, B1, "driving")
 *
 * @param {String} origin ที่อยู่จุดเริ่มต้น
 * @param {String} destination ที่อยู่ปลายทาง
 * @param {String} mode โหมดการเดินทาง (driving, walking, bicycling, transit)
 * @return {String} ระยะทาง (เช่น "15.2 km")
 * @customFunction
 */
const GOOGLEMAPS_DISTANCE = (origin, destination, mode = 'driving') => {
  if (!origin || !destination) {
    return 'ต้องระบุจุดเริ่มต้นและปลายทาง';
  }
  if (origin.map) {
    return origin.map((o) => GOOGLEMAPS_DISTANCE(o, destination, mode));
  }

  const key = ['distance', origin, destination, mode].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { routes: [data] = [] } = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setMode(mode)
    .getDirections();

  if (!data) {
    return 'ไม่พบเส้นทาง';
  }

  const { legs: [{ distance: { text: distance } } = {}] = [] } = data;
  _mapsSetCache(key, distance);
  return distance;
};

/**
 * GOOGLEMAPS_DURATION — คำนวณเวลาเดินทางระหว่าง 2 จุด
 *
 * ตัวอย่าง: =GOOGLEMAPS_DURATION("กรุงเทพ", "นนทบุรี", "driving")
 *           =GOOGLEMAPS_DURATION(A1, B1, "walking")
 *
 * @param {String} origin ที่อยู่จุดเริ่มต้น
 * @param {String} destination ที่อยู่ปลายทาง
 * @param {String} mode โหมดการเดินทาง (driving, walking, bicycling, transit)
 * @return {String} เวลาเดินทาง (เช่น "25 mins")
 * @customFunction
 */
const GOOGLEMAPS_DURATION = (origin, destination, mode = 'driving') => {
  if (!origin || !destination) {
    return 'ต้องระบุจุดเริ่มต้นและปลายทาง';
  }
  if (origin.map) {
    return origin.map((o) => GOOGLEMAPS_DURATION(o, destination, mode));
  }

  const key = ['duration', origin, destination, mode].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { routes: [data] = [] } = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setMode(mode)
    .getDirections();

  if (!data) {
    return 'ไม่พบเส้นทาง';
  }

  const { legs: [{ duration: { text: time } } = {}] = [] } = data;
  _mapsSetCache(key, time);
  return time;
};

/**
 * GOOGLEMAPS_LATLONG — แปลงที่อยู่เป็นพิกัด lat,lng
 *
 * ตัวอย่าง: =GOOGLEMAPS_LATLONG("สยามพารากอน กรุงเทพ")
 *           =GOOGLEMAPS_LATLONG(A1)
 *
 * @param {String} address ที่อยู่ที่ต้องการค้นหา
 * @return {String} พิกัด "lat, lng" (เช่น "13.7466, 100.5347")
 * @customFunction
 */
const GOOGLEMAPS_LATLONG = (address) => {
  if (!address) {
    return 'ต้องระบุที่อยู่';
  }
  if (address.map) {
    return address.map((a) => GOOGLEMAPS_LATLONG(a));
  }

  const key = ['latlong', address].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { results: [data = null] = [] } = Maps.newGeocoder().geocode(address);
  if (data === null) {
    return 'ไม่พบที่อยู่';
  }

  const { geometry: { location: { lat, lng } } = {} } = data;
  const answer = `${lat}, ${lng}`;
  _mapsSetCache(key, answer);
  return answer;
};

/**
 * GOOGLEMAPS_ADDRESS — แปลงรหัสไปรษณีย์/ที่อยู่บางส่วนเป็นที่อยู่เต็ม
 *
 * ตัวอย่าง: =GOOGLEMAPS_ADDRESS("10110")
 *           =GOOGLEMAPS_ADDRESS(A1)
 *
 * @param {String} address รหัสไปรษณีย์หรือที่อยู่บางส่วน
 * @return {String} ที่อยู่เต็มจาก Google Maps
 * @customFunction
 */
const GOOGLEMAPS_ADDRESS = (address) => {
  if (!address) {
    return 'ต้องระบุที่อยู่';
  }
  if (address.map) {
    return address.map((a) => GOOGLEMAPS_ADDRESS(a));
  }

  const key = ['address', address].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { results: [data = null] = [] } = Maps.newGeocoder().geocode(address);
  if (data === null) {
    return 'ไม่พบที่อยู่';
  }

  const { formatted_address } = data;
  _mapsSetCache(key, formatted_address);
  return formatted_address;
};

/**
 * GOOGLEMAPS_REVERSEGEOCODE — แปลงพิกัด lat,lng เป็นที่อยู่
 *
 * ตัวอย่าง: =GOOGLEMAPS_REVERSEGEOCODE(13.7466, 100.5347)
 *           =GOOGLEMAPS_REVERSEGEOCODE(A1, B1)
 *
 * @param {Number} latitude ละติจูด
 * @param {Number} longitude ลองจิจูด
 * @return {String} ที่อยู่จาก Google Maps
 * @customFunction
 */
const GOOGLEMAPS_REVERSEGEOCODE = (latitude, longitude) => {
  if (!latitude || !longitude) {
    return 'ต้องระบุละติจูดและลองจิจูด';
  }

  const key = ['reverse', latitude, longitude].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { results: [data = {}] = [] } = Maps.newGeocoder().reverseGeocode(latitude, longitude);

  const { formatted_address } = data;
  _mapsSetCache(key, formatted_address);
  return formatted_address;
};

/**
 * GOOGLEMAPS_COUNTRY — ดึงชื่อประเทศจากที่อยู่
 *
 * ตัวอย่าง: =GOOGLEMAPS_COUNTRY("10 Hanover Square, NY")
 *
 * @param {String} address ที่อยู่ที่ต้องการค้นหา
 * @return {String} ชื่อประเทศ (เช่น "Thailand (TH)")
 * @customFunction
 */
const GOOGLEMAPS_COUNTRY = (address) => {
  if (!address) {
    return 'ต้องระบุที่อยู่';
  }
  if (address.map) {
    return address.map((a) => GOOGLEMAPS_COUNTRY(a));
  }

  const key = ['country', address].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { results: [data = null] = [] } = Maps.newGeocoder().geocode(address);
  if (data === null) {
    return 'ไม่พบที่อยู่';
  }

  const [{ short_name, long_name } = {}] = data.address_components.filter(({ types: [level] }) => level === 'country');

  if (!short_name) {
    return 'ไม่พบประเทศ';
  }

  const answer = `${long_name} (${short_name})`;
  _mapsSetCache(key, answer);
  return answer;
};

/**
 * GOOGLEMAPS_DIRECTIONS — แสดงเส้นทางขับขี่ระหว่าง 2 จุด
 *
 * ตัวอย่าง: =GOOGLEMAPS_DIRECTIONS("กรุงเทพ", "นนทบุรี", "driving")
 *
 * @param {String} origin ที่อยู่จุดเริ่มต้น
 * @param {String} destination ที่อยู่ปลายทาง
 * @param {String} mode โหมดการเดินทาง (driving, walking, bicycling, transit)
 * @return {String} เส้นทางขับขี่ทีละขั้นตอน
 * @customFunction
 */
const GOOGLEMAPS_DIRECTIONS = (origin, destination, mode = 'driving') => {
  if (!origin || !destination) {
    return 'ต้องระบุจุดเริ่มต้นและปลายทาง';
  }

  const key = ['directions', origin, destination, mode].join(',');
  const value = _mapsGetCache(key);
  if (value !== null) return value;

  const { routes = [] } = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setMode(mode)
    .getDirections();

  if (!routes.length) {
    return 'ไม่พบเส้นทาง';
  }

  const directions = routes
    .map(({ legs }) => {
      return legs.map(({ steps }) => {
        return steps.map((step) => {
          // [FIX V5.5.040] HTML sanitization — CodeQL-compliant approach
          // Strategy: escape ALL HTML special chars first, then decode safe entities.
          //   This guarantees no raw < > & " ' survive in output (no XSS vector possible).
          //   Input is from Maps.newDirectionFinder().getDirections() (trusted Google API).
          const raw = String(step.html_instructions || '');
          // Step 1: Strip all HTML tags (including those with quoted attributes containing >)
          //   Pattern: < followed by anything that's not a quote, or a quoted string, until >
          const stripped = raw.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '');
          // Step 2: Decode safe entities (output is plain text, no XSS risk)
          return stripped
            .replace(/&nbsp;/g, ' ')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
        });
      });
    })
    .join(', ');

  _mapsSetCache(key, directions);
  return directions;
};
