import { describe, it, expect } from 'vitest'
import { subsolarPoint, sunAltitude, nightRing, nightGeoJson, deepestNight, NIGHT_STEPS, darknessAt } from './daylight'

/** Is the point inside the ring? Ray casting, enough for a test. */
function inside([x, y]: [number, number], ring: Array<[number, number]>): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

// Midday at Greenwich near the June solstice: the sun is over the Sahara.
const JUNE_NOON = new Date(Date.UTC(2026, 5, 21, 12, 0, 0))
// Midnight at Greenwich near the December solstice.
const DECEMBER_MIDNIGHT = new Date(Date.UTC(2026, 11, 21, 0, 0, 0))

describe('subsolarPoint', () => {
  it('puts the sun over the Tropic of Cancer at noon in late June', () => {
    const sun = subsolarPoint(JUNE_NOON)
    expect(sun.lat).toBeGreaterThan(23)
    expect(sun.lat).toBeLessThan(23.5)
    expect(Math.abs(sun.lng)).toBeLessThan(1)
  })

  it('puts it over the Tropic of Capricorn, on the far side, at midnight in late December', () => {
    const sun = subsolarPoint(DECEMBER_MIDNIGHT)
    expect(sun.lat).toBeLessThan(-23)
    expect(Math.abs(Math.abs(sun.lng) - 180)).toBeLessThan(1)
  })
})

describe('sunAltitude', () => {
  it('is straight up under the sun and below the horizon on the far side', () => {
    const sun = subsolarPoint(JUNE_NOON)
    expect(sunAltitude(sun.lat, sun.lng, sun)).toBeCloseTo(90, 5)
    expect(sunAltitude(-sun.lat, sun.lng + 180, sun)).toBeCloseTo(-90, 5)
  })
})

describe('nightRing', () => {
  it('holds the side of the world facing away from the sun, and not the side facing it', () => {
    const ring = nightRing(JUNE_NOON)
    expect(insideAnyCopy([179, 0], ring)).toBe(true) // the Pacific at midnight
    expect(insideAnyCopy([0, 0], ring)).toBe(false) // the Gulf of Guinea at noon
  })

  it('puts the dark pole inside it: the south in June, the north in December', () => {
    expect(insideAnyCopy([0, -85], nightRing(JUNE_NOON))).toBe(true)
    expect(insideAnyCopy([0, 85], nightRing(JUNE_NOON))).toBe(false)
    expect(insideAnyCopy([0, 85], nightRing(DECEMBER_MIDNIGHT))).toBe(true)
  })

  it('draws deeper twilight as a smaller area inside the first', () => {
    const sunset = nightRing(JUNE_NOON, 0)
    const deep = nightRing(JUNE_NOON, -12)
    // A place just past sunset is in the first band but not the deepest.
    const sun = subsolarPoint(JUNE_NOON)
    const justPast: [number, number] = [sun.lng + 95, 0]
    expect(insideAnyCopy(justPast, sunset)).toBe(true)
    expect(insideAnyCopy(justPast, deep)).toBe(false)
  })

  it('is a closed ring', () => {
    const ring = nightRing(JUNE_NOON)
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })
})

describe('nightGeoJson', () => {
  it('gives a band for every step from sunset to deep night, each with the opacity to draw it at', () => {
    const bands = nightGeoJson(JUNE_NOON)
    expect(bands.features).toHaveLength(NIGHT_STEPS.length)
    for (const band of bands.features) {
      expect(band.properties?.opacity).toBeGreaterThan(0)
      expect(band.properties?.opacity).toBeLessThan(0.5)
    }
  })

  it('makes the middle of the night properly dark, not the day map dulled', () => {
    expect(deepestNight()).toBeGreaterThan(0.75)
    expect(deepestNight()).toBeLessThan(0.9)
  })
})

describe('the night near an equinox', () => {
  // The old way walked each meridian from the dark pole, and with the sun near
  // the equator the pole is barely dark: every band but the first came out
  // empty, for weeks around each equinox.
  const EQUINOX = new Date(Date.UTC(2026, 8, 28, 12, 0, 0))

  it('draws every band, darker ones inside lighter ones', () => {
    const sun = subsolarPoint(EQUINOX)
    expect(Math.abs(sun.lat)).toBeLessThan(5)
    // Across the night side, along the equator: each step deeper is a
    // narrower stretch of it.
    const widths = NIGHT_STEPS.map((below) => {
      const ring = nightRing(EQUINOX, below)
      let inside = 0
      for (let lng = -180; lng < 180; lng += 1) if (insideAnyCopy([lng, 0], ring)) inside += 1
      return inside
    })
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(0)
      expect(widths[i]).toBeLessThan(widths[i - 1])
    }
    // About half the equator is past sunset.
    expect(widths[0]).toBeGreaterThan(170)
    expect(widths[0]).toBeLessThan(190)
  })

  it('puts midnight in the deepest band and noon in none', () => {
    const sun = subsolarPoint(EQUINOX)
    const deepest = nightRing(EQUINOX, NIGHT_STEPS[NIGHT_STEPS.length - 1])
    expect(insideAnyCopy([sun.lng + 180, 0], deepest)).toBe(true)
    expect(insideAnyCopy([sun.lng, 0], nightRing(EQUINOX, 0))).toBe(false)
  })
})

/** Rings keep their longitudes continuous, so a point is tried a world east and west too. */
function insideAnyCopy([lng, lat]: [number, number], ring: Array<[number, number]>) {
  return [-360, 0, 360].some((shift) => inside([lng + shift, lat], ring))
}

describe('darknessAt', () => {
  const date = new Date('2026-09-28T12:00:00Z')
  const { lat, lng } = subsolarPoint(date)

  it('is 0 where the sun is overhead, and full night on the far side', () => {
    expect(darknessAt(lat, lng, date)).toBe(0)
    expect(darknessAt(-lat, lng > 0 ? lng - 180 : lng + 180, date)).toBeCloseTo(deepestNight())
  })

  it('is part way in twilight, as the bands are', () => {
    // Just past sunset: 90 degrees and a little from the sun.
    const dusk = darknessAt(lat, lng + 95, date)
    expect(dusk).toBeGreaterThan(0)
    expect(dusk).toBeLessThan(deepestNight())
  })
})
