import { useEffect, useRef, useState } from 'react'
import maplibregl, {
  type GeoJSONSource,
  type Map as LibreMap,
  type MapGeoJSONFeature,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { nightGeoJson, NIGHT_COLOR } from '../../lib/geo/daylight'
import { FadeBook } from '../../lib/map/fades'
import { namesInEnglish } from '../../lib/map/labels'
import {
  cellFeatures,
  cellRing,
  groupFeatures,
  pinFeatures,
  withNight,
  NIGHT_AT_FLAT,
  GROUP_COLOR,
  type GroupProperties,
  type PinProperties,
} from '../../lib/map/features'
import {
  COUNTRY_MAX_METRES,
  FLAT_FROM,
  GLOBE_UNTIL,
  LITTER_FLOOR,
  LITTER_MAX_METRES,
  toLibreZoom,
  towerHeight,
  viewFromMap,
  type FlyTarget,
  type MapView2,
} from '../../lib/map/view'
import type { NormalisedCell } from '../../lib/severity/percentile'
import type { CleaningGroup, ReportView } from '../../lib/data/types'
import type { WorldLayerId } from '../../lib/worlddata/worldData'

export type { FlyTarget, MapView2 } from '../../lib/map/view'

/**
 * The basemap: OpenFreeMap's "liberty" style. Free, no key, no account, and it
 * allows use from a browser. Its colours are the "rich light" look; the night
 * side is the same map with the dark bands drawn over it.
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

/**
 * The colour of something the app draws, by zoom: its night colour on the
 * globe, easing to its day colour on the same curve as the night itself
 * (NIGHT_OPACITY). See withNight, which works out both for each shape.
 */
export const BY_NIGHT = [
  'interpolate', ['linear'], ['zoom'],
  GLOBE_UNTIL, ['get', 'nightColor'],
  FLAT_FROM, ['get', 'duskColor'],
  FLAT_FROM + 3, ['get', 'color'],
] as const

/** How long the basemap may take to arrive before the map says it could not. */
export const MAP_LOAD_TIMEOUT_MS = 20_000

/**
 * How dark night is, by zoom: full night on the globe, easing off as the map
 * flattens, and gone by street level, where the map is for reading streets.
 */
export const NIGHT_OPACITY = [
  'interpolate', ['linear'], ['zoom'],
  GLOBE_UNTIL, ['get', 'opacity'],
  FLAT_FROM, ['*', NIGHT_AT_FLAT, ['get', 'opacity']],
  FLAT_FROM + 3, 0,
] as const

/** How long anything takes to fade in or out on the map. Matches Reveal. */
export const MAP_FADE_MS = 220

/** A layer of real world data, already turned into shapes to draw. */
export interface WorldOverlay {
  layer: WorldLayerId
  /** Countries for air and plastic; hexagons for fires. */
  features: GeoJSON.FeatureCollection
}

export interface GlobeMapProps {
  initialCenter: [number, number]
  /** In the app's zoom numbers (see lib/map/view). */
  initialZoom: number
  flyTo?: FlyTarget | null
  onViewChange: (view: MapView2) => void
  /** Litter reports, aggregated: drawn as towers on the globe, flat hexagons up close. */
  cells: readonly NormalisedCell[]
  /** Changes when the size of the hexagons changes, which cross-fades the old set into the new. */
  cellsKey: string | number
  /** Individual reports, once close enough to tell them apart. Empty to hide them. */
  pins: readonly ReportView[]
  selectedPinId: string | null
  onPinSelect: (id: string) => void
  /** Empty to hide them. */
  groups: readonly CleaningGroup[]
  selectedGroupId: string | null
  onGroupSelect: (id: string) => void
  world: WorldOverlay | null
  /** An area of litter was picked: its hexagon, and how many reports it holds. */
  onCellSelect: (cell: string, reportCount: number) => void
  /** The area whose reports are listed, outlined on the map. */
  selectedCell: string | null
}

const CELL_LAYERS = ['mo-cells-0', 'mo-cells-1'] as const
const CELL_OPACITY = 0.9

/**
 * World data stands in 3D on the globe, then hands over to a flat tint as the
 * map flattens: once the towers lie flat too, two 3D layers at the same height
 * would flicker against each other. The flat tint is a plain 2D fill, drawn
 * beneath every 3D layer, so the litter always reads on top of it. Light up
 * close: a country coloured solid at street level would hide the streets.
 * `on` scales both curves, which is how the layer fades in and out.
 */
export const worldOpacity = (on: number) => [
  'interpolate', ['linear'], ['zoom'],
  0, 0.85 * on,
  GLOBE_UNTIL, 0.7 * on,
  FLAT_FROM, 0,
]
export const worldFlatOpacity = (on: number) => [
  'interpolate', ['linear'], ['zoom'],
  GLOBE_UNTIL, 0,
  FLAT_FROM, 0.55 * on,
  8, 0.22 * on,
  12, 0.1 * on,
]

/** Both of the world layers' fades, set together. */
const setWorldOpacity = (map: LibreMap, on: number) => {
  map.setPaintProperty('mo-world', 'fill-extrusion-opacity', worldOpacity(on) as never)
  map.setPaintProperty('mo-world-flat', 'fill-opacity', worldFlatOpacity(on) as never)
}

/** Points shrink with the map, so a ring sized for a street does not cover a country on the globe. */
const byZoom = (property: string) => [
  'interpolate', ['linear'], ['zoom'],
  0, ['*', 0.45, ['get', property]],
  FLAT_FROM, ['*', 0.75, ['get', property]],
  10, ['get', property],
]

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] })

