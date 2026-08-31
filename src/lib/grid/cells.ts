import { latLngToCell, cellToParent, cellToBoundary } from 'h3-js'

/**
 * The resolutions persisted with every report.
 *
 * r12 is the precision floor — everything is stored there. The coarser five exist
 * only so display rollup can be a plain indexed GROUP BY, with no Postgres H3
 * extension required. Store fine, display aggregated.
 */
export const STORED_RESOLUTIONS = [1, 3, 5, 7, 9, 12] as const

export type StoredResolution = (typeof STORED_RESOLUTIONS)[number]
export type CellColumns = Record<`cell_r${StoredResolution}`, string>

/** The finest resolution we store. Never aggregate below this. */
export const FINEST_RESOLUTION = 12

/**
 * Derive the six cell IDs for a point.
 *
 * The r12 cell is computed from the coordinates; the rest are its H3 ancestors.
 * Deriving the coarse cells with cellToParent rather than recomputing each from
 * lat/lng guarantees the columns genuinely nest, which is precisely what makes
 * GROUP BY rollup correct.
 */
export function cellsForPoint(lat: number, lng: number): CellColumns {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`latitude out of range: ${lat}`)
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError(`longitude out of range: ${lng}`)
  }

  const finest = latLngToCell(lat, lng, FINEST_RESOLUTION)

  const columns = {} as CellColumns
  for (const resolution of STORED_RESOLUTIONS) {
    columns[`cell_r${resolution}`] =
      resolution === FINEST_RESOLUTION ? finest : cellToParent(finest, resolution)
  }
  return columns
}

/** The cell's outline as [lat, lng] pairs, ready for a Leaflet polygon. */
export function cellBoundary(cell: string): Array<[number, number]> {
  return cellToBoundary(cell) as Array<[number, number]>
}
