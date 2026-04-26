import {} from "piu/MC";
import Compass from "embedded:sensor/Compass";
import Location from "embedded:sensor/Location";
import Button from "pebble/button";
import { lightArc, nextEvents } from "sun";

// ── Screen geometry ───────────────────────────────────────────────────────────
const W       = screen.width;
const H       = screen.height;
const IS_ROUND = W === H;
const CX      = W >> 1;
const RING_R  = Math.round(Math.min(W, H) * 0.36) | 0;
const CY      = IS_ROUND ? (H >> 1) : Math.round(H * 0.40) | 0;
const PANEL_Y = CY + RING_R + 8;

// ── Colors ────────────────────────────────────────────────────────────────────
const C_BG      = "#000000";
const C_PANEL   = "#181818";
const C_RING    = "#303030";
const C_TICK_HI = "#FFFFFF";
const C_TICK_LO = "#404040";
const C_NORTH   = "#FF3030";
const C_CARD    = "#FFFFFF";
const C_TEXT    = "#FFFFFF";
const C_DIM     = "#686868";
const C_GOLDEN  = "#F0A030";
const C_BLUE    = "#4068C8";

// ── Fonts ─────────────────────────────────────────────────────────────────────
const F_SM = new Style({ font: "bold 14px Gothic" });
const F_MD = new Style({ font: "bold 18px Gothic" });

// ── Demo mode (set DEMO = false for real device use) ──────────────────────────
const DEMO         = true;
const DEMO_LAT     = 55.68;
const DEMO_LON     = 12.57;
const DEMO_HEADING = 315;
const DEMO_DATE    = new Date(2026, 2, 13, 15, 0, 0);

// ── Zoom ──────────────────────────────────────────────────────────────────────
const ZOOM_FACTOR = 4;  // 4x = ±45° FOV

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    heading:      0,
    lat:          null,
    lon:          null,
    located:      false,
    arc:          null,   // lightArc() result
    events:       [],     // nextEvents() result
    // Pre-computed each calcState so draw functions allocate nothing:
    nextGolden:   null,
    nextBlue:     null,
    goldenActive: false,
    blueActive:   false,
    fmtGolden:    "--",
    fmtBlue:      "--",
    zoom:         false,
    zoomCenter:   0,
};

let port = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const RAD_C = Math.PI / 180;

// Reuse a single object — callers must read x/y before the next ringPos call.
const _pos = { x: 0, y: 0 };

function ringPos(bearing, r) {
    let delta = ((bearing - state.heading) % 360 + 360) % 360;
    if (delta > 180) delta -= 360;
    if (state.zoom) {
        // Heading stays at 12 o'clock — just magnify so arcs approach top as you rotate toward them.
        delta *= ZOOM_FACTOR;
        if (Math.abs(delta) > 180) { _pos.x = -9999; _pos.y = -9999; return _pos; }
    }
    const a = ((delta % 360) + 360) % 360 * RAD_C;
    _pos.x = CX + Math.round(r * Math.sin(a));
    _pos.y = CY - Math.round(r * Math.cos(a));
    return _pos;
}

function arcMidAz(half) {
    if (!half) return null;
    const a = half.azimuthAt6 !== null ? half.azimuthAt6 : half.azimuthAtMinus4;
    const b = half.azimuthAtMinus6 !== null ? half.azimuthAtMinus6 : half.azimuthAtMinus4;
    if (a === null || b === null) return a ?? b;
    const diff = ((b - a) + 360) % 360;
    return diff <= 180 ? (a + diff / 2 + 360) % 360 : (a - (360 - diff) / 2 + 360) % 360;
}

function computeZoomCenter() {
    const ev = state.events[0];
    if (ev && state.arc) {
        const mid = arcMidAz(ev.phase === "evening" ? state.arc.evening : state.arc.morning);
        if (mid !== null) return mid;
    }
    return arcMidAz(state.arc?.evening) ?? arcMidAz(state.arc?.morning) ?? 270;
}

function fmtTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fillCircle(p, cx, cy, r, color) {
    for (let dy = -r; dy <= r; dy++) {
        const dx = Math.round(Math.sqrt(r * r - dy * dy));
        p.fillColor(color, cx - dx, cy + dy, dx * 2 + 1, 1);
    }
}

