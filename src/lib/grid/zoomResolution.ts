/** Below this zoom the map shows aggregated cells; at or above it, individual pins. */
export const PIN_ZOOM_THRESHOLD = 15

const BANDS: ReadonlyArray<{ maxZoom: number; resolution: number }> = [
  { maxZoom: 3, resolution: 1 },
  { maxZoom: 6, resolution: 3 },
  { maxZoom: 9, resolution: 5 },
  { maxZoom: 12, resolution: 7 },
  { maxZoom: 14, resolution: 9 },
]

/**
 * The H3 resolution to aggregate at for a given map zoom.
 *
 * Returns null at or above PIN_ZOOM_THRESHOLD, where reports render individually
 * and — per the spec — submitting a new report unlocks.
 */
export function resolutionForZoom(zoom: number): number | null {
  if (zoom >= PIN_ZOOM_THRESHOLD) return null
  for (const band of BANDS) {
    if (zoom <= band.maxZoom) return band.resolution
  }
  return null
}
