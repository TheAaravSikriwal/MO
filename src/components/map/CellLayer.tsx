import { Polygon } from 'react-leaflet'
import { cellBoundary } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'
import type { NormalisedCell } from '../../lib/severity/percentile'

/** A barely-there wash, so areas with little reported stay effectively clear. */
export const MIN_FILL_OPACITY = 0.12
/** Still translucent at the top, so streets stay readable under the busiest areas. */
export const MAX_FILL_OPACITY = 0.7

export interface CellLayerProps {
  cells: readonly NormalisedCell[]
  minFillOpacity?: number
  maxFillOpacity?: number
}

/**
 * Draws aggregated cells as filled polygons.
 *
 * Stroke is off deliberately. An outlined hex grid reads as a hard-edged mosaic;
 * fill-only lets neighbouring cells of similar weight blend into one another,
 * which is what makes the transition look continuous rather than tiled.
 *
 * Opacity rises with severity as well as colour. The ramp starts at white, and a
 * flat white wash over every quiet area would fog the whole basemap; fading the
 * quiet end out instead means clean areas simply show the map underneath, which
 * is what "clean" should look like.
 */
export function CellLayer({
  cells,
  minFillOpacity = MIN_FILL_OPACITY,
  maxFillOpacity = MAX_FILL_OPACITY,
}: CellLayerProps) {
  return (
    <>
      {cells.map((cell) => (
        <Polygon
          key={cell.cell}
          positions={cellBoundary(cell.cell)}
          pathOptions={{
            fillColor: colorForT(cell.t),
            fillOpacity: minFillOpacity + (maxFillOpacity - minFillOpacity) * cell.t,
            stroke: false,
          }}
        />
      ))}
    </>
  )
}
