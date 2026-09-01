import { useEffect, useRef, useState } from 'react'
import { Polygon } from 'react-leaflet'
import { cellBoundary } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'
import type { NormalisedCell } from '../../lib/severity/percentile'

/** A barely-there wash, so areas with little reported stay effectively clear. */
export const MIN_FILL_OPACITY = 0.12
/** Still translucent at the top, so streets stay readable under the busiest areas. */
export const MAX_FILL_OPACITY = 0.7

/** How long the old cells take to give way to the new ones. */
export const CROSSFADE_MS = 320

export interface CellLayerProps {
  cells: readonly NormalisedCell[]
  minFillOpacity?: number
  maxFillOpacity?: number
  /** Off in tests, and honoured for anyone who has asked for less motion. */
  crossfade?: boolean
}

interface Generation {
  key: number
  cells: readonly NormalisedCell[]
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Draws aggregated cells as filled polygons.
 *
 * Stroke is off deliberately. An outlined hex grid reads as a hard-edged
 * mosaic; fill-only lets neighbouring cells of similar weight blend into one
 * another, which is what makes the transition look continuous rather than
 * tiled.
 *
 * Opacity rises with severity as well as colour. The ramp starts at white, and
 * a flat white wash over every quiet area would fog the whole basemap; fading
 * the quiet end out instead means clean areas simply show the map underneath.
 *
 * Crossing a zoom band swaps every cell for a differently-sized one. Unmounting
 * the old set and mounting the new one in a single frame reads as a flicker, so
 * the outgoing set is held on screen and faded out underneath the incoming one.
 */
export function CellLayer({
  cells,
  minFillOpacity = MIN_FILL_OPACITY,
  maxFillOpacity = MAX_FILL_OPACITY,
  crossfade = true,
}: CellLayerProps) {
  const nextKey = useRef(0)
  const mounted = useRef(false)
  const [generations, setGenerations] = useState<Generation[]>([{ key: 0, cells }])

  useEffect(() => {
    const animate = crossfade && !prefersReducedMotion()

    // Nothing to fade from on the first render. Without this the initial
    // generation is immediately joined by a duplicate of itself, so every
    // cell is drawn twice before anything has even changed.
    if (!mounted.current) {
      mounted.current = true
      return
    }

    if (!animate) {
      setGenerations([{ key: ++nextKey.current, cells }])
      return
    }

    const key = ++nextKey.current
    setGenerations((current) => [...current, { key, cells }])

    // Drop everything the new set replaced, once it has faded in over the top.
    const timer = setTimeout(() => {
      setGenerations((current) => current.filter((g) => g.key === key))
    }, CROSSFADE_MS)

    return () => clearTimeout(timer)
  }, [cells, crossfade])

  return (
    <>
      {generations.map((generation, index) => {
        // Only the newest generation is fully drawn; the ones underneath are on
        // their way out.
        const outgoing = index < generations.length - 1

        return generation.cells.map((cell) => (
          <Polygon
            key={`${generation.key}:${cell.cell}`}
            positions={cellBoundary(cell.cell)}
            pathOptions={{
              fillColor: colorForT(cell.t),
              fillOpacity:
                (minFillOpacity + (maxFillOpacity - minFillOpacity) * cell.t) *
                (outgoing ? 0.35 : 1),
              stroke: false,
              className: outgoing ? 'mo-cell mo-cell--leaving' : 'mo-cell',
            }}
          />
        ))
      })}
    </>
  )
}
