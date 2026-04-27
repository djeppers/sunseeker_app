import {} from "piu/MC";
import Compass from "embedded:sensor/Compass";
import Location from "embedded:sensor/Location";
import Button from "pebble/button";
import { lightArc } from "sun";

// ── Screen geometry ───────────────────────────────────────────────────────────
const W       = screen.width;
const H       = screen.height;
const IS_ROUND = W === H;
const CX      = W >> 1;
const RING_R  = Math.round(Math.min(W, H) * 0.36) | 0;
const CY      = IS_ROUND ? (H >> 1) : Math.round(H * 0.40) | 0;
const PANEL_Y = CY + RING_R + 8;

// ── Colors (one object = one slot instead of 11) ──────────────────────────────
const C = {
    BG:      "#000000",
    PANEL:   "#181818",
    RING:    "#303030",
    TICK_HI: "#FFFFFF",
    TICK_LO: "#404040",
    NORTH:   "#FF3030",
    CARD:    "#FFFFFF",
    TEXT:    "#FFFFFF",
    DIM:     "#686868",
    GOLDEN:  "#F0A030",
    BLUE:    "#4068C8",
};

// ── Font (one Style object instead of two) ────────────────────────────────────
const F_SM = new Style({ font: "bold 14px Gothic" });

// ── Demo mode ─────────────────────────────────────────────────────────────────
const DEMO      = true;
const DEMO_LAT  = 55.68;
const DEMO_LON  = 12.57;
const DEMO_HEAD = 315;
// Demo date as ms-since-epoch avoids a module-level Date object
const DEMO_MS   = Date.UTC(2026, 2, 13, 15, 0, 0);

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    heading:      0,
    lat:          null,
    lon:          null,
    located:      false,
    arc:          null,
    events:       [],
    nextGolden:   null,
    nextBlue:     null,
    goldenActive: false,
    blueActive:   false,
    fmtGolden:    "--",
    fmtBlue:      "--",
    zoom:         false,
    zoomCenter:   0,
    view:         "clock",
};

let port = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const RAD_C = Math.PI / 180;
const _pos  = { x: 0, y: 0 };

function ringPos(bearing, r) {
    const delta = ((bearing - state.heading) % 360 + 360) % 360;
    const a = delta * RAD_C;
    _pos.x = CX + Math.round(r * Math.sin(a));
    _pos.y = CY - Math.round(r * Math.cos(a));
    return _pos;
}

function fillCircle(p, cx, cy, r, color) {
    for (let dy = -r; dy <= r; dy++) {
        const dx = Math.round(Math.sqrt(r * r - dy * dy));
        p.fillColor(color, cx - dx, cy + dy, dx * 2 + 1, 1);
    }
}

// Gradient arc from azimuthAt6 → azimuthAtMinus6 with dithered amber→blue blend.
function drawGradientArc(p, az6, azM4, azM6, r) {
    const arcStart = az6  !== null ? az6  : azM4;
    const arcEnd   = azM6 !== null ? azM6 : azM4;
    if (arcStart === null || arcEnd === null) return;

    const cwSpan = ((arcEnd - arcStart) + 360) % 360;
    const cw     = cwSpan <= 180;
    const total  = cw ? cwSpan : 360 - cwSpan;

    let m4Offset = null;
    if (azM4 !== null && az6 !== null) {
        const s = ((azM4 - arcStart) + 360) % 360;
        m4Offset = cw ? s : 360 - s;
    }

    const DITHER = 2;
    const DOT    = 3;

    const startColor = az6  !== null ? C.GOLDEN : C.BLUE;
    const endColor   = azM6 !== null ? C.BLUE   : C.GOLDEN;
    ringPos(arcStart, r);
    if (_pos.x > -100) p.fillColor(startColor, _pos.x - DOT - 1, _pos.y - DOT - 1, (DOT + 1) * 2 + 1, (DOT + 1) * 2 + 1);
    ringPos(arcEnd, r);
    if (_pos.x > -100) p.fillColor(endColor, _pos.x - DOT - 1, _pos.y - DOT - 1, (DOT + 1) * 2 + 1, (DOT + 1) * 2 + 1);

    for (let i = 0; i <= total; i += 2) {
        const az = cw ? (arcStart + i + 360) % 360 : (arcStart - i + 360) % 360;
        ringPos(az, r);
        if (_pos.x < -100) continue;
        let color;
        if (m4Offset === null)             color = az6 !== null ? C.GOLDEN : C.BLUE;
        else if (i < m4Offset - DITHER)    color = C.GOLDEN;
        else if (i > m4Offset + DITHER)    color = C.BLUE;
        else                               color = (i >> 1) % 2 === 0 ? C.GOLDEN : C.BLUE;
        p.fillColor(color, _pos.x - DOT, _pos.y - DOT, DOT * 2 + 1, DOT * 2 + 1);
    }
}

