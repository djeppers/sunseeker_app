import {} from "piu/MC";
import Compass from "embedded:sensor/Compass";
import Location from "embedded:sensor/Location";
import Button from "pebble/button";
import Timer from "timer";
import { sunTimes, sunAzimuth } from "sun";

// ── Screen geometry ───────────────────────────────────────────────────────────
const W        = screen.width;
const H        = screen.height;
const IS_ROUND = W === H;                              // gabbro 260×260
const CX       = W >> 1;
const RING_R   = Math.round(Math.min(W, H) * 0.36) | 0;
const CY       = IS_ROUND ? (H >> 1) : Math.round(H * 0.43) | 0;
const PANEL_Y  = CY + RING_R + 8;                     // info panel top edge

// ── Colors ────────────────────────────────────────────────────────────────────
const C_BG      = "#000000";
const C_RING    = "#203870";
const C_TICK_HI = "#FFFFFF";
const C_TICK_LO = "#484848";
const C_NORTH   = "#FF4040";
const C_CARD    = "#A0A0A0";
const C_RISE    = "#FFD700";
const C_SET     = "#FF6347";
const C_SUN_DOT = "#FFFF00";
const C_TEXT    = "#FFFFFF";
const C_DIM     = "#686868";
const C_PANEL   = "#080C18";

// ── Fonts ─────────────────────────────────────────────────────────────────────
const F_SM = "bold 10px Gothic";
const F_MD = "bold 14px Gothic";

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    heading:   0,
    lat:       null,
    lon:       null,
    times:     null,     // result of sunTimes()
    az:        null,     // result of sunAzimuth()
    view:      "compass",  // "compass" | "detail"
    dayOffset: 0,          // 0 = today, 1 = tomorrow
    located:   false,
};

let port = null;  // set in PortBehavior.onCreate; used to trigger redraws

// ── Helpers ───────────────────────────────────────────────────────────────────
const RAD = Math.PI / 180;

// Screen coords for a compass bearing at distance r from (cx, cy), given current heading.
function ringPos(bearing, r) {
    const a = ((bearing - state.heading) % 360 + 360) % 360 * RAD;
    return { x: CX + Math.round(r * Math.sin(a)), y: CY - Math.round(r * Math.cos(a)) };
}

// Format a UTC Date as local HH:MM (XS engine applies device timezone to getHours/getMinutes).
function fmtTime(d) {
    if (!d) return "--:--";
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h > 0 ? `${h}h${m < 10 ? "0" : ""}${m}m` : `${m}m`;
}

function calcSun() {
    if (state.lat === null) return;
    const now  = new Date();
    const date = state.dayOffset
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
        : now;
    state.times = sunTimes(state.lat, state.lon, date);
    state.az    = sunAzimuth(state.lat, state.lon, now);  // always current time for live position
}

function saveLocation(lat, lon) {
    try { localStorage.setItem("loc", JSON.stringify({ lat, lon })); } catch (e) { /* skip */ }
}

function loadLocation() {
    try {
        const raw = localStorage.getItem("loc");
        if (!raw) return;
        const { lat, lon } = JSON.parse(raw);
        state.lat = lat;
        state.lon = lon;
        state.located = true;
        calcSun();
    } catch (e) { /* skip */ }
}

function redraw() {
    if (port) port.invalidate();
}

// ── Drawing — compass view ────────────────────────────────────────────────────
function drawDot(p, bearing, r, color, radius) {
    const { x, y } = ringPos(bearing, r);
    p.fillRoundRectangle(color, x - radius, y - radius, radius * 2, radius * 2, radius);
}

