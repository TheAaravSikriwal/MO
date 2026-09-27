import { Fragment, useEffect, useRef, useState } from 'react'
import { Polygon } from 'react-leaflet'
import { cellPositions } from '../../lib/grid/cells'
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
 * two together, because a silent mismatch means a layer is removed part-way
 * through its fade — a visible step across the whole map.
 */
export const CROSSFADE_MS = 320

/** The class index.css animates. See the note in the render for why it is a top-level prop. */
export const CELL_CLASS = 'mo-cell'

/**
 * How many fading layers may overlap.
 *
 * A continuous wheel or pinch zoom steps a level every 60–100 ms and fires a
 * move each time, so several bands can be crossed inside one fade. Keeping only
 * one meant the earlier layer was culled mid-ramp at around half opacity — a
 * flash across the whole viewport, which is the artefact this exists to remove.
 * The cap stops an unbounded pile-up on a long zoom.
 */
export const MAX_LAYERS = 4

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

interface Layer {
  id: number
  cells: readonly NormalisedCell[]
  /** 1 while visible, 0 once on its way out. CSS does the ramp between them. */
  scale: number
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
 * single frame reads as a flicker. Outgoing sets are held on screen and driven
 * to zero while the incoming set rises from zero over the top.
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
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  /**
   * Every set currently drawn, oldest first; the last one is the live set.
   *
   * Held in state rather than read from props: rendering props directly meant
   * that between a band change and the effect handling it, React drew the NEW
   * cells under the OLD layer's id, destroying the set that was about to fade.
   */
  const [layers, setLayers] = useState<Layer[]>([{ id: 0, cells, scale: 1 }])

  useEffect(() => {
    // Collapsing to the live set has to be possible from any exit path.
    //
    // React runs the previous cleanup before re-running this effect, so a path
    // that returns without rescheduling would leave fading layers with no timer
    // to remove them — stranded on the map, invisible but still re-projected on
    // every pan. Turning motion off mid-fade takes exactly that path, because
    // it changes `crossfade` without changing `fadeKey`.
    const collapse = () => {
      for (const timer of timers.current) clearTimeout(timer)
      timers.current.clear()
      setLayers((current) => [{ ...current[current.length - 1], scale: 1 }])
    }

    if (!crossfade || prefersReducedMotion()) {
      collapse()
      previousKey.current = fadeKey
      return
    }

    // Deliberately NOT keyed on `cells`. Listing it meant every refetch — a
    // pan, a filter change — ran this effect's cleanup, cancelling the timers
    // that end the fades and leaving those layers on screen for good.
    if (fadeKey === previousKey.current) return
    previousKey.current = fadeKey

    // Nothing to fade between if both sides are the same data. Fading a set
    // against itself dips the combined alpha — a pulse across the whole map,
    // the exact artefact this is here to prevent.
    if (previousCells.current === cells) {
      collapse()
      return
    }

    const arriving = ++nextId.current

    setLayers((current) => {
      // Everything on screen is now leaving; the newcomer starts at nothing.
      // Older layers are already at 0 and keep ramping down from wherever CSS
      // has them, rather than being culled mid-ramp.
      const leaving = current.map((layer) => ({ ...layer, scale: 0 }))
      return [...leaving, { id: arriving, cells, scale: 0 }].slice(-MAX_LAYERS)
    })

    // A second commit is what makes it a fade rather than a snap: the incoming
    // set mounts at zero and only then rises.
    const raf = requestAnimationFrame(() => {
      setLayers((current) =>
        current.map((layer) => (layer.id === arriving ? { ...layer, scale: 1 } : layer)),
      )
    })

    // Each timer retires the layers ITS crossing set fading, identified by id
    // rather than by position.
    //
    // Removing "the oldest survivor" instead meant that once the cap trimmed a
    // layer, its timer outlived it and the next one fired against a layer still
    // ramping down — culling it mid-fade, the exact thing the cap exists to
    // prevent. Filtering by id makes a surplus timer a harmless no-op.
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setLayers((current) => {
        const kept = current.filter((layer) => layer.id >= arriving)
        return kept.length === 0 ? current.slice(-1) : kept
      })
    }, CROSSFADE_MS)
    timers.current.add(timer)

    return () => {
      cancelAnimationFrame(raf)
    }
    // `cells` is read above but deliberately not a dependency: this must run
    // only when the zoom band changes, or when motion is turned off. The
    // closure already holds the value from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeKey, crossfade])

  // Declared after the fade effect on purpose: effects run in order, so the one
  // above still sees the previous set when both change in the same commit.
  useEffect(() => {
    previousCells.current = cells
    // Keep the live set in step with new data that did not cross a band — a
    // pan, or a filter change. Its id stays put, so nothing remounts.
    setLayers((current) => {
      const live = current[current.length - 1]
      if (live.cells === cells) return current
      return [...current.slice(0, -1), { ...live, cells }]
    })
  }, [cells])

  // Nothing may outlive the component.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return (
    <>
      {/* An ARRAY, not sibling expressions: React matches siblings by position,
          and keys only govern identity inside an array. As siblings, a set
          moving from live to leaving changed slot and was torn down, so Leaflet
          rebuilt it at full opacity mid-fade. */}
      {layers.map((layer) => (
        <Fragment key={layer.id}>
          {layer.cells.map((cell) => (
            <Polygon
              key={cell.cell}
              positions={cellPositions(cell.cell)}
              // Top level, NOT inside pathOptions.
              //
              // react-leaflet hands the constructor `{pathOptions, pane, ...}`,
              // so a className nested inside pathOptions is still undefined
              // when Leaflet creates the path — and _initPath is the only place
              // Leaflet ever applies it. setStyle, which runs afterwards, never
              // touches the class. Nested, the stylesheet rule matched nothing
              // in a production build and every "fade" was a hard cut; it only
              // appeared to work in dev, where StrictMode remounts each layer.
              className={CELL_CLASS}
              pathOptions={{
                fillColor: colorForT(cell.t),
                fillOpacity: opacityFor(cell.t, minFillOpacity, maxFillOpacity) * layer.scale,
                stroke: false,
              }}
            />
          ))}
        </Fragment>
      ))}
    </>
  )
}
