export interface ViewBounds {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

export const WHOLE_WORLD: ViewBounds = {
  minLat: -90,
  minLng: -180,
  maxLat: 90,
  maxLng: 180,
}

/** Wrap any longitude into -180..180. */
export function wrapLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return 0
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/**
 * Turn Leaflet's raw bounds into something a query can use.
 *
 * Leaflet does NOT wrap longitude. Panning east past the dateline gives you
 * west=179.9, east=180.1; panning a whole world east gives west=340, east=380.
 * Neither ever satisfies `minLng > maxLng`, so code written to detect that
 * never fires — and the raw values match no report on Earth, so the map goes
 * blank over populated ground while the panel reports zero.
 *
 * This wraps both edges back into range, which turns a dateline-crossing
 * viewport into the `minLng > maxLng` form the queries do handle, and collapses
 * anything spanning a full turn to the whole world.
 */
export function normaliseBounds(raw: ViewBounds): ViewBounds {
  const minLat = Math.max(-90, Math.min(90, Math.min(raw.minLat, raw.maxLat)))
  const maxLat = Math.max(-90, Math.min(90, Math.max(raw.minLat, raw.maxLat)))

  // A viewport wider than the globe covers every longitude there is.
  if (Math.abs(raw.maxLng - raw.minLng) >= 360) {
    return { minLat, minLng: -180, maxLat, maxLng: 180 }
  }

  return {
    minLat,
    maxLat,
    minLng: wrapLongitude(raw.minLng),
    maxLng: wrapLongitude(raw.maxLng),
  }
}

/** True when the viewport straddles the dateline, after normalising. */
export const crossesAntimeridian = (bounds: ViewBounds): boolean =>
  bounds.minLng > bounds.maxLng

/** Whether a point falls inside, handling the dateline case. */
export function containsPoint(bounds: ViewBounds, lat: number, lng: number): boolean {
  if (lat < bounds.minLat || lat > bounds.maxLat) return false
  const wrapped = wrapLongitude(lng)
  return crossesAntimeridian(bounds)
    ? wrapped >= bounds.minLng || wrapped <= bounds.maxLng
    : wrapped >= bounds.minLng && wrapped <= bounds.maxLng
}
