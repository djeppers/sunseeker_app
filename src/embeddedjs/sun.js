// Solar/twilight calculator for SunSeeker.
// Pure math, no Pebble dependencies — unit-testable in Node.js.
// Elevation boundaries follow the PhotoPills standard:
//   Golden hour: sun between +6° and -4°
//   Blue hour:   sun between -4° and -6°

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function toJulianDay(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const h = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const A = Math.floor((14 - m) / 12);
    const Y = y + 4800 - A;
    const M = m + 12 * A - 3;
    const JDN = d + Math.floor((153 * M + 2) / 5) + 365 * Y
              + Math.floor(Y / 4) - Math.floor(Y / 100) + Math.floor(Y / 400) - 32045;
    return JDN + (h - 12) / 24;
}

function solarParams(jd) {
    const T = (jd - 2451545.0) / 36525;
    let L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    L0 = ((L0 % 360) + 360) % 360;
    let M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    M = ((M % 360) + 360) % 360;
    const Mrad = M * DEG;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
            + 0.000289 * Math.sin(3 * Mrad);
    const omega  = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG);
    const eps0   = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps    = eps0 + 0.00256 * Math.cos(omega * DEG);
    const decl   = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG)) * RAD;
    const e      = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const y      = Math.tan((eps * DEG) / 2) ** 2;
    const eqt    = 4 * RAD * (
        y * Math.sin(2 * L0 * DEG)
        - 2 * e * Math.sin(Mrad)
        + 4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0 * DEG)
        - 0.5 * y * y * Math.sin(4 * L0 * DEG)
        - 1.25 * e * e * Math.sin(2 * Mrad)
    );
    return { decl, eqt };
}

// cosHA < -1 → sun always above zenith; cosHA > 1 → sun never reaches zenith.
function computeHourAngle(lat, decl, zenith) {
    const cosHA = (Math.cos(zenith * DEG) - Math.sin(lat * DEG) * Math.sin(decl * DEG))
                / (Math.cos(lat * DEG) * Math.cos(decl * DEG));
    if (cosHA < -1) return { ha: null, alwaysAbove: true,  alwaysBelow: false };
    if (cosHA > 1)  return { ha: null, alwaysAbove: false, alwaysBelow: true  };
    return { ha: Math.acos(cosHA) * RAD, alwaysAbove: false, alwaysBelow: false };
}

// Returns { riseMs, setMs } in ms from UTC midnight, or null for polar cases.
function riseSetMs(lat, lon, date, zenith) {
    const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
    const { decl, eqt } = solarParams(toJulianDay(noon));
    const { ha, alwaysAbove, alwaysBelow } = computeHourAngle(lat, decl, zenith);
    if (alwaysAbove || alwaysBelow) return null;
    const noonMs = (720 - 4 * lon - eqt) * 60000;
    const haMs   = ha * 4 * 60000;
    return { riseMs: noonMs - haMs, setMs: noonMs + haMs };
}

