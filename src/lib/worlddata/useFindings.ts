import { useCallback, useEffect, useState } from 'react'
import {
  AIR_POLLUTION_CSV,
  COUNTRIES_URL,
  COUNTRY_COLUMNS,
  GDP_PER_PERSON_CSV,
  OCEAN_PLASTIC_CSV,
  PLASTIC_PER_PERSON_CSV,
  QUALITY_OF_LIFE_CSV,
  SAVED_COPIES,
  SAVED_ON,
  WATER_QUALITY_CSV,
} from './sources'
import { latestByCountry } from './worldData'
import { defaultFetch, loadWorldLayer, type Fetcher } from './useWorldData'
import { countryShapes, perArea } from '../geo/countries'
import type { CountryTable, MetricId } from './findings'

/** The country figures the findings read, and where each is. */
const FIGURES: Array<{ id: Exclude<MetricId, 'fires'>; live: string; saved: string; column: string }> = [
  { id: 'life', live: QUALITY_OF_LIFE_CSV, saved: SAVED_COPIES.life, column: COUNTRY_COLUMNS.life },
  { id: 'gdp', live: GDP_PER_PERSON_CSV, saved: SAVED_COPIES.gdp, column: COUNTRY_COLUMNS.gdp },
  { id: 'air', live: AIR_POLLUTION_CSV, saved: SAVED_COPIES.air, column: COUNTRY_COLUMNS.air },
  {
    id: 'plasticPerPerson',
    live: PLASTIC_PER_PERSON_CSV,
    saved: SAVED_COPIES.plasticPerPerson,
    column: COUNTRY_COLUMNS.plasticPerPerson,
  },
  { id: 'water', live: WATER_QUALITY_CSV, saved: SAVED_COPIES.water, column: COUNTRY_COLUMNS.water },
]

/** Fewer countries than this from a file means it was not read, not that the world shrank. */
const FEWEST = 20

export interface Findings {
  table: CountryTable
  /** The measures drawn from a saved copy because the live file could not be reached. */
  fromSaved: MetricId[]
  /** The day the saved copies were made, for saying so. */
  savedOn: string
  /** The earliest and latest year among each measure's figures, for the write-up. */
  years: Partial<Record<MetricId, [number, number]>>
  /** The day these figures were read, as YYYY-MM-DD. */
  readOn: string
  /**
   * World totals for the introduction: plastic into the ocean in tonnes a
   * year, summed over every country (NaN if its file could not be read), and
   * fire hot spots seen in the last 24 hours.
   */
  totals: { oceanPlasticTonnes: number; oceanPlasticYear: number; firesToday: number; firesSavedOn: string | null }
}

/** One figure, live if it can be had, else the saved copy; throws if neither reads. */
async function figure(get: Fetcher, source: { id: string; live: string; saved: string; column: string }) {
  for (const [url, saved] of [
    [source.live, false],
    [source.saved, true],
  ] as const) {
    try {
      const values = latestByCountry(await get(url), source.column)
      if (values.size >= FEWEST) return { values, saved }
    } catch {
      // Tried the next.
    }
  }
  throw new Error(`${source.id} could not be read`)
}

/** Every figure, joined country by country. */
export async function loadFindings(get: Fetcher = defaultFetch): Promise<Findings> {
  const [figures, countriesText, fires, ocean] = await Promise.all([
    Promise.all(FIGURES.map((source) => figure(get, source))),
    get(COUNTRIES_URL),
    loadWorldLayer('fires', get),
    // Only for the introduction's total: its failing must not stop the findings.
    figure(get, { id: 'plastic', live: OCEAN_PLASTIC_CSV, saved: SAVED_COPIES.plastic, column: COUNTRY_COLUMNS.plastic }).catch(
      () => null,
    ),
  ])
  const table: CountryTable = new Map()
  const fromSaved: MetricId[] = []
  const years: Findings['years'] = {}
  FIGURES.forEach((source, i) => {
    const { values, saved } = figures[i]
    if (saved) fromSaved.push(source.id)
    let [first, last] = [Infinity, -Infinity]
    for (const [iso, { name, value, year }] of values) {
      const row = table.get(iso) ?? { name }
      row[source.id] = value
      table.set(iso, row)
      first = Math.min(first, year)
      last = Math.max(last, year)
    }
    years[source.id] = [first, last]
  })
  if (fires.kind === 'fires') {
    if (fires.savedOn) fromSaved.push('fires')
    const shapes = countryShapes(JSON.parse(countriesText) as GeoJSON.FeatureCollection)
    for (const [iso, density] of perArea(fires.fires, shapes)) {
      const row = table.get(iso)
      // Only for countries the other files know: an outline with no figures
      // at all would add nothing to any link.
      if (row) row.fires = density
    }
  }
  const oceanValues = ocean ? [...ocean.values.values()] : []
  const totals = {
    oceanPlasticTonnes: ocean ? oceanValues.reduce((sum, v) => sum + v.value, 0) : Number.NaN,
    oceanPlasticYear: oceanValues.length ? Math.max(...oceanValues.map((v) => v.year)) : Number.NaN,
    firesToday: fires.kind === 'fires' ? fires.fires.length : Number.NaN,
    firesSavedOn: fires.kind === 'fires' ? fires.savedOn : null,
  }
  return { table, fromSaved, savedOn: SAVED_ON, years, readOn: new Date().toISOString().slice(0, 10), totals }
}

let kept: Promise<Findings> | null = null

/** For tests: forget what was loaded. */
export function forgetFindings() {
  kept = null
}

export type FindingsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; findings: Findings }
  | { status: 'failed'; message: string; retry: () => void }

/** The findings, loaded once the section is opened, and kept after. */
export function useFindings(open: boolean, get: Fetcher = defaultFetch): FindingsState {
  const [state, setState] = useState<FindingsState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    kept = null
    setAttempt((n) => n + 1)
  }, [])
  useEffect(() => {
    if (!open) return
    let live = true
    setState((now) => (now.status === 'ready' ? now : { status: 'loading' }))
    kept ??= loadFindings(get)
    const pending = kept
    pending
      .then((findings) => {
        if (live) setState({ status: 'ready', findings })
      })
      .catch(() => {
        if (kept === pending) kept = null
        if (live) {
          setState({
            status: 'failed',
            message: 'Could not load the figures right now. Check your connection, then try again.',
            retry,
          })
        }
      })
    return () => {
      live = false
    }
    // `get` is a stand-in only tests pass; a new one each render must not reload.
  }, [open, attempt, retry])
  return state
}
