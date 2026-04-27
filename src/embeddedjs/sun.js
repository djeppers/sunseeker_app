// Solar/twilight calculator for SunSeeker.
// Pure math, no Pebble dependencies — unit-testable in Node.js.
// Elevation boundaries follow the PhotoPills standard:
//   Golden hour: sun between +6° and -4°
//   Blue hour:   sun between -4° and -6°

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// Module-level output slots — avoids { } object allocation in hot solar math.
// In XS, object properties are heap chunks; local vars and module vars are slots (no chunk).
let _decl = 0;
let _eqt  = 0;
let _ha   = 0;
let _alwaysAbove = false;
let _alwaysBelow = false;
let _riseMs = 0;
let _setMs  = 0;

// Julian Day Number at 12:00 UTC for the given date (no internal Date object created).
function jdNoonFromDate(date) {
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
    const A = Math.floor((14 - m) / 12);
    const Y = y + 4800 - A;
    const M = m + 12 * A - 3;
    return d + Math.floor((153 * M + 2) / 5) + 365 * Y
         + Math.floor(Y / 4) - Math.floor(Y / 100) + Math.floor(Y / 400) - 32045;
}

function toJulianDay(date) {
    const h = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    return jdNoonFromDate(date) + (h - 12) / 24;
}

// Writes _decl and _eqt — no return value, no { } allocation.
function solarParams(jd) {
    const T = (jd - 2451545.0) / 36525;
    let L0 = ((280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360 + 360) % 360;
    let M  = ((357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360 + 360) % 360;
    const Mrad = M * DEG;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
            + 0.000289 * Math.sin(3 * Mrad);
    const omega  = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG);
    const eps0   = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps    = eps0 + 0.00256 * Math.cos(omega * DEG);
    _decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG)) * RAD;
    const e     = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const tHalf = Math.tan((eps * DEG) / 2);
    const y     = tHalf * tHalf;
    _eqt = 4 * RAD * (
        y * Math.sin(2 * L0 * DEG)
        - 2 * e * Math.sin(Mrad)
        + 4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0 * DEG)
        - 0.5 * y * y * Math.sin(4 * L0 * DEG)
        - 1.25 * e * e * Math.sin(2 * Mrad)
    );
}

// Writes _ha, _alwaysAbove, _alwaysBelow. Uses _decl from last solarParams(). No { } allocation.
function computeHourAngle(lat, zenith) {
    const cosHA = (Math.cos(zenith * DEG) - Math.sin(lat * DEG) * Math.sin(_decl * DEG))
                / (Math.cos(lat * DEG) * Math.cos(_decl * DEG));
    if (cosHA < -1) { _ha = null; _alwaysAbove = true;  _alwaysBelow = false; return; }
    if (cosHA > 1)  { _ha = null; _alwaysAbove = false; _alwaysBelow = true;  return; }
    _ha = Math.acos(cosHA) * RAD;
    _alwaysAbove = false;
    _alwaysBelow = false;
}

// Writes _riseMs, _setMs (UTC ms from midnight). Returns false if polar.
// Requires solarParams() called for the date's noon JD; uses _decl, _eqt.
function riseSet(lat, lon, zenith) {
    computeHourAngle(lat, zenith);
    if (_alwaysAbove || _alwaysBelow) return false;
    const noonMs = (720 - 4 * lon - _eqt) * 60000;
    const haMs   = _ha * 4 * 60000;
    _riseMs = noonMs - haMs;
    _setMs  = noonMs + haMs;
    return true;
}

// Azimuth (0=N, 90=E, 180=S, 270=W) from already-set _decl/_eqt. utcMin = minutes past UTC midnight.
function azimuthFromParams(lat, lon, utcMin) {
    let ha = (utcMin + _eqt + 4 * lon) / 4 - 180;
    if (ha < -180) ha += 360;
    if (ha >  180) ha -= 360;
    const cosZ = Math.max(-1, Math.min(1,
        Math.sin(lat * DEG) * Math.sin(_decl * DEG)
        + Math.cos(lat * DEG) * Math.cos(_decl * DEG) * Math.cos(ha * DEG)
    ));
    const z    = Math.acos(cosZ) * RAD;
    const sinZ = Math.sin(z * DEG);
    if (sinZ < 1e-10) return 0;
    const cosAz = Math.max(-1, Math.min(1,
        (Math.sin(lat * DEG) * cosZ - Math.sin(_decl * DEG)) / (Math.cos(lat * DEG) * sinZ)
    ));
    const a = Math.acos(cosAz) * RAD;
    return ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
}

// Azimuth at utcMin (minutes past UTC midnight) on the day whose noon is jdNoon.
// Calls solarParams() internally — _decl/_eqt are overwritten.
function azimuthAtMin(lat, lon, utcMin, jdNoon) {
    solarParams(jdNoon + (utcMin / 60 - 12) / 24);
    return azimuthFromParams(lat, lon, utcMin);
}