function drawCompassView(p) {
    p.fillColor(C_BG, 0, 0, W, H);

    // Ring: filled outer circle + background inner circle = torus
    const ringW = 5;
    p.fillRoundRectangle(C_RING, CX - RING_R, CY - RING_R, RING_R * 2, RING_R * 2, RING_R);
    const inner = RING_R - ringW;
    p.fillRoundRectangle(C_BG, CX - inner, CY - inner, inner * 2, inner * 2, inner);

    // Tick marks every 30° (major at 0/90/180/270)
    for (let b = 0; b < 360; b += 30) {
        const isMaj = b % 90 === 0;
        const { x, y } = ringPos(b, RING_R - ringW - 1);
        const sz = isMaj ? 4 : 2;
        p.fillRoundRectangle(
            isMaj ? C_TICK_HI : C_TICK_LO,
            x - (sz >> 1), y - (sz >> 1), sz, sz, sz >> 1,
        );
    }

    // Cardinal labels inside the ring
    const cardinals = [[0, "N", C_NORTH], [90, "E", C_CARD], [180, "S", C_CARD], [270, "W", C_CARD]];
    for (const [b, ltr, col] of cardinals) {
        const { x, y } = ringPos(b, RING_R - 22);
        p.drawString(ltr, F_MD, col, x - 5, y - 8);
    }

    // Sun markers on the ring
    if (state.az) {
        const { sunrise: srAz, sunset: ssAz, current: curAz, elevation } = state.az;
        drawDot(p, srAz, RING_R,     C_RISE,    6);
        drawDot(p, ssAz, RING_R,     C_SET,     6);
        if (elevation > 0) drawDot(p, curAz, RING_R - 11, C_SUN_DOT, 4);
    }

    // Fixed downward-pointing pointer at 12 o'clock
    const tip = CY - RING_R - 2;
    p.fillColor(C_TEXT, CX - 4, tip - 8, 8, 3);
    p.fillColor(C_TEXT, CX - 3, tip - 5, 6, 3);
    p.fillColor(C_TEXT, CX - 2, tip - 2, 4, 3);
    p.fillColor(C_TEXT, CX - 1, tip,     2, 3);

    // Info panel
    if (IS_ROUND) {
        drawInfoCenter(p);
    } else {
        drawInfoPanel(p);
    }
}

function drawInfoPanel(p) {
    p.fillColor(C_PANEL, 0, PANEL_Y, W, H - PANEL_Y);

    if (!state.located) {
        p.drawString("Locating...", F_SM, C_DIM, 6, PANEL_Y + 6);
        return;
    }
    const { times, az } = state;
    if (!times) return;

    // Row 1: sunrise / sunset times
    p.drawString(`^ ${fmtTime(times.sunrise)}`, F_MD, C_RISE, 4,       PANEL_Y + 3);
    p.drawString(`v ${fmtTime(times.sunset)}`,  F_MD, C_SET,  W / 2 + 2, PANEL_Y + 3);

    // Row 2: elevation + countdown to next event
    if (az) {
        const elevStr = az.elevation >= 0
            ? `${az.elevation.toFixed(0)} up`
            : `below horizon`;
        p.drawString(elevStr, F_SM, C_TEXT, 4, PANEL_Y + 20);

        const now = Date.now();
        if (times.sunrise && times.sunset) {
            const toSet  = (times.sunset  - now) / 60000;
            const toRise = (times.sunrise - now) / 60000;
            const str = toSet > 0  ? `set in ${fmtDuration(toSet)}`
                      : toRise > 0 ? `rise in ${fmtDuration(toRise)}`
                      : "";
            if (str) p.drawString(str, F_SM, C_DIM, W / 2 + 2, PANEL_Y + 20);
        }
    }

    if (state.dayOffset) p.drawString("[tomorrow]", F_SM, C_RISE, 4, PANEL_Y + 34);
}

// Round display: small summary in the center of the ring
function drawInfoCenter(p) {
    const { times } = state;
    if (!state.located || !times) {
        p.drawString("Locating", F_SM, C_DIM, CX - 22, CY - 6);
        return;
    }
    p.drawString(fmtTime(times.sunrise), F_SM, C_RISE, CX - 18, CY - 12);
    p.drawString(fmtTime(times.sunset),  F_SM, C_SET,  CX - 18, CY + 2);
}

