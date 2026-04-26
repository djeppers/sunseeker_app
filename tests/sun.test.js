// Unit tests for sun.js — runs in Node.js: node tests/sun.test.js
// No external dependencies required.

import { goldenHour, blueHour, sunPosition, nextEvents } from '../src/embeddedjs/sun.js';

let passed = 0;
let failed = 0;

function assertApprox(actual, expected, tolerance, label) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        console.error(`  FAIL: ${label}`);
        console.error(`        expected ${expected} ±${tolerance}, got ${actual.toFixed(2)} (diff ${diff.toFixed(2)})`);
        failed++; process.exitCode = 1;
    } else {
        console.log(`  PASS: ${label}`);
        passed++;
    }
}

function check(condition, label) {
    if (!condition) {
        console.error(`  FAIL: ${label}`);
        failed++; process.exitCode = 1;
    } else {
        console.log(`  PASS: ${label}`);
        passed++;
    }
}

const utcMin = d => d.getUTCHours() * 60 + d.getUTCMinutes();
const dur    = w => (w.end - w.start) / 60000;  // duration in minutes

// ── goldenHour ────────────────────────────────────────────────────────────────
console.log('\n── goldenHour: Copenhagen summer solstice 2026 ──');
{
    const d  = new Date(Date.UTC(2026, 5, 21));
    const gh = goldenHour(55.68, 12.57, d);

    check(gh.morning !== null, 'CPH summer — morning golden hour exists');
    check(gh.evening !== null, 'CPH summer — evening golden hour exists');

    if (gh.morning && gh.evening) {
        // Morning: starts at sunrise ~02:26 UTC, duration ~64 min (shallow sun angle at 55°N)
        assertApprox(utcMin(gh.morning.start), 2 * 60 + 26, 8, 'CPH summer morning GH start ~02:26 UTC');
        assertApprox(dur(gh.morning), 64, 10, 'CPH summer morning GH duration ~64 min');

        // Evening: ends at sunset ~19:57 UTC, duration ~64 min
        assertApprox(utcMin(gh.evening.end), 19 * 60 + 57, 8, 'CPH summer evening GH end ~19:57 UTC');
        assertApprox(dur(gh.evening), 64, 10, 'CPH summer evening GH duration ~64 min');

        // Morning azimuth: sun in NE sky at solstice (~40-55°)
        check(gh.morning.azimuthStart >= 38 && gh.morning.azimuthStart <= 56,
            `CPH summer morning GH azimuth start ${gh.morning.azimuthStart.toFixed(1)}° (expected 38-56°)`);

        // Evening azimuth: sun in NW sky (~304-322°)
        check(gh.evening.azimuthEnd >= 304 && gh.evening.azimuthEnd <= 322,
            `CPH summer evening GH azimuth end ${gh.evening.azimuthEnd.toFixed(1)}° (expected 304-322°)`);
    }
}

console.log('\n── goldenHour: Copenhagen winter solstice 2026 ──');
{
    const d  = new Date(Date.UTC(2026, 11, 21));
    const gh = goldenHour(55.68, 12.57, d);

    check(gh.morning !== null, 'CPH winter — morning golden hour exists');
    check(gh.evening !== null, 'CPH winter — evening golden hour exists');

    if (gh.morning && gh.evening) {
        // Winter GH is ~78 min — sun rises very shallowly at 55°N in December
        assertApprox(dur(gh.morning), 78, 12, 'CPH winter morning GH duration ~78 min');
        assertApprox(dur(gh.evening), 78, 12, 'CPH winter evening GH duration ~78 min');

        // SE morning, SW evening
        check(gh.morning.azimuthStart >= 115 && gh.morning.azimuthStart <= 140,
            `CPH winter morning GH azimuth start ${gh.morning.azimuthStart.toFixed(1)}° (expected SE 115-140°)`);
        check(gh.evening.azimuthEnd >= 220 && gh.evening.azimuthEnd <= 245,
            `CPH winter evening GH azimuth end ${gh.evening.azimuthEnd.toFixed(1)}° (expected SW 220-245°)`);
    }
}

console.log('\n── goldenHour: Equator equinox ──');
{
    const d  = new Date(Date.UTC(2026, 2, 20));
    const gh = goldenHour(0, 0, d);

    check(gh.morning !== null, 'Equator equinox — morning GH exists');
    check(gh.evening !== null, 'Equator equinox — evening GH exists');

    if (gh.morning && gh.evening) {
        // Sun rises nearly due east, azimuth ~85-95°
        assertApprox(gh.morning.azimuthStart, 90, 6, 'Equator morning GH azimuth start ~90° (E)');
        assertApprox(gh.evening.azimuthEnd,   270, 6, 'Equator evening GH azimuth end ~270° (W)');
    }
}

// ── blueHour ──────────────────────────────────────────────────────────────────
console.log('\n── blueHour: Copenhagen summer solstice 2026 ──');
{
    const d  = new Date(Date.UTC(2026, 5, 21));
    const bh = blueHour(55.68, 12.57, d);

    check(bh.morning !== null, 'CPH summer — morning blue hour exists');
    check(bh.evening !== null, 'CPH summer — evening blue hour exists');

    if (bh.morning && bh.evening) {
        // Evening BH starts after golden hour ends
        const gh = goldenHour(55.68, 12.57, d);
        if (gh.evening) {
            check(bh.evening.start >= gh.evening.end,
                'CPH summer evening BH starts after GH ends');
        }
        // BH duration shorter than GH at high latitude in summer
        check(dur(bh.evening) > 0 && dur(bh.evening) < dur(goldenHour(55.68, 12.57, d).evening ?? { start: 0, end: 99e9 }),
            `CPH summer evening BH duration ${dur(bh.evening).toFixed(0)} min (shorter than GH)`);
    }
}

