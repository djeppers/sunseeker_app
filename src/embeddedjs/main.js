import {} from "piu/MC";
import Compass from "embedded:sensor/Compass";
import Location from "embedded:sensor/Location";
import Button from "pebble/button";
import { goldenHour, blueHour, nextEvents } from "sun";

// ── Screen geometry ───────────────────────────────────────────────────────────
const W      = screen.width;
const H      = screen.height;
const IS_ROUND = W === H;
const CX     = W >> 1;
const RING_R = Math.round(Math.min(W, H) * 0.36) | 0;
const CY     = IS_ROUND ? (H >> 1) : Math.round(H * 0.40) | 0;
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

// ── State ─────────────────────────────────────────────────────────────────────
const ZOOM_FACTOR = 4;  // 4× zoom = ±45° FOV

const state = {
    heading:     0,
    lat:         null,
    lon:         null,
    located:     false,
    gh:          null,   // goldenHour() result
    bh:          null,   // blueHour() result
    events:      [],     // nextEvents() result
    zoom:        false,
    zoomCenter:  0,      // bearing to lock at 12 o'clock in zoom mode
};

let port = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const RAD_C = Math.PI / 180;

function ringPos(bearing, r) {
    let delta = ((bearing - state.heading) % 360 + 360) % 360;
    if (delta > 180) delta -= 360;  // [-180, 180]
    if (state.zoom) {
        const zc = ((state.zoomCenter - state.heading) % 360 + 360) % 360;
        const offset = zc > 180 ? zc - 360 : zc;
        delta = (delta - offset) * ZOOM_FACTOR;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (Math.abs(delta) > 180) return { x: -9999, y: -9999 };  // off-screen
    }
    const a = ((delta % 360) + 360) % 360 * RAD_C;
    return { x: CX + Math.round(r * Math.sin(a)), y: CY - Math.round(r * Math.cos(a)) };
}

// Bearing of the next event's arc midpoint — used to set zoom center.
function computeZoomCenter() {
    const ev = state.events[0];
    if (ev) return (ev.azimuthStart + ev.azimuthEnd) / 2;
    if (state.gh?.evening) return (state.gh.evening.azimuthStart + state.gh.evening.azimuthEnd) / 2;
    if (state.gh?.morning) return (state.gh.morning.azimuthStart + state.gh.morning.azimuthEnd) / 2;
    return 270;
}

