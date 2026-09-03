import { Fragment, useEffect, useRef, useState } from 'react'
import { Polygon } from 'react-leaflet'
import { cellBoundary } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'
import type { NormalisedCell } from '../../lib/severity/percentile'

/** A barely-there wash, so areas with little reported stay effectively clear. */
export const MIN_FILL_OPACITY = 0.12
/** Still translucent at the top, so streets stay readable under the busiest areas. */
export const MAX_FILL_OPACITY = 0.7

/**
 * How long the old cells take to give way to the new ones.
 *
 * Must match the transition duration in index.css. There is a test pinning the
 * two together, because a silent mismatch means the outgoing layer is deleted
 * part-way through its fade — a visible step across the whole map.
 */
export const CROSSFADE_MS = 320

export interface CellLayerProps {
  cells: readonly NormalisedCell[]
  /**
   * Changes only when the map crosses a zoom band.
   *
   * The fade is keyed on this rather than on the identity of `cells`, because
   * `cells` is a fresh array after every pan and every filter change. Fading on
   * those made the whole map pulse darker each time you dragged it — the
   * outgoing copy of an identical cell sitting under the incoming one.
   */
  fadeKey?: string | number
  minFillOpacity?: number
  maxFillOpacity?: number
  /** Off in tests, and ignored for anyone who has asked for less motion. */
  crossfade?: boolean
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const opacityFor = (t: number, min: number, max: number) => min + (max - min) * t

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
 * Crossing a zoom band swaps every cell for a differently-sized one, which in a
 * single frame reads as a flicker. The outgoing set is held on screen and
 * driven to zero while the incoming set rises from zero over the top.
 *
 * The animation is done purely by changing `fillOpacity`. Leaflet applies
 * `className` only when it first creates a path and ignores it on later style
 * updates, so a class-swap approach never reaches the DOM at all.
 */
export function CellLayer({
  cells,
  fadeKey,
  minFillOpacity = MIN_FILL_OPACITY,
  maxFillOpacity = MAX_FILL_OPACITY,
  crossfade = true,
}: CellLayerProps) {
  const previousKey = useRef(fadeKey)
  const previousCells = useRef(cells)

  // The set on its way out, and how far through the fade it is.
  const [outgoing, setOutgoing] = useState<readonly NormalisedCell[] | null>(null)
  const [arrived, setArrived] = useState(true)

  useEffect(() => {
    // Deliberately NOT keyed on `cells`.
    //
    // Listing it here meant every refetch -- a pan, a filter change -- ran this
    // effect's cleanup, which cancelled the timer that ends the fade. The
    // outgoing set then stayed on screen indefinitely, stacked under the new
    // one, which is worse than not fading at all.
    if (fadeKey === previousKey.current) return
    previousKey.current = fadeKey

    const leaving = previousCells.current

    // Cancel any fade already running before deciding not to start a new one.
    // React runs the previous cleanup first, so an early return here used to
    // leave the outgoing set with no timer to remove it -- stranded on the map
    // for good, invisible but still re-projected on every pan.
    const stop = () => {
      setOutgoing(null)
      setArrived(true)
    }

    if (!crossfade || prefersReducedMotion() || leaving.length === 0) {
      stop()
      return
    }

    // Nothing to fade between if both sides are the same data. This happens
    // when the key changes before the new cells have arrived, and fading a set
    // against itself dips the combined alpha -- a pulse across the whole map,
    // the exact artefact this is here to prevent.
    if (leaving === cells) {
      stop()
      return
    }

    // Exactly one outgoing set, always the immediately previous one. Keeping a
    // stack meant a fast wheel-zoom across several bands piled up layers of
    // mismatched hexagons, each adding more alpha over the same ground.
    setOutgoing(leaving)
    setArrived(false)

    // A second commit is what makes it a fade rather than a snap: the incoming
    // set mounts at zero and only then rises, and the outgoing set is driven to
    // zero rather than being culled part-way down.
    const raf = requestAnimationFrame(() => setArrived(true))
    const timer = setTimeout(() => setOutgoing(null), CROSSFADE_MS)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
    // `cells` is read above but deliberately not a dependency: this effect must
    // run only when the zoom band changes. The closure already holds the cells
    // from that render, which is exactly what the comparison needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeKey, crossfade])

  // Declared after the fade effect on purpose: effects run in order, so the one
  // above still sees the previous set when both change in the same commit.
  useEffect(() => {
    previousCells.current = cells
  }, [cells])

  const draw = (
    set: readonly NormalisedCell[],
    generation: string,
    scale: number,
  ) => (
    <Fragment key={generation}>
      {set.map((cell) => (
        <Polygon
          key={cell.cell}
          positions={cellBoundary(cell.cell)}
          pathOptions={{
            fillColor: colorForT(cell.t),
            fillOpacity: opacityFor(cell.t, minFillOpacity, maxFillOpacity) * scale,
            stroke: false,
            className: 'mo-cell',
          }}
        />
      ))}
    </Fragment>
  )

  return (
    <>
      {/* Keyed fragments, so collapsing to one generation does not renumber the
          survivor's children and force Leaflet to rebuild every path. */}
      {outgoing && draw(outgoing, 'leaving', arrived ? 0 : 1)}
      {draw(cells, String(fadeKey ?? 'only'), outgoing && !arrived ? 0 : 1)}
    </>
  )
}