/** Show place names in English where the map has them (see namesInEnglish). */
function preferEnglishLabels(map: LibreMap) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue
    const english = namesInEnglish(map.getLayoutProperty(layer.id, 'text-field'))
    if (english) map.setLayoutProperty(layer.id, 'text-field', english as never)
  }
}

/** Plain words for whatever is under the pointer. */
export function describe(feature: Pick<MapGeoJSONFeature, 'properties' | 'layer'>): string | null {
  const p = feature.properties ?? {}
  const layer = feature.layer.id
  if (layer.startsWith('mo-cells')) {
    const n = Number(p.reportCount)
    return n === 1 ? '1 report of litter here' : `${n.toLocaleString()} reports of litter here`
  }
  if (layer.startsWith('mo-world')) {
    if (p.count !== undefined) {
      const n = Number(p.count)
      const when = String(p.when ?? 'today')
      return n === 1 ? `1 hot spot seen here ${when}` : `${n.toLocaleString()} hot spots seen here ${when}`
    }
    const value = Number(p.value)
    const unit = String(p.unit ?? '')
    const shown = value >= 100 ? Math.round(value).toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
    return `${p.name}: ${shown} ${unit} (${p.year})`
  }
  if (layer === 'mo-groups') return `${p.name} · ${Number(p.memberCount) === 1 ? '1 person' : `${p.memberCount} people`}`
  return null
}

/**
 * The map: a globe in space when zoomed out, turning smoothly into a flat map
 * as you come in.
 *
 * Deliberately imperative inside and declarative outside: everything drawn
 * arrives as props, is turned into GeoJSON by lib/map (where it is tested),
 * and is handed to MapLibre here. MapLibre needs a graphics card, so this file
 * is the one part of the map that tests stand in for (see test/globeMapMock).
 */
