// Solar position calculator for SunSeeker.
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

// Returns solar declination (degrees) and equation of time (minutes) for a Julian Day.
function solarParams(jd) {
    const T = (jd - 2451545.0) / 36525;

    // Geometric mean longitude and anomaly (degrees)
    let L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    L0 = ((L0 % 360) + 360) % 360;
    let M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    M = ((M % 360) + 360) % 360;
    const Mrad = M * DEG;

    // Equation of center → true longitude → apparent longitude
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
            + 0.000289 * Math.sin(3 * Mrad);
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG);

    // Obliquity of ecliptic (degrees)
    const epsilon0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const epsilon = epsilon0 + 0.00256 * Math.cos(omega * DEG);

    // Declination
    const decl = Math.asin(Math.sin(epsilon * DEG) * Math.sin(lambda * DEG)) * RAD;

    // Equation of time (minutes) — NOAA formulation
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

// Hour angle (degrees) for sunrise/sunset at the given zenith.
// Returns null ha for polar day (cosHA < -1) or polar night (cosHA > 1).
function computeHourAngle(lat, decl, zenith = 90.833) {
    const cosHA = (Math.cos(zenith * DEG) - Math.sin(lat * DEG) * Math.sin(decl * DEG))
                / (Math.cos(lat * DEG) * Math.cos(decl * DEG));
    if (cosHA < -1) return { ha: null, polarDay: true,  polarNight: false };
    if (cosHA > 1)  return { ha: null, polarDay: false, polarNight: true  };
    return { ha: Math.acos(cosHA) * RAD, polarDay: false, polarNight: false };
}

// sunTimes — { sunrise: Date|null, sunset: Date|null, polarDay: bool, polarNight: bool }
// All Date values are UTC. Caller is responsible for timezone display.
export function sunTimes(lat, lon, date) {
    const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0));
    const { decl, eqt } = solarParams(toJulianDay(noon));
    const { ha, polarDay, polarNight } = computeHourAngle(lat, decl);

    if (polarDay || polarNight) {
        return { sunrise: null, sunset: null, polarDay: !!polarDay, polarNight: !!polarNight };
    }

    const solarNoonUTC = 720 - 4 * lon - eqt; // minutes from UTC midnight
    const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return {
        sunrise:    new Date(base + (solarNoonUTC - ha * 4) * 60000),
        sunset:     new Date(base + (solarNoonUTC + ha * 4) * 60000),
        polarDay:   false,
        polarNight: false,
    };
}

// solarNoon — UTC Date of solar noon for the given day.
export function solarNoon(lat, lon, date) {
    const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0));
    const { eqt } = solarParams(toJulianDay(noon));
    const solarNoonUTC = 720 - 4 * lon - eqt;
    const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return new Date(base + solarNoonUTC * 60000);
}

// dayLength — day length in minutes (0 for polar night, 24×60 for polar day).
export function dayLength(lat, lon, date) {
    const { sunrise, sunset, polarDay, polarNight } = sunTimes(lat, lon, date);
    if (polarDay)   return 24 * 60;
    if (polarNight) return 0;
    return (sunset - sunrise) / 60000;
}

// sunAzimuth — { sunrise, sunset, current, elevation } all in degrees.
// Azimuths: 0=North, 90=East, 180=South, 270=West.
// elevation: degrees above horizon (negative = below).
export function sunAzimuth(lat, lon, date) {
    // Sunrise/sunset azimuth uses noon declination (direction where sun crosses the horizon).
    const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0));
    const { decl: declNoon } = solarParams(toJulianDay(noon));

    // Zenith = 90.833° (standard: accounts for refraction + solar disc radius)
    const cosZ = Math.cos(90.833 * DEG); // ≈ −0.01454
    const sinZ = Math.sin(90.833 * DEG); // ≈  0.9999
    const cosRiseAz = Math.max(-1, Math.min(1,
        (Math.sin(declNoon * DEG) - Math.sin(lat * DEG) * cosZ) / (Math.cos(lat * DEG) * sinZ)
    ));
    const srAz = Math.acos(cosRiseAz) * RAD; // sunrise azimuth (eastern sky)

    // Current sun position from the exact timestamp.
    const { decl, eqt } = solarParams(toJulianDay(date));
    const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let ha = (utcMin + eqt + 4 * lon) / 4 - 180; // hour angle in degrees
    if (ha < -180) ha += 360;
    if (ha >  180) ha -= 360;

    const cosZenith = Math.max(-1, Math.min(1,
        Math.sin(lat * DEG) * Math.sin(decl * DEG)
        + Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(ha * DEG)
    ));
    const zenith    = Math.acos(cosZenith) * RAD;
    const sinZenith = Math.sin(zenith * DEG);

    let azimuth = 0;
    if (sinZenith > 1e-10) {
        // NOAA azimuth formula: ha > 0 → afternoon (sun moving west), ha ≤ 0 → morning.
        const cosAz = Math.max(-1, Math.min(1,
            (Math.sin(lat * DEG) * cosZenith - Math.sin(decl * DEG)) / (Math.cos(lat * DEG) * sinZenith)
        ));
        const arcCosAz = Math.acos(cosAz) * RAD;
        azimuth = ha > 0 ? (arcCosAz + 180) % 360 : (540 - arcCosAz) % 360;
    }

    return {
        sunrise:   srAz,
        sunset:    360 - srAz,
        current:   azimuth,
        elevation: 90 - zenith,
    };
}