// ── Drawing — detail view ─────────────────────────────────────────────────────
function drawDetailView(p) {
    p.fillColor(C_BG, 0, 0, W, H);

    if (!state.located) {
        p.drawString("Waiting for GPS...", F_SM, C_DIM, 8, 40);
        return;
    }
    const { times, az } = state;
    if (!times) return;

    let y = 6;
    function row(label, value, col) {
        p.drawString(label, F_SM, C_DIM, 8, y);
        p.drawString(value, F_MD, col ?? C_TEXT, 8, y + 11);
        y += 28;
    }

    row("SUNRISE",    fmtTime(times.sunrise), C_RISE);
    row("SUNSET",     fmtTime(times.sunset),  C_SET);

    if (times.polarDay || times.polarNight) {
        row("DAY", times.polarDay ? "Polar day" : "Polar night");
    } else {
        const dl = (times.sunset - times.sunrise) / 60000;
        row("DAY LENGTH", fmtDuration(dl));
    }

    if (az) {
        row("SUN NOW", az.elevation >= 0
            ? `${az.elevation.toFixed(1)} elev`
            : "below horizon");
    }

    if (state.lat !== null) {
        row("LOCATION", `${state.lat.toFixed(2)} ${state.lon.toFixed(2)}`);
    }

    if (state.dayOffset) p.drawString("[ tomorrow ]", F_SM, C_RISE, 8, y);
}

// ── Location fetch (module-level so button + timer can both call it) ──────────
function doLocationFetch() {
    const sensor = new Location({
        onSample: () => {
            const pos = sensor.sample();
            state.lat     = pos.latitude;
            state.lon     = pos.longitude;
            state.located = true;
            calcSun();
            saveLocation(pos.latitude, pos.longitude);
            redraw();
            sensor.close();
        }
    });
    sensor.configure({
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 300000,
    });
}

// ── Port behavior ─────────────────────────────────────────────────────────────
class PortBehavior {
    onCreate(content) {
        port = content;
    }
    onDraw(p) {
        if (state.view === "compass") drawCompassView(p);
        else                          drawDetailView(p);
    }
}

// ── App behavior (sensor wiring + buttons) ────────────────────────────────────
class AppBehavior {
    onCreate(app) {
        loadLocation();
        redraw();

        // Compass — update heading on every sample
        const compass = new Compass({
            onSample: () => {
                const { heading } = compass.sample();
                if (state.heading !== heading) {
                    state.heading = heading;
                    redraw();
                }
            }
        });

        // Location — fetch once now, then every 10 minutes
        doLocationFetch();
        Timer.set(doLocationFetch, 600000, 600000);

        // Recalculate sun elevation every minute (bearing / elevation drift)
        Timer.set(() => { calcSun(); redraw(); }, 60000, 60000);

        // Buttons
        new Button({
            types: ["up", "select", "down"],
            onPush(down, type) {
                if (!down) return;  // ignore release
                switch (type) {
                    case "up":      // toggle compass ↔ detail
                        state.view = state.view === "compass" ? "detail" : "compass";
                        redraw();
                        break;
                    case "select":  // force GPS refresh
                        doLocationFetch();
                        break;
                    case "down":    // toggle today ↔ tomorrow
                        state.dayOffset = state.dayOffset ? 0 : 1;
                        calcSun();
                        redraw();
                        break;
                }
            }
        });
    }
}

// ── Application ───────────────────────────────────────────────────────────────
const SunSeeker = Application.template($ => ({
    skin: new Skin({ fill: C_BG }),
    Behavior: AppBehavior,
    contents: [
        Port($, {
            top: 0, bottom: 0, left: 0, right: 0,
            Behavior: PortBehavior,
        }),
    ],
}));

export default new SunSeeker(null, {
    displayListLength: 4096,
    touchCount: 0,
    pixels: W * 8,
});