// Gradient arc from azimuthAt6 → azimuthAtMinus6, with amber→blue dither at azimuthAtMinus4.
// Any azimuth argument may be null (partial arc rendered gracefully).
function drawGradientArc(p, az6, azM4, azM6, r) {
    const arcStart = az6  !== null ? az6  : azM4;
    const arcEnd   = azM6 !== null ? azM6 : azM4;
    if (arcStart === null || arcEnd === null) return;

    // Shorter-path direction
    const cwSpan = ((arcEnd - arcStart) + 360) % 360;
    const cw     = cwSpan <= 180;
    const total  = cw ? cwSpan : 360 - cwSpan;

    // Position of the -4° boundary within the arc (in step units)
    let m4Offset = null;
    if (azM4 !== null && az6 !== null) {
        const s = ((azM4 - arcStart) + 360) % 360;
        m4Offset = cw ? s : 360 - s;
    }

    const DITHER = 1;  // degrees of dither zone on each side of the -4° boundary

    for (let i = 0; i <= total; i += 2) {
        const az = cw ? (arcStart + i + 360) % 360 : (arcStart - i + 360) % 360;
        const { x, y } = ringPos(az, r);
        if (x < -100) continue;

        let color;
        if (m4Offset === null) {
            color = az6 !== null ? C_GOLDEN : C_BLUE;
        } else if (i < m4Offset - DITHER) {
            color = C_GOLDEN;
        } else if (i > m4Offset + DITHER) {
            color = C_BLUE;
        } else {
            color = (i >> 1) % 2 === 0 ? C_GOLDEN : C_BLUE;  // dither alternation
        }
        p.fillColor(color, x - 3, y - 3, 7, 7);
    }
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
    // Day comparison via integer UTC-day arithmetic (no Date allocation)
    if (((event.startMs / 86400000) | 0) !== ((nowMs / 86400000) | 0))
        return `tmrw ${fmtTime(event.startMs)}`;
    return h > 0 ? `in ${h}h${min < 10 ? "0" : ""}${min}m` : `in ${m}m`;
}

function calcState() {
    if (state.lat === null) return;
    const now   = DEMO ? DEMO_DATE : new Date();
    const nowMs = now instanceof Date ? now.getTime() : now;
    state.arc    = lightArc(state.lat, state.lon, now);
    state.events = nextEvents(state.lat, state.lon, now);
    state.nextGolden   = state.events.find(e => e.type === "golden") || null;
    state.nextBlue     = state.events.find(e => e.type === "blue")   || null;
    state.goldenActive = state.nextGolden !== null && state.nextGolden.startMs <= nowMs;
    state.blueActive   = state.nextBlue   !== null && state.nextBlue.startMs   <= nowMs;
    state.fmtGolden    = fmtCountdown(state.nextGolden, nowMs);
    state.fmtBlue      = fmtCountdown(state.nextBlue,   nowMs);
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

function redraw() { if (port) port.invalidate(); }

// ── Drawing ───────────────────────────────────────────────────────────────────
function drawCompassView(p) {
    p.fillColor(C_BG, 0, 0, W, H);

    // Circular ring
    const ringW = 5;
    fillCircle(p, CX, CY, RING_R, C_RING);
    fillCircle(p, CX, CY, RING_R - ringW, C_BG);

    // Gradient arcs (amber→blue with dither at the -4° boundary)
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
        // Fine tick marks every 5° (only those in ±45° FOV are on-screen)
        for (let b = 0; b < 360; b += 5) {
            const { x, y } = ringPos(b, RING_R - ringW - 1);
            if (x < -100 || x > W) continue;
            const isMaj = b % 45 === 0;
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C_TICK_HI : C_TICK_LO, x - (sz >> 1), y - (sz >> 1), sz, sz);
        }
        // Normal pointer at 12 o'clock — heading is always at top in zoom mode
        const tip = CY - RING_R - 2;
        p.fillColor(C_TEXT, CX - 4, tip - 8, 8, 3);
        p.fillColor(C_TEXT, CX - 3, tip - 5, 6, 3);
        p.fillColor(C_TEXT, CX - 2, tip - 2, 4, 3);
        p.fillColor(C_TEXT, CX - 1, tip,     2, 3);
    } else {
        // Tick marks every 30°
        for (let b = 0; b < 360; b += 30) {
            const isMaj = b % 90 === 0;
            const { x, y } = ringPos(b, RING_R - ringW - 1);
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C_TICK_HI : C_TICK_LO, x - (sz >> 1), y - (sz >> 1), sz, sz);
        }
        // Cardinal labels
        for (const [b, ltr, col] of [[0, "N", C_NORTH], [90, "E", C_CARD], [180, "S", C_CARD], [270, "W", C_CARD]]) {
            const { x, y } = ringPos(b, RING_R - 22);
            p.drawString(ltr, F_MD, col, x - 5, y - 8);
        }
        // Fixed downward pointer at 12 o'clock
        const tip = CY - RING_R - 2;
        p.fillColor(C_TEXT, CX - 4, tip - 8, 8, 3);
        p.fillColor(C_TEXT, CX - 3, tip - 5, 6, 3);
        p.fillColor(C_TEXT, CX - 2, tip - 2, 4, 3);
        p.fillColor(C_TEXT, CX - 1, tip,     2, 3);
    }

    if (IS_ROUND) drawTimerCenter(p);
    else          drawTimerPanel(p);
}

