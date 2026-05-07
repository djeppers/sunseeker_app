import {} from "piu/MC";
import Location from "embedded:sensor/Location";
import Button from "pebble/button";
import { lightArc } from "sun";

// ── Screen geometry ───────────────────────────────────────────────────────────
const W        = screen.width;
const H        = screen.height;
const IS_ROUND = W === H;
const CX       = W >> 1;
const RING_R   = Math.round(Math.min(W, H) * 0.36) | 0;
const CY       = IS_ROUND ? (H >> 1) : Math.round(H * 0.40) | 0;
const PANEL_Y  = CY + RING_R + 8;

// ── Colors — individual constants avoid the object property hash table chunk ──
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

// ── Font — deferred to first draw so chunk heap is free at platform init ──────
let F_SM = null;

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
let _posX = 0, _posY = 0;

function ringPos(bearing, r) {
    const delta = ((bearing - state.heading) % 360 + 360) % 360;
    const a = delta * RAD_C;
    _posX = CX + Math.round(r * Math.sin(a));
    _posY = CY - Math.round(r * Math.cos(a));
}

function fillCircle(p, cx, cy, r, color) {
    for (let dy = -r; dy <= r; dy++) {
        const dx = Math.round(Math.sqrt(r * r - dy * dy));
        p.fillColor(color, cx - dx, cy + dy, dx * 2 + 1, 1);
    }
}

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

    const startColor = az6  !== null ? C_GOLDEN : C_BLUE;
    const endColor   = azM6 !== null ? C_BLUE   : C_GOLDEN;
    ringPos(arcStart, r);
    if (_posX > -100) p.fillColor(startColor, _posX - DOT - 1, _posY - DOT - 1, (DOT + 1) * 2 + 1, (DOT + 1) * 2 + 1);
    ringPos(arcEnd, r);
    if (_posX > -100) p.fillColor(endColor, _posX - DOT - 1, _posY - DOT - 1, (DOT + 1) * 2 + 1, (DOT + 1) * 2 + 1);

    for (let i = 0; i <= total; i += 2) {
        const az = cw ? (arcStart + i + 360) % 360 : (arcStart - i + 360) % 360;
        ringPos(az, r);
        if (_posX < -100) continue;
        let color;
        if (m4Offset === null)             color = az6 !== null ? C_GOLDEN : C_BLUE;
        else if (i < m4Offset - DITHER)    color = C_GOLDEN;
        else if (i > m4Offset + DITHER)    color = C_BLUE;
        else                               color = (i >> 1) % 2 === 0 ? C_GOLDEN : C_BLUE;
        p.fillColor(color, _posX - DOT, _posY - DOT, DOT * 2 + 1, DOT * 2 + 1);
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
        const _d = new Date(event.startMs);
        const hh = _d.getHours(), mm = _d.getMinutes();
        return `tmrw ${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;
    }
    return h > 0 ? `in ${h}h${min < 10 ? "0" : ""}${min}m` : `in ${m}m`;
}

function calcState() {
    if (state.lat === null) return;
    const nowMs = Date.now();
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
    p.fillColor(C_GOLDEN, x, y1 + 4, 6, 6);
    p.drawString("Golden", F_SM, C_TEXT, x + 10, y1);
    p.drawString(state.fmtGolden, F_SM, state.goldenActive ? C_GOLDEN : C_TEXT, x + 68, y1);

    p.fillColor(C_BLUE, x, y2 + 4, 6, 6);
    p.drawString("Blue", F_SM, C_TEXT, x + 10, y2);
    p.drawString(state.fmtBlue, F_SM, state.blueActive ? C_BLUE : C_TEXT, x + 68, y2);
}

function drawCompassView(p) {
    if (!F_SM) F_SM = new Style({ font: "bold 14px Gothic" });
    p.fillColor(C_BG, 0, 0, W, H);

    const ringW = 5;
    fillCircle(p, CX, CY, RING_R, C_RING);
    fillCircle(p, CX, CY, RING_R - ringW, C_BG);

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
            ringPos(b, RING_R - ringW - 1);
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C_TICK_HI : C_TICK_LO, _posX - (sz >> 1), _posY - (sz >> 1), sz, sz);
        }
    } else {
        for (let b = 0; b < 360; b += 30) {
            const isMaj = b % 90 === 0;
            ringPos(b, RING_R - ringW - 1);
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C_TICK_HI : C_TICK_LO, _posX - (sz >> 1), _posY - (sz >> 1), sz, sz);
        }
        ringPos(0,   RING_R - 22); p.drawString("N", F_SM, C_NORTH, _posX - 5, _posY - 8);
        ringPos(90,  RING_R - 22); p.drawString("E", F_SM, C_CARD,  _posX - 5, _posY - 8);
        ringPos(180, RING_R - 22); p.drawString("S", F_SM, C_CARD,  _posX - 5, _posY - 8);
        ringPos(270, RING_R - 22); p.drawString("W", F_SM, C_CARD,  _posX - 5, _posY - 8);
    }

    // Fixed pointer triangle at 12 o'clock
    const tip = CY - RING_R - 2;
    p.fillColor(C_TEXT, CX - 4, tip - 8, 8, 3);
    p.fillColor(C_TEXT, CX - 3, tip - 5, 6, 3);
    p.fillColor(C_TEXT, CX - 2, tip - 2, 4, 3);
    p.fillColor(C_TEXT, CX - 1, tip,     2, 3);

    // Timer area
    if (IS_ROUND) {
        if (!state.located) { p.drawString("Locating...", F_SM, C_DIM, CX - 36, CY - 8); return; }
        if (state.zoom) {
            const diff = ((state.zoomCenter - state.heading) % 360 + 360) % 360;
            const deg  = diff > 180 ? diff - 360 : diff;
            const abs  = Math.abs(Math.round(deg));
            const str  = abs <= 2 ? "Aligned!" : `${abs}deg ${deg > 0 ? "R" : "L"}`;
            p.drawString("ZOOM", F_SM, C_GOLDEN, CX - 18, CY - 10);
            p.drawString(str, F_SM, str === "Aligned!" ? C_GOLDEN : C_TEXT, CX - 26, CY + 4);
        } else {
            drawTimerRows(p, CX - 52, CY - 12, CY + 6);
        }
    } else {
        p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);
        if (!state.located) { p.drawString("Locating...", F_SM, C_DIM, 6, PANEL_Y + 8); return; }
        if (state.zoom) {
            const diff = ((state.zoomCenter - state.heading) % 360 + 360) % 360;
            const deg  = diff > 180 ? diff - 360 : diff;
            const abs  = Math.abs(Math.round(deg));
            const str  = abs <= 2 ? "Aligned!" : `${abs}deg ${deg > 0 ? "R" : "L"}`;
            p.drawString("ZOOM", F_SM, C_GOLDEN, 6, PANEL_Y + 6);
            p.drawString(str, F_SM, str === "Aligned!" ? C_GOLDEN : C_TEXT, 52, PANEL_Y + 4);
        } else {
            drawTimerRows(p, 6, PANEL_Y + 6, PANEL_Y + 26);
        }
    }
}

// ── 24-hour clock view ────────────────────────────────────────────────────────
function drawClockView(p) {
    if (!F_SM) F_SM = new Style({ font: "bold 14px Gothic" });
    p.fillColor(C_BG, 0, 0, W, H);

    function clockDeg(ms) {
        const d = new Date(ms);
        const localMin = d.getHours() * 60 + d.getMinutes();
        return ((localMin - 720 >> 2) + 360) % 360;
    }

    function clockSector(az6, azM4, azM6) {
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
        for (let i = 0; i <= total; i += 2) {
            const az = cw ? (arcStart + i + 360) % 360 : (arcStart - i + 360) % 360;
            const a  = az * RAD_C;
            const sinA = Math.sin(a), cosA = Math.cos(a);
            let color;
            if (m4Offset === null)          color = az6 !== null ? C_GOLDEN : C_BLUE;
            else if (i < m4Offset - 1)      color = C_GOLDEN;
            else if (i > m4Offset + 1)      color = C_BLUE;
            else                            color = (i >> 1) % 2 === 0 ? C_GOLDEN : C_BLUE;
            for (let t = 5; t <= RING_R; t += 5) {
                const x = CX + Math.round(t * sinA);
                const y = CY - Math.round(t * cosA);
                p.fillColor(color, x - 2, y - 2, 5, 5);
            }
        }
    }

    if (state.arc) {
        if (state.arc.morning) {
            const m = state.arc.morning;
            clockSector(
                m.goldenStartMs !== null ? clockDeg(m.goldenStartMs) : null,
                m.goldenEndMs   !== null ? clockDeg(m.goldenEndMs)   : null,
                m.blueEndMs     !== null ? clockDeg(m.blueEndMs)     : null
            );
        }
        if (state.arc.evening) {
            const e = state.arc.evening;
            clockSector(
                e.goldenStartMs !== null ? clockDeg(e.goldenStartMs) : null,
                e.goldenEndMs   !== null ? clockDeg(e.goldenEndMs)   : null,
                e.blueEndMs     !== null ? clockDeg(e.blueEndMs)     : null
            );
        }
    }

    // Thin ring outline
    for (let d = 0; d < 360; d += 6) {
        const a  = d * RAD_C;
        const rx = CX + Math.round(RING_R * Math.sin(a));
        const ry = CY - Math.round(RING_R * Math.cos(a));
        p.fillColor(C_RING, rx, ry, 2, 2);
    }

    // Hour ticks every 15° (1h), major every 90° (6h)
    const tickR = RING_R - 5;
    for (let h = 0; h < 24; h++) {
        const deg = ((h - 12) * 15 + 360) % 360;
        const a   = deg * RAD_C;
        const tx  = CX + Math.round(tickR * Math.sin(a));
        const ty  = CY - Math.round(tickR * Math.cos(a));
        const isMaj = h % 6 === 0;
        const sz = isMaj ? 4 : 2;
        p.fillColor(isMaj ? C_TICK_HI : C_TICK_LO, tx - (sz >> 1), ty - (sz >> 1), sz, sz);
    }

    // 24h labels at 6h positions
    const labelR = RING_R - 20;
    p.drawString("12:00", F_SM, C_DIM, CX - 16,         CY - labelR - 7);
    p.drawString("18:00", F_SM, C_DIM, CX + labelR - 9, CY - 7);
    p.drawString("00:00", F_SM, C_DIM, CX - 16,         CY + labelR - 7);
    p.drawString("06:00", F_SM, C_DIM, CX - labelR - 9, CY - 7);

    // Current time hand
    const nowDeg = clockDeg(Date.now());
    const hRa = nowDeg * RAD_C;
    const hx  = CX + Math.round((RING_R - 8) * Math.sin(hRa));
    const hy  = CY - Math.round((RING_R - 8) * Math.cos(hRa));
    {
        let ldx = Math.abs(hx - CX), ldy = Math.abs(hy - CY);
        const sx = CX < hx ? 1 : -1, sy = CY < hy ? 1 : -1;
        let err = ldx - ldy, lx = CX, ly = CY;
        for (;;) {
            p.fillColor(C_TEXT, lx - 1, ly - 1, 3, 3);
            if (lx === hx && ly === hy) break;
            const e2 = 2 * err;
            if (e2 > -ldy) { err -= ldy; lx += sx; }
            if (e2 <  ldx) { err += ldx; ly += sy; }
        }
    }
    p.fillColor(C_TEXT, CX - 2, CY - 2, 5, 5);

    // Timer panel
    if (IS_ROUND) {
        if (!state.located) { p.drawString("Locating...", F_SM, C_DIM, CX - 36, CY - 8); return; }
        drawTimerRows(p, CX - 52, CY - 12, CY + 6);
    } else {
        p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);
        if (!state.located) { p.drawString("Locating...", F_SM, C_DIM, 6, PANEL_Y + 8); return; }
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
        // Seed Copenhagen so arcs render immediately; real GPS overrides on fix
        state.lat = 55.68; state.lon = 12.57; state.located = true;
        calcState();
        loadLocation();
        if (port) port.invalidate();

        doLocationFetch();
        setInterval(doLocationFetch, 600000);
        setInterval(() => { calcState(); if (port) port.invalidate(); }, 60000);

        new Button({
            types: ["up", "select"],
            onPush(down, type) {
                if (!down) return;
                if (type === "up") {
                    state.view = state.view === "clock" ? "compass" : "clock";
                    if (port) port.invalidate();
                } else if (type === "select") {
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