export function GlobeMap(props: GlobeMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LibreMap | null>(null)
  const ready = useRef(false)
  // What went wrong with the basemap, in plain words, if anything did.
  const [trouble, setTrouble] = useState<'failed' | 'tiles' | null>(null)
  const latest = useRef(props)
  latest.current = props

  const activeCells = useRef(0)
  /** Whether each cell layer is meant to be seen. A faded-out one is cleared, and never picked. */
  const cellsShown = useRef([false, false])
  const clearTimers = useRef<Array<ReturnType<typeof setTimeout> | null>>([null, null])
  const lastCellsKey = useRef<string | number | null>(null)
  const pinBook = useRef(new FadeBook<GeoJSON.Feature<GeoJSON.Point, PinProperties>>((f) => f.properties.id, MAP_FADE_MS))
  const groupBook = useRef(new FadeBook<GeoJSON.Feature<GeoJSON.Point, GroupProperties>>((f) => f.properties.id, MAP_FADE_MS))
  const frame = useRef<number | null>(null)

  // --- drawing ---------------------------------------------------------------

  const animatePoints = () => {
    const map = mapRef.current
    if (!map || frame.current !== null) return
    const tick = (now: number) => {
      frame.current = null
      const moving = [
        { book: pinBook.current, source: 'mo-pins' },
        { book: groupBook.current, source: 'mo-groups' },
      ].map(({ book, source }) => {
        const before = book.shown().length
        const still = book.step(now)
        const shown = book.shown()
        const src = map.getSource(source) as GeoJSONSource | undefined
        if (src && shown.length !== before) {
          src.setData({ type: 'FeatureCollection', features: shown.map((e) => e.item) })
        }
        for (const entry of shown) map.setFeatureState({ source, id: entry.key }, { o: entry.opacity })
        return still
      })
      if (moving.some(Boolean)) frame.current = requestAnimationFrame(tick)
      else {
        pinBook.current.pause()
        groupBook.current.pause()
      }
    }
    frame.current = requestAnimationFrame(tick)
  }

  const drawPoints = (
    source: 'mo-pins' | 'mo-groups',
    book: FadeBook<GeoJSON.Feature<GeoJSON.Point>>,
    features: GeoJSON.Feature<GeoJSON.Point>[],
  ) => {
    const map = mapRef.current
    if (!map || !ready.current) return
    book.set(features)
    const shown = book.shown()
    ;(map.getSource(source) as GeoJSONSource).setData({ type: 'FeatureCollection', features: shown.map((e) => e.item) })
    for (const entry of shown) map.setFeatureState({ source, id: entry.key }, { o: entry.opacity })
    animatePoints()
  }

  const drawCells = () => {
    const map = mapRef.current
    if (!map || !ready.current) return
    const { cells, cellsKey } = latest.current
    const data = withNight(cellFeatures(cells), new Date())
    const transition = { duration: 320, delay: 0 }
    const show = (i: number, data: GeoJSON.FeatureCollection) => {
      const timer = clearTimers.current[i]
      if (timer !== null) clearTimeout(timer)
      clearTimers.current[i] = null
      ;(map.getSource(CELL_LAYERS[i]) as GeoJSONSource).setData(data)
      map.setPaintProperty(CELL_LAYERS[i], 'fill-extrusion-opacity-transition', transition)
      map.setPaintProperty(CELL_LAYERS[i], 'fill-extrusion-opacity', CELL_OPACITY)
      cellsShown.current[i] = true
    }
    // Fade a layer out where it stands, then empty it: an invisible tower
    // left in place would still answer hover and clicks.
    const hide = (i: number) => {
      map.setPaintProperty(CELL_LAYERS[i], 'fill-extrusion-opacity-transition', transition)
      map.setPaintProperty(CELL_LAYERS[i], 'fill-extrusion-opacity', 0)
      cellsShown.current[i] = false
      const timer = clearTimers.current[i]
      if (timer !== null) clearTimeout(timer)
      clearTimers.current[i] = setTimeout(() => {
        clearTimers.current[i] = null
        if (!cellsShown.current[i]) (map.getSource(CELL_LAYERS[i]) as GeoJSONSource | undefined)?.setData(empty())
      }, transition.duration + 50)
    }
    if (lastCellsKey.current !== cellsKey) {
      // A different size of hexagon: the new set rises in the other layer
      // while the old one fades out, instead of swapping in one frame.
      const next = 1 - activeCells.current
      if (cells.length > 0) show(next, data)
      else hide(next)
      hide(activeCells.current)
      activeCells.current = next
      lastCellsKey.current = cellsKey
    } else if (cells.length === 0) {
      // Litter switched off, or nothing here.
      hide(activeCells.current)
    } else {
      show(activeCells.current, data)
    }
  }

  const worldOn = useRef(0)
  const worldFrame = useRef<number | null>(null)

  // The shapes the world layer holds now, so a change can fade them out first.
  const worldShown = useRef<GeoJSON.FeatureCollection | null>(null)

  /**
   * Steps the world layer's fade towards `target`, then calls `done`. A curve
   * over zoom cannot use MapLibre's own transition, so it is stepped here,
   * frame by frame.
   */
  const fadeWorld = (map: LibreMap, target: number, done?: () => void) => {
    if (worldFrame.current !== null) cancelAnimationFrame(worldFrame.current)
    worldFrame.current = null
    let last: number | null = null
    const tick = (now: number) => {
      const dt = last === null ? 16 : now - last
      last = now
      const step = dt / 320
      worldOn.current = target > worldOn.current
        ? Math.min(target, worldOn.current + step)
        : Math.max(target, worldOn.current - step)
      setWorldOpacity(map, worldOn.current)
      if (worldOn.current === target) {
        worldFrame.current = null
        done?.()
      } else worldFrame.current = requestAnimationFrame(tick)
    }
    worldFrame.current = requestAnimationFrame(tick)
  }

  const drawWorld = () => {
    const map = mapRef.current
    if (!map || !ready.current) return
    const { world } = latest.current
    const source = () => map.getSource('mo-world') as GeoJSONSource | undefined
    if (worldShown.current && worldShown.current !== world?.features) {
      // Something else is up: fade it out, empty it -- so a switched-off layer
      // is not hovered -- and then draw whatever is wanted by then. Swapped in
      // one frame, fire hexagons of the old size sat over the new towers.
      fadeWorld(map, 0, () => {
        source()?.setData(empty())
        worldShown.current = null
        drawWorld()
      })
      return
    }
    if (!world) return
    if (!worldShown.current) {
      source()?.setData(withNight(world.features, new Date()))
      worldShown.current = world.features
      // Countries and fires alike stand below the least of the litter towers,
      // so a litter tower always rises out of whatever is under it.
      map.setPaintProperty('mo-world', 'fill-extrusion-height', towerHeight(COUNTRY_MAX_METRES) as never)
    }
    fadeWorld(map, 1)
  }

  const drawPicked = () => {
    const map = mapRef.current
    if (!map || !ready.current) return
    const cell = latest.current.selectedCell
    ;(map.getSource('mo-cell-picked') as GeoJSONSource).setData(
      cell
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: cellRing(cell) } }] }
        : empty(),
    )
  }

  const drawPins = () => {
    const { pins, selectedPinId } = latest.current
    drawPoints('mo-pins', pinBook.current as never, pinFeatures(pins, selectedPinId).features)
  }

  const drawGroups = () => {
    const { groups, selectedGroupId } = latest.current
    drawPoints('mo-groups', groupBook.current as never, groupFeatures(groups, selectedGroupId).features)
  }

  // --- the map itself, once ----------------------------------------------------

  useEffect(() => {
    if (!container.current) return
    const initial = latest.current
    const map = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL as unknown as StyleSpecification,
      center: [initial.initialCenter[1], initial.initialCenter[0]],
      zoom: toLibreZoom(initial.initialZoom),
      attributionControl: { compact: true },
      // Room above the globe for the panels, so it does not sit under them.
      maxPitch: 70,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')

    const report = () => {
      const c = map.getCenter()
      const b = map.getBounds()
      latest.current.onViewChange(
        viewFromMap({
          lat: c.lat,
          lng: c.lng,
          libreZoom: map.getZoom(),
          bounds: { minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() },
        }),
      )
    }

    // The basemap comes from someone else's server. If it never arrives, say so,
    // rather than leaving a black screen with nothing to explain it.
    const gaveUp = window.setTimeout(() => {
      if (!ready.current) setTrouble('failed')
    }, MAP_LOAD_TIMEOUT_MS)
    map.on('error', (e: { sourceId?: string; error?: unknown }) => {
      if (!ready.current) setTrouble('failed')
      // A basemap tile that failed; the app's own layers are local data.
      else if (e.sourceId && !e.sourceId.startsWith('mo-')) setTrouble('tiles')
      // Anything else is the app's own mistake -- a style it drew wrong. A
      // listener here stops MapLibre printing it, so print it.
      else console.error('[map]', e.error ?? e)
    })
    map.on('sourcedata', (e: { sourceId?: string; tile?: unknown }) => {
      // A basemap tile that did arrive: the connection is back.
      if (ready.current && e.tile && e.sourceId && !e.sourceId.startsWith('mo-')) {
        setTrouble((now) => (now === 'tiles' ? null : now))
      }
    })

    map.on('style.load', () => {
      window.clearTimeout(gaveUp)
      setTrouble(null)
      // A globe from space, turning into a flat map between these two zooms.
      map.setProjection({
        type: ['interpolate', ['linear'], ['zoom'], GLOBE_UNTIL, 'vertical-perspective', FLAT_FROM, 'mercator'],
      } as never)
      map.setSky({
        // Black, like space: only a thin glow of atmosphere at the edge.
        'sky-color': '#000000',
        'horizon-color': '#1d4ed8',
        'fog-color': '#000000',
        'sky-horizon-blend': 0.5,
        'horizon-fog-blend': 0.7,
        'fog-ground-blend': 0.9,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, GLOBE_UNTIL, 1, FLAT_FROM + 1, 0],
      } as never)
      preferEnglishLabels(map)
      map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.45, position: [1.4, 210, 40] })

      // Night: the same map, darker, in soft bands from sunset to full night.
      // Beneath the place names, so a city at night can still be read.
      map.addSource('mo-night', { type: 'geojson', data: nightGeoJson(new Date()) })
      const firstLabels = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id
      map.addLayer(
        {
          id: 'mo-night',
          type: 'fill',
          source: 'mo-night',
          // Deep blue-black, so night reads as night, not as the day map greyed.
          paint: { 'fill-color': NIGHT_COLOR, 'fill-opacity': NIGHT_OPACITY as never, 'fill-antialias': false },
        },
        firstLabels,
      )

      // World data, beneath the litter so the litter always reads on top.
      map.addSource('mo-world', { type: 'geojson', data: empty() })
      map.addLayer({
        id: 'mo-world',
        type: 'fill-extrusion',
        source: 'mo-world',
        paint: {
          'fill-extrusion-color': BY_NIGHT as never,
          'fill-extrusion-height': towerHeight(COUNTRY_MAX_METRES) as never,
          'fill-extrusion-opacity': worldOpacity(0) as never,
          'fill-extrusion-vertical-gradient': true,
        },
      })
      // Beneath the place names, like the night, so a tinted country's towns
      // can still be read.
      map.addLayer(
        {
          id: 'mo-world-flat',
          type: 'fill',
          source: 'mo-world',
          paint: { 'fill-color': BY_NIGHT as never, 'fill-opacity': worldFlatOpacity(0) as never },
        },
        firstLabels,
      )

      for (const id of CELL_LAYERS) {
        map.addSource(id, { type: 'geojson', data: empty() })
        map.addLayer({
          id,
          type: 'fill-extrusion',
          source: id,
          paint: {
            'fill-extrusion-color': BY_NIGHT as never,
            'fill-extrusion-height': towerHeight(LITTER_MAX_METRES, LITTER_FLOOR) as never,
            'fill-extrusion-opacity': 0,
            'fill-extrusion-vertical-gradient': true,
          },
        })
      }

      // The area whose reports are listed, outlined.
      map.addSource('mo-cell-picked', { type: 'geojson', data: empty() })
      map.addLayer({
        id: 'mo-cell-picked',
        type: 'line',
        source: 'mo-cell-picked',
        paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.95 },
      })

      map.addSource('mo-groups', { type: 'geojson', data: empty(), promoteId: 'id' })
      map.addLayer({
        id: 'mo-groups',
        type: 'circle',
        source: 'mo-groups',
        paint: {
          'circle-radius': byZoom('radius') as never,
          'circle-color': '#ffffff',
          'circle-opacity': ['*', 0.92, ['coalesce', ['feature-state', 'o'], 0]],
          // A group waiting to be checked has a paler ring.
          'circle-stroke-color': ['case', ['get', 'approved'], GROUP_COLOR, '#6ee7b7'],
          'circle-stroke-width': ['case', ['get', 'selected'], 5, 3],
          'circle-stroke-opacity': ['coalesce', ['feature-state', 'o'], 0],
          'circle-pitch-alignment': 'map',
        },
      })

      map.addSource('mo-pins', { type: 'geojson', data: empty(), promoteId: 'id' })
      map.addLayer({
        id: 'mo-pins',
        type: 'circle',
        source: 'mo-pins',
        paint: {
          'circle-radius': byZoom('radius') as never,
          'circle-color': ['get', 'color'],
          'circle-opacity': ['*', ['get', 'fill'], ['coalesce', ['feature-state', 'o'], 0]],
          'circle-stroke-color': ['get', 'stroke'],
          'circle-stroke-width': ['get', 'strokeWidth'],
          'circle-stroke-opacity': ['coalesce', ['feature-state', 'o'], 0],
          'circle-pitch-alignment': 'map',
        },
      })

      ready.current = true
      drawPicked()
      drawWorld()
      drawCells()
      drawGroups()
      drawPins()
      report()
    })

    map.on('moveend', report)

    // Picking: a pin opens its report, a group its card, a tower brings you in.
    /**
     * Something shown, not something on its way out, under the pointer. The
     * opacity is read from the map itself: features handed to a click do not
     * reliably carry their state, and read from there every marker looked
     * invisible, so none could be picked.
     */
    const pickable = (features: MapGeoJSONFeature[] | undefined) =>
      features?.find((f) => {
        if (f.id === undefined || !f.source) return false
        const state = map.getFeatureState({ source: f.source, id: f.id }) as { o?: number }
        return (state.o ?? 0) > 0.5
      })
    map.on('click', 'mo-pins', (e) => {
      const id = pickable(e.features)?.properties?.id
      if (id !== undefined) latest.current.onPinSelect(String(id))
    })
    map.on('click', 'mo-groups', (e) => {
      const id = pickable(e.features)?.properties?.id
      if (id !== undefined) latest.current.onGroupSelect(String(id))
    })
    for (const id of CELL_LAYERS) {
      map.on('click', id, (e) => {
        // A pin or a group on top of the tower was what was meant.
        const onTop = map.queryRenderedFeatures(e.point, { layers: ['mo-pins', 'mo-groups'] })
        if (pickable(onTop)) return
        if (!cellsShown.current[CELL_LAYERS.indexOf(id)]) return
        const picked = e.features?.[0]?.properties
        if (picked?.cell) latest.current.onCellSelect(String(picked.cell), Number(picked.reportCount) || 0)
      })
    }

    // Plain words for what is under the pointer.
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'mo-hover', offset: 12 })
    const hoverable = ['mo-pins', 'mo-groups', ...CELL_LAYERS, 'mo-world', 'mo-world-flat']
    map.on('mousemove', (e) => {
      const layers = hoverable.filter(
        (id) =>
          map.getLayer(id) &&
          (id.startsWith('mo-world') ? worldOn.current > 0 : CELL_LAYERS.includes(id as never) ? cellsShown.current[CELL_LAYERS.indexOf(id as never)] : true),
      )
      const [feature] = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : []
      const text = feature ? describe(feature) : null
      map.getCanvas().style.cursor = feature ? 'pointer' : ''
      if (text) popup.setLngLat(e.lngLat).setText(text).addTo(map)
      else popup.remove()
    })
    map.on('mouseout', () => popup.remove())

    // The night moves; redraw it once a minute, and what stands in it with it.
    const clock = window.setInterval(() => {
      const now = new Date()
      ;(map.getSource('mo-night') as GeoJSONSource | undefined)?.setData(nightGeoJson(now))
      drawCells()
      if (worldShown.current) (map.getSource('mo-world') as GeoJSONSource | undefined)?.setData(withNight(worldShown.current, now))
    }, 60_000)

    const resize = new ResizeObserver(() => map.resize())
    resize.observe(container.current)

    return () => {
      window.clearTimeout(gaveUp)
      window.clearInterval(clock)
      for (const timer of clearTimers.current) if (timer !== null) clearTimeout(timer)
      if (worldFrame.current !== null) cancelAnimationFrame(worldFrame.current)
      resize.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      popup.remove()
      map.remove()
      mapRef.current = null
      ready.current = false
      worldShown.current = null
    }
  }, [])

  // --- following the props ----------------------------------------------------

  useEffect(drawCells, [props.cells, props.cellsKey])
  useEffect(drawWorld, [props.world])
  useEffect(drawPins, [props.pins, props.selectedPinId])
  useEffect(drawGroups, [props.groups, props.selectedGroupId])
  useEffect(() => drawPicked(), [props.selectedCell])

  const nonce = props.flyTo?.nonce
  useEffect(() => {
    const map = mapRef.current
    const target = latest.current.flyTo
    if (!map || !target) return
    const next = { center: [target.center[1], target.center[0]] as [number, number], zoom: toLibreZoom(target.zoom) }
    // Keyed on the nonce, not the place: asking to go somewhere twice still moves the map.
    // `essential`: MapLibre would otherwise jump for anyone set to reduce
    // motion. Here it flies for everyone, as the rest of the site moves.
    map.flyTo({ ...next, essential: true, speed: 1.4 })
  }, [nonce])

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="mo-globe h-full w-full" data-testid="map" />
      {trouble && (
        <p
          role="alert"
          className="mo-glass absolute bottom-24 left-1/2 z-[999] w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl px-3 py-2 text-center text-xs text-slate-800"
        >
          {trouble === 'failed'
            ? 'The map could not be loaded. Check your connection, then reload the page.'
            : 'Parts of the map could not be loaded. Check your connection.'}
        </p>
      )}
    </div>
  )
}
