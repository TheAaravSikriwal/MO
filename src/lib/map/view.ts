import { normaliseBounds, wrapLongitude, WHOLE_WORLD } from '../geo/bounds'

export interface MapBounds {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

export interface MapPosition {
  center: [number, number]
  zoom: number
}

export interface MapView2 {
  center: [number, number]
  /** In the app's own zoom numbers: see toAppZoom. */
  zoom: number
  bounds: MapBounds
}

/** A fly target that repeats: the nonce makes asking twice for the same place still move the map. */
export interface FlyTarget extends MapPosition {
  nonce: number
}

/**
 * The app's zoom numbers are the ones it was written with: street level at 16,
 * pins from 15, the world at 3. MapLibre draws 512-pixel tiles where those
 * numbers assumed 256, so the same view is one lower there. Everything outside
 * the map keeps the old numbers, and the map converts at the edge.
 */
export const ZOOM_OFFSET = 1
export const toAppZoom = (libreZoom: number) => libreZoom + ZOOM_OFFSET
export const toLibreZoom = (appZoom: number) => appZoom - ZOOM_OFFSET

/**
 * Where the globe turns into a flat map, in MapLibre's zoom. Fully a globe up
 * to the first, fully flat from the second, and a smooth blend between.
 */
export const GLOBE_UNTIL = 3
export const FLAT_FROM = 5

/**
 * What is in view, for asking the data source what to draw.
 *
 * On the globe the whole hemisphere facing you is in view, and MapLibre's own
 * bounds there are an approximation that can miss the edges. So while the
 * globe is showing, the whole world is asked for: at that scale the answer is
 * aggregated anyway.
 */
export function viewFromMap(input: {
  lat: number
  lng: number
  libreZoom: number
  bounds: MapBounds
}): MapView2 {
  const zoom = toAppZoom(input.libreZoom)
  return {
    center: [input.lat, wrapLongitude(input.lng)],
    zoom,
    bounds: input.libreZoom < GLOBE_UNTIL + 0.5 ? WHOLE_WORLD : normaliseBounds(input.bounds),
  }
}

/**
 * The tallest a country stands, and the least a litter tower does. Litter's
 * least is higher, so a litter tower always shows above the country it is in:
 * both are 3D and share one depth, so drawing order alone would not do it.
 */
export const COUNTRY_MAX_METRES = 160_000
export const LITTER_MAX_METRES = 1_200_000
export const LITTER_FLOOR = 0.16

/**
 * How tall a tower stands, as a MapLibre expression, for a feature with a `t`
 * from 0 to 1. Tall on the globe, shrinking as you come in, and flat from the
 * point where the map is flat: up close, a tower hides the streets it is about.
 * Every tower keeps a little height, so the quietest area still shows.
 */
export function towerHeight(maxMetres: number, floor = 0.06): unknown {
  const at = (scale: number) => ['*', ['+', floor, ['*', 1 - floor, ['get', 't']]], maxMetres * scale]
  return ['interpolate', ['linear'], ['zoom'], 0, at(1), GLOBE_UNTIL, at(0.35), FLAT_FROM, 0]
}
