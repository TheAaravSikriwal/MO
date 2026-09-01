import { describe, it, expect } from 'vitest'
import {
  normaliseBounds,
  wrapLongitude,
  crossesAntimeridian,
  containsPoint,
  boundsAround,
  intersectBounds,
  WHOLE_WORLD,
} from './bounds'

describe('wrapLongitude', () => {
  it('leaves an ordinary longitude alone', () => {
    expect(wrapLongitude(0)).toBe(0)
    expect(wrapLongitude(-0.12)).toBeCloseTo(-0.12)
    expect(wrapLongitude(151.2)).toBeCloseTo(151.2)
  })

  it('wraps past the dateline', () => {
    expect(wrapLongitude(180.1)).toBeCloseTo(-179.9)
    expect(wrapLongitude(-180.1)).toBeCloseTo(179.9)
  })

  it('wraps a whole world of panning', () => {
    expect(wrapLongitude(340)).toBeCloseTo(-20)
    expect(wrapLongitude(380)).toBeCloseTo(20)
    expect(wrapLongitude(-540)).toBeCloseTo(180)
  })

  it('keeps 180 as 180 rather than flipping it to -180', () => {
    expect(wrapLongitude(180)).toBe(180)
  })

  it('copes with nonsense', () => {
    expect(wrapLongitude(Number.NaN)).toBe(0)
  })
})

describe('normaliseBounds', () => {
  it('leaves an ordinary viewport alone', () => {
    // Close rather than exact: wrapping is modular arithmetic on floats.
    const raw = { minLat: 51.4, minLng: -0.2, maxLat: 51.6, maxLng: -0.05 }
    const result = normaliseBounds(raw)
    expect(result.minLat).toBeCloseTo(raw.minLat)
    expect(result.maxLat).toBeCloseTo(raw.maxLat)
    expect(result.minLng).toBeCloseTo(raw.minLng)
    expect(result.maxLng).toBeCloseTo(raw.maxLng)
    expect(crossesAntimeridian(result)).toBe(false)
  })

  it('turns a dateline crossing into the wrapped form the queries handle', () => {
    // Leaflet reports west=179.9, east=180.1 here and never wraps it. Left raw,
    // the query becomes `lng >= 179.9 and lng <= 180.1` and silently drops
    // every report on the negative side -- half the screen.
    const result = normaliseBounds({ minLat: -1, minLng: 179.9, maxLat: 1, maxLng: 180.1 })
    expect(result.minLng).toBeCloseTo(179.9)
    expect(result.maxLng).toBeCloseTo(-179.9)
    expect(crossesAntimeridian(result)).toBe(true)
  })

  it('rescues a viewport panned a whole world east', () => {
    // west=340, east=380 matches nothing on Earth: blank map over real ground.
    const result = normaliseBounds({ minLat: -1, minLng: 340, maxLat: 1, maxLng: 380 })
    expect(result.minLng).toBeCloseTo(-20)
    expect(result.maxLng).toBeCloseTo(20)
    expect(crossesAntimeridian(result)).toBe(false)
  })

  it('collapses anything spanning a full turn to the whole world', () => {
    const result = normaliseBounds({ minLat: -80, minLng: -400, maxLat: 80, maxLng: 400 })
    expect(result.minLng).toBe(-180)
    expect(result.maxLng).toBe(180)
  })

  it('clamps latitude to the poles', () => {
    const result = normaliseBounds({ minLat: -120, minLng: -10, maxLat: 120, maxLng: 10 })
    expect(result.minLat).toBe(-90)
    expect(result.maxLat).toBe(90)
  })

  it('copes with the latitudes arriving the wrong way round', () => {
    const result = normaliseBounds({ minLat: 60, minLng: -10, maxLat: 40, maxLng: 10 })
    expect(result.minLat).toBe(40)
    expect(result.maxLat).toBe(60)
  })
})

describe('containsPoint', () => {
  const london = normaliseBounds({ minLat: 51.4, minLng: -0.2, maxLat: 51.6, maxLng: -0.05 })

  it('accepts a point inside', () => {
    expect(containsPoint(london, 51.5, -0.12)).toBe(true)
  })

  it('rejects a point outside', () => {
    expect(containsPoint(london, 51.5, 2.35)).toBe(false)
    expect(containsPoint(london, 40, -0.12)).toBe(false)
  })

  it('handles a dateline-crossing viewport', () => {
    const across = normaliseBounds({ minLat: -1, minLng: 179.9, maxLat: 1, maxLng: 180.1 })
    // Both of these are genuinely on screen; a plain between test drops the
    // second one.
    expect(containsPoint(across, 0, 179.95)).toBe(true)
    expect(containsPoint(across, 0, -179.95)).toBe(true)
    expect(containsPoint(across, 0, 0)).toBe(false)
  })

  it('accepts anything at all in the whole world', () => {
    expect(containsPoint(WHOLE_WORLD, 51.5, -0.12)).toBe(true)
    expect(containsPoint(WHOLE_WORLD, -33.8, 151.2)).toBe(true)
  })
})

describe('boundsAround', () => {
  it('contains everything within the radius', () => {
    const origin = { lat: 51.5074, lng: -0.1278 }
    const box = boundsAround(origin, 500)
    // A point 400 m north is inside; one 5 km north is not.
    expect(containsPoint(box, origin.lat + 400 / 111_320, origin.lng)).toBe(true)
    expect(containsPoint(box, origin.lat + 5000 / 111_320, origin.lng)).toBe(false)
  })

  it('widens in longitude towards the poles, where degrees are narrower', () => {
    const equator = boundsAround({ lat: 0, lng: 0 }, 1000)
    const arctic = boundsAround({ lat: 70, lng: 0 }, 1000)
    expect(arctic.maxLng - arctic.minLng).toBeGreaterThan(equator.maxLng - equator.minLng)
  })

  it('does not blow up at the pole', () => {
    const box = boundsAround({ lat: 90, lng: 0 }, 1000)
    expect(Number.isFinite(box.minLng)).toBe(true)
    expect(box.maxLat).toBeLessThanOrEqual(90)
  })
})

describe('intersectBounds', () => {
  it('returns the overlap', () => {
    const a = { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 }
    const b = { minLat: 5, minLng: 5, maxLat: 20, maxLng: 20 }
    expect(intersectBounds(a, b)).toEqual({ minLat: 5, minLng: 5, maxLat: 10, maxLng: 10 })
  })

  it('keeps the viewport when the boxes do not overlap', () => {
    // An inverted box would match nothing at all; the wider one only costs a
    // few extra rows.
    const a = { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 }
    const b = { minLat: 50, minLng: 50, maxLat: 60, maxLng: 60 }
    expect(intersectBounds(a, b)).toEqual(a)
  })

  it('keeps the viewport when either box crosses the dateline', () => {
    const across = normaliseBounds({ minLat: -1, minLng: 179.9, maxLat: 1, maxLng: 180.1 })
    const ordinary = { minLat: -1, minLng: -10, maxLat: 1, maxLng: 10 }
    expect(intersectBounds(across, ordinary)).toEqual(across)
  })

  it('never returns a box that excludes something both boxes contained', () => {
    const a = { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 }
    const b = { minLat: 2, minLng: 2, maxLat: 8, maxLng: 8 }
    const result = intersectBounds(a, b)
    expect(containsPoint(result, 5, 5)).toBe(true)
  })
})
