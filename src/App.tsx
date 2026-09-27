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
import { normaliseWeights, type NormalisedCell } from './lib/severity/percentile'
import { createDebouncedSearch, type Place } from './lib/geo/nominatim'
import { createDataSource, createIdeaSource } from './lib/data/createDataSource'
import { FakeDataSource } from './lib/data/fakeSource'
import { worldFromSearch, searchWithWorld, type World } from './lib/data/worlds'
import { WorldSwitch } from './components/WorldSwitch'
import { plainError } from './lib/moderation/plainWords'
import type { CurrentUser, DataSource, ReportView, RollupCell } from './lib/data/types'

/** Stable identity, so handing 'no cells' to the map does not churn every render. */
const NO_CELLS: NormalisedCell[] = []

const WORLD_VIEW = { center: [20, 0] as [number, number], zoom: 3 }

/**
 * Who you are when you try the idea signed in. Made up, like everything else
 * on that side: nobody is asked for a real email address to try a pretend map.
 */
export const IDEA_VISITOR_EMAIL = 'visitor@the-idea.example'
const PLACE_ZOOM = 16

export interface AppProps {
  /** Injected in tests; production picks a source from the environment. */
  data?: DataSource
}

export default function App({ data: injected }: AppProps = {}) {
  // An injected source is a test's: the bare map, with no switch above it.
  if (injected) return <MapScreen data={injected} />
  return <Worlds />
}

/**
 * The map, under the switch between "The idea" and "Real world".
 *
 * Each side has its own source, and the map below is keyed on the side, so
 * switching starts it fresh: an open report, a signed-in person or a list of
 * pins from one side can never be shown against the other's data.
 */
function Worlds() {
  const chosen = useMemo(() => createDataSource(import.meta.env), [])
  const realConnected = !chosen.demo
  const [world, setWorld] = useState<World>(() =>
    worldFromSearch(globalThis.location?.search ?? '', realConnected),
  )
  // Built on first use and then kept. Seeding thousands of reports is not
  // free, and anything added while trying the idea out is still there after a
  // look at the real map.
  const [built] = useState(() => new Map<World, DataSource>())
  const sourceFor = (side: World): DataSource => {
    const existing = built.get(side)
    if (existing) return existing
    // Not connected: an empty map that says so, never the idea's reports.
    // Here chosen.source is already empty then, but realConnected can be
    // false with a database configured (wearechintu shares its Supabase keys
    // with the store before the map's tables exist), and that database must
    // not be asked for reports it does not have.
    const made =
      side === 'idea'
        ? createIdeaSource()
        : realConnected
          ? chosen.source
          : new FakeDataSource(null)
    built.set(side, made)
    return made
  }

  useEffect(() => {
    const { pathname, search, hash } = window.location
    window.history.replaceState(null, '', `${pathname}${searchWithWorld(search, world)}${hash}`)
  }, [world])

  return (
    <MapScreen
      key={world}
      data={sourceFor(world)}
      worlds={{ value: world, onChange: setWorld, realConnected }}
    />
  )
}

interface MapScreenProps {
  data: DataSource
  /** The switch above the map. Absent when a test renders the map bare. */
  worlds?: { value: World; onChange: (world: World) => void; realConnected: boolean }
}

