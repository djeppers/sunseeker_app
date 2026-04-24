// Unit tests for sun.js — runs in Node.js: node tests/sun.test.js
// No external dependencies required.

import { sunTimes, sunAzimuth, solarNoon, dayLength } from '../src/embeddedjs/sun.js';

let passed = 0;
let failed = 0;

function assertApprox(actual, expected, tolerance, label) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        console.error(`  FAIL: ${label}`);
        console.error(`        expected ${expected} ±${tolerance}, got ${actual.toFixed(2)} (diff ${diff.toFixed(2)})`);
        failed++;
        process.exitCode = 1;
    } else {
        console.log(`  PASS: ${label}`);
        passed++;
    }
}

function check(condition, label) {
    if (!condition) {
        console.error(`  FAIL: ${label}`);
        failed++;
        process.exitCode = 1;
    } else {
        console.log(`  PASS: ${label}`);
        passed++;
    }
}

const toUTCMin = d => d.getUTCHours() * 60 + d.getUTCMinutes();

// ─────────────────────────────────────────────────────────────
console.log('\n── Sunrise / Sunset Times ──');

// Copenhagen (55.68°N, 12.57°E) summer solstice 2026
// Expected: sunrise ~02:26 UTC (04:26 CEST), sunset ~19:57 UTC (21:57 CEST)
{
    const t = sunTimes(55.68, 12.57, new Date(Date.UTC(2026, 5, 21)));
    assertApprox(toUTCMin(t.sunrise), 2 * 60 + 26, 5, 'CPH summer solstice sunrise ~02:26 UTC');
    assertApprox(toUTCMin(t.sunset),  19 * 60 + 57, 5, 'CPH summer solstice sunset ~19:57 UTC');
    check(!t.polarDay && !t.polarNight, 'CPH summer — not polar');
}

// Copenhagen winter solstice 2026
// Expected: sunrise ~07:37 UTC (08:37 CET), sunset ~14:39 UTC (15:39 CET)
{
    const t = sunTimes(55.68, 12.57, new Date(Date.UTC(2026, 11, 21)));
    assertApprox(toUTCMin(t.sunrise), 7 * 60 + 37, 5, 'CPH winter solstice sunrise ~07:37 UTC');
    assertApprox(toUTCMin(t.sunset),  14 * 60 + 39, 5, 'CPH winter solstice sunset ~14:39 UTC');
    check(!t.polarDay && !t.polarNight, 'CPH winter — not polar');
}

// New York (40.71°N, −74.01°W) equinox 2026
// Solar noon at −74° lon ≈ 17:03 UTC; day ≈ 12h → rise ~10:59, set ~23:07 UTC
{
    const t = sunTimes(40.71, -74.01, new Date(Date.UTC(2026, 2, 20)));
    assertApprox(toUTCMin(t.sunrise), 10 * 60 + 59, 8, 'NYC equinox sunrise ~10:59 UTC');
    assertApprox(toUTCMin(t.sunset),  23 * 60 +  7, 8, 'NYC equinox sunset ~23:07 UTC');
}

// Sydney (−33.87°S, 151.21°E) — southern hemisphere verification
// At equinox day length ≈ 12h (check length, not times, to avoid UTC date-wrap complexity)
{
    const dl = dayLength(-33.87, 151.21, new Date(Date.UTC(2026, 2, 20)));
    assertApprox(dl, 720, 15, 'Sydney equinox day length ~720 min');
}

// ─────────────────────────────────────────────────────────────
console.log('\n── Polar Edge Cases ──');

// Tromsø (69.65°N, 18.96°E) — polar day in June
{
    const t = sunTimes(69.65, 18.96, new Date(Date.UTC(2026, 5, 21)));
    check(t.polarDay === true,  'Tromsø June — polarDay');
    check(t.sunrise === null,   'Tromsø June — sunrise is null');
    assertApprox(dayLength(69.65, 18.96, new Date(Date.UTC(2026, 5, 21))), 24 * 60, 0, 'Tromsø June — 24×60 min day');
}

// Tromsø — polar night in December
{
    const t = sunTimes(69.65, 18.96, new Date(Date.UTC(2026, 11, 21)));
    check(t.polarNight === true, 'Tromsø December — polarNight');
    check(t.sunrise === null,    'Tromsø December — sunrise is null');
    assertApprox(dayLength(69.65, 18.96, new Date(Date.UTC(2026, 11, 21))), 0, 0, 'Tromsø December — 0 min day');
}

// 65°N at midsummer — just south of effective polar circle (with refraction 65°N is finite)
{
    const dl = dayLength(65.0, 18.96, new Date(Date.UTC(2026, 5, 21)));
    check(dl > 22 * 60 && dl < 24 * 60, `65°N midsummer day length ${dl.toFixed(0)} min (expected 22–24 h)`);
}

