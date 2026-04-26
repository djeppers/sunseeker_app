# Solar Elevation Reference for SunSeeker

Add this section to CLAUDE.md under the sun.js module documentation.

---

## Solar Elevation Angles: Definitions

The sun's "elevation" (or "altitude") is the angle between the center of the sun's disc and the observer's local horizon. Positive = above horizon, negative = below.

### The PhotoPills Standard (USE THIS)

PhotoPills is the industry-standard photography planning app. Their definitions are what photographers expect. Use these exact angles:

- **Golden hour**: sun elevation between **-4° and +6°**
- **Blue hour**: sun elevation between **-6° and -4°**

This means golden hour INCLUDES part of civil twilight (the -4° to 0° range, when the sun is just below the horizon but the sky is golden/orange). This is intentional and correct for photography - the warm light starts before the sun physically clears the horizon.

Golden hour and blue hour are adjacent and non-overlapping. The sequence through an evening is:

```
Daytime         sun above +6°
Golden hour     sun descends from +6° to -4°    (warm amber/orange light)
Blue hour       sun descends from -4° to -6°    (deep blue saturated light)
Civil twilight ends at -6° (same as blue hour end)
Nautical twilight  -6° to -12°                  (dark, stars visible)
Night           below -18°
```

Morning is the reverse: blue hour first, then golden hour.

### Why not other definitions

Some sources (timeanddate.com) use -6° to +6° for golden hour, which makes golden hour and blue hour overlap. Others define blue hour as -4° to -8°. The PhotoPills definition is cleaner (no overlap, adjacent boundaries) and matches what most photographers actually use in planning tools.

### Standard sunrise/sunset

Standard sunrise and sunset use a zenith of 90.833° (equivalent to -0.833° elevation). This accounts for:
- Atmospheric refraction bending light (~0.567°)
- The sun's apparent radius (~0.266°)

So "sunrise" happens when the sun's center is actually 0.833° below the geometric horizon. This falls within the golden hour range, which is correct - sunrise/sunset happens during golden hour.

## Duration Varies by Latitude and Season

The sun crosses the horizon at different angles depending on latitude:

- **Equator**: sun rises/sets near-vertical (~90° to horizon). Golden hour is short (~40-50 min). Blue hour is very short (~15-20 min).
- **Mid latitudes (40-50°N/S)**: golden hour ~60-90 min. Blue hour ~20-30 min.
- **High latitudes (55-65°N/S)**: golden hour can exceed 2 hours near solstices. Blue hour 30-40 min.
- **Polar regions**: near summer solstice the sun may never go above +6° or below -6°, meaning golden hour or blue hour can last all "night."

Copenhagen (55.68°N) in summer will have very long golden hours. In December, they'll be shorter.

## What the Arcs Represent

Each arc on the compass shows the BEARING RANGE of the sun during that light phase. For example, if golden hour runs from 20:45 to 21:32, the sun's azimuth might sweep from 285° to 315° during that time. The arc covers that 30° range on the compass ring.

The arc width varies:
- Near equinox: narrower arcs (sun moves more vertically relative to horizon)
- Near solstice at high latitudes: wider arcs (sun moves more horizontally, skimming the horizon)

To calculate the arc: compute the sun's azimuth at the START elevation boundary and at the END elevation boundary for each phase. Those two azimuths define the arc endpoints.

## Implementation: Computing the Boundary Times

For each light phase boundary, you need to solve: "at what TIME does the sun reach elevation X?"

The boundaries you need:
- +6°: golden hour / daytime boundary
- -4°: golden hour / blue hour boundary
- -6°: blue hour / darkness boundary

For each boundary angle, compute the hour angle using:

```
cos(hourAngle) = (sin(elevationAngle) - sin(lat) * sin(declination)) / (cos(lat) * cos(declination))
```

This gives you two solutions per day (morning and evening). Convert hour angle to clock time using the equation of time and the observer's longitude.

Then compute the azimuth at each boundary time:

```
azimuth = atan2(sin(hourAngle), cos(hourAngle) * sin(lat) - tan(declination) * cos(lat))
```

Convert to compass bearing (0-360°, clockwise from north). The atan2 result needs adjustment: add 180° and normalize.

## Edge Cases to Handle

1. **Sun never reaches +6°**: The entire "day" is golden hour (common in Arctic winter). Return golden hour spanning the full daylight period.

2. **Sun never drops below -4°**: No blue hour, golden hour extends to/from the minimum elevation. Common at high latitudes in summer.

3. **Sun never drops below -6°**: No blue hour at all, and golden hour may last all night. Return null for blue hour.

4. **Sun never rises above -6°**: No golden hour or blue hour (polar night). Return null for both.

5. **Sun never rises above -4°**: No golden hour, but blue hour exists around solar noon. Handle this edge case.

## Accuracy Target

For a watch app, +/- 3 minutes on times and +/- 3° on bearings is more than sufficient. Weather, terrain, and buildings have a far bigger effect than algorithm precision. The simplified solar position equations (using mean anomaly, equation of center, and obliquity) achieve this easily.
