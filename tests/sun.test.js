// Unit tests for sun.js — runs in Node.js: node tests/sun.test.js
import { lightArc, sunPosition, nextEvents } from '../src/embeddedjs/sun.js';

let passed = 0, failed = 0;

function assertApprox(actual, expected, tolerance, label) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        console.error(`  FAIL: ${label}\n        expected ${expected} +/-${tolerance}, got ${actual.toFixed(2)}`);
        failed++; process.exitCode = 1;
    } else { console.log(`  PASS: ${label}`); passed++; }
}
function check(condition, label) {
    if (!condition) { console.error(`  FAIL: ${label}`); failed++; process.exitCode = 1; }
    else            { console.log(`  PASS: ${label}`); passed++; }
}
const utcMinMs = ms => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const durMs    = (startMs, endMs) => (endMs - startMs) / 60000;

// ── lightArc: Copenhagen summer solstice 2026 ─────────────────────────────────
console.log('\n── lightArc: Copenhagen summer solstice 2026 ──');
{
    const d   = new Date(Date.UTC(2026, 5, 21));
    const arc = lightArc(55.68, 12.57, d);

    check(arc.morning !== null, 'CPH summer — morning arc exists');
    check(arc.evening !== null, 'CPH summer — evening arc exists');

    if (arc.morning) {
        const m = arc.morning;
        check(m.azimuthAt6 !== null,      'CPH summer morning — azimuthAt6 exists');
        check(m.azimuthAtMinus4 !== null,  'CPH summer morning — azimuthAtMinus4 exists');
        check(m.azimuthAtMinus6 !== null,  'CPH summer morning — azimuthAtMinus6 exists');

        // Times in chronological order: blueEnd < goldenEnd < goldenStart
        check(m.blueEndMs < m.goldenEndMs && m.goldenEndMs < m.goldenStartMs,
            'CPH summer morning — times in chronological order');

        // Golden hour (-4° to +6°) is longer than old 0°-6° definition
        const ghDur = durMs(m.goldenEndMs, m.goldenStartMs);
        check(ghDur > 80 && ghDur < 130, `CPH summer morning GH duration ${ghDur.toFixed(0)} min (expected 80-130)`);

        // Blue hour duration ~26 min (same as before)
        const bhDur = durMs(m.blueEndMs, m.goldenEndMs);
        assertApprox(bhDur, 26, 10, 'CPH summer morning BH duration ~26 min');

        // Morning arc in the NE sky
        check(m.azimuthAt6 >= 35 && m.azimuthAt6 <= 60,
            `CPH summer morning azimuthAt6 ${m.azimuthAt6.toFixed(1)}° (expected NE 35-60°)`);
    }

    if (arc.evening) {
        const e = arc.evening;
        // Times in chronological order: goldenStart < goldenEnd < blueEnd
        check(e.goldenStartMs < e.goldenEndMs && e.goldenEndMs < e.blueEndMs,
            'CPH summer evening — times in chronological order');

        // +6° crossing time: ~18:53 UTC (sunset 19:57 minus ~64 min from old test)
        assertApprox(utcMinMs(e.goldenStartMs), 18 * 60 + 53, 10,
            'CPH summer evening goldenStart ~18:53 UTC');

        // -6° crossing: sunset + ~61 min
        assertApprox(utcMinMs(e.blueEndMs), 20 * 60 + 58, 10,
            'CPH summer evening blueEnd ~20:58 UTC');

        // Evening arc in the NW sky
        check(e.azimuthAt6 >= 295 && e.azimuthAt6 <= 325,
            `CPH summer evening azimuthAt6 ${e.azimuthAt6.toFixed(1)}° (expected NW 295-325°)`);
        check(e.azimuthAtMinus6 >= 315 && e.azimuthAtMinus6 <= 345,
            `CPH summer evening azimuthAtMinus6 ${e.azimuthAtMinus6.toFixed(1)}° (expected NNW 315-345°)`);

        // Arc continuity: azimuth sweeps across a range
        const span = Math.abs(e.azimuthAtMinus6 - e.azimuthAt6);
        check(span > 5 && span < 60,
            `CPH summer evening arc span ${span.toFixed(1)}° (expected 5-60°)`);
    }
}

// ── lightArc: arc continuity and boundary match ───────────────────────────────
console.log('\n── lightArc: arc continuity ──');
{
    const d   = new Date(Date.UTC(2026, 2, 20));  // equinox
    const arc = lightArc(55.68, 12.57, d);
    if (arc.evening) {
        const e = arc.evening;
        // goldenEnd time and azimuthAtMinus4 represent the same moment (-4° crossing)
        // Verify times are consistent (goldenEnd is strictly between goldenStart and blueEnd)
        check(e.goldenStartMs < e.goldenEndMs, 'Evening: goldenStart < goldenEnd');
        check(e.goldenEndMs < e.blueEndMs,     'Evening: goldenEnd < blueEnd');
    }
}

// ── lightArc: Copenhagen winter solstice ──────────────────────────────────────
console.log('\n── lightArc: Copenhagen winter solstice 2026 ──');
{
    const d   = new Date(Date.UTC(2026, 11, 21));
    const arc = lightArc(55.68, 12.57, d);

    check(arc.morning !== null, 'CPH winter — morning arc exists');
    check(arc.evening !== null, 'CPH winter — evening arc exists');

    if (arc.morning && arc.evening) {
        // Winter: SE morning, SW evening
        check(arc.morning.azimuthAt6 >= 115 && arc.morning.azimuthAt6 <= 160,
            `CPH winter morning azimuthAt6 ${arc.morning.azimuthAt6.toFixed(1)}° (expected SE 115-160°)`);
        check(arc.evening.azimuthAt6 >= 200 && arc.evening.azimuthAt6 <= 245,
            `CPH winter evening azimuthAt6 ${arc.evening.azimuthAt6.toFixed(1)}° (expected SW 200-245°)`);
    }
}