// ── Event extraction ──────────────────────────────────────────────────────────
function eventsFromArc(arc, nowMs) {
    const ev = [];
    if (arc.morning) {
        const { goldenStartMs: p6, goldenEndMs: m4, blueEndMs: m6 } = arc.morning;
        if (m6 !== null && m4 !== null) ev.push({ type: "blue",   phase: "morning", startMs: m6, endMs: m4 });
        if (m4 !== null && p6 !== null) ev.push({ type: "golden", phase: "morning", startMs: m4, endMs: p6 });
    }
    if (arc.evening) {
        const { goldenStartMs: p6, goldenEndMs: m4, blueEndMs: m6 } = arc.evening;
        if (p6 !== null && m4 !== null) ev.push({ type: "golden", phase: "evening", startMs: p6, endMs: m4 });
        if (m4 !== null && m6 !== null) ev.push({ type: "blue",   phase: "evening", startMs: m4, endMs: m6 });
    }
    ev.sort((a, b) => a.startMs - b.startMs);
    return ev.filter(e => e.endMs > nowMs);
}

// ── State calculation ─────────────────────────────────────────────────────────
function fmtCountdown(event, nowMs) {
    if (!event) return "--";
    const tillEnd   = event.endMs   - nowMs;
    const tillStart = event.startMs - nowMs;
    if (tillEnd <= 0) return "--";
    if (tillStart <= 0) {
        const m = Math.ceil(tillEnd / 60000);
        return m >= 60 ? `NOW ${Math.floor(m / 60)}h${m % 60}m` : `NOW ${m}m`;
    }
    const m   = Math.floor(tillStart / 60000);
    const h   = Math.floor(m / 60);
    const min = m % 60;
    if (((event.startMs / 86400000) | 0) !== ((nowMs / 86400000) | 0)) {
        // "tmrw HH:MM" — compute without new Date
        const utcMin = (event.startMs / 60000 | 0) % 1440;
        const hh = (utcMin / 60 | 0), mm = utcMin % 60;
        return `tmrw ${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;
    }
    return h > 0 ? `in ${h}h${min < 10 ? "0" : ""}${min}m` : `in ${m}m`;
}

function calcState() {
    if (state.lat === null) return;
    const nowMs = DEMO ? DEMO_MS : Date.now();
    const now   = new Date(nowMs);

    state.arc    = lightArc(state.lat, state.lon, now);
    state.events = eventsFromArc(state.arc, nowMs);

    if (state.events.length < 2) {
        const tmrw    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const tmrwArc = lightArc(state.lat, state.lon, tmrw);
        const tmrwEv  = eventsFromArc(tmrwArc, nowMs);
        for (const e of tmrwEv) { if (state.events.length < 4) state.events.push(e); }
    }

    state.nextGolden   = state.events.find(e => e.type === "golden") || null;
    state.nextBlue     = state.events.find(e => e.type === "blue")   || null;
    state.goldenActive = state.nextGolden !== null && state.nextGolden.startMs <= nowMs;
    state.blueActive   = state.nextBlue   !== null && state.nextBlue.startMs   <= nowMs;
    state.fmtGolden    = fmtCountdown(state.nextGolden, nowMs);
    state.fmtBlue      = fmtCountdown(state.nextBlue,   nowMs);

    if (state.zoom) state.zoomCenter = computeZoomCenter();
}

function computeZoomCenter() {
    const ev = state.events[0];
    if (ev && state.arc) {
        const half = ev.phase === "evening" ? state.arc.evening : state.arc.morning;
        if (half) {
            const a = half.azimuthAt6 !== null ? half.azimuthAt6 : half.azimuthAtMinus4;
            const b = half.azimuthAtMinus6 !== null ? half.azimuthAtMinus6 : half.azimuthAtMinus4;
            if (a !== null && b !== null) {
                const diff = ((b - a) + 360) % 360;
                return diff <= 180 ? (a + diff / 2 + 360) % 360 : (a - (360 - diff) / 2 + 360) % 360;
            }
            if (a !== null) return a;
            if (b !== null) return b;
        }
    }
    if (state.arc) {
        const e = state.arc.evening, m = state.arc.morning;
        if (e && e.azimuthAtMinus4 !== null) return e.azimuthAtMinus4;
        if (m && m.azimuthAtMinus4 !== null) return m.azimuthAtMinus4;
    }
    return 270;
}

function saveLocation(lat, lon) {
    try { localStorage.setItem("loc", JSON.stringify({ lat, lon })); } catch (_) {}
}

function loadLocation() {
    try {
        const raw = localStorage.getItem("loc");
        if (!raw) return;
        const { lat, lon } = JSON.parse(raw);
        state.lat = lat; state.lon = lon; state.located = true;
        calcState();
    } catch (_) {}
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function drawTimerRows(p, x, y1, y2) {
    p.fillColor(C.GOLDEN, x, y1 + 4, 6, 6);
    p.drawString("Golden", F_SM, C.TEXT, x + 10, y1);
    p.drawString(state.fmtGolden, F_SM, state.goldenActive ? C.GOLDEN : C.TEXT, x + 68, y1);

    p.fillColor(C.BLUE, x, y2 + 4, 6, 6);
    p.drawString("Blue", F_SM, C.TEXT, x + 10, y2);
    p.drawString(state.fmtBlue, F_SM, state.blueActive ? C.BLUE : C.TEXT, x + 68, y2);
}

function drawCompassView(p) {
    p.fillColor(C.BG, 0, 0, W, H);

    const ringW = 5;
    fillCircle(p, CX, CY, RING_R, C.RING);
    fillCircle(p, CX, CY, RING_R - ringW, C.BG);

    const arcR = RING_R - 2;
    if (state.arc) {
        if (state.arc.morning) {
            const m = state.arc.morning;
            drawGradientArc(p, m.azimuthAt6, m.azimuthAtMinus4, m.azimuthAtMinus6, arcR);
        }
        if (state.arc.evening) {
            const e = state.arc.evening;
            drawGradientArc(p, e.azimuthAt6, e.azimuthAtMinus4, e.azimuthAtMinus6, arcR);
        }
    }

    if (state.zoom) {
        for (let b = 0; b < 360; b += 10) {
            const isMaj = b % 90 === 0;
            const { x, y } = ringPos(b, RING_R - ringW - 1);
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C.TICK_HI : C.TICK_LO, x - (sz >> 1), y - (sz >> 1), sz, sz);
        }
    } else {
        for (let b = 0; b < 360; b += 30) {
            const isMaj = b % 90 === 0;
            const { x, y } = ringPos(b, RING_R - ringW - 1);
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C.TICK_HI : C.TICK_LO, x - (sz >> 1), y - (sz >> 1), sz, sz);
        }
        ringPos(0,   RING_R - 22); p.drawString("N", F_SM, C.NORTH, _pos.x - 5, _pos.y - 8);
        ringPos(90,  RING_R - 22); p.drawString("E", F_SM, C.CARD,  _pos.x - 5, _pos.y - 8);
        ringPos(180, RING_R - 22); p.drawString("S", F_SM, C.CARD,  _pos.x - 5, _pos.y - 8);
        ringPos(270, RING_R - 22); p.drawString("W", F_SM, C.CARD,  _pos.x - 5, _pos.y - 8);
    }

    // Fixed pointer triangle at 12 o'clock
    const tip = CY - RING_R - 2;
    p.fillColor(C.TEXT, CX - 4, tip - 8, 8, 3);
    p.fillColor(C.TEXT, CX - 3, tip - 5, 6, 3);
    p.fillColor(C.TEXT, CX - 2, tip - 2, 4, 3);
    p.fillColor(C.TEXT, CX - 1, tip,     2, 3);

    // Timer area
    if (IS_ROUND) {
        if (!state.located) { p.drawString("Locating...", F_SM, C.DIM, CX - 36, CY - 8); return; }
        if (state.zoom) {
            const diff = ((state.zoomCenter - state.heading) % 360 + 360) % 360;
            const deg  = diff > 180 ? diff - 360 : diff;
            const abs  = Math.abs(Math.round(deg));
            const str  = abs <= 2 ? "Aligned!" : `${abs}deg ${deg > 0 ? "R" : "L"}`;
            p.drawString("ZOOM", F_SM, C.GOLDEN, CX - 18, CY - 10);
            p.drawString(str, F_SM, str === "Aligned!" ? C.GOLDEN : C.TEXT, CX - 26, CY + 4);
        } else {
            drawTimerRows(p, CX - 52, CY - 12, CY + 6);
        }
    } else {
        p.fillColor(C.PANEL, 0, PANEL_Y, W, H - PANEL_Y);
        if (!state.located) { p.drawString("Locating...", F_SM, C.DIM, 6, PANEL_Y + 8); return; }
        if (state.zoom) {
            const diff = ((state.zoomCenter - state.heading) % 360 + 360) % 360;
            const deg  = diff > 180 ? diff - 360 : diff;
            const abs  = Math.abs(Math.round(deg));
            const str  = abs <= 2 ? "Aligned!" : `${abs}deg ${deg > 0 ? "R" : "L"}`;
            p.drawString("ZOOM", F_SM, C.GOLDEN, 6, PANEL_Y + 6);
            p.drawString(str, F_SM, str === "Aligned!" ? C.GOLDEN : C.TEXT, 52, PANEL_Y + 4);
        } else {
            drawTimerRows(p, 6, PANEL_Y + 6, PANEL_Y + 26);
        }
    }
}

// ── 24-hour clock view ────────────────────────────────────────────────────────
// Inner helpers (clockDeg, clockArc, Bresenham line) live inside this function
// so they consume zero module-level closure slots.
function drawClockView(p) {
    p.fillColor(C.BG, 0, 0, W, H);
    const ringW = 4;
    fillCircle(p, CX, CY, RING_R, C.RING);
    fillCircle(p, CX, CY, RING_R - ringW, C.BG);

    // UTC ms → 24h clock angle: noon=0°, 6pm=90°, midnight=180°, 6am=270°
    // Pure integer arithmetic — no Date objects, no float chunk allocations.
    function clockDeg(ms) {
        return (((ms / 60000 | 0) % 1440 - 720 >> 2) + 360) % 360;
    }

    // Draw golden+blue arc at absolute clock-angle positions (not heading-relative).
    const arcR = RING_R - 2;
    function clockArc(az6, azM4, azM6) {
        const arcStart = az6  !== null ? az6  : azM4;
        const arcEnd   = azM6 !== null ? azM6 : azM4;
        if (arcStart === null || arcEnd === null) return;
        const cwSpan = ((arcEnd - arcStart) + 360) % 360;
        const cw     = cwSpan <= 180;
        const total  = cw ? cwSpan : 360 - cwSpan;
        let m4Offset = null;
        if (azM4 !== null && az6 !== null) {
            const s = ((azM4 - arcStart) + 360) % 360;
            m4Offset = cw ? s : 360 - s;
        }
        const DITHER = 1, DOT = 3;
        const startColor = az6  !== null ? C.GOLDEN : C.BLUE;
        const endColor   = azM6 !== null ? C.BLUE   : C.GOLDEN;
        {
            const a = arcStart * RAD_C;
            const sx = CX + Math.round(arcR * Math.sin(a));
            const sy = CY - Math.round(arcR * Math.cos(a));
            p.fillColor(startColor, sx - DOT - 1, sy - DOT - 1, (DOT + 1) * 2 + 1, (DOT + 1) * 2 + 1);
        }
        {
            const a = arcEnd * RAD_C;
            const ex = CX + Math.round(arcR * Math.sin(a));
            const ey = CY - Math.round(arcR * Math.cos(a));
            p.fillColor(endColor, ex - DOT - 1, ey - DOT - 1, (DOT + 1) * 2 + 1, (DOT + 1) * 2 + 1);
        }
        for (let i = 0; i <= total; i += 2) {
            const az = cw ? (arcStart + i + 360) % 360 : (arcStart - i + 360) % 360;
            const a  = az * RAD_C;
            const x  = CX + Math.round(arcR * Math.sin(a));
            const y  = CY - Math.round(arcR * Math.cos(a));
            let color;
            if (m4Offset === null)             color = az6 !== null ? C.GOLDEN : C.BLUE;
            else if (i < m4Offset - DITHER)    color = C.GOLDEN;
            else if (i > m4Offset + DITHER)    color = C.BLUE;
            else                               color = (i >> 1) % 2 === 0 ? C.GOLDEN : C.BLUE;
            p.fillColor(color, x - DOT, y - DOT, DOT * 2 + 1, DOT * 2 + 1);
        }
    }

    // Event arcs (morning left/top, evening right)
    if (state.arc) {
        if (state.arc.morning) {
            const m = state.arc.morning;
            clockArc(
                m.goldenStartMs !== null ? clockDeg(m.goldenStartMs) : null,
                m.goldenEndMs   !== null ? clockDeg(m.goldenEndMs)   : null,
                m.blueEndMs     !== null ? clockDeg(m.blueEndMs)     : null
            );
        }
        if (state.arc.evening) {
            const e = state.arc.evening;
            clockArc(
                e.goldenStartMs !== null ? clockDeg(e.goldenStartMs) : null,
                e.goldenEndMs   !== null ? clockDeg(e.goldenEndMs)   : null,
                e.blueEndMs     !== null ? clockDeg(e.blueEndMs)     : null
            );
        }
    }

    // Hour ticks every 15° (1h), major every 90° (6h)
    const tickR = RING_R - ringW - 1;
    for (let h = 0; h < 24; h++) {
        const deg = ((h - 12) * 15 + 360) % 360;
        const a   = deg * RAD_C;
        const tx  = CX + Math.round(tickR * Math.sin(a));
        const ty  = CY - Math.round(tickR * Math.cos(a));
        const isMaj = h % 6 === 0;
        const sz = isMaj ? 4 : 2;
        p.fillColor(isMaj ? C.TICK_HI : C.TICK_LO, tx - (sz >> 1), ty - (sz >> 1), sz, sz);
    }

    // Labels at 6h positions — sin/cos of 0°/90°/180°/270° are ±1 or 0, no trig needed
    const labelR = RING_R - 20;
    p.drawString("12p", F_SM, C.DIM, CX - 12,         CY - labelR - 7);
    p.drawString("6p",  F_SM, C.DIM, CX + labelR - 9, CY - 7);
    p.drawString("12a", F_SM, C.DIM, CX - 12,         CY + labelR - 7);
    p.drawString("6a",  F_SM, C.DIM, CX - labelR - 9, CY - 7);

    // Current time hand — Bresenham line from center to ring
    const nowDeg = clockDeg(DEMO ? DEMO_MS : Date.now());
    const hR  = RING_R - ringW - 6;
    const hRa = nowDeg * RAD_C;
    const hx  = CX + Math.round(hR * Math.sin(hRa));
    const hy  = CY - Math.round(hR * Math.cos(hRa));
    {
        let ldx = Math.abs(hx - CX), ldy = Math.abs(hy - CY);
        const sx = CX < hx ? 1 : -1, sy = CY < hy ? 1 : -1;
        let err = ldx - ldy, lx = CX, ly = CY;
        for (;;) {
            p.fillColor(C.TEXT, lx - 1, ly - 1, 3, 3);
            if (lx === hx && ly === hy) break;
            const e2 = 2 * err;
            if (e2 > -ldy) { err -= ldy; lx += sx; }
            if (e2 <  ldx) { err += ldx; ly += sy; }
        }
    }
    p.fillColor(C.TEXT, CX - 2, CY - 2, 5, 5);

    // Timer panel
    if (IS_ROUND) {
        if (!state.located) { p.drawString("Locating...", F_SM, C.DIM, CX - 36, CY - 8); return; }
        drawTimerRows(p, CX - 52, CY - 12, CY + 6);
    } else {
        p.fillColor(C.PANEL, 0, PANEL_Y, W, H - PANEL_Y);
        if (!state.located) { p.drawString("Locating...", F_SM, C.DIM, 6, PANEL_Y + 8); return; }
        drawTimerRows(p, 6, PANEL_Y + 6, PANEL_Y + 26);
    }
}

// ── Port behavior ─────────────────────────────────────────────────────────────
class PortBehavior {
    onCreate(content) { port = content; }
    onDraw(p) {
        if (state.view === "clock") drawClockView(p);
        else                        drawCompassView(p);
    }
}

// ── Location fetch ────────────────────────────────────────────────────────────
let gps = null;

function doLocationFetch(force = false) {
    if (gps !== null) {
        if (!force) return;
        try { gps.close(); } catch (_) {}
        gps = null;
    }
    gps = new Location({
        onSample: () => {
            const pos = gps.sample();
            state.lat = pos.latitude; state.lon = pos.longitude; state.located = true;
            calcState(); saveLocation(pos.latitude, pos.longitude);
            if (port) port.invalidate();
            gps.close(); gps = null;
        },
        onError: () => { try { gps.close(); } catch (_) {} gps = null; },
    });
    gps.configure({ enableHighAccuracy: false, timeout: 15000, maximumAge: force ? 0 : 300000 });
}

// ── App behavior ──────────────────────────────────────────────────────────────
class AppBehavior {
    onCreate(app) {
        if (DEMO) {
            state.lat = DEMO_LAT; state.lon = DEMO_LON;
            state.heading = DEMO_HEAD; state.located = true;
            calcState();
            if (port) port.invalidate();
        } else {
            loadLocation();
            if (port) port.invalidate();

            const compass = new Compass({
                onSample: () => {
                    const { heading } = compass.sample();
                    if (state.heading !== heading) {
                        state.heading = heading;
                        if (port) port.invalidate();
                    }
                }
            });

            doLocationFetch();
            setInterval(doLocationFetch, 600000);
            setInterval(() => { calcState(); if (port) port.invalidate(); }, 60000);
        }

        new Button({
            types: ["up", "select"],
            onPush(down, type) {
                if (!down) return;
                if (type === "up") {
                    state.view = state.view === "clock" ? "compass" : "clock";
                    if (port) port.invalidate();
                } else if (type === "select" && !DEMO) {
                    doLocationFetch(true);
                }
            }
        });
    }
}

// ── Application ───────────────────────────────────────────────────────────────
const SunSeeker = Application.template($ => ({
    skin: new Skin({ fill: C.BG }),
    Behavior: AppBehavior,
    contents: [Port($, { top: 0, bottom: 0, left: 0, right: 0, Behavior: PortBehavior })],
}));

export default new SunSeeker(null, { displayListLength: 8192, touchCount: 0, pixels: W * 4 });
