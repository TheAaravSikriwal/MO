export interface Point {
  lat: number
  lng: number
}

const EARTH_RADIUS_M = 6_371_008.8
const toRadians = (degrees: number) => (degrees * Math.PI) / 180

/**
 * Distance between two points in metres, by the haversine formula.
 *
 * Good to well under a percent at any distance MO cares about, and needs no
 * PostGIS round trip — this runs on reports already in memory so "within 2 km
 * of me" filters instantly instead of refetching.
 *
 * Handles the antimeridian for free: the formula works on the difference of
 * longitudes through a cosine, so a hop from +179.9 to -179.9 comes out as the
 * short way round rather than most of the way about the planet.
 */
export function distanceMetres(a: Point, b: Point): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Plain enough to put in front of anyone: "450 m away", "2.4 km away". */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return ''
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m away`
  if (metres < 10_000) return `${(metres / 1000).toFixed(1)} km away`
  return `${Math.round(metres / 1000)} km away`
}