// ── lightArc: Equator equinox ─────────────────────────────────────────────────
console.log('\n── lightArc: Equator equinox ──');
{
    const d   = new Date(Date.UTC(2026, 2, 20));
    const arc = lightArc(0, 0, d);

    check(arc.morning !== null, 'Equator — morning arc exists');
    check(arc.evening !== null, 'Equator — evening arc exists');

    if (arc.evening) {
        // At equinox, sun rises/sets nearly due E/W
        assertApprox(arc.evening.azimuthAt6, 270, 8, 'Equator evening azimuthAt6 ~270° (W)');

        // Arc spans narrow at equator (sun moves steeply)
        if (arc.evening.azimuthAt6 !== null && arc.evening.azimuthAtMinus6 !== null) {
            const span = Math.abs(arc.evening.azimuthAtMinus6 - arc.evening.azimuthAt6);
            check(span < 20, `Equator arc span ${span.toFixed(1)}° (expected narrow <20°)`);
        }
    }
}

// ── lightArc: Polar edge cases ────────────────────────────────────────────────
console.log('\n── lightArc: polar edge cases ──');
{
    // Tromsø June: polar day — sun never drops below +6°, so no golden/blue boundaries
    const d   = new Date(Date.UTC(2026, 5, 21));
    const arc = lightArc(69.65, 18.96, d);
    // During polar day the sun stays above +6°, so minus4/minus6 crossings don't exist
    // Either arc is null (sun never reaches any boundary) or partial
    check(arc !== null, 'Tromsø June — lightArc does not throw');
    // Evening blue hour should not exist (sun doesn't drop to -4°)
    const eveningHasBlue = arc.evening && arc.evening.blueEndMs !== null;
    check(!eveningHasBlue, 'Tromsø June — no evening blue hour (polar day)');
}
{
    // Tromsø December: polar night — sun never rises
    const d   = new Date(Date.UTC(2026, 11, 21));
    const arc = lightArc(69.65, 18.96, d);
    check(arc !== null, 'Tromsø December — lightArc does not throw');
    // Sun crosses -4°/-6° twilight zone but never reaches +6° — arcs exist but golden portion is null
    if (arc.morning) check(arc.morning.azimuthAt6 === null, 'Tromsø December morning — no azimuthAt6 (sun below +6°)');
    if (arc.evening) check(arc.evening.azimuthAt6 === null, 'Tromsø December evening — no azimuthAt6 (sun below +6°)');
    check(arc !== null, 'Tromsø December — lightArc handles polar night gracefully');
}

// ── sunPosition ───────────────────────────────────────────────────────────────
console.log('\n── sunPosition ──');
{
    const noon = new Date(Date.UTC(2026, 5, 21, 11, 11, 0));
    const pos  = sunPosition(55.68, 12.57, noon);
    assertApprox(pos.azimuth,   180,  6, 'CPH solar noon azimuth ~180° (S)');
    assertApprox(pos.elevation, 57.7, 2, 'CPH solar noon elevation ~57.7°');
}
{
    const midnight = new Date(Date.UTC(2026, 11, 21, 0, 0, 0));
    const pos = sunPosition(55.68, 12.57, midnight);
    check(pos.elevation < -30, `CPH winter midnight elevation ${pos.elevation.toFixed(1)}° (< -30°)`);
}

// ── nextEvents ────────────────────────────────────────────────────────────────
console.log('\n── nextEvents ──');
{
    // During evening golden hour: first event should be active
    const d   = new Date(Date.UTC(2026, 5, 21));
    const arc = lightArc(55.68, 12.57, d);
    if (arc.evening && arc.evening.goldenStartMs && arc.evening.goldenEndMs) {
        const midGH  = arc.evening.goldenStartMs + 10 * 60000;
        const evs    = nextEvents(55.68, 12.57, new Date(midGH));
        check(evs.length > 0, 'nextEvents during GH — returns events');
        check(evs[0].type === "golden" && evs[0].startMs <= midGH,
            'First event is active golden (start in past)');
    }
}
{
    // Late at night: wraps to tomorrow
    const lateNight = new Date(Date.UTC(2026, 5, 21, 23, 0, 0));
    const evs = nextEvents(55.68, 12.57, lateNight);
    check(evs.length > 0, 'nextEvents late at night — returns events');
    check(evs[0].startMs > lateNight.getTime(), 'First event is in the future');
}
{
    // Afternoon: should have both golden and blue upcoming
    const now = new Date(Date.UTC(2026, 2, 20, 14, 0, 0));
    const evs = nextEvents(55.68, 12.57, now);
    check(evs.some(e => e.type === "golden"), 'nextEvents includes golden');
    check(evs.some(e => e.type === "blue"),   'nextEvents includes blue');
    check(evs.length <= 4,                    'nextEvents returns at most 4');
    // Events sorted chronologically
    for (let i = 1; i < evs.length; i++) {
        check(evs[i].startMs >= evs[i-1].startMs, `Events[${i-1}→${i}] in chronological order`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) console.error('\nSome tests FAILED.');
else            console.log('\nAll tests passed.');
