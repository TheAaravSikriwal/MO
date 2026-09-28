/**
 * Where on Earth it is night, for shading the globe.
 *
 * Worked out from where the sun is overhead at a given moment. The dark side is
 * drawn as a stack of bands, each a little darker: from sunset, through
 * twilight, to full night. Together they make the change from day to night a
 * gradient, and the middle of the night side properly dark, the way it looks
 * from space, rather than the day map dulled.
 */

const RAD = Math.PI / 180

/** Where the sun is directly overhead: its latitude and longitude, in degrees. */
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const dayOfYear = (date.getTime() - start) / 864e5
  // The tilt of the Earth's axis, through the year. Close enough to draw.
  const lat = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * RAD)
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  // Noon at Greenwich puts the sun over longitude 0, and it moves west 15 degrees an hour.
  let lng = 180 - hours * 15
  if (lng > 180) lng -= 360
  if (lng < -180) lng += 360
  return { lat, lng }
}

/** How high the sun is above the horizon at a place, in degrees. Below 0 is night. */
export function sunAltitude(lat: number, lng: number, sun: { lat: number; lng: number }): number {
  const sinAlt =
    Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) +
    Math.cos(lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos((lng - sun.lng) * RAD)
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD
}

/**
 * The area where the sun is lower than `below` degrees, as one closed ring.
 *
 * Every such area is a circle on the globe, centred on the point directly
 * opposite the sun, with a radius of 90 + `below` degrees. The circle is walked
 * point by point with the longitudes kept continuous rather than wrapped, so a
 * ring that crosses the 180th meridian is still one piece. When the circle
 * takes in a pole (as the night does for months at a time) it is closed round
 * that pole.
 */
export function nightRing(date: Date, below = 0, step = 3): Array<[number, number]> {
  const sun = subsolarPoint(date)
  const centre = { lat: -sun.lat, lng: sun.lng + 180 }
  const radius = (90 + below) * RAD
  const lat1 = centre.lat * RAD
  const ring: Array<[number, number]> = []
  let previous: number | null = null
  for (let bearing = 0; bearing < 360; bearing += step) {
    const b = bearing * RAD
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(radius) + Math.cos(lat1) * Math.sin(radius) * Math.cos(b))
    let lng2 =
      centre.lng +
      Math.atan2(Math.sin(b) * Math.sin(radius) * Math.cos(lat1), Math.cos(radius) - Math.sin(lat1) * Math.sin(lat2)) / RAD
    // Keep longitudes continuous from one point to the next.
    if (previous !== null) {
      while (lng2 - previous > 180) lng2 -= 360
      while (lng2 - previous < -180) lng2 += 360
    }
    previous = lng2
    ring.push([lng2, lat2 / RAD])
  }
  // A pole is inside when the centre is nearer to it than the radius.
  const toNorth = 90 - centre.lat
  const toSouth = 90 + centre.lat
  const pole = toNorth < 90 + below ? 89.9 : toSouth < 90 + below ? -89.9 : null
  if (pole !== null) {
    // Walked by bearing, the edge runs all the way round in longitude. Order it
    // by longitude and close it round the pole.
    ring.sort((a, b) => a[0] - b[0])
    const [first] = ring
    // Round the full turn: without this the edge stops one step short of
    // where it began, and leaves a sliver of night undrawn.
    const round: [number, number] = [first[0] + 360, first[1]]
    return [...ring, round, [round[0], pole], [first[0], pole], first]
  }
  return [...ring, ring[0]]
}

export interface NightBand {
  /** How far below the horizon the sun is inside this band, in degrees. */
  below: number
  opacity: number
  ring: Array<[number, number]>
}

/**
 * The bands of the night, from sunset to astronomical night (18 degrees below
 * the horizon), one degree apart. Each is drawn over the one before, so the
 * darkness builds smoothly towards the middle -- steps this fine read as a
 * gradient, not as stripes -- and the deepest part of the night side comes to
 * about four-fifths dark.
 */
export const NIGHT_STEPS = Array.from({ length: 19 }, (_, i) => -i)
export const NIGHT_BAND_OPACITY = 0.082

export function nightBands(date: Date): NightBand[] {
  return NIGHT_STEPS.map((below) => ({ below, opacity: NIGHT_BAND_OPACITY, ring: nightRing(date, below) }))
}

/** The bands as GeoJSON, one polygon each, with the opacity to draw it at. */
export function nightGeoJson(date: Date): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    type: 'FeatureCollection',
    features: nightBands(date).map((band) => ({
      type: 'Feature',
      properties: { opacity: band.opacity, below: band.below },
      geometry: { type: 'Polygon', coordinates: [band.ring] },
    })),
  }
}

/** The colour night is drawn in: deep blue-black, so it reads as night. */
export const NIGHT_COLOR = '#01040f'

/**
 * How dark it is at one place: exactly as dark as the bands stacked over it,
 * from 0 in daylight to deepestNight() in full night. For darkening what the
 * app draws on top of the night, so a tower on the night side is in the dark
 * too rather than standing in daylight colours.
 */
export function darknessAt(lat: number, lng: number, date: Date): number {
  const altitude = sunAltitude(lat, lng, subsolarPoint(date))
  const over = NIGHT_STEPS.filter((below) => altitude < below).length
  return 1 - (1 - NIGHT_BAND_OPACITY) ** over
}

/** How dark the deepest night is, with every band stacked. */
export function deepestNight(): number {
  return 1 - (1 - NIGHT_BAND_OPACITY) ** NIGHT_STEPS.length
}
