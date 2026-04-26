// Solar/twilight calculator for SunSeeker.
// Pure math, no Pebble dependencies — unit-testable in Node.js.

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
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG);
    const epsilon0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const epsilon = epsilon0 + 0.00256 * Math.cos(omega * DEG);
    const decl = Math.asin(Math.sin(epsilon * DEG) * Math.sin(lambda * DEG)) * RAD;
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const y = Math.tan((epsilon * DEG) / 2) ** 2;
    const eqt = 4 * RAD * (
        y * Math.sin(2 * L0 * DEG)
        - 2 * e * Math.sin(Mrad)
        + 4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0 * DEG)
        - 0.5 * y * y * Math.sin(4 * L0 * DEG)
        - 1.25 * e * e * Math.sin(2 * Mrad)
    );
    return { decl, eqt };
}

// cosHA < -1 → sun always above this zenith (alwaysAbove)
// cosHA > 1  → sun never reaches this zenith (alwaysBelow)
function computeHourAngle(lat, decl, zenith = 90.833) {
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

// Compass azimuth (0=N, 90=E, 180=S, 270=W) at a specific datetime.
// Works for sub-horizon positions (blue hour).
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
    const z = Math.acos(cosZ) * RAD;
    const sinZ = Math.sin(z * DEG);
    if (sinZ < 1e-10) return 0;
    const cosAz = Math.max(-1, Math.min(1,
        (Math.sin(lat * DEG) * cosZ - Math.sin(decl * DEG)) / (Math.cos(lat * DEG) * sinZ)
    ));
    const a = Math.acos(cosAz) * RAD;
    return ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
}

function makeWindow(lat, lon, base, riseMs, setMs) {
    const start = new Date(base + riseMs);
    const end   = new Date(base + setMs);
    return {
        start,
        end,
        azimuthStart: azimuthAt(lat, lon, start),
        azimuthEnd:   azimuthAt(lat, lon, end),
    };
}

// goldenHour — { morning, evening } windows where sun is 0°–6° above horizon.
// Each window is { start, end, azimuthStart, azimuthEnd } or null.
// Special case: if sun rises but never reaches 6°, the whole day is golden hour
// and is reported as a single morning window with evening = null.
export function goldenHour(lat, lon, date) {
    const base    = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const horizon = riseSetMs(lat, lon, date, 90.833);
    const sixDeg  = riseSetMs(lat, lon, date, 84);

    if (!horizon) return { morning: null, evening: null };

    if (!sixDeg) {
        // Sun rises but never reaches 6° — entire day is golden hour
        return {
            morning: makeWindow(lat, lon, base, horizon.riseMs, horizon.setMs),
            evening: null,
        };
    }

    return {
        morning: makeWindow(lat, lon, base, horizon.riseMs, sixDeg.riseMs),
        evening: makeWindow(lat, lon, base, sixDeg.setMs,   horizon.setMs),
    };
}

// blueHour — { morning, evening } windows where sun is 4°–6° below horizon (civil twilight).
// Each window is { start, end, azimuthStart, azimuthEnd } or null.
export function blueHour(lat, lon, date) {
    const base    = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const fourDeg = riseSetMs(lat, lon, date, 94);  // -4° elevation
    const sixDeg  = riseSetMs(lat, lon, date, 96);  // -6° elevation

    if (!fourDeg || !sixDeg) return { morning: null, evening: null };

    return {
        morning: makeWindow(lat, lon, base, sixDeg.riseMs,  fourDeg.riseMs),
        evening: makeWindow(lat, lon, base, fourDeg.setMs,  sixDeg.setMs),
    };
}

// sunPosition — current azimuth (0-360) and elevation (degrees, negative = below horizon).
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

// nextEvents — chronologically ordered upcoming events (includes currently active ones).
// Returns up to 4 events, wrapping into tomorrow if needed.
export function nextEvents(lat, lon, now) {
    const collected = [];
    for (let d = 0; d <= 1 && collected.length < 4; d++) {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
        const gh = goldenHour(lat, lon, date);
        const bh = blueHour(lat, lon, date);

        const candidates = [
            gh.morning ? { type: "golden", phase: "morning", ...gh.morning } : null,
            gh.evening ? { type: "golden", phase: "evening", ...gh.evening } : null,
            bh.morning ? { type: "blue",   phase: "morning", ...bh.morning } : null,
            bh.evening ? { type: "blue",   phase: "evening", ...bh.evening } : null,
        ].filter(ev => ev !== null && ev.end > now);

        candidates.sort((a, b) => a.start - b.start);
        for (const ev of candidates) {
            if (collected.length < 4) collected.push(ev);
        }
    }
    return collected;
}