// Equator — equinox day length ≈ 12h
{
    const dl = dayLength(0, 0, new Date(Date.UTC(2026, 2, 20)));
    assertApprox(dl, 720, 15, 'Equator equinox day length ~720 min');
}

// ─────────────────────────────────────────────────────────────
console.log('\n── Solar Azimuth — Rise / Set Directions ──');

// At equinox sunrise ≈ 90° (East) and sunset ≈ 270° (West) for any latitude
{
    const d = new Date(Date.UTC(2026, 2, 20));
    const az = sunAzimuth(55.68, 12.57, d);
    assertApprox(az.sunrise, 90, 3, 'CPH equinox sunrise azimuth ~90°');
    assertApprox(az.sunset,  270, 3, 'CPH equinox sunset azimuth ~270°');

    const azS = sunAzimuth(-33.87, 151.21, d);
    assertApprox(azS.sunrise, 90, 3, 'Sydney equinox sunrise azimuth ~90°');
    assertApprox(azS.sunset,  270, 3, 'Sydney equinox sunset azimuth ~270°');
}

// Summer solstice 55°N: sunrise well north of east (40–51°), sunset symmetric (309–320°)
{
    const az = sunAzimuth(55.68, 12.57, new Date(Date.UTC(2026, 5, 21)));
    check(az.sunrise >= 39 && az.sunrise <= 52,
          `CPH summer solstice sunrise az ${az.sunrise.toFixed(1)}° (expected 40–51°)`);
    check(az.sunset >= 308 && az.sunset <= 321,
          `CPH summer solstice sunset az ${az.sunset.toFixed(1)}° (expected 309–320°)`);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── Solar Azimuth — Current Position ──');

// Solar noon in N hemisphere: azimuth ≈ 180° (South), elevation = 90 − lat + decl
{
    const d    = new Date(Date.UTC(2026, 5, 21));
    const noon = solarNoon(55.68, 12.57, d);
    const az   = sunAzimuth(55.68, 12.57, noon);
    assertApprox(az.current,   180,  5, 'CPH solar noon azimuth ~180° (South)');
    // elevation at summer solstice solar noon: 90 − 55.68 + 23.44 ≈ 57.76°
    assertApprox(az.elevation, 57.7, 2, 'CPH summer solstice noon elevation ~57.7°');
}

// Solar noon in S hemisphere: azimuth ≈ 0°/360° (North)
{
    const d    = new Date(Date.UTC(2026, 2, 20));
    const noon = solarNoon(-33.87, 151.21, d);
    const az   = sunAzimuth(-33.87, 151.21, noon);
    const distFromNorth = Math.min(az.current, 360 - az.current);
    assertApprox(distFromNorth, 0, 5, 'Sydney solar noon azimuth ~0° (North)');
}

// Midnight in winter: sun clearly below horizon
{
    const midnight = new Date(Date.UTC(2026, 11, 21, 0, 0, 0));
    const az = sunAzimuth(55.68, 0, midnight);
    check(az.elevation < -30, `CPH winter midnight elevation ${az.elevation.toFixed(1)}° (expected < −30°)`);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── Day Length ──');

{
    const dl1 = dayLength(55.68, 12.57, new Date(Date.UTC(2026, 5, 21)));
    assertApprox(dl1, 1051, 15, 'CPH summer solstice day length ~1051 min (17.5 h)');

    const dl2 = dayLength(55.68, 12.57, new Date(Date.UTC(2026, 11, 21)));
    assertApprox(dl2, 420, 15, 'CPH winter solstice day length ~420 min (7 h)');
}

// ─────────────────────────────────────────────────────────────
console.log('\n── Solar Noon ──');

{
    const noon = solarNoon(55.68, 12.57, new Date(Date.UTC(2026, 5, 21)));
    assertApprox(toUTCMin(noon), 11 * 60 + 11, 5, 'CPH summer solstice solar noon ~11:11 UTC');
}

// ─────────────────────────────────────────────────────────────
console.log('\n── Edge Cases ──');

// Date line area (longitude ±180)
{
    const t = sunTimes(0, 179.9, new Date(Date.UTC(2026, 2, 20)));
    check(t.sunrise instanceof Date && t.sunset instanceof Date, 'Lon +179.9 — valid dates');
}
{
    const t = sunTimes(0, -179.9, new Date(Date.UTC(2026, 2, 20)));
    check(t.sunrise instanceof Date && t.sunset instanceof Date, 'Lon −179.9 — valid dates');
}

// Equator (lat = 0)
{
    const t = sunTimes(0, 0, new Date(Date.UTC(2026, 6, 15)));
    check(t.sunrise instanceof Date && t.sunset instanceof Date, 'Equator lat=0 — valid dates');
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('\nSome tests FAILED. Check output above.');
} else {
    console.log('\nAll tests passed.');
}
