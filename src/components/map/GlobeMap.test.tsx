import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { latLngToCell } from 'h3-js'

/**
 * The real GlobeMap, with MapLibre replaced by a stand-in that records what it
 * is asked to do and lets a test fire the map's own events. Everything else in
 * the app tests uses a mock of GlobeMap itself; this is where GlobeMap runs.
 */

type Handler = (e?: unknown) => void

class FakeMap {
  static last: FakeMap
  handlers: Array<{ type: string; layer?: string; fn: Handler }> = []
  layers: Array<{ spec: { id: string; paint?: Record<string, unknown> }; before?: string }> = []
  paint = new Map<string, unknown>()
  state = new Map<string, Record<string, unknown>>()
  rendered: unknown[] = []
  style = { layers: [{ id: 'water', type: 'fill' }, { id: 'road-name', type: 'symbol' }, { id: 'city-name', type: 'symbol' }] }
  constructor() {
    FakeMap.last = this
  }
  on(type: string, a: string | Handler, b?: Handler) {
    if (typeof a === 'function') this.handlers.push({ type, fn: a })
    else this.handlers.push({ type, layer: a, fn: b! })
  }
  fire(type: string, e: unknown = {}, layer?: string) {
    for (const h of this.handlers) if (h.type === type && h.layer === layer) h.fn(e)
  }
  addControl() {}
  setProjection() {}
  setSky() {}
  setLight() {}
  getStyle() {
    return this.style
  }
  getLayoutProperty() {
    return undefined
  }
  setLayoutProperty() {}
  addSource() {}
  /** What each source was last given, and every give in order. */
  data = new Map<string, unknown>()
  given: Array<[string, unknown]> = []
  getSource(id: string) {
    return {
      setData: (value: unknown) => {
        this.data.set(id, value)
        this.given.push([id, value])
      },
    }
  }
  addLayer(spec: { id: string }, before?: string) {
    this.layers.push({ spec, before })
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.spec.id === id)
  }
  setPaintProperty(layer: string, name: string, value: unknown) {
    this.paint.set(`${layer}.${name}`, value)
  }
  setFeatureState(target: { source: string; id: string | number }, value: Record<string, unknown>) {
    const key = `${target.source}/${target.id}`
    this.state.set(key, { ...this.state.get(key), ...value })
  }
  getFeatureState(target: { source: string; id: string | number }) {
    return this.state.get(`${target.source}/${target.id}`) ?? {}
  }
  removeFeatureState() {}
  queryRenderedFeatures() {
    return this.rendered
  }
  getCenter() {
    return { lat: 0, lng: 0 }
  }
  getBounds() {
    return { getSouth: () => -1, getWest: () => -1, getNorth: () => 1, getEast: () => 1 }
  }
  getZoom() {
    return 2
  }
  getCanvas() {
    return { style: {} as Record<string, string> }
  }
  flyTo() {}
  jumpTo() {}
  resize() {}
  remove() {}
}

vi.mock('maplibre-gl', () => {
  class Popup {
    setLngLat() {
      return this
    }
    setText() {
      return this
    }
    addTo() {
      return this
    }
    remove() {}
  }
  class NavigationControl {}
  return { default: { Map: FakeMap, Popup, NavigationControl } }
})
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

const { GlobeMap, MAP_LOAD_TIMEOUT_MS, NIGHT_OPACITY, describe: words } = await import('./GlobeMap')
const { FLAT_FROM, COUNTRY_MAX_METRES, LITTER_MAX_METRES, LITTER_FLOOR, towerHeight } = await import('../../lib/map/view')

const props = () => ({
  initialCenter: [0, 0] as [number, number],
  initialZoom: 2,
  onViewChange: vi.fn(),
  cells: [],
  cellsKey: 'k',
  pins: [],
  selectedPinId: null,
  onPinSelect: vi.fn(),
  groups: [],
  selectedGroupId: null,
  onGroupSelect: vi.fn(),
  world: null,
  onCellSelect: vi.fn(),
  selectedCell: null,
})

/**
 * Runs every animation frame straight away, each 16 ms after the last, so a
 * fade finishes inside the test that starts it.
 */
