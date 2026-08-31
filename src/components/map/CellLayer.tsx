import { Polygon } from 'react-leaflet'
import { cellBoundary } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'
import type { NormalisedCell } from '../../lib/severity/percentile'

export interface CellLayerProps {
  cells: readonly NormalisedCell[]
  /** Kept below 1 so the streets underneath stay readable. */
  fillOpacity?: number
}

/**
 * Draws aggregated cells as filled polygons.
 *
 * Stroke is off deliberately. An outlined hex grid reads as a hard-edged mosaic;
 * fill-only lets neighbouring cells of similar weight blend into one another,
 * which is what makes the transition look continuous rather than tiled.
 */
export function CellLayer({ cells, fillOpacity = 0.55 }: CellLayerProps) {
  return (
    <>
      {cells.map((cell) => (
        <Polygon
          key={cell.cell}
          positions={cellBoundary(cell.cell)}
          pathOptions={{
            fillColor: colorForT(cell.t),
            fillOpacity,
            stroke: false,
          }}
        />
      ))}
    </>
  )
}