function fmtTime(d) {
    if (!d) return "--:--";
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Filled circle via scanline (Poco has no arc primitive)
function fillCircle(p, cx, cy, r, color) {
    for (let dy = -r; dy <= r; dy++) {
        const dx = Math.round(Math.sqrt(r * r - dy * dy));
        p.fillColor(color, cx - dx, cy + dy, dx * 2 + 1, 1);
    }
}

// Thick arc along the compass ring between two bearings (takes the shorter path).
function drawArc(p, az1, az2, r, color) {
    let diff  = ((az2 - az1) + 360) % 360;
    let start = az1;
    if (diff > 180) { diff = 360 - diff; start = az2; }
    for (let i = 0; i <= diff; i++) {
        const { x, y } = ringPos((start + i + 360) % 360, r);
        p.fillColor(color, x - 2, y - 2, 5, 5);
    }
}

// ── State calculation ─────────────────────────────────────────────────────────
function calcState() {
    if (state.lat === null) return;
    const now  = DEMO ? DEMO_DATE : new Date();
    state.gh     = goldenHour(state.lat, state.lon, now);
    state.bh     = blueHour(state.lat, state.lon, now);
    state.events = nextEvents(state.lat, state.lon, now);
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

// ── Countdown formatting ──────────────────────────────────────────────────────
function fmtCountdown(event, now) {
    if (!event) return "--";
    const nowMs   = now instanceof Date ? now.getTime() : now;
    const startMs = event.start - nowMs;
    const endMs   = event.end   - nowMs;
    if (endMs <= 0) return "--";
    if (startMs <= 0) {
        const m = Math.ceil(endMs / 60000);
        return m >= 60 ? `NOW ${Math.floor(m / 60)}h${m % 60}m` : `NOW ${m}m`;
    }
    const m = Math.floor(startMs / 60000);
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (event.start.getDate() !== new Date(nowMs).getDate()) return `tmrw ${fmtTime(event.start)}`;
    return h > 0 ? `in ${h}h${min < 10 ? "0" : ""}${min}m` : `in ${m}m`;
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function drawCompassView(p) {
    p.fillColor(C_BG, 0, 0, W, H);

    // Circular compass ring
    const ringW = 5;
    fillCircle(p, CX, CY, RING_R, C_RING);
    fillCircle(p, CX, CY, RING_R - ringW, C_BG);

    // Golden and blue hour arcs on the ring surface
    const arcR = RING_R - 2;
    if (state.gh) {
        if (state.gh.morning) drawArc(p, state.gh.morning.azimuthStart, state.gh.morning.azimuthEnd, arcR, C_GOLDEN);
        if (state.gh.evening) drawArc(p, state.gh.evening.azimuthStart, state.gh.evening.azimuthEnd, arcR, C_GOLDEN);
    }
    if (state.bh) {
        if (state.bh.morning) drawArc(p, state.bh.morning.azimuthStart, state.bh.morning.azimuthEnd, arcR, C_BLUE);
        if (state.bh.evening) drawArc(p, state.bh.evening.azimuthStart, state.bh.evening.azimuthEnd, arcR, C_BLUE);
    }

    if (state.zoom) {
        // Fine tick marks every 5° (only those within ±45° FOV will be on-screen)
        for (let b = 0; b < 360; b += 5) {
            const isMaj = b % 45 === 0;
            const { x, y } = ringPos(b, RING_R - ringW - 1);
            if (x < 0 || x > W) continue;
            const sz = isMaj ? 4 : 2;
            p.fillColor(isMaj ? C_TICK_HI : C_TICK_LO, x - (sz >> 1), y - (sz >> 1), sz, sz);
        }

        // Heading indicator — white diamond on the ring showing where you face
        const { x: hx, y: hy } = ringPos(state.heading, RING_R - 3);
        if (hx > -100) {
            p.fillColor(C_TEXT, hx - 1, hy - 4, 3, 4);  // diamond top
            p.fillColor(C_TEXT, hx - 2, hy,     5, 1);  // diamond mid
            p.fillColor(C_TEXT, hx - 1, hy + 1, 3, 3);  // diamond bottom
        }

        // Target crosshair at 12 o'clock (= zoom center direction)
        const tip = CY - RING_R - 2;
        p.fillColor(C_GOLDEN, CX - 5, tip - 1, 11, 3);
        p.fillColor(C_GOLDEN, CX - 1, tip - 5,  3, 11);
    } else {
        // Normal tick marks every 30°
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

    // Timer section
    if (IS_ROUND) drawTimerCenter(p);
    else          drawTimerPanel(p);
}

function drawTimerRows(p, x, y1, y2, now) {
    const events     = state.events;
    const nextGolden = events.find(e => e.type === "golden");
    const nextBlue   = events.find(e => e.type === "blue");

    const goldenActive = nextGolden && nextGolden.start <= now;
    const blueActive   = nextBlue   && nextBlue.start   <= now;

    // Golden row
    p.fillColor(C_GOLDEN, x, y1 + 4, 6, 6);
    p.drawString("Golden", F_SM, C_TEXT, x + 10, y1);
    p.drawString(fmtCountdown(nextGolden, now), F_SM, goldenActive ? C_GOLDEN : C_TEXT, x + 68, y1);

    // Blue row
    p.fillColor(C_BLUE, x, y2 + 4, 6, 6);
    p.drawString("Blue", F_SM, C_TEXT, x + 10, y2);
    p.drawString(fmtCountdown(nextBlue, now), F_SM, blueActive ? C_BLUE : C_TEXT, x + 68, y2);
}

function drawZoomPanel(p) {
    p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);
    const diff = ((state.heading - state.zoomCenter) % 360 + 360) % 360;
    const deg  = diff > 180 ? diff - 360 : diff;  // [-180, 180]
    const absDeg = Math.abs(Math.round(deg));
    let str;
    if (absDeg <= 2)       str = "Aligned!";
    else if (deg > 0)      str = `${absDeg}° left`;
    else                   str = `${absDeg}° right`;
    p.drawString("ZOOM", F_SM, C_GOLDEN, 6, PANEL_Y + 6);
    p.drawString(str, F_MD, absDeg <= 2 ? C_GOLDEN : C_TEXT, 52, PANEL_Y + 4);
}

function drawTimerPanel(p) {
    p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);
    if (!state.located) {
        p.drawString("Locating...", F_SM, C_DIM, 6, PANEL_Y + 8);
        return;
    }
    if (state.zoom) { drawZoomPanel(p); return; }
    const now = DEMO ? DEMO_DATE : new Date();
    drawTimerRows(p, 6, PANEL_Y + 6, PANEL_Y + 26, now);
}

function drawTimerCenter(p) {
    if (!state.located) {
        p.drawString("Locating...", F_SM, C_DIM, CX - 36, CY - 8);
        return;
    }
    if (state.zoom) {
        const diff = ((state.heading - state.zoomCenter) % 360 + 360) % 360;
        const deg  = diff > 180 ? diff - 360 : diff;
        const absDeg = Math.abs(Math.round(deg));
        const str = absDeg <= 2 ? "Aligned!" : (deg > 0 ? `${absDeg}° left` : `${absDeg}° right`);
        p.drawString("ZOOM", F_SM, C_GOLDEN, CX - 18, CY - 10);
        p.drawString(str, F_SM, absDeg <= 2 ? C_GOLDEN : C_TEXT, CX - 26, CY + 4);
        return;
    }
    const now = DEMO ? DEMO_DATE : new Date();
    drawTimerRows(p, CX - 52, CY - 12, CY + 6, now);
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

export default new SunSeeker(null, { displayListLength: 4096, touchCount: 0, pixels: W * 8 });