function framesAtOnce() {
  let clock = 0
  vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => {
    clock += 16
    fn(clock)
    return clock
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('GlobeMap — when the basemap does not arrive', () => {
  it('says so if the map cannot be loaded at all', () => {
    render(<GlobeMap {...props()} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => FakeMap.last.fire('error', { error: new Error('style 503') }))
    expect(screen.getByRole('alert')).toHaveTextContent('The map could not be loaded')
  })

  it('says so if the map is still not there after a while', () => {
    vi.useFakeTimers()
    render(<GlobeMap {...props()} />)
    act(() => vi.advanceTimersByTime(MAP_LOAD_TIMEOUT_MS - 1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('alert')).toHaveTextContent('The map could not be loaded')
  })

  it('says nothing once it has loaded, and says so when later pieces fail, until they come back', () => {
    vi.useFakeTimers()
    render(<GlobeMap {...props()} />)
    act(() => FakeMap.last.fire('style.load'))
    act(() => vi.advanceTimersByTime(MAP_LOAD_TIMEOUT_MS * 2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // One of the app's own layers is not the basemap.
    act(() => FakeMap.last.fire('error', { sourceId: 'mo-pins' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => FakeMap.last.fire('error', { sourceId: 'openmaptiles' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Parts of the map could not be loaded')
    act(() => FakeMap.last.fire('sourcedata', { sourceId: 'openmaptiles', tile: {} }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('GlobeMap — the app’s own map mistakes', () => {
  it('are printed for whoever is building it, not shown to people using it', () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<GlobeMap {...props()} />)
    act(() => FakeMap.last.fire('style.load'))
    act(() => FakeMap.last.fire('error', { error: new Error('bad paint value') }))
    expect(printed).toHaveBeenCalledWith('[map]', expect.objectContaining({ message: 'bad paint value' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    printed.mockRestore()
  })
})

describe('GlobeMap — night', () => {
  it('lies beneath the place names, so a city at night can still be read', () => {
    render(<GlobeMap {...props()} />)
    act(() => FakeMap.last.fire('style.load'))
    const night = FakeMap.last.layers.find((l) => l.spec.id === 'mo-night')!
    expect(night.before).toBe('road-name')
    expect(night.spec.paint?.['fill-opacity']).toBe(NIGHT_OPACITY)
  })

  it('is at full strength on the globe and gone by street level', () => {
    const expr = NIGHT_OPACITY as unknown as unknown[]
    expect(expr.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']])
    expect(expr[4]).toEqual(['get', 'opacity'])
    expect(expr[expr.length - 1]).toBe(0)
    expect(expr[expr.length - 2]).toBeGreaterThan(FLAT_FROM)
  })
})

describe('GlobeMap — picking', () => {
  const pin = { id: 'r1', source: 'mo-pins', properties: { id: 'r1' }, layer: { id: 'mo-pins' } }

  it('opens a pin that is showing, and not one that has faded out', () => {
    const p = props()
    render(<GlobeMap {...p} />)
    act(() => FakeMap.last.fire('style.load'))
    FakeMap.last.fire('click', { features: [pin] }, 'mo-pins')
    expect(p.onPinSelect).not.toHaveBeenCalled()
    FakeMap.last.setFeatureState({ source: 'mo-pins', id: 'r1' }, { o: 1 })
    FakeMap.last.fire('click', { features: [pin] }, 'mo-pins')
    expect(p.onPinSelect).toHaveBeenCalledWith('r1')
  })

  it('lists an area when its tower is clicked, but not through a pin on top of it', () => {
    const cell = latLngToCell(51.5, -0.12, 4)
    const p = { ...props(), cells: [{ cell, weight: 3, reportCount: 4, t: 1 }] }
    render(<GlobeMap {...p} />)
    act(() => FakeMap.last.fire('style.load'))
    const layers = FakeMap.last.layers.map((l) => l.spec.id).filter((id) => id.startsWith('mo-cells'))
    const shown = layers.find((id) => FakeMap.last.paint.get(`${id}.fill-extrusion-opacity`) !== 0)!
    const hidden = layers.find((id) => id !== shown)!
    const click = { point: {}, features: [{ properties: { cell, reportCount: 4 } }] }

    // A shown pin on top of the tower is what was meant.
    FakeMap.last.setFeatureState({ source: 'mo-pins', id: 'r1' }, { o: 1 })
    FakeMap.last.rendered = [pin]
    FakeMap.last.fire('click', click, shown)
    expect(p.onCellSelect).not.toHaveBeenCalled()

    // The layer fading out answers nothing.
    FakeMap.last.rendered = []
    FakeMap.last.fire('click', click, hidden)
    expect(p.onCellSelect).not.toHaveBeenCalled()

    FakeMap.last.fire('click', click, shown)
    expect(p.onCellSelect).toHaveBeenCalledWith(cell, 4)
  })
})

describe('GlobeMap — world data under the litter', () => {
  it('stands fires below the lowest litter tower, as it does countries', () => {
    const world = { layer: 'fires' as const, features: { type: 'FeatureCollection' as const, features: [] } }
    render(<GlobeMap {...props()} world={world} />)
    act(() => FakeMap.last.fire('style.load'))
    expect(FakeMap.last.paint.get('mo-world.fill-extrusion-height')).toEqual(towerHeight(COUNTRY_MAX_METRES))
    expect(COUNTRY_MAX_METRES).toBeLessThan(LITTER_MAX_METRES * LITTER_FLOOR)
  })
})

describe('GlobeMap — the words on hover', () => {
  const world = (properties: Record<string, unknown>) => ({ properties, layer: { id: 'mo-world' } }) as never

  it('says today for live fires, and the saved day for a saved copy', () => {
    expect(words(world({ count: 3, when: 'today' }))).toBe('3 hot spots seen here today')
    expect(words(world({ count: 1, when: 'in the 24 hours to 28 Sep 2026' }))).toBe('1 hot spot seen here in the 24 hours to 28 Sep 2026')
  })
})

describe('GlobeMap — world data on the flat map', () => {
  it('hands over from 3D slabs on the globe to a flat tint, so nothing at one height flickers', async () => {
    const { worldOpacity, worldFlatOpacity } = await import('./GlobeMap')
    const slab = worldOpacity(1) as unknown[]
    const tint = worldFlatOpacity(1) as unknown[]
    // The slabs are gone by the time the map is flat, and the tint is there.
    expect(slab[slab.indexOf(FLAT_FROM) + 1]).toBe(0)
    expect(tint[tint.indexOf(FLAT_FROM) + 1]).toBeGreaterThan(0)
  })

  it('draws the tint as a plain fill, under the litter towers, and fades both together', () => {
    framesAtOnce()
    const world = { layer: 'air' as const, features: { type: 'FeatureCollection' as const, features: [] } }
    render(<GlobeMap {...props()} world={world} />)
    act(() => FakeMap.last.fire('style.load'))
    const ids = FakeMap.last.layers.map((l) => l.spec.id)
    const flat = FakeMap.last.layers.find((l) => l.spec.id === 'mo-world-flat')!
    expect((flat.spec as { type?: string }).type).toBe('fill')
    expect(ids.indexOf('mo-world-flat')).toBeLessThan(ids.indexOf('mo-cells-0'))
    const shown = FakeMap.last.paint.get('mo-world-flat.fill-opacity') as unknown[]
    expect(shown[shown.indexOf(FLAT_FROM) + 1]).toBeGreaterThan(0)
    expect(FakeMap.last.paint.get('mo-world.fill-extrusion-opacity')).toBeDefined()
  })
})

describe('GlobeMap — every layer is one MapLibre accepts', () => {
  it('passes the style validator, with every paint value it sets later', async () => {
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec')
    framesAtOnce()
    const cell = latLngToCell(51.5, -0.12, 4)
    const world = { layer: 'fires' as const, features: { type: 'FeatureCollection' as const, features: [] } }
    render(<GlobeMap {...props()} cells={[{ cell, weight: 3, reportCount: 4, t: 1 }]} world={world} />)
    act(() => FakeMap.last.fire('style.load'))
    const layers = FakeMap.last.layers.map(({ spec }) => {
      const paint = { ...(spec.paint ?? {}) }
      for (const [key, value] of FakeMap.last.paint) {
        const [id, name] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
        if (id === spec.id) paint[name] = value
      }
      return { ...spec, paint }
    })
    const sources = Object.fromEntries(
      layers.map((l) => [(l as { source?: string }).source!, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }]),
    )
    const errors = validateStyleMin({ version: 8, sources, layers } as never)
    expect(errors.map((e) => e.message)).toEqual([])
  })
})

describe('GlobeMap — world data changing while it is shown', () => {
  // Frames run by hand, so a test can look between them.
  let frames: Array<(now: number) => void> = []
  let clock = 0
  const runFrames = (n = 200) => {
    for (let i = 0; i < n && frames.length; i++) {
      const due = frames
      frames = []
      clock += 16
      for (const frame of due) frame(clock)
    }
  }
  beforeEach(() => {
    frames = []
    clock = 0
    vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => (frames.push(fn), frames.length))
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = []
    })
  })

  const collection = (name: string) => ({ type: 'FeatureCollection' as const, features: [], name })
  const worldOf = (name: string) => ({ layer: 'fires' as const, features: collection(name) as never })
  const shownName = () => (FakeMap.last.data.get('mo-world') as { name?: string }).name
  const opacity = () => {
    const expr = FakeMap.last.paint.get('mo-world.fill-extrusion-opacity') as unknown[]
    return expr[4] as number
  }

  it('fades the old shapes out before the new ones go in, then fades those in', () => {
    const first = worldOf('size 2')
    const { rerender } = render(<GlobeMap {...props()} world={first} />)
    act(() => FakeMap.last.fire('style.load'))
    act(() => runFrames())
    expect(shownName()).toBe('size 2')
    expect(opacity()).toBeCloseTo(0.85)

    const second = worldOf('size 3')
    rerender(<GlobeMap {...props()} world={second} />)
    act(() => runFrames(5))
    // Part way: the old shapes, dimmer, and the new ones not in yet.
    expect(shownName()).toBe('size 2')
    expect(opacity()).toBeLessThan(0.85)
    act(() => runFrames())
    expect(shownName()).toBe('size 3')
    expect(opacity()).toBeCloseTo(0.85)
    // The old ones were cleared out before the new went in, never both at once.
    const worldGives = FakeMap.last.given.filter(([id]) => id === 'mo-world').map(([, v]) => (v as { name?: string }).name ?? 'empty')
    expect(worldGives.slice(-3)).toEqual(['size 2', 'empty', 'size 3'])
  })

  it('fades out and empties when switched off, so nothing hidden is hovered', () => {
    const { rerender } = render(<GlobeMap {...props()} world={worldOf('on')} />)
    act(() => FakeMap.last.fire('style.load'))
    act(() => runFrames())
    rerender(<GlobeMap {...props()} world={null} />)
    act(() => runFrames())
    expect(opacity()).toBe(0)
    expect((FakeMap.last.data.get('mo-world') as { features: unknown[] }).features).toEqual([])
  })
})

describe('GlobeMap — what the app draws is in the dark too', () => {
  it('colours towers, slabs and the flat tint by night, and puts the tint under the place names', async () => {
    const { BY_NIGHT } = await import('./GlobeMap')
    render(<GlobeMap {...props()} />)
    act(() => FakeMap.last.fire('style.load'))
    const layer = (id: string) => FakeMap.last.layers.find((l) => l.spec.id === id)!
    for (const id of ['mo-cells-0', 'mo-cells-1', 'mo-world']) {
      expect(layer(id).spec.paint?.['fill-extrusion-color'], id).toBe(BY_NIGHT)
    }
    expect(layer('mo-world-flat').spec.paint?.['fill-color']).toBe(BY_NIGHT)
    expect(layer('mo-world-flat').before).toBe('road-name')
  })

  it('gives each tower its night colours, and works them out again as the night moves', () => {
    framesAtOnce()
    let everyMinute: (() => void) | null = null
    const real = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 60_000) {
        everyMinute = fn
        return 0
      }
      return real(fn, ms)
    }) as typeof window.setInterval)
    const cell = latLngToCell(51.5, -0.12, 4)
    render(<GlobeMap {...props()} cells={[{ cell, weight: 3, reportCount: 4, t: 1 }]} />)
    act(() => FakeMap.last.fire('style.load'))
    const drawn = () =>
      FakeMap.last.given.filter(([id]) => id.startsWith('mo-cells')).map(([, v]) => v as GeoJSON.FeatureCollection)
    const before = drawn().length
    const last = drawn()[before - 1]
    expect(last.features[0].properties).toEqual(expect.objectContaining({ nightColor: expect.any(String), duskColor: expect.any(String) }))
    expect(everyMinute).not.toBeNull()
    act(() => everyMinute!())
    expect(drawn().length).toBeGreaterThan(before)
    vi.restoreAllMocks()
  })
})

describe('GlobeMap — motion for everyone', () => {
  it('flies, and fades the world in, even on a machine set to reduce motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const frames: Array<(now: number) => void> = []
    vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => frames.push(fn))
    const flown = vi.spyOn(FakeMap.prototype, 'flyTo')
    const jumped = vi.spyOn(FakeMap.prototype, 'jumpTo')
    const world = { layer: 'air' as const, features: { type: 'FeatureCollection' as const, features: [] } }
    const { rerender } = render(<GlobeMap {...props()} world={world} />)
    act(() => FakeMap.last.fire('style.load'))
    // The world fades in over frames rather than appearing at once.
    expect(frames.length).toBeGreaterThan(0)
    rerender(<GlobeMap {...props()} world={world} flyTo={{ center: [10, 20], zoom: 3, nonce: 1 }} />)
    expect(flown).toHaveBeenCalledWith(expect.objectContaining({ essential: true }))
    expect(jumped).not.toHaveBeenCalled()
  })
})
