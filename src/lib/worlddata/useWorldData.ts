import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AIR_POLLUTION_CSV,
  COUNTRIES_URL,
  COUNTRY_COLUMNS,
  FIRES_ENDPOINT,
  OCEAN_PLASTIC_CSV,
  QUALITY_OF_LIFE_CSV,
  SAVED_COPIES,
  SAVED_ON,
  WATER_QUALITY_CSV,
} from './sources'
import {
  countryFeatures,
  fireCellFeatures,
  latestByCountry,
  parseFires,
  valueRange,
  WORLD_LAYERS,
  type Fire,
  type WorldLayerId,
} from './worldData'
import type { WorldOverlay } from '../../components/map/GlobeMap'

export interface WorldLegend {
  /** Lowest, middle and highest figure shown, in the layer's own unit. */
  range: { low: number; middle: number; high: number } | null
  /** How many places or areas are drawn. */
  count: number
  /** The latest year among the figures, where there is one. */
  year: number | null
  /** Set when the live file could not be reached and the saved copy is drawn: the day it was saved. */
  savedOn: string | null
}

export type WorldDataState =
  | { status: 'off' }
  | { status: 'loading'; layer: WorldLayerId }
  | { status: 'ready'; layer: WorldLayerId; overlay: WorldOverlay; legend: WorldLegend }
  /** `retry` asks again at once. */
  | { status: 'failed'; layer: WorldLayerId; message: string; retry: () => void }

export type Fetcher = (url: string) => Promise<string>

/** How long a source may take before the app stops waiting and says so. */
export const WORLD_TIMEOUT_MS = 20_000

