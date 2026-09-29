import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GlobeMap, type FlyTarget, type MapView2 } from './components/map/GlobeMap'
import { LayerPanel } from './components/map/LayerPanel'
import { CellCatalog, type CatalogState } from './components/map/CellCatalog'
import { FindingsPanel } from './components/findings/FindingsPanel'
import { HighlightReel } from './components/intro/HighlightReel'
import { AboutPanel } from './components/about/AboutPanel'
import { useFindings } from './lib/worlddata/useFindings'
import { getResolution } from 'h3-js'
import { useWorldData } from './lib/worlddata/useWorldData'
import type { WorldLayerId } from './lib/worlddata/worldData'
import { FilterPanel } from './components/map/FilterPanel'
import {
  sortByDistance,
  DEFAULT_FILTERS,
  isDefault,
  type ReportFilters,
} from './lib/filters/reportFilters'
import { distanceMetres, formatDistance } from './lib/geo/distance'
import { WHOLE_WORLD } from './lib/geo/bounds'
import { getCurrentPosition } from './lib/geo/nearMe'
import { ReportForm } from './components/report/ReportForm'
import { ReportDetail } from './components/report/ReportDetail'
import { SignInPanel } from './components/auth/SignInPanel'
import { AdminQueue } from './components/admin/AdminQueue'
import { resolutionForZoom, REPORT_PLACE_ZOOM } from './lib/grid/zoomResolution'
import { normaliseWeights, type NormalisedCell } from './lib/severity/percentile'
import { createDebouncedSearch, type Place } from './lib/geo/nominatim'
import { createDataSource, createIdeaSource } from './lib/data/createDataSource'
import { FakeDataSource } from './lib/data/fakeSource'
import { worldFromSearch, searchWithWorld, type World } from './lib/data/worlds'
import { WorldSwitch } from './components/WorldSwitch'
import { Reveal } from './components/Reveal'
import { MapTabs, type Tab } from './components/MapTabs'
import { GroupsPanel } from './components/groups/GroupsPanel'
import { GroupForm } from './components/groups/GroupForm'
import { plainError } from './lib/moderation/plainWords'
import type { CleaningGroup, CurrentUser, DataSource, ReportView, RollupCell } from './lib/data/types'
import { GROUPS_IN_VIEW, REPORT_PAGE_LIMIT } from './lib/data/types'

/** Stable identity, so handing 'no cells' to the map does not churn every render. */
const NO_CELLS: NormalisedCell[] = []
const NO_REPORTS: ReportView[] = []
const NO_GROUPS: CleaningGroup[] = []

// The globe whole, seen from space. In the app's zoom numbers (lib/map/view).
const WORLD_VIEW = { center: [20, 10] as [number, number], zoom: 2.9 }

/**
 * Who you are when you try the idea signed in. Made up, like everything else
 * on that side: nobody is asked for a real email address to try a pretend map.
 */
export const IDEA_VISITOR_EMAIL = 'visitor@the-idea.example'
const PLACE_ZOOM = 16

export interface AppProps {
  /** Injected in tests; production picks a source from the environment. */
  data?: DataSource
  /**
   * Whether the introduction plays first. Production plays it every time the
   * map is opened, with a large skip button; a test that injects a source
   * gets the bare map unless it asks.
   */
  intro?: boolean
}

/**
 * The introduction, over whatever it introduces. `waiting` is true while it
 * plays, so the map can hold back its panels and its zoom until it ends;
 * `replay` plays it again.
 */
