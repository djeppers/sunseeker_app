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
const state = {
    heading: 0,
    lat:     null,
    lon:     null,
    located: false,
    gh:      null,   // goldenHour() result
    bh:      null,   // blueHour() result
    events:  [],     // nextEvents() result
};

let port = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const RAD_C = Math.PI / 180;

function ringPos(bearing, r) {
    const a = ((bearing - state.heading) % 360 + 360) % 360 * RAD_C;
    return { x: CX + Math.round(r * Math.sin(a)), y: CY - Math.round(r * Math.cos(a)) };
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

    // Tick marks every 30° (major at cardinals)
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

function drawTimerPanel(p) {
    p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);
    if (!state.located) {
        p.drawString("Locating...", F_SM, C_DIM, 6, PANEL_Y + 8);
        return;
    }
    const now = DEMO ? DEMO_DATE : new Date();
    drawTimerRows(p, 6, PANEL_Y + 6, PANEL_Y + 26, now);
}

function drawTimerCenter(p) {
    if (!state.located) {
        p.drawString("Locating...", F_SM, C_DIM, CX - 36, CY - 8);
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
            types: ["select"],
            onPush(down) {
                if (!down || DEMO) return;
                doLocationFetch(true);
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