function MapScreen({ data, worlds }: MapScreenProps) {
  // "Real world" with no database behind it. Nothing can be read, and nothing
  // may be written: a report added here would look real and go nowhere.
  const unconnected = worlds?.value === 'real' && !worlds.realConnected

  const [view, setView] = useState<MapView2>({ ...WORLD_VIEW, bounds: WHOLE_WORLD })
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null)
  /**
   * The aggregated cells AND the resolution they were computed at, set
   * together.
   *
   * They have to arrive in one commit. Deriving the fade key from view.zoom
   * instead meant the key changed the moment the map moved, while the cells
   * were still the previous band's -- so the fade ran the old cells against
   * themselves, and the actual swap, one round trip later, snapped.
   */
  const [cells, setCells] = useState<{ resolution: number | null; cells: RollupCell[] }>({
    resolution: null,
    cells: [],
  })
  const [totalInView, setTotalInView] = useState(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [reports, setReports] = useState<ReportView[]>([])
  const [offMapReports, setOffMapReports] = useState<ReportView[]>([])
  // Said, not swallowed: a cut-short or failed list of off-map pins must not
  // look like a complete one. Only ever set for somebody who can see them.
  const [offMapNotice, setOffMapNotice] = useState<string | null>(null)
  // Bumped whenever a pin changes from a report's screen, so an open review
  // queue reloads its list of pins off the map.
  const [pinsVersion, setPinsVersion] = useState(0)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [openReportId, setOpenReportId] = useState<string | null>(null)
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

  /**
   * Keep the open panel showing live data.
   *
   * Holding the object selected at click time meant a vote or a cleanup left
   * the panel rendering pre-change state -- still offering "Mark as cleaned" on
   * something just cleaned. Falling back to that stale object when the report
   * drops out of the filtered results has the same effect, and dropping out is
   * exactly what a cleanup does under the default "still there" filter. So when
   * it is not in the list, ask for it by id.
   */
  useEffect(() => {
    if (!openReportId) {
      setOpenReport(null)
      return
    }

    const fromList = reports.find((r) => r.id === openReportId)
    if (fromList) {
      setOpenReport(fromList)
      return
    }

    let live = true
    void data
      .getReport(openReportId)
      .then((fresh) => {
        if (live) setOpenReport(fresh)
      })
      .catch(() => {
        if (live) setOpenReport(null)
      })
    return () => {
      live = false
    }
  }, [data, openReportId, reports])


  // Memoised, not computed inline. CellLayer holds the outgoing cells while
  // the new ones fade in, keyed on the identity of this prop -- recomputing it
  // every render would start a fresh fade on every render and pile up
  // generations without end.
  const normalisedCells = useMemo(() => normaliseWeights(cells.cells), [cells.cells])

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
      const [loaded, matching, total, offMap] = await Promise.all([
        data.listReportsInView(view.bounds, serverFilters),
        data.countReportsInView(view.bounds, serverFilters),
        data.countReportsInView(view.bounds),
        // Only ever the viewer's own, or all of them for an admin. Caught
        // here so a failure does not take the live map down with it -- and
        // then said, below, rather than passed off as "none".
        data.listOffMapInView(view.bounds, serverFilters).catch(() => null),
      ])
      if (seq !== reportsSeq.current) return
      setReports(loaded)
      setOffMapReports(offMap?.reports ?? [])
      setOffMapNotice(
        offMap === null
          ? 'Could not load the pins taken off the map here.'
          : offMap.more
            ? 'Not every pin taken off the map here is shown. Zoom in to see the rest.'
            : null,
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
      // Deliberately does NOT clear the cells.
      //
      // Clearing them meant zooming back out showed a bare basemap for a whole
      // round trip: the pins unmounted, the cells were already gone, and
      // nothing appeared until the rollup returned. Every other band boundary
      // holds the previous cells until the new ones land; this one now does
      // too. App simply stops drawing them while pins are shown.
      //
      // The banner does go, though: it belongs to the aggregated view, and
      // left set it kept saying "Reports may be missing" over a pin view whose
      // reports had all loaded.
      setCellsError(null)
      return
    }

    try {
      // Aggregated where the data is, with the filters pushed down -- rolling
      // up a capped page on the client drops the very cells that should be
      // hottest.
      const rolled = await data.getRollup(view.bounds, resolution, serverFilters)
      if (seq !== cellsSeq.current) return
      setCells({ resolution, cells: rolled })
      setCellsError(null)
    } catch (cause) {
      if (seq !== cellsSeq.current) return
      setCellsError(plainError(cause instanceof Error ? cause.message : null))
    }
  }, [data, view.bounds, view.zoom, serverFilters])

  /**
   * One place that decides both the user and the auth banner.
   *
   * Two handlers meant the mount-time path could raise a banner that the next
   * auth event silently cleared, and that a failed permission check -- which
   * resolves rather than rejects, so no catch runs -- was never surfaced at
   * all. A real admin then lost the review queue with nothing to explain it.
   */
  const applyUser = useCallback((current: CurrentUser | null) => {
    setUser(current)
    setAuthError(
      current?.adminUnknown
        ? 'Could not check your permissions, so some options may be missing.'
        : null,
    )
  }, [])

  useEffect(() => {
    void data
      .getCurrentUser()
      .then(applyUser)
      .catch(() => {
        // A failure here is indistinguishable from being signed out, which
        // silently hides the review queue from an admin. Say so.
        setUser(null)
        setAuthError('Could not check whether you are signed in.')
      })
    return data.onAuthChange(applyUser)
  }, [data])


  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refreshCells()
  }, [refreshCells])

  const publishedReports = useMemo(
    // Off-map pins are included. The server only ever returns one to its
    // reporter and to admins, and those are exactly the people who need to
    // find it again: the reporter to be told it was taken off, an admin to put
    // it back. Filtering them out here made both impossible. The pin layer
    // draws them greyed out, and they add nothing to the colours.
    () => [...reports, ...offMapReports],
    [reports, offMapReports],
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
      {worlds && (
        // A frame round the whole map in the side's colour, so which one this
        // is stays plain even with every panel scrolled out of view.
        <div
          aria-hidden="true"
          data-testid="world-frame"
          data-world={worlds.value}
          className={`pointer-events-none absolute inset-0 z-[1001] border-[6px] ${
            worlds.value === 'idea' ? 'border-violet-500/70' : 'border-emerald-500/70'
          }`}
        />
      )}
      <div className="pointer-events-none absolute inset-0 z-[1000] flex flex-col gap-3 p-4">
        {worlds && (
          <div className="pointer-events-auto w-[min(26rem,calc(100vw-2rem))] xl:absolute xl:left-1/2 xl:top-4 xl:-translate-x-1/2">
            <WorldSwitch
              value={worlds.value}
              onChange={worlds.onChange}
              realConnected={worlds.realConnected}
            />
          </div>
        )}
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

          {worlds?.value === 'idea' && !user ? (
            <div className="space-y-2 rounded-lg bg-white p-3 shadow-md">
              <p className="text-sm text-slate-700">
                No account needed to try the idea. Nothing you add here is sent anywhere.
              </p>
              <button
                type="button"
                onClick={() => void data.signInWithEmail(IDEA_VISITOR_EMAIL)}
                className="w-full rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white"
              >
                Try it signed in
              </button>
            </div>
          ) : (
            !unconnected && (
              <div className="rounded-lg bg-white p-3 shadow-md">
                <SignInPanel data={data} user={user} />
              </div>
            )
          )}

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

          {offMapNotice && (
            <p role="status" className="rounded-lg bg-slate-100 p-3 text-xs text-slate-700">
              {offMapNotice}
            </p>
          )}

          {(reportsError ?? cellsError) && (
            <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-900">
              {reportsError ?? cellsError} Reports may be missing.
            </p>
          )}

          {worlds?.value === 'idea' && (
            <p role="status" className="rounded-lg bg-violet-50 p-3 text-xs text-violet-900">
              <strong>The idea.</strong> Every report on this map is made up, to show how
              it works. None of them are real.
            </p>
          )}

          {unconnected && (
            <p role="status" className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900">
              <strong>Real world.</strong> This map is not connected to the real reports
              yet, so there are none to show. Switch to The idea to see how it works.
            </p>
          )}
        </div>

        <div className="pointer-events-auto mt-auto w-[min(26rem,calc(100vw-2rem))] space-y-3">
          {reviewing && user?.isAdmin && (
            <AdminQueue
              data={data}
              isAdmin={user.isAdmin}
              onClose={() => setReviewing(false)}
              pinsVersion={pinsVersion}
              onDecided={() => {
                void refresh()
                void refreshCells()
              }}
            />
          )}

          {openReport && (
            <ReportDetail
              // One panel per report. Without the key, opening another pin
              // swapped the report under the same panel, and a reason typed for
              // one pin was sent -- and recorded for good -- against the next.
              key={openReport.id}
              data={data}
              report={openReport}
              signedIn={user !== null}
              isAdmin={user?.isAdmin ?? false}
              onChanged={() => {
                // Cells too. Marking a report cleaned from the aggregated view
                // dropped it from the counts while its hexagon stayed exactly
                // as hot -- the one thing the product exists to show.
                void refresh()
                void refreshCells()
              }}
              // Only a pin moving on or off the map reloads an open review queue.
              onPinChanged={() => setPinsVersion((version) => version + 1)}
              onClose={() => setOpenReportId(null)}
            />
          )}

          {unconnected ? null : adding ? (
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
        {/*
          The cell layer stays mounted across the pin threshold.

          Swapping it out for the pin layer unmounted every hexagon in one
          frame -- the harshest cut on the map, and the one zoom boundary with
          no fade at all. Handing it an empty set instead lets it fade the
          hexagons out, and fade them back in on the way down.
        */}
        <CellLayer
          cells={showPins ? NO_CELLS : normalisedCells}
          fadeKey={showPins ? 'pins' : (cells.resolution ?? 'none')}
        />

        {showPins && (
          <ReportPinLayer
            reports={visibleReports}
            selectedId={openReportId}
            onSelect={(report) => setOpenReportId(report.id)}
          />
        )}
      </MapView>

      {/* Reports are reachable by name as well as by eye, which matters for
          anyone who cannot pick a pin out of a busy map. */}
      <ul className="sr-only">
        {visibleReports.map((report) => (
          <li key={report.id}>
            <button type="button" onClick={() => setOpenReportId(report.id)}>
              {report.status === 'cleaned' ? 'Cleaned report' : 'Litter reported here'}
              {report.moderationStatus === 'rejected' ? ' (off the map)' : ''} —{' '}
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