function Introduced({ first, children }: { first: boolean; children: (waiting: boolean, replay: () => void) => ReactNode }) {
  const [open, setOpen] = useState(first)
  // The figures load while the welcome plays, and are kept for the Findings tab.
  const figures = useFindings(open)
  return (
    <>
      {children(open, () => setOpen(true))}
      {open && (
        <HighlightReel
          state={figures}
          onDone={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** A phone-sized screen: below Tailwind's `md`, where the panels stack. */
// A window 480px tall or less counts too, a laptop's included: at that height
// the column cannot hold the filters and the map at once either.
const PHONE_QUERY = '(max-width: 767.98px), (max-height: 480px)'
const matches = (query: string) => typeof window.matchMedia === 'function' && window.matchMedia(query).matches
const isPhone = () => matches(PHONE_QUERY)
/** Narrower than md: the area's list is a sheet along the bottom of the screen. */
const isNarrow = () => matches('(max-width: 767.98px)')

export default function App({ data: injected, intro }: AppProps = {}) {
  // An injected source is a test's: the bare map, with no switch above it.
  if (injected) {
    return (
      <Introduced first={intro ?? false}>
        {(waiting, replay) => <MapScreen data={injected} waiting={waiting} onReplayIntro={replay} />}
      </Introduced>
    )
  }
  return (
    <Introduced first={intro ?? true}>{(waiting, replay) => <Worlds waiting={waiting} onReplayIntro={replay} />}</Introduced>
  )
}

/**
 * The map, under the switch between "The idea" and "Real world".
 *
 * Each side has its own source, and the map below is keyed on the side, so
 * switching starts it fresh: an open report, a signed-in person or a list of
 * pins from one side can never be shown against the other's data.
 */
function Worlds({ waiting, onReplayIntro }: { waiting: boolean; onReplayIntro: () => void }) {
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
      waiting={waiting}
      onReplayIntro={onReplayIntro}
    />
  )
}

interface MapScreenProps {
  data: DataSource
  /** The switch above the map. Absent when a test renders the map bare. */
  worlds?: { value: World; onChange: (world: World) => void; realConnected: boolean }
  /** The introduction is playing: hold the panels back, and the globe far out. */
  waiting?: boolean
  onReplayIntro?: () => void
}

/**
 * Where the globe starts while the introduction plays: far out and turned
 * away, so that when it ends the map can fly in and round to the whole world.
 */
const FAR_VIEW = { center: [WORLD_VIEW.center[0] - 25, WORLD_VIEW.center[1] - 110] as [number, number], zoom: 1 }

function MapScreen({ data, worlds, waiting = false, onReplayIntro }: MapScreenProps) {
  // Whether the panels are in. False only from a start behind the introduction.
  const [entered, setEntered] = useState(!waiting)
  // Fixed at the first render: where the globe starts.
  const [start] = useState(() => (waiting ? FAR_VIEW : WORLD_VIEW))
  const [aboutOpen, setAboutOpen] = useState(false)
  // "Real world" with no database behind it. Nothing can be read, and nothing
  // may be written: a report added here would look real and go nowhere.
  const unconnected = worlds?.value === 'real' && !worlds.realConnected

  const [view, setView] = useState<MapView2>({ ...WORLD_VIEW, bounds: WHOLE_WORLD })
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null)
  useEffect(() => {
    if (waiting || entered) return
    setEntered(true)
    setFlyTo({ center: WORLD_VIEW.center, zoom: WORLD_VIEW.zoom, nonce: Date.now() })
  }, [waiting, entered])
  // Played again from About: close it, and let the reel play over the map.
  useEffect(() => {
    if (waiting) setAboutOpen(false)
  }, [waiting])
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
  // Which side of the panel is showing: litter reports, or cleaning groups.
  const [tab, setTab] = useState<Tab>('map')
  const [groups, setGroups] = useState<CleaningGroup[]>([])
  // Set once, when the first load finishes: a reload on every pan must not
  // take "no groups here" away and put it back.
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupsMore, setGroupsMore] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [startingGroup, setStartingGroup] = useState(false)
  // What is drawn on the map, whichever tab is open.
  const [showReports, setShowReports] = useState(true)
  const [showGroupsOnMap, setShowGroupsOnMap] = useState(true)
  const [worldLayer, setWorldLayer] = useState<WorldLayerId | null>(null)
  // Fires share the litter's hexagons: the size the towers are drawn at now,
  // not the size the zoom is heading for, so the two change together when
  // the new towers arrive. Where the litter has gone to single dots the layer
  // is flat and faded anyway, so the finest will do.
  const worldData = useWorldData(worldLayer, cells.resolution ?? resolutionForZoom(view.zoom) ?? 7)
  // Loaded the first time the Findings tab is opened, and kept after.
  const findings = useFindings(tab === 'findings')
  // On a phone the layer panel is folded behind a button; wider, it is always open.
  const [layersOpen, setLayersOpen] = useState(false)
  // On a phone the filters and the list of groups fold away until asked for.
  // Stacked full width with everything else they covered the whole globe, so
  // the map was a column of panels with a strip of world behind it. What
  // folds is only those controls and that list: signing in, errors, empty
  // states and which world this is stay in sight. Wider screens show all.
  const [panelOpen, setPanelOpen] = useState(false)
  // Set by the Review queue button, cleared once the queue has taken focus.
  const [focusQueue, setFocusQueue] = useState(false)
  const fold = panelOpen ? '' : 'phone:hidden'
  const filtering = !isDefault(
    filters.origin ? filters : { ...filters, withinMetres: DEFAULT_FILTERS.withinMetres },
  )
  // A report, a form or the review queue open at the bottom of the column, on
  // the tab it belongs to. On a phone that and the stack at the top were the
  // whole screen, and a report lands where the map is looking, which was under
  // them. So while one is open, on an upright phone the bottom is held to 40%
  // of the screen, scrolling inside itself, which keeps the middle of the map
  // in sight; on a phone on its side the map is beside the narrow column, so
  // the bottom takes what height is left. On any phone the top keeps to 25%
  // and scrolls inside itself (see `capTop`), and the name row steps aside to
  // make the room. Everything else stays: the
  // tabs (a half-written report waits on its own), the search, the fold,
  // signing in, errors, notices and the world switch. Signed out, a form is
  // only "sign in to...", so nothing moves.
  const working =
    (tab === 'map' && ((reviewing && !!user?.isAdmin) || openReport !== null || (adding && user !== null))) ||
    (tab === 'groups' && startingGroup && user !== null)
  // The top's cap lifts while search results are up, or when the filters or
  // groups have been opened on purpose: a person asked to see those. Signing
  // in stays in the capped top, a scroll away.
  const capTop = working && results.length === 0 && !panelOpen
  // The column is in use: something is open in it, or the filters or groups
  // are unfolded. On a phone the column is nearly the screen's width then,
  // and the map's own floating controls (Layers, the compass) step aside
  // rather than sit over its panels. Pinching still zooms and turns the map.
  const busy = working || panelOpen
  const column = useRef<HTMLDivElement>(null)
  const tabsRow = useRef<HTMLDivElement>(null)
  const [findingsTop, setFindingsTop] = useState<number | null>(null)
  useEffect(() => {
    if (tab !== 'findings') return
    const place = () => {
      const tabs = tabsRow.current
      const main = tabs?.closest('main')
      if (!tabs || !main) return
      setFindingsTop(Math.round(tabs.getBoundingClientRect().bottom - main.getBoundingClientRect().top + 8))
    }
    place()
    // The errors above the tabs open and close with an animation (Reveal).
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    const top = tabsRow.current?.closest('[data-testid="column-top"]')
    if (watch && top) watch.observe(top)
    const box = column.current
    window.addEventListener('resize', place)
    box?.addEventListener('scroll', place)
    return () => {
      watch?.disconnect()
      window.removeEventListener('resize', place)
      box?.removeEventListener('scroll', place)
    }
  }, [tab])
  useEffect(() => {
    if (!panelOpen || !isPhone()) return
    // Once the fold has opened (Reveal), as the list's own scroll waits too.
    const wait = setTimeout(() => {
      const box = column.current
      const opened = document.getElementById(tab === 'groups' ? 'mo-group-list' : 'mo-filters')
      if (!box || !opened) return
      const edge = box.getBoundingClientRect()
      const at = opened.getBoundingClientRect()
      if (at.bottom > edge.bottom) box.scrollTop += Math.min(at.top - edge.top - 16, at.bottom - edge.bottom)
    }, 260)
    return () => clearTimeout(wait)
  }, [panelOpen, tab])
  // The area of litter whose reports are listed on the right, and that list.
  const [picked, setPicked] = useState<{ cell: string; reportCount: number } | null>(null)
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  // Bumped whenever a report changes from this screen -- confirmed, cleaned,
  // added, decided -- so the list on the right is read again with it.
  const [changes, setChanges] = useState(0)

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


  // Memoised, not computed inline. The map redraws its towers whenever this
  // prop changes identity, so recomputing it every render would rebuild every
  // tower on every render.
  const normalisedCells = useMemo(() => normaliseWeights(cells.cells), [cells.cells])

  const showPins = resolutionForZoom(view.zoom) === null

  // A picked area stands for a tower on the map. Put the list and its outline
  // away when the towers go -- litter switched off -- or when the map changes
  // to hexagons of another size, where the old outline would sit over a grid
  // it is not part of. Kept in dot view: that is where a report opened from
  // the list is read, among the dots of the same area.
  const gridSize = resolutionForZoom(view.zoom)
  useEffect(() => {
    if (!picked) return
    if (!showReports || (gridSize !== null && gridSize !== getResolution(picked.cell))) setPicked(null)
  }, [picked, showReports, gridSize])

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

  const groupsSeq = useRef(0)
  const refreshGroups = useCallback(async () => {
    const seq = ++groupsSeq.current
    try {
      const found = await data.listGroupsInView(view.bounds)
      if (seq !== groupsSeq.current) return
      // One more than a page means there are more than it shows: said, not
      // passed off as the whole list.
      setGroups(found.slice(0, GROUPS_IN_VIEW))
      setGroupsMore(found.length > GROUPS_IN_VIEW)
      setGroupsError(null)
    } catch (cause) {
      if (seq !== groupsSeq.current) return
      setGroupsError(plainError(cause instanceof Error ? cause.message : null))
    } finally {
      if (seq === groupsSeq.current) setGroupsLoaded(true)
    }
  }, [data, view.bounds])

  useEffect(() => {
    if (tab === 'groups' || showGroupsOnMap) void refreshGroups()
  }, [tab, showGroupsOnMap, refreshGroups, user])

  // A report opens on the Reports side, wherever it was picked: a pin on the
  // map, or the list read out to people who cannot pick a pin out of it.
  // Picked from the groups tab, it would otherwise wait unseen until that tab
  // was chosen.
  const openReportById = (id: string) => {
    setTab('map')
    setPanelOpen(false)
    if (isNarrow()) setPicked(null)
    setOpenReportId(id)
  }

  // The reports in the picked area: everything in view of its outline, with
  // the same filters as the map, kept to the ones inside that very hexagon.
  const catalogSeq = useRef(0)
  useEffect(() => {
    if (!picked) return
    const seq = ++catalogSeq.current
    setCatalog({ status: 'loading' })
    // Asked of the hexagon itself. Fetching the box round it and trimming
    // afterwards let a busier neighbour fill the page, so an area the tower
    // counted could list as empty.
    data
      .listReportsInCell(picked.cell, serverFilters)
      .then(({ reports, more }) => {
        if (seq !== catalogSeq.current) return
        setCatalog({ status: 'ready', reports, capped: more })
      })
      .catch((cause) => {
        if (seq !== catalogSeq.current) return
        setCatalog({ status: 'failed', message: plainError(cause instanceof Error ? cause.message : null) })
      })
  }, [picked, data, serverFilters, changes])

  const openFromCatalog = (report: ReportView) => {
    // On a phone the list is a sheet over the lower half of the screen, where
    // the report opens: openReportById puts the list away.
    openReportById(report.id)
    setFlyTo({ center: [report.lat, report.lng], zoom: Math.max(view.zoom, 14), nonce: Date.now() })
  }

  const selectGroup = (group: CleaningGroup) => {
    setSelectedGroupId(group.id)
    setFlyTo({ center: [group.lat, group.lng], zoom: Math.max(view.zoom, 13), nonce: Date.now() })
  }

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

  const closeEnoughToAdd = view.zoom >= REPORT_PLACE_ZOOM

  const onQueryChange = (value: string) => {
    setQuery(value)
    if (value.trim() === '') {
      setResults([])
      return
    }
    search(value, setResults)
  }

  return (
    <main
      className="mo-space relative h-full w-full overflow-hidden"
      data-entered={entered ? 'yes' : 'no'}
      data-busy={busy ? 'yes' : undefined}
      // The compass also steps aside for the layers panel, which it sat on.
      data-layers-open={layersOpen && !picked ? 'yes' : undefined}
    >
      {/*
        The log behind a tower: on the right, under the map's own buttons; on a
        phone, a sheet along the bottom, clear of the name, tabs and search.
      */}
      <div
        className="mo-enter mo-enter--right pointer-events-none absolute inset-x-3 bottom-3 z-[1002] md:inset-x-auto md:bottom-auto md:right-14 md:top-4 md:z-[1001] md:w-[22rem]"
        style={{ '--delay': '350ms' } as CSSProperties}
      >
        <div className="pointer-events-auto">
          <Reveal show={picked !== null} from="above">
            {picked && (
              <CellCatalog
                reportCount={picked.reportCount}
                state={catalog}
                onOpen={openFromCatalog}
                onClose={() => setPicked(null)}
              />
            )}
          </Reveal>
        </div>
      </div>
      <div
        style={{ '--delay': '450ms' } as CSSProperties}
        className={`mo-enter mo-enter--right pointer-events-none absolute bottom-24 right-3 z-[1000] w-[min(19rem,calc(100vw-1.5rem))] phone:z-[1001] md:bottom-10 md:right-4 ${
          // Under the list's sheet on a phone: out of the way while it is open.
          picked ? 'max-md:hidden' : ''
        } ${busy ? 'upright:hidden' : ''}`}
        data-testid="layers-corner"
        // On a phone the column is nearly the screen's width, and it was
        // painted over the Layers button and the open panel: this corner sits
        // above it there, and on an upright phone steps aside while the
        // column is in use (busy).
        // Only its button and panel take the pointer.
      >
        {/*
          The right side holds the list or the layers, never both: on a laptop
          screen the list reached down over the panel. While the list is open
          the layers fold into their button, which puts the list away.
        */}
        <div className="flex flex-col items-end gap-2 [&>*]:pointer-events-auto">
          <button
            type="button"
            aria-expanded={layersOpen && !picked}
            aria-controls="mo-layers"
            onClick={() => {
              if (picked) {
                setPicked(null)
                setLayersOpen(true)
              } else setLayersOpen((open) => !open)
            }}
            className={`mo-glass rounded-2xl px-4 py-2 text-sm font-medium text-slate-900 ${picked ? '' : 'roomy:hidden'}`}
          >
            {layersOpen && !picked ? 'Hide layers' : 'Layers'}
          </button>
          <div
            id="mo-layers"
            data-testid="layers-panel"
            className={`w-full phone:max-h-[50svh] phone:overflow-y-auto phone:overscroll-contain ${picked ? 'hidden' : `roomy:block ${layersOpen ? 'block' : 'hidden'}`}`}
          >
          <LayerPanel
            showReports={showReports}
            onShowReports={setShowReports}
            showGroups={showGroupsOnMap}
            onShowGroups={setShowGroupsOnMap}
            world={worldLayer}
            onWorld={setWorldLayer}
            worldData={worldData}
          />
          </div>
        </div>
      </div>
      {/*
        The findings need room for tables and a chart: beside the left column
        on a wide screen, below the name and tabs on a phone. Over the list and
        the layer switches, which are about the map it covers.
      */}
      {aboutOpen && (
        <div className="pointer-events-none absolute inset-3 z-[1004] md:inset-x-[max(1rem,calc(50%-26rem))] md:bottom-10 md:top-6">
          <div className="mo-swap-in pointer-events-auto h-full">
            <AboutPanel onClose={() => setAboutOpen(false)} onReplay={() => onReplayIntro?.()} />
          </div>
        </div>
      )}
      {/* On a narrow screen the world switch and the search step aside while it
          is open (Findings is about countries, not either world's reports), so
          it starts just under the tabs, where they are measured to end: an
          error above them moves them down. At 12.5rem down, below them all, a
          short phone left it about 30px. */}
      {tab === 'findings' && (
        <div
          data-testid="findings-place"
          className="pointer-events-none absolute inset-x-3 bottom-3 top-[var(--findings-top,7.25rem)] z-[1003] md:bottom-10 md:left-[26.5rem] md:right-4 md:top-4 xl:top-28"
          style={findingsTop === null ? undefined : ({ '--findings-top': `${findingsTop}px` } as CSSProperties)}
        >
          <div className="mo-swap-in pointer-events-auto h-full">
            <FindingsPanel state={findings} />
          </div>
        </div>
      )}
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
      {/*
        The left column scrolls on its own once it is taller than the window: a
        report open under the filters ran off the bottom of the screen. Only
        the panels take the pointer; the gaps between them are still the map.
      */}
      <div
        ref={column}
        className="mo-column mo-enter mo-enter--left pointer-events-none absolute inset-0 z-[1000] flex flex-col gap-3 overflow-y-auto p-4"
        style={{ '--delay': '200ms' } as CSSProperties}
      >
        {worlds && (
          <div
            className={`pointer-events-auto w-[min(26rem,calc(100vw-2rem))] [@media(max-height:480px)]:w-[min(18rem,45vw)] xl:absolute xl:left-1/2 xl:top-4 xl:-translate-x-1/2 ${tab === 'findings' ? 'max-md:hidden' : ''}`}
          >
            <WorldSwitch
              value={worlds.value}
              onChange={worlds.onChange}
              realConnected={worlds.realConnected}
            />
          </div>
        )}
        <div
          data-testid="column-top"
          className={`pointer-events-auto w-[min(24rem,calc(100vw-2rem))] [@media(max-height:480px)]:w-[min(18rem,45vw)] shrink-0 ${
            capTop ? 'phone:max-h-[25svh] phone:overflow-y-auto phone:overscroll-contain' : ''
          } ${
            !working && results.length === 0 && !panelOpen
              ? 'short:max-h-[35svh] short:overflow-y-auto short:overscroll-contain'
              : ''
          }`}
        >
          {/* Errors first: in a top held to a quarter of a phone's screen, one that
              came after the sign-in card appeared scrolled out of sight. */}
          <Reveal gap="pb-2" show={authError !== null}>
            <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-900 phone:p-2">
              {authError}
            </p>
          </Reveal>

          <Reveal gap="pb-2" show={(reportsError ?? cellsError) !== null}>
            <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-900 phone:p-2">
              {reportsError ?? cellsError} Reports may be missing.
            </p>
          </Reveal>

          {/* The app's name, lower case on purpose, and what it is about. */}
          <div data-testid="column-name" className={`flex items-center gap-2 ${working ? 'phone:hidden' : ''}`}>
            <p className="mo-glass inline-block rounded-2xl px-3.5 py-1 text-xl font-semibold tracking-tight text-emerald-800">
              tidy
            </p>
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              aria-expanded={aboutOpen}
              className="mo-glass rounded-2xl px-3.5 py-1.5 text-sm font-medium text-slate-800 hover:text-slate-950"
            >
              About
            </button>
          </div>
          <div ref={tabsRow} data-testid="column-tabs" className={`mt-2 ${working ? 'phone:mt-0' : ''}`}>
          <MapTabs
            value={tab}
            // A half-written report or group waits, hidden, on its own tab.
            // Closing it on a tab change threw away whatever had been typed.
            onChange={(next) => {
              setTab(next)
              setPanelOpen(false)
            }}
          />
          </div>

          <div className={`mt-2 flex gap-2 ${tab === 'findings' ? 'max-md:hidden' : ''}`}>
            <input
              type="search"
              aria-label="Search for a place"
              placeholder="Search for a place"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              className="mo-glass w-full min-w-0 flex-1 rounded-2xl px-4 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-slate-900/15"
            />
            {working && (
              <button
                type="button"
                onClick={() => setAboutOpen(true)}
                aria-expanded={aboutOpen}
                aria-label="About"
                title="About"
                className="mo-glass shrink-0 rounded-2xl px-3.5 py-2 hidden text-sm font-medium text-slate-800 phone:block"
              >
                ?
              </button>
            )}
            {(tab === 'map' || (tab === 'groups' && (groups.length > 0 || panelOpen))) && (
              <button
                type="button"
                aria-expanded={panelOpen}
                aria-controls={tab === 'groups' ? 'mo-group-list' : 'mo-filters'}
                onClick={() => setPanelOpen((open) => !open)}
                className="mo-glass shrink-0 rounded-2xl px-3.5 py-2 hidden text-sm font-medium text-slate-800 phone:block"
              >
                {tab === 'groups'
                  ? panelOpen
                    ? 'Hide groups'
                    : 'Groups'
                  : panelOpen
                    ? 'Hide filters'
                    : filtering
                      ? 'Filters on'
                      : 'Filters'}
              </button>
            )}
          </div>
          <Reveal show={results.length > 0} from="above" gap="pt-1">
            <ul className="mo-glass max-h-64 overflow-auto rounded-2xl">
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
          </Reveal>

          <Reveal gap="pt-2" show={worlds?.value === 'idea' && !user}>
            <div className="mo-glass space-y-2 rounded-2xl p-3 phone:flex phone:items-center phone:gap-3 phone:space-y-0 phone:p-2">
              <p className="text-sm text-slate-700 phone:text-xs">
                No account needed to try the idea. Nothing you add here is sent anywhere.
              </p>
              <button
                type="button"
                onClick={() => void data.signInWithEmail(IDEA_VISITOR_EMAIL)}
                className="w-full rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white phone:w-auto phone:shrink-0"
              >
                Try it signed in
              </button>
            </div>
          </Reveal>

          <Reveal gap="pt-2" show={!unconnected && !(worlds?.value === 'idea' && !user)}>
            <div className="mo-glass rounded-2xl p-3 phone:px-3 phone:py-1.5">
              <SignInPanel data={data} user={user} />
            </div>
          </Reveal>

          <Reveal gap={panelOpen ? 'pt-2' : 'pt-2 phone:pt-0'} show={tab === 'map'}>
            <div role="tabpanel" id="panel-map" aria-labelledby="tab-map">
            {!panelOpen && locatingMessage && (
              <p role="status" className="mo-glass hidden rounded-2xl p-2 text-xs text-slate-700 phone:block">
                {locatingMessage}
              </p>
            )}
            <div id="mo-filters" className={fold}>
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              showing={matchingInView}
              total={totalInView}
              onUseMyLocation={() => void onUseMyLocation()}
              locatingMessage={locatingMessage}
              hasLocation={filters.origin !== null}
            />
            </div>
            </div>
          </Reveal>

          <Reveal gap="pt-2" show={tab === 'groups'}>
            <div role="tabpanel" id="panel-groups" aria-labelledby="tab-groups">
            <GroupsPanel
              data={data}
              groups={groups}
              loaded={groupsLoaded}
              error={groupsError}
              signedIn={user !== null && !unconnected}
              selectedId={selectedGroupId}
              onSelect={(group) => {
                if (isPhone()) setPanelOpen(false)
                selectGroup(group)
              }}
              onChanged={() => void refreshGroups()}
              canStart={!unconnected}
              more={groupsMore}
              isAdmin={user?.isAdmin ?? false}
              listFolded={!panelOpen}
              bringPickedIntoView={isPhone()}
            />
            </div>
          </Reveal>

          <Reveal gap="pt-2" show={tab === 'map' && !!user?.isAdmin && !reviewing}>
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false)
                setFocusQueue(true)
                setReviewing(true)
              }}
              className="mo-glass w-full rounded-2xl px-3 py-2 text-left text-sm font-medium text-slate-800"
            >
              Review queue
            </button>
          </Reveal>

          <Reveal gap="pt-2" show={tab === 'map' && showReports && showPins && reports.length >= REPORT_PAGE_LIMIT}>
            <p role="status" className="rounded-lg bg-slate-100 p-3 text-xs text-slate-700 phone:p-2">
              Showing the {REPORT_PAGE_LIMIT} most confirmed reports here. Zoom in to see the rest.
            </p>
          </Reveal>

          <Reveal gap="pt-2" show={tab === 'map' && offMapNotice !== null}>
            <p role="status" className="rounded-lg bg-slate-100 p-3 text-xs text-slate-700 phone:p-2">
              {offMapNotice}
            </p>
          </Reveal>

          <Reveal gap="pt-2" show={worlds?.value === 'idea'}>
            <p role="status" className="rounded-lg bg-violet-50 p-3 text-xs text-violet-900 phone:p-2">
              <strong>The idea.</strong> Every report and group on this map is made up, to show
              how it works. None of them are real.
            </p>
          </Reveal>

          <Reveal gap="pt-2" show={unconnected}>
            <p role="status" className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900 phone:p-2">
              <strong>Real world.</strong> This map is not connected to the real reports
              yet, so there are none to show. Switch to The idea to see how it works.
            </p>
          </Reveal>
        </div>

        <div
          data-testid="column-bottom"
          className={`pointer-events-auto mt-auto w-[min(26rem,calc(100vw-2rem))] [@media(max-height:480px)]:w-[min(18rem,45vw)] shrink-0 upright:max-h-[40svh] upright:overflow-y-auto upright:overscroll-contain ${
            working ? 'short:min-h-24 short:flex-1 short:shrink short:overflow-y-auto short:overscroll-contain' : ''
          }`}
        >
          <Reveal gap="pt-3" show={tab === 'map' && reviewing && !!user?.isAdmin}>
            {user?.isAdmin && (
              <AdminQueue
                data={data}
                isAdmin={user.isAdmin}
                onClose={() => setReviewing(false)}
                takeFocus={focusQueue}
                onFocused={() => setFocusQueue(false)}
                pinsVersion={pinsVersion}
                onDecided={() => {
                  setChanges((n) => n + 1)
                  void refresh()
                  void refreshCells()
                }}
              />
            )}
          </Reveal>

          <Reveal gap="pt-3" show={tab === 'map' && openReport !== null}>
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
                  setChanges((n) => n + 1)
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
          </Reveal>

          <Reveal gap="pt-3" show={tab === 'map' && !unconnected && adding} keepMounted={adding}>
            <ReportForm
              data={data}
              lat={view.center[0]}
              lng={view.center[1]}
              zoom={view.zoom}
              signedIn={user !== null}
              onSubmitted={() => {
                setChanges((n) => n + 1)
                setAdding(false)
                void refresh()
              }}
              onCancel={() => setAdding(false)}
            />
          </Reveal>

          <Reveal gap="pt-3" show={tab === 'map' && !unconnected && !adding}>
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false)
                setAdding(true)
              }}
              className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg"
            >
              {closeEnoughToAdd ? 'Add a report here' : 'Add a report'}
            </button>
          </Reveal>

          <Reveal gap="pt-3" show={tab === 'groups' && !unconnected && startingGroup} keepMounted={startingGroup}>
            <GroupForm
              data={data}
              lat={view.center[0]}
              lng={view.center[1]}
              zoom={view.zoom}
              signedIn={user !== null}
              onCreated={(id) => {
                setStartingGroup(false)
                setPanelOpen(true)
                setSelectedGroupId(id)
                void refreshGroups()
              }}
              onCancel={() => setStartingGroup(false)}
              checkedFirst={worlds?.value !== 'idea'}
            />
          </Reveal>

          <Reveal gap="pt-3" show={tab === 'groups' && !unconnected && !startingGroup}>
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false)
                setStartingGroup(true)
              }}
              className="w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-medium text-white shadow-lg"
            >
              Start a cleaning group here
            </button>
          </Reveal>
        </div>
      </div>

      <GlobeMap
        initialCenter={start.center}
        initialZoom={start.zoom}
        flyTo={flyTo}
        onViewChange={setView}
        // Towers while aggregated. Handing it none -- pins taking over, or
        // litter switched off -- fades them out rather than cutting them.
        cells={showReports && !showPins ? normalisedCells : NO_CELLS}
        cellsKey={showPins ? 'pins' : (cells.resolution ?? 'none')}
        pins={showReports && showPins ? visibleReports : NO_REPORTS}
        selectedPinId={openReportId}
        onPinSelect={openReportById}
        groups={showGroupsOnMap ? groups : NO_GROUPS}
        selectedGroupId={selectedGroupId}
        onGroupSelect={(id) => {
          const group = groups.find((g) => g.id === id)
          if (!group) return
          setTab('groups')
          setPanelOpen(true)
          selectGroup(group)
        }}
        world={worldData.status === 'ready' ? worldData.overlay : null}
        onCellSelect={(cell, reportCount) => {
          // Emptied in the same update, so the list never opens on the last
          // area's reports before this one's arrive.
          setCatalog({ status: 'loading' })
          setPanelOpen(false)
          setPicked({ cell, reportCount })
        }}
        selectedCell={picked?.cell ?? null}
      />

      {/* Reports are reachable by name as well as by eye, which matters for
          anyone who cannot pick a pin out of a busy map. */}
      {/* Only while litter is on the map: switched off, it is off the list too. */}
      <ul className="sr-only">
        {(showReports ? visibleReports : []).map((report) => (
          <li key={report.id}>
            <button type="button" onClick={() => openReportById(report.id)}>
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
