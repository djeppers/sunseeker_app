# XS Memory Findings — SunSeeker Pebble App

## Platform context
- Emery (200×228, rectangular) — working
- Gabbro (260×260, round) — crash progress: 260 → 76 → 24 → 52 → ?? (ongoing)
- XS (Moddable JS engine) has TWO heaps: slot heap (fixed 8-byte slots) and chunk heap (variable-length objects/strings)
- `creation` section in manifest.json appears to be **ignored** by the Pebble platform; hardcoded limits apply
- The platform module `pebble.moddable.tech` allocates its own chunks after our module loads (including a screen-width-sized buffer: 200 bytes on Emery, 260 bytes on Gabbro — this is why Gabbro needs more headroom than Emery)
- `app_message_open()` is called by the platform at startup consuming 8200+8200 = 16400 bytes of **C heap** (separate from XS chunk heap, so NOT our problem to fix)
- `displayListLength` and `pixels` in Application export do NOT come from XS chunk heap — reducing them had no effect on crashes

## Crash types
- `# Chunk allocation: failed for N bytes` → XS chunk heap exhausted; N = size of the next object trying to allocate
- `# Slot allocation: failed for 1024 bytes` → XS slot heap (module closure bindings) exhausted; each module-level `const`/`let`/`function` = 1 slot

## What consumes CHUNK heap (the critical one)
- **Object property hash tables**: an object with many properties allocates a hash table chunk.
  - Observed: 11-property object costs ~256 bytes chunk. Dissolving it saved ~52 bytes.
  - XS appears to use a 16-bucket hash table for 9–16 properties, possibly smaller for ≤8.
  - **AVOID module-level objects with many properties. Use individual constants instead.**
- **String values**: each distinct string (e.g. `"#F0A030"`) is a chunk (~16 bytes). String literals in bytecode appear to be interned per module — using `const C_GOLDEN = "#F0A030"` vs inline literal makes no difference for string chunk count.
- **Style objects**: `new Style({ font: "..." })` is large (~184 bytes confirmed). **Must be deferred to first draw, not module-level.**
- **Float values**: any non-integer number stored as a module-level `const` is a float chunk (8 bytes). e.g. `const RAD_C = Math.PI / 180`. UTC timestamps in ms always exceed SmallInt (~537M) so `Date.UTC(...)` is always a float chunk.
- **Array literals**: `[]` or `[0, 1]` = array object chunk. Nested arrays = N+1 chunks. The `events: []` in state was ~24+ bytes.
- **Function objects**: evidence mixed. Removing module-level functions appeared to NOT save chunk bytes in practice. They may be in slot heap only, or the savings are offset by hash table resizing.
- **`new Date()`**: Date object = chunk (~50+ bytes). Avoid at module level.

## What consumes SLOT heap
- Every module-level `const`, `let`, `var`, `function`, `class` declaration = 1 slot
- Each slot = 8 bytes; default slot heap appears to be ~256 slots
- Reducing slots was critical early on (slot allocation failures), now chunk is the bottleneck

## Key fixes applied (in order)
1. **`solarParams()` return object** `{ decl, eqt }` = 24-byte chunk × 9 calls per lightArc → use module-level `_decl`, `_eqt` vars
2. **`computeHourAngle()` / `riseSet()`** refactored to module-level output vars `_ha`, `_riseMs`, `_setMs`
3. **Removed `CARDINALS`/`CLOCK_LABELS`** module-level nested arrays → inline draw calls (saves array chunks + slots)
4. **Removed `F_MD`** Style object → single `F_SM`
5. **Consolidated 11 color constants → single `C` object** (saves 10 slots) — **LATER REVERSED** (step 10)
6. **Deferred `F_SM` Style creation** from module load to first draw — saved **~184 bytes** chunk (biggest single win; crash 260→76)
7. **Removed DEMO constants** (DEMO_LAT, DEMO_LON, DEMO_HEAD, DEMO_MS, DEMO) — saved float chunks + slots + dead code
8. **`_pos = { x:0, y:0 }` → `_posX, _posY`** flat module vars — eliminates 2-property object chunk
9. **Removed `computeZoomCenter`** + `state.zoom`/`state.zoomCenter` — dead code (up button repurposed to view toggle)
10. **Reverted C object back to 11 individual constants** — eliminates ~256-byte property hash table chunk; crash 76→24
11. **Removed `nextGolden`, `nextBlue`, `goldenActive`, `blueActive` from state** — made crash WORSE (24→52). Suspected cause: XS hash table size did NOT change (still 16-bucket for 9 props), but some internal reorg cost ~28 bytes.
12. **Removed `events` from state (9→8 properties)** — attempting to cross the XS hash table threshold to smaller inline storage (~128 bytes savings if threshold is at 8 props)