console.log('\n── blueHour: Equator equinox ──');
{
    const d  = new Date(Date.UTC(2026, 2, 20));
    const bh = blueHour(0, 0, d);

    check(bh.morning !== null, 'Equator — morning BH exists');
    check(bh.evening !== null, 'Equator — evening BH exists');

    if (bh.morning && bh.evening) {
        // Near equator sun moves fast so BH is very short (~6-12 min)
        check(dur(bh.evening) >= 5 && dur(bh.evening) <= 14,
            `Equator evening BH duration ${dur(bh.evening).toFixed(0)} min (expected 5-14)`);
    }
}

// ── sunPosition ───────────────────────────────────────────────────────────────
console.log('\n── sunPosition ──');
{
    // Solar noon in Copenhagen (summer solstice): azimuth ~180° (S), elevation ~57.7°
    const noonUTC = new Date(Date.UTC(2026, 5, 21, 11, 11, 0));
    const pos = sunPosition(55.68, 12.57, noonUTC);
    assertApprox(pos.azimuth,   180,  6, 'CPH solar noon azimuth ~180° (S)');
    assertApprox(pos.elevation,  57.7, 2, 'CPH solar noon elevation ~57.7°');
}

{
    // Midnight in winter: elevation well below horizon
    const midnight = new Date(Date.UTC(2026, 11, 21, 0, 0, 0));
    const pos = sunPosition(55.68, 12.57, midnight);
    check(pos.elevation < -30, `CPH winter midnight elevation ${pos.elevation.toFixed(1)}° (expected < -30°)`);
}

{
    // Sydney at solar noon (equinox): azimuth ~0° (N, southern hemisphere)
    const noonUTC = new Date(Date.UTC(2026, 2, 20, 2, 20, 0));  // ~solar noon Sydney UTC
    const pos = sunPosition(-33.87, 151.21, noonUTC);
    const distFromNorth = Math.min(pos.azimuth, 360 - pos.azimuth);
    assertApprox(distFromNorth, 0, 8, 'Sydney equinox noon azimuth ~0°/360° (N)');
}

// ── nextEvents ────────────────────────────────────────────────────────────────
console.log('\n── nextEvents ──');
{
    // Called during evening golden hour: first event should be active (start in past)
    const d  = new Date(Date.UTC(2026, 5, 21));
    const gh = goldenHour(55.68, 12.57, d);
    if (gh.evening) {
        const midGH = new Date(gh.evening.start.getTime() + 10 * 60000);
        const evs = nextEvents(55.68, 12.57, midGH);
        check(evs.length > 0, 'nextEvents during GH returns events');
        check(evs[0].type === "golden" && evs[0].start <= midGH,
            'First event is active golden hour (start in past)');
    }
}

{
    // Called late at night: wraps to tomorrow's morning events
    const lateNight = new Date(Date.UTC(2026, 5, 21, 22, 0, 0));
    const evs = nextEvents(55.68, 12.57, lateNight);
    check(evs.length > 0, 'nextEvents late at night returns events');
    check(evs[0].start > lateNight, 'First event is in the future (tomorrow)');
}

{
    // Should always return golden and blue events
    const now = new Date(Date.UTC(2026, 2, 20, 14, 0, 0));  // afternoon, equinox
    const evs = nextEvents(55.68, 12.57, now);
    const hasGolden = evs.some(e => e.type === "golden");
    const hasBlue   = evs.some(e => e.type === "blue");
    check(hasGolden, 'nextEvents includes a golden hour event');
    check(hasBlue,   'nextEvents includes a blue hour event');
    check(evs.length <= 4, 'nextEvents returns at most 4 events');
}

// ── Polar edge cases ──────────────────────────────────────────────────────────
console.log('\n── Polar edge cases ──');
{
    // Tromsø June: polar day — golden and blue hour return null
    const d  = new Date(Date.UTC(2026, 5, 21));
    const gh = goldenHour(69.65, 18.96, d);
    const bh = blueHour(69.65, 18.96, d);
    check(gh.morning === null && gh.evening === null, 'Tromsø June — no golden hour (polar day)');
    check(bh.morning === null && bh.evening === null, 'Tromsø June — no blue hour (polar day)');

    const evs = nextEvents(69.65, 18.96, new Date(Date.UTC(2026, 5, 21, 12, 0, 0)));
    check(evs.every(e => e.start > new Date(Date.UTC(2026, 5, 21))), 'Tromsø June — no events crash');
}

{
    // Tromsø December: polar night — no crash, graceful nulls
    const d  = new Date(Date.UTC(2026, 11, 21));
    const gh = goldenHour(69.65, 18.96, d);
    check(gh.morning === null && gh.evening === null, 'Tromsø December — no golden hour (polar night)');
    const bh = blueHour(69.65, 18.96, d);
    check(bh !== null, 'Tromsø December — blueHour does not throw');
}

{
    // Arctic winter day: sun barely rises, may never reach 6°
    // Should return morning-only GH window gracefully
    const d  = new Date(Date.UTC(2026, 11, 21));
    const gh = goldenHour(68.0, 18.96, d);
    check(gh !== null, 'Arctic winter — goldenHour does not throw');
    if (gh.morning) {
        check(gh.morning.end > gh.morning.start, 'Arctic winter — morning GH window is valid');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) console.error('\nSome tests FAILED.');
else            console.log('\nAll tests passed.');
