import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type FlyTarget, type MapView2 } from './components/map/MapView'
import { CellLayer } from './components/map/CellLayer'
import { ReportPinLayer } from './components/map/ReportPinLayer'
import { FilterPanel } from './components/map/FilterPanel'
import {
  sortByDistance,
  DEFAULT_FILTERS,
  type ReportFilters,
} from './lib/filters/reportFilters'
import { distanceMetres, formatDistance } from './lib/geo/distance'
import { WHOLE_WORLD } from './lib/geo/bounds'
import { getCurrentPosition } from './lib/geo/nearMe'
import { ReportForm } from './components/report/ReportForm'
import { ReportDetail } from './components/report/ReportDetail'
import { SignInPanel } from './components/auth/SignInPanel'
import { AdminQueue } from './components/admin/AdminQueue'
import { resolutionForZoom, PIN_ZOOM_THRESHOLD } from './lib/grid/zoomResolution'
import { normaliseWeights } from './lib/severity/percentile'
import { createDebouncedSearch, type Place } from './lib/geo/nominatim'
import { createDataSource } from './lib/data/createDataSource'
import { plainError } from './lib/moderation/plainWords'
import type { CurrentUser, DataSource, ReportView, RollupCell } from './lib/data/types'

const WORLD_VIEW = { center: [20, 0] as [number, number], zoom: 3 }
const PLACE_ZOOM = 16

export interface AppProps {
  /** Injected in tests; production picks a source from the environment. */
  data?: DataSource
}

