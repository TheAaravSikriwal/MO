import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapView, type MapPosition } from './components/map/MapView'
import { CellLayer } from './components/map/CellLayer'
import { ReportForm } from './components/report/ReportForm'
import { ReportDetail } from './components/report/ReportDetail'
import { SignInPanel } from './components/auth/SignInPanel'
import { resolutionForZoom, PIN_ZOOM_THRESHOLD } from './lib/grid/zoomResolution'
import { weighCells } from './lib/severity/weight'
import { normaliseWeights } from './lib/severity/percentile'
import { createDebouncedSearch, type Place } from './lib/geo/nominatim'
import { createDataSource } from './lib/data/createDataSource'
import type { CurrentUser, DataSource, ReportView } from './lib/data/types'
import type { WeighableReport } from './types/report'

const WORLD_VIEW: MapPosition = { center: [20, 0], zoom: 3 }
const PLACE_ZOOM = 16

/** Reports are already public data; only what they contain is moderated. */
const toWeighable = (report: ReportView): WeighableReport => ({
  id: report.id,
  status: report.status,
  moderationStatus: 'approved',
  voteCount: report.voteCount,
  cells: report.cells,
})

export interface AppProps {
  /** Injected in tests; production picks a source from the environment. */
  data?: DataSource
}

export default function App({ data: injected }: AppProps = {}) {
  const chosen = useMemo(() => createDataSource(import.meta.env), [])
  const data = injected ?? chosen.source

  const [view, setView] = useState<MapPosition>(WORLD_VIEW)
  const [flyTo, setFlyTo] = useState<MapPosition | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [reports, setReports] = useState<ReportView[]>([])
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [openReport, setOpenReport] = useState<ReportView | null>(null)
  const [adding, setAdding] = useState(false)

  const search = useMemo(() => createDebouncedSearch(), [])

  const refresh = useCallback(async () => {
    // A generous window: the map is the homepage, so something should always
    // be on it rather than only what is strictly in frame.
    const loaded = await data.listReportsInView({
      minLat: -90,
      minLng: -180,
      maxLat: 90,
      maxLng: 180,
    })
    setReports(loaded)
    setOpenReport((current) =>
      current ? (loaded.find((r) => r.id === current.id) ?? current) : null,
    )
  }, [data])

  useEffect(() => {
    void data.getCurrentUser().then(setUser)
    return data.onAuthChange(setUser)
  }, [data])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const cells = useMemo(() => {
    const resolution = resolutionForZoom(view.zoom)
    if (resolution === null) return []
    return normaliseWeights(weighCells(reports.map(toWeighable), resolution))
  }, [reports, view.zoom])

  const closeEnoughToAdd = view.zoom >= PIN_ZOOM_THRESHOLD

  const onQueryChange = (value: string) => {
    setQuery(value)
    if (value.trim() === '') {
      setResults([])
      return
    }
    search(value, setResults)
  }

  return (
    <main className="relative h-full w-full">
      <div className="pointer-events-none absolute inset-0 z-[1000] flex flex-col gap-3 p-4">
        <div className="pointer-events-auto w-[min(24rem,calc(100vw-2rem))] space-y-2">
          <input
            type="search"
            aria-label="Search for a place"
            placeholder="Search for a place"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-md outline-none focus:border-slate-500"
          />
          {results.length > 0 && (
            <ul className="max-h-64 overflow-auto rounded-lg bg-white shadow-md">
              {results.map((place) => (
                <li key={`${place.name}:${place.lat},${place.lng}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setFlyTo({ center: [place.lat, place.lng], zoom: PLACE_ZOOM })
                      setResults([])
                      setQuery(place.name)
                    }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                  >
                    {place.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-lg bg-white p-3 shadow-md">
            <SignInPanel data={data} user={user} />
          </div>

          {chosen.demo && !injected && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
              Showing sample reports. Connect a database to see real ones.
            </p>
          )}
        </div>

        <div className="pointer-events-auto mt-auto w-[min(26rem,calc(100vw-2rem))] space-y-3">
          {openReport && (
            <ReportDetail
              data={data}
              report={openReport}
              signedIn={user !== null}
              onChanged={() => void refresh()}
              onClose={() => setOpenReport(null)}
            />
          )}

          {adding ? (
            <ReportForm
              data={data}
              lat={view.center[0]}
              lng={view.center[1]}
              zoom={view.zoom}
              signedIn={user !== null}
              onSubmitted={() => {
                setAdding(false)
                void refresh()
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg"
            >
              {closeEnoughToAdd ? 'Add a report here' : 'Add a report'}
            </button>
          )}
        </div>
      </div>

      <MapView
        initialCenter={WORLD_VIEW.center}
        initialZoom={WORLD_VIEW.zoom}
        flyTo={flyTo}
        onViewChange={setView}
      >
        <CellLayer cells={cells} />
      </MapView>

      {/* Reports are reachable by name as well as by eye, which matters for
          anyone who cannot pick a pin out of a busy map. */}
      <ul className="sr-only">
        {reports.map((report) => (
          <li key={report.id}>
            <button type="button" onClick={() => setOpenReport(report)}>
              {report.status === 'cleaned' ? 'Cleaned report' : 'Litter reported here'} —{' '}
              {report.voteCount} confirmed
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