## XS hash table behavior (observed)
- Dissolving an 11-property `C` object saved ~52 bytes → the hash table was ~256+ bytes
- Going from 13→9 state properties saved 0 bytes and apparently COST ~28 bytes (threshold not crossed)
- **Hypothesis**: XS uses 16-bucket hash table for properties 9–16, and a smaller inline table for ≤8 properties
- State with 8 properties (current): heading, lat, lon, located, arc, fmtGolden, fmtBlue, view

## solarParams optimization
- Original: returned `{ decl, eqt }` object, called 9× per `lightArc()` → 9 × 24-byte chunks
- Fixed: module-level output vars; only 1 solarParams call per lightArc (reuse noon _decl/_eqt for azimuths; <0.5° error, within ±5° tolerance)
- Azimuth values rounded to integers (`Math.round`) → SmallInt, no float chunk in arc result objects

## Clock view display list budget
- Display list does NOT come from XS chunk heap
- `pixels: 800` does NOT come from XS chunk heap
- Clock sector: 2° angular step, 5px/7px radial step (Emery/Gabbro), matching dot size
- Display list: ~400–700 entries × ~10 bytes ≈ 4–7KB, well within 7168-byte budget

## Active state detection
- Removed `goldenActive`/`blueActive` from state to save chunk
- Detection in drawTimerRows: `state.fmtGolden.indexOf("NOW") === 0` — if format starts with "NOW", event is active
- `fmtCountdown` prefixes active events with "NOW": `"NOW 32m"`, `"NOW 1h5m"` etc.

## Triangle-Based Cone Rendering (Current Approach)
- **Problem**: Dot-based rendering was memory-intensive and pixelated on 200 DPI displays
- **Solution**: Draw triangles from arc points to center with tapering width
- **Key parameters**:
  - Base width: 10px (ensures overlap for solid fill)
  - Angular step: 2° (balances quality and performance)
  - Width formula: `width = base_width * (1 - distance_from_edge / radius)`
  - Interpolation: `tx = CX + (x - CX) * (1 - t)` where t goes from 0 to 1
- **Benefits**:
  - ~95% fewer draw operations vs radial stepping
  - Solid, smooth cones instead of pixelated dots
  - Properly tapers to point at center
  - Much more memory efficient
- **Memory impact**: Allows higher displayListLength (6144) while staying within budget

## Memory Management Updates
- App message system consumes 8200 bytes C heap (separate from XS chunk heap)
- DisplayListLength must account for platform overhead
- Safe values: 4096-5120 for complex apps with app messaging
- Current setting: 6144 (triangle rendering is efficient enough)

## Current Architecture
- Clock view: 24-hour clock with golden/blue hour triangle cones
- Zoom view: Detailed half-clock for active phases
- Compass view: Direction-based golden/blue hour display
- Triangle-based cone rendering for efficiency and quality
- Memory-optimized display list management

## Triangle-Based Cone Rendering (Current Approach)
- **Problem**: Dot-based rendering was memory-intensive and pixelated on 200 DPI displays
- **Solution**: Draw triangles from arc points to center with tapering width
- **Key parameters**:
  - Base width: 15px (ensures overlap for solid fill)
  - Angular step: 1° (closer spacing = smoother)
  - Width formula: `width = base_width * (1 - distance_from_edge / radius)`
- **Benefits**:
  - ~90% fewer draw operations vs dot-based
  - Solid, smooth cones instead of pixelated dots
  - Properly tapers to point at center
- **Memory impact**: Much more efficient, allows higher displayListLength (5120)

## Memory Management Updates
- App message system consumes 8200 bytes C heap (separate from XS chunk heap)
- DisplayListLength must account for platform overhead
- Safe values: 4096-5120 for complex apps with app messaging
- Current setting: 5120 (balances quality and memory)

## Removed Features (Memory Optimization)
- Compass view and related code
- Compass sensor integration
- Heading state and compass-based rotation
- Simplified to clock/zoom views only

## Current Architecture
- Clock view: 24-hour clock with golden/blue hour triangle cones
- Zoom view: Detailed half-clock for active phases
- Triangle-based cone rendering for efficiency and quality
- Memory-optimized display list management
