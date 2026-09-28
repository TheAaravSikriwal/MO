import { latLngToCell, cellToParent, getResolution } from 'h3-js'

/**
 * The resolutions persisted with every report.
 *
 * r12 is the precision floor — everything is stored there. The coarser eight
 * exist only so display rollup can be a plain indexed GROUP BY, with no
 * Postgres H3 extension required. Store fine, display aggregated. Every
 * resolution from 1 to 7 is kept, one per step of zoom, so hexagons shrink
 * steadily as you zoom in (see zoomResolution).
 */
export const STORED_RESOLUTIONS = [1, 2, 3, 4, 5, 6, 7, 9, 12] as const

export type StoredResolution = (typeof STORED_RESOLUTIONS)[number]
export type CellColumns = Record<`cell_r${StoredResolution}`, string>

/** The finest resolution we store. Never aggregate below this. */
export const FINEST_RESOLUTION = 12

/**
 * The stored column a cell lives in, such as `cell_r6`. Throws for a size
 * that is not stored, rather than asking the database for a column it lacks.
 */
export function cellColumn(cell: string): keyof CellColumns {
  const resolution = getResolution(cell)
  if (!(STORED_RESOLUTIONS as readonly number[]).includes(resolution)) {
    throw new RangeError(`cells of size ${resolution} are not stored`)
  }
  return `cell_r${resolution}` as keyof CellColumns
}

/**
 * Derive the stored cell IDs for a point.
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
