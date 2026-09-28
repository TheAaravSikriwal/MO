import { getHexagonEdgeLengthAvg, UNITS } from 'h3-js'

/**
 * Below this zoom the map shows aggregated hexagons; at or above it, one dot
 * per report. City level: dots show early, as soon as they can be told apart.
 */
export const PIN_ZOOM_THRESHOLD = 12

/**
 * How close in the map has to be before a new report can be placed. Street
 * level, deliberately further in than where dots first show: a report's pin is
 * where the person is looking, and at city level that is a guess.
 */
export const REPORT_PLACE_ZOOM = 15

/** How many pixels a hexagon's edge is aimed at on screen at the equator, at every zoom. */
export const TARGET_EDGE_PIXELS = 24

/** Metres one pixel covers at zoom 0 on 256-pixel tiles, at the equator. */
const METRES_PER_PIXEL_AT_ZOOM_0 = 156543.03

/** The finest hexagon size drawn; past it, dots. */
const FINEST_DRAWN = 7

/** A hexagon edge's length on screen, in pixels, at a zoom, at the equator. */
export const edgePixels = (resolution: number, zoom: number) =>
  getHexagonEdgeLengthAvg(resolution, UNITS.m) / (METRES_PER_PIXEL_AT_ZOOM_0 / 2 ** zoom)

/**
 * The hexagon size follows the zoom directly, and the zoom alone: at every
 * zoom it is the size whose edge is nearest TARGET_EDGE_PIXELS on screen at
 * the equator.
 *
 * Worked out from h3's own sizes, not written by hand. A size gives way to the
 * next one at the zoom where the two sit either side of the target by the same
 * factor. Each size is about 2.65 times smaller than the last, so every size
 * covers the same 1.4 steps of zoom and swings over the same range on screen,
 * about 15 to 39 pixels at the equator, from the globe to city level.
 *
 * Away from the equator the flat map draws everything larger -- by 1/cos of
 * the latitude, about 1.6 times at London -- and hexagons grow with it, so a
 * hexagon keeps the same size against the streets and towns around it. That
 * is deliberate: the size is set by the zoom, not by where you are looking,
 * so panning north or south never swaps the grid under you.
 */
const BANDS: ReadonlyArray<{ below: number; resolution: number }> = [
  ...Array.from({ length: FINEST_DRAWN - 1 }, (_, i) => {
    const resolution = i + 1
    const here = getHexagonEdgeLengthAvg(resolution, UNITS.m)
    const next = getHexagonEdgeLengthAvg(resolution + 1, UNITS.m)
    // Where edgePixels(resolution) * edgePixels(resolution + 1) = target squared.
    const below = Math.log2((TARGET_EDGE_PIXELS * METRES_PER_PIXEL_AT_ZOOM_0) ** 2 / (here * next)) / 2
    return { below, resolution }
  }),
  { below: PIN_ZOOM_THRESHOLD, resolution: FINEST_DRAWN },
]

/**
 * The H3 resolution to aggregate at for a given map zoom (in the app's zoom
 * numbers). Null at or above PIN_ZOOM_THRESHOLD, where reports show one by one.
 */
export function resolutionForZoom(zoom: number): number | null {
  if (zoom >= PIN_ZOOM_THRESHOLD) return null
  for (const band of BANDS) {
    if (zoom < band.below) return band.resolution
  }
  return null
}