// lightArc — the combined golden + blue hour arc for one day.
//
// Each half (morning/evening) describes three elevation boundaries:
//   +6°  → goldenStartMs / azimuthAt6      (golden begins / day ends)
//   -4°  → goldenEndMs   / azimuthAtMinus4 (golden ends, blue begins)
//   -6°  → blueEndMs     / azimuthAtMinus6 (blue ends / darkness)
//
// All time fields are ms-since-epoch (not Date objects, to save heap on XS).
// Any field may be null if the sun never crosses that elevation on this day.
export function lightArc(lat, lon, date) {
    const base   = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const jdNoon = jdNoonFromDate(date);

    // One solarParams call for noon; _decl/_eqt are reused for riseSet AND azimuth lookups.
    // Declination drifts ~0.017°/hour so reusing noon values for event-time azimuths
    // introduces < 0.5° error — negligible for compass rendering (±5° tolerance).
    solarParams(jdNoon);

    let p6r = null, p6s = null;
    let m4r = null, m4s = null;
    let m6r = null, m6s = null;

    if (riseSet(lat, lon, 84)) { p6r = _riseMs; p6s = _setMs; }  // +6° elevation
    if (riseSet(lat, lon, 94)) { m4r = _riseMs; m4s = _setMs; }  // -4° elevation
    if (riseSet(lat, lon, 96)) { m6r = _riseMs; m6s = _setMs; }  // -6° elevation

    // azimuthFromParams uses the noon _decl/_eqt already set above — no extra solarParams calls.
    function half(p6ms, m4ms, m6ms) {
        if (p6ms === null && m4ms === null) return null;
        return {
            goldenStartMs:   p6ms !== null ? base + p6ms : null,
            goldenEndMs:     m4ms !== null ? base + m4ms : null,
            blueEndMs:       m6ms !== null ? base + m6ms : null,
            azimuthAt6:      p6ms !== null ? Math.round(azimuthFromParams(lat, lon, p6ms / 60000)) : null,
            azimuthAtMinus4: m4ms !== null ? Math.round(azimuthFromParams(lat, lon, m4ms / 60000)) : null,
            azimuthAtMinus6: m6ms !== null ? Math.round(azimuthFromParams(lat, lon, m6ms / 60000)) : null,
        };
    }

    return {
        morning: half(p6r, m4r, m6r),
        evening: half(p6s, m4s, m6s),
    };
}

// sunPosition — current azimuth and elevation (degrees, negative = below horizon).
export function sunPosition(lat, lon, date) {
    solarParams(toJulianDay(date));
    const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let ha = (utcMin + _eqt + 4 * lon) / 4 - 180;
    if (ha < -180) ha += 360;
    if (ha >  180) ha -= 360;
    const cosZ = Math.max(-1, Math.min(1,
        Math.sin(lat * DEG) * Math.sin(_decl * DEG)
        + Math.cos(lat * DEG) * Math.cos(_decl * DEG) * Math.cos(ha * DEG)
    ));
    const z    = Math.acos(cosZ) * RAD;
    const sinZ = Math.sin(z * DEG);
    let azimuth = 0;
    if (sinZ > 1e-10) {
        const cosAz = Math.max(-1, Math.min(1,
            (Math.sin(lat * DEG) * cosZ - Math.sin(_decl * DEG)) / (Math.cos(lat * DEG) * sinZ)
        ));
        const a = Math.acos(cosAz) * RAD;
        azimuth = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { azimuth, elevation: 90 - z };
}

// nextEvents — upcoming golden/blue hour events, chronological, up to 4, wrapping to tomorrow.
// Includes currently active events (start in past, end in future).
export function nextEvents(lat, lon, now) {
    const collected = [];
    const nowMs = now instanceof Date ? now.getTime() : now;

    for (let d = 0; d <= 1 && collected.length < 4; d++) {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
        const arc  = lightArc(lat, lon, date);
        const candidates = [];

        if (arc.morning) {
            const { goldenStartMs: p6, goldenEndMs: m4, blueEndMs: m6 } = arc.morning;
            if (m6 !== null && m4 !== null)
                candidates.push({ type: "blue",   phase: "morning", startMs: m6, endMs: m4 });
            if (m4 !== null && p6 !== null)
                candidates.push({ type: "golden", phase: "morning", startMs: m4, endMs: p6 });
        }
        if (arc.evening) {
            const { goldenStartMs: p6, goldenEndMs: m4, blueEndMs: m6 } = arc.evening;
            if (p6 !== null && m4 !== null)
                candidates.push({ type: "golden", phase: "evening", startMs: p6, endMs: m4 });
            if (m4 !== null && m6 !== null)
                candidates.push({ type: "blue",   phase: "evening", startMs: m4, endMs: m6 });
        }

        candidates.sort((a, b) => a.startMs - b.startMs);
        for (const ev of candidates) {
            if (ev.endMs > nowMs && collected.length < 4) collected.push(ev);
        }
    }
    return collected;
}
