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
 * two together, because a silent mismatch means the outgoing layer is removed
 * part-way through its fade — a visible step across the whole map.
 */
export const CROSSFADE_MS = 320

/** The class index.css animates. See the note in `draw` for why it is a top-level prop. */
export const CELL_CLASS = 'mo-cell'

export interface CellLayerProps {
  cells: readonly NormalisedCell[]
  /**
   * Changes only when the map crosses a zoom band.
   *
   * Keyed on this rather than on the identity of `cells`, which is a fresh
   * array after every pan and every filter change. Fading on those made the
   * whole map pulse darker whenever it was dragged.
   */
  fadeKey?: string | number
  minFillOpacity?: number
  maxFillOpacity?: number
  /** Off in tests, and ignored for anyone who has asked for less motion. */
  crossfade?: boolean
}

interface Generation {
  id: number
  cells: readonly NormalisedCell[]
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
  const nextId = useRef(0)

  /**
   * The set on screen, held in state rather than read straight from props.
   *
   * Rendering props directly meant that between a band change and the effect
   * that handles it, React drew the NEW cells under the OLD generation id --
   * destroying the set that was about to become the outgoing one, so it
   * remounted at full opacity instead of fading.
   */
  const [current, setCurrent] = useState<Generation>({ id: 0, cells })
  const [outgoing, setOutgoing] = useState<Generation | null>(null)
  const [arrived, setArrived] = useState(true)

  useEffect(() => {
    // Cancelling comes first, and outside the key check.
    //
    // React runs the previous cleanup before re-running this effect, so any
    // path that returns without rescheduling leaves the outgoing set with no
    // timer to remove it — stranded on the map, invisible but still
    // re-projected on every pan. Turning motion off mid-fade took exactly that
    // path, because it changes `crossfade` without changing `fadeKey`.
    const stop = () => {
      setOutgoing(null)
      setArrived(true)
    }

    if (!crossfade || prefersReducedMotion()) {
      stop()
      previousKey.current = fadeKey
      return
    }

    // Deliberately NOT keyed on `cells`. Listing it meant every refetch — a
    // pan, a filter change — ran this effect's cleanup, cancelling the timer
    // that ends the fade and leaving the outgoing set on screen for good.
    if (fadeKey === previousKey.current) return
    previousKey.current = fadeKey

    const leaving = previousCells.current

    // Nothing to fade between if there is no previous set, or if both sides are
    // the same data. Fading a set against itself dips the combined alpha — a
    // pulse across the whole map, the exact artefact this is here to prevent.
    if (leaving.length === 0 || leaving === cells) {
      stop()
      return
    }

    // The set that was current becomes the outgoing one, keeping its id.
    //
    // A fixed key meant a second band crossing inside one fade renumbered the
    // mid-rise set, so React tore down its Leaflet layers and rebuilt them at
    // full opacity — a jump to full brightness before fading out again.
    setOutgoing({ id: current.id, cells: leaving })
    setCurrent({ id: ++nextId.current, cells })
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
    // `cells` and `current` are read above but deliberately not dependencies:
    // this must run only when the zoom band changes, or when motion is turned
    // off. The closure already holds the values from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeKey, crossfade])

  // Declared after the fade effect on purpose: effects run in order, so the one
  // above still sees the previous set when both change in the same commit.
  useEffect(() => {
    previousCells.current = cells
    // Keep the visible set in step with new data that did not cross a band --
    // a pan, or a filter change. The id stays put, so nothing remounts.
    setCurrent((c) => (c.cells === cells ? c : { ...c, cells }))
  }, [cells])

  const draw = (generation: Generation, scale: number) => (
    <Fragment key={generation.id}>
      {generation.cells.map((cell) => (
        <Polygon
          key={cell.cell}
          positions={cellBoundary(cell.cell)}
          // Top level, NOT inside pathOptions.
          //
          // react-leaflet hands the constructor `{pathOptions, pane, ...}`, so a
          // className nested inside pathOptions is still undefined when Leaflet
          // creates the path — and _initPath is the only place Leaflet ever
          // applies it. setStyle, which runs afterwards, never touches the
          // class. Nested, the stylesheet rule matched nothing in a production
          // build and every "fade" was a hard cut; it only appeared to work in
          // dev, where StrictMode remounts each layer.
          className={CELL_CLASS}
          pathOptions={{
            fillColor: colorForT(cell.t),
            fillOpacity: opacityFor(cell.t, minFillOpacity, maxFillOpacity) * scale,
            stroke: false,
          }}
        />
      ))}
    </Fragment>
  )

  // Rendered as an ARRAY, not as two sibling expressions.
  //
  // React matches `<>{a}{b}</>` by position; keys only govern identity inside
  // an array. As siblings, the set that was current moved from the second slot
  // to the first when it became the outgoing one, so React tore it down and
  // rebuilt its Leaflet layers at full opacity mid-fade.
  const layers: Array<{ generation: Generation; scale: number }> = []
  if (outgoing) layers.push({ generation: outgoing, scale: arrived ? 0 : 1 })
  layers.push({ generation: current, scale: outgoing && !arrived ? 0 : 1 })

  return <>{layers.map(({ generation, scale }) => draw(generation, scale))}</>
}