function drawTimerRows(p, x, y1, y2) {
    p.fillColor(C_GOLDEN, x, y1 + 4, 6, 6);
    p.drawString("Golden", F_SM, C_TEXT, x + 10, y1);
    p.drawString(state.fmtGolden, F_SM, state.goldenActive ? C_GOLDEN : C_TEXT, x + 68, y1);

    p.fillColor(C_BLUE, x, y2 + 4, 6, 6);
    p.drawString("Blue", F_SM, C_TEXT, x + 10, y2);
    p.drawString(state.fmtBlue, F_SM, state.blueActive ? C_BLUE : C_TEXT, x + 68, y2);
}

function zoomAlignStr() {
    // Positive diff = arc is to your right, negative = to your left
    const diff   = ((state.zoomCenter - state.heading) % 360 + 360) % 360;
    const deg    = diff > 180 ? diff - 360 : diff;
    const absDeg = Math.abs(Math.round(deg));
    if (absDeg <= 2) return "Aligned!";
    return deg > 0 ? `${absDeg}deg R` : `${absDeg}deg L`;
}

function drawTimerPanel(p) {
    p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);
    if (!state.located) { p.drawString("Locating...", F_SM, C_DIM, 6, PANEL_Y + 8); return; }
    if (state.zoom) {
        const str = zoomAlignStr();
        p.drawString("ZOOM", F_SM, C_GOLDEN, 6, PANEL_Y + 6);
        p.drawString(str, F_MD, str === "Aligned!" ? C_GOLDEN : C_TEXT, 52, PANEL_Y + 4);
        return;
    }
    drawTimerRows(p, 6, PANEL_Y + 6, PANEL_Y + 26);
}

function drawTimerCenter(p) {
    if (!state.located) { p.drawString("Locating...", F_SM, C_DIM, CX - 36, CY - 8); return; }
    if (state.zoom) {
        const str = zoomAlignStr();
        p.drawString("ZOOM", F_SM, C_GOLDEN, CX - 18, CY - 10);
        p.drawString(str, F_SM, str === "Aligned!" ? C_GOLDEN : C_TEXT, CX - 26, CY + 4);
        return;
    }
    drawTimerRows(p, CX - 52, CY - 12, CY + 6);
}

// ── Port behavior ─────────────────────────────────────────────────────────────
class PortBehavior {
    onCreate(content) { port = content; }
    onDraw(p) { drawCompassView(p); }
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
            calcState(); saveLocation(pos.latitude, pos.longitude); redraw();
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
            state.heading = DEMO_HEADING; state.located = true;
            calcState(); redraw();
        } else {
            loadLocation(); redraw();

            const compass = new Compass({
                onSample: () => {
                    const { heading } = compass.sample();
                    if (state.heading !== heading) { state.heading = heading; redraw(); }
                }
            });

            doLocationFetch();
            setInterval(doLocationFetch, 600000);
            setInterval(() => { calcState(); redraw(); }, 60000);
        }

        new Button({
            types: ["up", "select"],
            onPush(down, type) {
                if (!down) return;
                if (type === "up") {
                    state.zoom = !state.zoom;
                    if (state.zoom) state.zoomCenter = computeZoomCenter();
                    redraw();
                } else if (type === "select" && !DEMO) {
                    doLocationFetch(true);
                }
            }
        });
    }
}

// ── Application ───────────────────────────────────────────────────────────────
const SunSeeker = Application.template($ => ({
    skin: new Skin({ fill: C_BG }),
    Behavior: AppBehavior,
    contents: [Port($, { top: 0, bottom: 0, left: 0, right: 0, Behavior: PortBehavior })],
}));

export default new SunSeeker(null, { displayListLength: 8192, touchCount: 0, pixels: W * 4 });