export const defaultFetch: Fetcher = async (url) => {
  // A source that never answers would otherwise leave "Loading…" up for good.
  const response = await fetch(url, { signal: AbortSignal.timeout(WORLD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${response.status}`)
  return response.text()
}

/** What a source gives: countries ready to draw, or fires to group at whatever size the litter is. */
type Loaded =
  | { kind: 'countries'; overlay: WorldOverlay; legend: WorldLegend }
  | { kind: 'fires'; fires: Fire[]; savedOn: string | null }

/**
 * Each layer is fetched once and kept, so switching between them is instant
 * after the first time. A failure is not kept: asking again retries. Kept for
 * an hour only: fires, since they are "today's" and a tab left open all day
 * would otherwise go on showing the morning's file; and a saved copy of any
 * layer, so the live file is tried again once it may be back.
 */
const cache = new Map<WorldLayerId, { at: number; pending: Promise<Loaded>; saved: boolean }>()
export const FIRES_KEPT_MS = 60 * 60 * 1000

/** How often a layer left on is asked for again; a kept, fresh one answers at once. */
export const WORLD_RECHECK_MS = FIRES_KEPT_MS + 1000

/**
 * The live file, or failing that the copy saved with the app, said as such. A
 * live file that arrives but cannot be read -- it changed shape, say -- counts
 * as not reached. Only when both fail is the layer a failure.
 */
async function build(layer: WorldLayerId, get: Fetcher): Promise<Loaded> {
  try {
    return await buildFrom(layer, get, null)
  } catch {
    return buildFrom(layer, get, SAVED_ON)
  }
}

/** Where each layer's live file is. */
const LIVE: Record<WorldLayerId, string> = {
  air: AIR_POLLUTION_CSV,
  plastic: OCEAN_PLASTIC_CSV,
  fires: FIRES_ENDPOINT,
  life: QUALITY_OF_LIFE_CSV,
  water: WATER_QUALITY_CSV,
}

async function buildFrom(layer: WorldLayerId, get: Fetcher, savedOn: string | null): Promise<Loaded> {
  const unit = WORLD_LAYERS[layer].unit
  const source = savedOn ? SAVED_COPIES[layer] : LIVE[layer]
  if (layer === 'fires') {
    const fires = parseFires(await get(source))
    if (fires.length === 0) throw new Error('no fires in the file')
    return { kind: 'fires', fires, savedOn }
  }
  const [csv, countriesText] = await Promise.all([get(source), get(COUNTRIES_URL)])
  const values = latestByCountry(csv, COUNTRY_COLUMNS[layer])
  const countries = JSON.parse(countriesText) as GeoJSON.FeatureCollection
  const features = countryFeatures(countries, values, layer)
  // Nothing to draw -- the file changed shape, say -- is a failure to load,
  // not an empty world, and is said as one.
  if (features.features.length === 0) throw new Error('no countries could be read from the file')
  // The unit travels with each country, for the words shown on hover.
  for (const f of features.features) (f.properties as unknown as Record<string, unknown>).unit = unit
  const years = features.features.map((f) => f.properties.year)
  return {
    kind: 'countries',
    overlay: { layer, features },
    legend: {
      range: valueRange(features.features.map((f) => f.properties.value)),
      count: features.features.length,
      year: years.length ? Math.max(...years) : null,
      savedOn,
    },
  }
}

export function loadWorldLayer(layer: WorldLayerId, get: Fetcher = defaultFetch, now: number = Date.now()) {
  const kept = cache.get(layer)
  const stale = kept !== undefined && (layer === 'fires' || kept.saved) && now - kept.at > FIRES_KEPT_MS
  if (kept && !stale) return kept.pending
  const pending = build(layer, get)
  const entry = { at: now, pending, saved: false }
  cache.set(layer, entry)
  pending.then(
    (loaded) => {
      entry.saved = (loaded.kind === 'fires' ? loaded.savedOn : loaded.legend.savedOn) !== null
    },
    () => {
      if (cache.get(layer) === entry) cache.delete(layer)
    },
  )
  return pending
}

/** For tests: forget everything fetched. */
export function forgetWorldData() {
  cache.clear()
}

/** Fires grouped into the given size of hexagon, with the legend to match. */
export function firesAt(
  fires: readonly Fire[],
  resolution: number,
  savedOn: string | null = null,
): { overlay: WorldOverlay; legend: WorldLegend } {
  const features = fireCellFeatures(fires, resolution, savedOn)
  return {
    overlay: { layer: 'fires', features },
    legend: { range: valueRange(features.features.map((f) => f.properties.count)), count: fires.length, year: null, savedOn },
  }
}

type LoadState =
  | { status: 'off' }
  | { status: 'loading'; layer: WorldLayerId }
  | { status: 'ready'; layer: WorldLayerId; loaded: Loaded }
  | { status: 'failed'; layer: WorldLayerId; message: string }

/**
 * The chosen world layer, loaded. Says so plainly when a source cannot be
 * reached, rather than drawing an empty globe that looks like a clean one.
 *
 * `resolution` is the litter's hexagon size at this zoom. Fires are grouped
 * into the same hexagons, so the two layers stand on one grid rather than
 * big and small hexagons overlapping each other.
 */
export function useWorldData(layer: WorldLayerId | null, resolution: number, get: Fetcher = defaultFetch): WorldDataState {
  const [state, setState] = useState<LoadState>({ status: 'off' })
  // Held, not depended on: a caller passing a fresh function every render
  // would otherwise start a new load every render, for ever.
  const getRef = useRef(get)
  getRef.current = get
  // Bumped to ask again: by the hourly check while a layer stays on, and by
  // "Try again" after a failure.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    if (!layer) return
    const timer = window.setInterval(retry, WORLD_RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [layer, retry])
  const shownLayer = state.status === 'ready' ? state.layer : null
  useEffect(() => {
    if (!layer) {
      setState({ status: 'off' })
      return
    }
    let live = true
    // Asking again for what is on screen keeps it there until the new answer
    // arrives, rather than blanking the globe to "Loading…" once an hour.
    if (shownLayer !== layer) setState({ status: 'loading', layer })
    loadWorldLayer(layer, getRef.current)
      .then((loaded) => {
        if (live) setState((now) => (now.status === 'ready' && now.loaded === loaded ? now : { status: 'ready', layer, loaded }))
      })
      .catch(() => {
        if (live) {
          setState({
            status: 'failed',
            layer,
            message: `Could not load ${WORLD_LAYERS[layer].inSentence} right now. Please try again.`,
          })
        }
      })
    return () => {
      live = false
    }
    // shownLayer is read, not depended on: it changes as a result of this.
  }, [layer, attempt])
  const fireLoad = state.status === 'ready' && state.loaded.kind === 'fires' ? state.loaded : null
  const grouped = useMemo(
    () => (fireLoad ? firesAt(fireLoad.fires, resolution, fireLoad.savedOn) : null),
    [fireLoad, resolution],
  )
  // Said at once, not a frame later once the effect runs: for that one frame
  // the state still held the last layer, and the panel drew the new layer's
  // name over the old one's figures.
  if (!layer) return { status: 'off' }
  if (state.status === 'off' || state.layer !== layer) return { status: 'loading', layer }
  if (state.status === 'failed') return { ...state, retry }
  if (state.status !== 'ready') return state
  const { overlay, legend } = state.loaded.kind === 'countries' ? state.loaded : grouped!
  return { status: 'ready', layer: state.layer, overlay, legend }
}