// Compass azimuth (0=N, 90=E, 180=S, 270=W). Works below the horizon (for twilight).
function azimuthAt(lat, lon, date) {
    const { decl, eqt } = solarParams(toJulianDay(date));
    const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let ha = (utcMin + eqt + 4 * lon) / 4 - 180;
    if (ha < -180) ha += 360;
    if (ha >  180) ha -= 360;
    const cosZ = Math.max(-1, Math.min(1,
        Math.sin(lat * DEG) * Math.sin(decl * DEG)
        + Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(ha * DEG)
    ));
    const z    = Math.acos(cosZ) * RAD;
    const sinZ = Math.sin(z * DEG);
    if (sinZ < 1e-10) return 0;
    const cosAz = Math.max(-1, Math.min(1,
        (Math.sin(lat * DEG) * cosZ - Math.sin(decl * DEG)) / (Math.cos(lat * DEG) * sinZ)
    ));
    const a = Math.acos(cosAz) * RAD;
    return ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
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
//
// Rendering:  draw arc from azimuthAt6 → azimuthAtMinus6.
//   Amber portion:  azimuthAt6 → azimuthAtMinus4
//   Dither zone:    ~3° around azimuthAtMinus4
//   Blue portion:   azimuthAtMinus4 → azimuthAtMinus6
export function lightArc(lat, lon, date) {
    const base   = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const plus6  = riseSetMs(lat, lon, date, 84);   // zenith 84° = +6° elevation
    const minus4 = riseSetMs(lat, lon, date, 94);   // zenith 94° = -4° elevation
    const minus6 = riseSetMs(lat, lon, date, 96);   // zenith 96° = -6° elevation

    function half(p6ms, m4ms, m6ms) {
        if (p6ms === null && m4ms === null) return null;
        return {
            goldenStartMs:    p6ms  !== null ? base + p6ms  : null,
            goldenEndMs:      m4ms  !== null ? base + m4ms  : null,
            blueEndMs:        m6ms  !== null ? base + m6ms  : null,
            azimuthAt6:       p6ms  !== null ? azimuthAt(lat, lon, new Date(base + p6ms))  : null,
            azimuthAtMinus4:  m4ms  !== null ? azimuthAt(lat, lon, new Date(base + m4ms))  : null,
            azimuthAtMinus6:  m6ms  !== null ? azimuthAt(lat, lon, new Date(base + m6ms))  : null,
        };
    }

    // Morning (sun rising):  -6° → -4° → +6°
    // Evening (sun setting): +6° → -4° → -6°
    return {
        morning: half(
            plus6  ? plus6.riseMs  : null,
            minus4 ? minus4.riseMs : null,
            minus6 ? minus6.riseMs : null,
        ),
        evening: half(
            plus6  ? plus6.setMs  : null,
            minus4 ? minus4.setMs : null,
            minus6 ? minus6.setMs : null,
        ),
    };
}

// sunPosition — current azimuth and elevation (degrees, negative = below horizon).
export function sunPosition(lat, lon, date) {
    const { decl, eqt } = solarParams(toJulianDay(date));
    const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let ha = (utcMin + eqt + 4 * lon) / 4 - 180;
    if (ha < -180) ha += 360;
    if (ha >  180) ha -= 360;
    const cosZ = Math.max(-1, Math.min(1,
        Math.sin(lat * DEG) * Math.sin(decl * DEG)
        + Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(ha * DEG)
    ));
    const z    = Math.acos(cosZ) * RAD;
    const sinZ = Math.sin(z * DEG);
    let azimuth = 0;
    if (sinZ > 1e-10) {
        const cosAz = Math.max(-1, Math.min(1,
            (Math.sin(lat * DEG) * cosZ - Math.sin(decl * DEG)) / (Math.cos(lat * DEG) * sinZ)
        ));
        const a = Math.acos(cosAz) * RAD;
        azimuth = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { azimuth, elevation: 90 - z };
}

// nextEvents — upcoming golden/blue hour events, chronological, up to 4, wrapping to tomorrow.
// Includes currently active events (start in past, end in future).
// Uses ms timestamps throughout to avoid Date object allocation.
export function nextEvents(lat, lon, now) {
    const collected = [];
    const nowMs = now instanceof Date ? now.getTime() : now;

    for (let d = 0; d <= 1 && collected.length < 4; d++) {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
        const arc  = lightArc(lat, lon, date);
        const candidates = [];

        if (arc.morning) {
            const { goldenStartMs: p6, goldenEndMs: m4, blueEndMs: m6 } = arc.morning;
            // Morning blue:   -6° rising → -4° rising
            if (m6 !== null && m4 !== null)
                candidates.push({ type: "blue",   phase: "morning", startMs: m6, endMs: m4 });
            // Morning golden: -4° rising → +6° rising
            if (m4 !== null && p6 !== null)
                candidates.push({ type: "golden", phase: "morning", startMs: m4, endMs: p6 });
        }
        if (arc.evening) {
            const { goldenStartMs: p6, goldenEndMs: m4, blueEndMs: m6 } = arc.evening;
            // Evening golden: +6° setting → -4° setting
            if (p6 !== null && m4 !== null)
                candidates.push({ type: "golden", phase: "evening", startMs: p6, endMs: m4 });
            // Evening blue:   -4° setting → -6° setting
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