export default function App({ data: injected }: AppProps = {}) {
  const chosen = useMemo(() => createDataSource(import.meta.env), [])
  const data = injected ?? chosen.source

  const [view, setView] = useState<MapView2>({ ...WORLD_VIEW, bounds: WHOLE_WORLD })
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null)
  const [cells, setCells] = useState<RollupCell[]>([])
  const [totalInView, setTotalInView] = useState(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [reports, setReports] = useState<ReportView[]>([])
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [openReport, setOpenReport] = useState<ReportView | null>(null)
  const [adding, setAdding] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // One slot per fetch. Sharing a single one meant a successful cell load wiped
  // the banner from a failed report load, so half the map was missing with
  // nothing on screen to say so.
  const [reportsError, setReportsError] = useState<string | null>(null)
  const [cellsError, setCellsError] = useState<string | null>(null)
  // Its own slot. Written into the reports slot, it was wiped by the very next
  // successful load -- which fires on mount and on every pan -- leaving an
  // admin with the review queue invisible and nothing on screen to explain it.
  const [authError, setAuthError] = useState<string | null>(null)
  const [matchingInView, setMatchingInView] = useState(0)
  const [filters, setFilters] = useState<ReportFilters>(DEFAULT_FILTERS)
  const [locatingMessage, setLocatingMessage] = useState<string | null>(null)

  const search = useMemo(() => createDebouncedSearch(), [])

  const showPins = resolutionForZoom(view.zoom) === null

  // One filter object for both queries. Two derivations could disagree, and
  // the pin view and the aggregated view have to answer the same question the
  // same way.
  const serverFilters = useMemo(
    () => ({
      status: filters.status,
      minConfirmations: filters.minConfirmations,
      since: filters.since,
      origin: filters.origin,
      withinMetres: filters.withinMetres,
    }),
    [filters.status, filters.minConfirmations, filters.since, filters.origin, filters.withinMetres],
  )

  /**
   * Only the newest request may write.
   *
   * Both fetches re-fire on every pan and zoom with no cancellation, so a slow
   * world-level query issued first can resolve after a fast street-level one
   * and repaint the map with the wrong viewport's data, where it stays until
   * the next move. Separate counters, because the two run independently and
   * one must not invalidate the other's response.
   */
  const reportsSeq = useRef(0)
  const cellsSeq = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++reportsSeq.current
    try {
      // Only what is on screen, and counted twice on purpose: `showing` has to
      // be an exact count of what matches, not the length of a capped page, or
      // a dense viewport reports "500 of 12000" with no filter applied and
      // blames the filters for the cap.
      const [loaded, matching, total] = await Promise.all([
        data.listReportsInView(view.bounds, serverFilters),
        data.countReportsInView(view.bounds, serverFilters),
        data.countReportsInView(view.bounds),
      ])
      if (seq !== reportsSeq.current) return
      setReports(loaded)
      // Re-point the open panel at the freshly loaded row. The real source
      // builds new objects every load, so without this a vote or a cleanup
      // leaves the panel rendering pre-change data -- still offering
      // "Confirm this is here" on something you just confirmed. The fake
      // mutates in place, so only production was affected.
      setOpenReport((current) =>
        current ? (loaded.find((r) => r.id === current.id) ?? current) : null,
      )
      setMatchingInView(matching)
      setTotalInView(total)
      setReportsError(null)
    } catch (cause) {
      // Guarded too: a superseded request that fails must not raise a banner
      // for a viewport the person has already left.
      if (seq !== reportsSeq.current) return
      // Without this the promise rejects unhandled and a failed load renders as
      // an empty map -- indistinguishable from an area with nothing reported.
      setReportsError(plainError(cause instanceof Error ? cause.message : null))
    }
  }, [data, view.bounds, serverFilters])

  const refreshCells = useCallback(async () => {
    // Claimed BEFORE the early return, so leaving the aggregated view
    // invalidates a rollup still in flight. Otherwise its response lands
    // unopposed and paints the old viewport's cells the moment you zoom back
    // out somewhere else.
    const seq = ++cellsSeq.current

    const resolution = resolutionForZoom(view.zoom)
    if (resolution === null) {
      setCells([])
      // The banner belongs to the aggregated view. Left set, it kept saying
      // "Reports may be missing" over a pin view whose reports all loaded.
      setCellsError(null)
      return
    }
    try {
      // Aggregated where the data is, with the filters pushed down -- rolling
      // up a capped page on the client drops the very cells that should be
      // hottest.
      const rolled = await data.getRollup(view.bounds, resolution, serverFilters)
      if (seq !== cellsSeq.current) return
      setCells(rolled)
      setCellsError(null)
    } catch (cause) {
      if (seq !== cellsSeq.current) return
      setCellsError(plainError(cause instanceof Error ? cause.message : null))
    }
  }, [data, view.bounds, view.zoom, serverFilters])

  useEffect(() => {
    void data
      .getCurrentUser()
      .then((current) => {
        setUser(current)
        setAuthError(null)
      })
      .catch(() => {
        // A failure here is indistinguishable from being signed out, which
        // silently hides the review queue from an admin. Say so.
        setUser(null)
        setAuthError('Could not check whether you are signed in.')
      })
    return data.onAuthChange((current) => {
      setUser(current)
      // Signing in successfully answers the question the banner was raising, so
      // it must go. Otherwise a transient failure at startup leaves "Could not
      // check whether you are signed in" on screen for the whole session.
      setAuthError(null)
    })
  }, [data])


  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refreshCells()
  }, [refreshCells])

  const publishedReports = useMemo(
    // A rejected pin is visible to its author and to admins, and must not be
    // drawn on the map for them as though it were live.
    () => reports.filter((report) => report.moderationStatus === 'approved'),
    [reports],
  )

  const visibleReports = useMemo(
    // No applyFilters here: the server already applied them. Filtering again
    // over a page would narrow results that were already narrowed correctly.
    // Nearest first once a location is known -- "never force users to hunt
    // visually" means the list needs a useful order, not the database's.
    () => sortByDistance(publishedReports, filters.origin),
    [publishedReports, filters.origin],
  )

  const onUseMyLocation = async () => {
    setLocatingMessage('Finding your location…')
    const result = await getCurrentPosition()
    if (result.ok) {
      setLocatingMessage(null)
      setFilters((current) => ({ ...current, origin: result.point }))
      setFlyTo({ center: [result.point.lat, result.point.lng], zoom: PLACE_ZOOM, nonce: Date.now() })
    } else {
      setLocatingMessage(result.message)
    }
  }

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
                      setFlyTo({ center: [place.lat, place.lng], zoom: PLACE_ZOOM, nonce: Date.now() })
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

          <FilterPanel
            filters={filters}
            onChange={setFilters}
            showing={matchingInView}
            total={totalInView}
            onUseMyLocation={() => void onUseMyLocation()}
            locatingMessage={locatingMessage}
            hasLocation={filters.origin !== null}
          />

          {user?.isAdmin && !reviewing && (
            <button
              type="button"
              onClick={() => setReviewing(true)}
              className="w-full rounded-lg bg-white px-3 py-2 text-left text-sm font-medium text-slate-800 shadow-md"
            >
              Review queue
            </button>
          )}

          {authError && (
            <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-900">
              {authError}
            </p>
          )}

          {(reportsError ?? cellsError) && (
            <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-900">
              {reportsError ?? cellsError} Reports may be missing.
            </p>
          )}

          {chosen.demo && !injected && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
              Showing sample reports. Connect a database to see real ones.
            </p>
          )}
        </div>

        <div className="pointer-events-auto mt-auto w-[min(26rem,calc(100vw-2rem))] space-y-3">
          {reviewing && user?.isAdmin && (
            <AdminQueue
              data={data}
              isAdmin={user.isAdmin}
              onClose={() => setReviewing(false)}
              onDecided={() => {
                void refresh()
                void refreshCells()
              }}
            />
          )}

          {openReport && (
            <ReportDetail
              data={data}
              report={openReport}
              signedIn={user !== null}
              onChanged={() => {
                // Cells too. Marking a report cleaned from the aggregated view
                // dropped it from the counts while its hexagon stayed exactly
                // as hot -- the one thing the product exists to show.
                void refresh()
                void refreshCells()
              }}
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
        {showPins ? (
          <ReportPinLayer
            reports={visibleReports}
            selectedId={openReport?.id ?? null}
            onSelect={setOpenReport}
          />
        ) : (
          <CellLayer cells={normaliseWeights(cells)} />
        )}
      </MapView>

      {/* Reports are reachable by name as well as by eye, which matters for
          anyone who cannot pick a pin out of a busy map. */}
      <ul className="sr-only">
        {visibleReports.map((report) => (
          <li key={report.id}>
            <button type="button" onClick={() => setOpenReport(report)}>
              {report.status === 'cleaned' ? 'Cleaned report' : 'Litter reported here'} —{' '}
              {report.voteCount} confirmed
              {filters.origin
                ? `, ${formatDistance(
                    distanceMetres(filters.origin, { lat: report.lat, lng: report.lng }),
                  )}`
                : ''}
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
