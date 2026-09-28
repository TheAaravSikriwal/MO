/**
 * Which country a point is in, and how big each country is: enough geometry
 * to turn the day's fire points into fires per area, country by country.
 * Works on the slimmed Natural Earth outlines in public/data.
 */

type Ring = number[][]

/** Every outer ring and its holes, for a Polygon or MultiPolygon. */
function polygonsOf(geometry: GeoJSON.Geometry): Ring[][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  return []
}

/** Is the point inside the ring? Counting crossings of a line east from it. */
function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inPolygon(lng: number, lat: number, polygon: Ring[]): boolean {
  const [outer, ...holes] = polygon
  return inRing(lng, lat, outer) && !holes.some((hole) => inRing(lng, lat, hole))
}

/** The area inside a ring on a round Earth, in square kilometres. */
function ringArea(ring: Ring): number {
  const R = 6371.0088
  const rad = Math.PI / 180
  let sum = 0
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    sum += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad))
  }
  return Math.abs((sum * R * R) / 2)
}

export interface CountryShape {
  iso: string
  /** Square kilometres, holes taken out. */
  areaKm2: number
  /** West, south, east, north: a quick first test before the exact one. */
  box: [number, number, number, number]
  polygons: Ring[][]
}

/** The countries, ready to be asked which one a point is in. */
export function countryShapes(countries: GeoJSON.FeatureCollection): CountryShape[] {
  return countries.features.flatMap((feature) => {
    const iso = String(feature.properties?.iso ?? '')
    if (!feature.geometry || !/^[A-Z]{3}$/.test(iso)) return []
    const polygons = polygonsOf(feature.geometry)
    if (polygons.length === 0) return []
    const points = polygons.flatMap((p) => p[0])
    const lngs = points.map(([x]) => x)
    const lats = points.map(([, y]) => y)
    const areaKm2 = polygons.reduce(
      (total, [outer, ...holes]) => total + ringArea(outer) - holes.reduce((h, hole) => h + ringArea(hole), 0),
      0,
    )
    return [{ iso, areaKm2, box: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], polygons }]
  })
}

/** The country a point is in, by code, or null at sea or off the outlines. */
export function countryAt(lat: number, lng: number, shapes: readonly CountryShape[]): string | null {
  for (const shape of shapes) {
    const [w, s, e, n] = shape.box
    if (lat < s || lat > n || lng < w || lng > e) continue
    if (shape.polygons.some((polygon) => inPolygon(lng, lat, polygon))) return shape.iso
  }
  return null
}

/**
 * How many of the points fall in each country, per 10,000 square kilometres.
 * Every country is given a figure, 0 where none fell: a quiet day is a figure
 * too, not a gap.
 */
export function perArea(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  shapes: readonly CountryShape[],
): Map<string, number> {
  const counts = new Map(shapes.map((s) => [s.iso, 0]))
  for (const point of points) {
    const iso = countryAt(point.lat, point.lng, shapes)
    if (iso) counts.set(iso, (counts.get(iso) ?? 0) + 1)
  }
  return new Map(shapes.filter((s) => s.areaKm2 > 0).map((s) => [s.iso, (counts.get(s.iso)! / s.areaKm2) * 10_000]))
}
