import { createClient } from '@supabase/supabase-js'
import { MO_SCHEMA } from './schema'
import { cellsForPoint } from '../grid/cells'
import { crossesAntimeridian, boundsAround, intersectBounds } from '../geo/bounds'
import { distanceMetres } from '../geo/distance'
import { uploadPhoto } from '../upload/uploadPhoto'
import { OFF_MAP_IN_VIEW, OFF_MAP_PAGE, REJECTED_PAGE } from './types'

/**
 * How many individual reports one viewport will return.
 *
 * The aggregated view does not use this — it is a real GROUP BY over every
 * matching row — so a capped page only ever limits how many pins are drawn at
 * street level, where far fewer than this are on screen anyway.
 */
export const REPORT_PAGE_LIMIT = 500

/**
 * One place the client is built, so its type follows from its options.
 *
 * `SupabaseClient` is generic over the schema name, so annotating the field as
 * a bare `SupabaseClient` makes it the `public`-schema type and the assignment
 * stops compiling. Deriving the type from this function means the generics
 * never have to be written out — or kept in step with supabase-js changing
 * their number.
 */
function createMoClient(url: string, anonKey: string) {
  return createClient(url, anonKey, { db: { schema: MO_SCHEMA } })
}
import type {
  CommentView,
  CurrentUser,
  DataSource,
  DirectFlagSubject,
  MyDisplayName,
  RejectedPhoto,
  NewReport,
  PhotoView,
  QueueItem,
  QueueSubject,
  ReportView,
  RollupCell,
  RollupFilters,
  ViewBounds,
} from './types'

/**
 * The real backend.
 *
 * UNVERIFIED. Nothing in this file has run against a live Supabase project,
 * because none exists yet. Every other part of the app has passing tests behind
 * it; this is a careful draft of the wiring, and it should be exercised against
 * a real project before it is trusted.
 *
 * The one exception is `createReport`, which has tests in
 * `supabaseSource.createReport.test.ts`. They run against a fake client, so
 * they prove nothing about the SQL -- but that method is the app's primary
 * write and the only one that has to undo its own work, and its control flow
 * is worth pinning whether or not a database exists.
 *
 * It reads through the public_reports and public_report_photos views rather
 * than the tables, so a note or photo that has not been approved comes back as
 * null rather than as content the UI has to remember to hide.
 */
export class SupabaseDataSource implements DataSource {
  private readonly client: ReturnType<typeof createMoClient>
  private readonly photoBaseUrl: string

  constructor(url: string, anonKey: string, photoBaseUrl: string) {
    // Everything MO owns lives in the `mo` schema, not `public`.
    //
    // MO shares the wearechintu project's database, which already has a
    // `public.reports` table holding abuse reports against marketplace
    // projects. Setting the schema once here is what lets every query below
    // stay written as `.from('reports')` and still mean `mo.reports`.
    //
    // `mo` has to be in the project's exposed-schemas list for this to work
    // at all (Supabase dashboard: API settings). Without it every request
    // comes back 406 with "The schema must be one of the following".
    this.client = createMoClient(url, anonKey)
    this.photoBaseUrl = photoBaseUrl.replace(/\/$/, '')
  }

  // --- auth ---------------------------------------------------------------

  async getCurrentUser(): Promise<CurrentUser | null> {
    const { data } = await this.client.auth.getUser()
    if (!data.user) return null

    // Through the RPC, because there is nothing to read. Moderators are rows
    // in `mo.admins`, which is revoked from both browser roles and has no
    // policy, so `is_admin()` is the only reachable answer and it tells you
    // about yourself only.
    //
    // (This used to say `profiles` was revoked so nobody could read `role`.
    // Neither half is true here: there is no role column, and the
    // marketplace's `public.profiles` is readable by anon in this database.)
    //
    // Swallowing the error made isAdmin silently false for everyone --
    // including real admins, which left the review queue impossible to open.
    const { data: isAdmin, error } = await this.client.rpc('is_admin')
    if (error) {
      console.error('[mo] could not determine admin status:', error.message)
    }

    return {
      id: data.user.id,
      email: data.user.email ?? undefined,
      // Fail closed on the permission itself, but say so. Returning a bare
      // false made a failed check identical to "not an admin", so a real admin
      // silently lost the review queue.
      isAdmin: isAdmin === true,
      adminUnknown: Boolean(error),
    }
  }

  onAuthChange(listener: (user: CurrentUser | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange(() => {
      void this.getCurrentUser().then(listener)
    })
    return () => data.subscription.unsubscribe()
  }

  async signInWithEmail(email: string): Promise<void> {
    const { error } = await this.client.auth.signInWithOtp({ email })
    if (error) throw new Error(error.message)
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut()
  }

  // --- the name you post under ----------------------------------------------

  /**
   * Through RPCs, because mo.display_names is revoked from both browser roles.
   * Both act on the caller's own row only.
   *
   * Throws rather than returning null on failure: null means "has not chosen
   * one", and reading a failed lookup that way would ask somebody who already
   * has a name to choose again -- and then refuse the new one as too soon.
   */
  async getMyDisplayName(): Promise<MyDisplayName | null> {
    const { data, error } = await this.client.rpc('my_display_name')
    if (error) throw new Error(error.message)
    const row = ((data ?? []) as Array<{ name: string; moderation_status: string }>)[0]
    if (!row) return null
    return {
      name: String(row.name),
      status: row.moderation_status as MyDisplayName['status'],
    }
  }

  async setDisplayName(name: string): Promise<void> {
    const { error } = await this.client.rpc('set_display_name', { new_name: name })
    if (error) throw new Error(error.message)
  }

  // --- reports ------------------------------------------------------------

  /**
   * With no photo host configured there is nowhere to serve images from, so the
   * url stays null. Building `/{path}` instead produced a truthy relative URL
   * against the app's own origin: a broken <img> that the UI treated as a real
   * photo, and an admin asked to judge content they could not see.
   */
  private toPhoto = (row: Record<string, unknown>): PhotoView => ({
    id: String(row.id),
    url:
      this.photoBaseUrl && row.storage_path
        ? `${this.photoBaseUrl}/${String(row.storage_path)}`
        : null,
    moderationStatus: row.moderation_status as PhotoView['moderationStatus'],
  })

  /**
   * postgrest-js sends `.in()` as a GET with every id in the query string, so
   * 500 UUIDs is roughly 19 KB of URL -- past the gateway's limit, which then
   * returns 414 before the query ever runs. Chunking keeps each request well
   * inside it.
   */
  private static readonly ID_CHUNK = 100

  private static chunk(ids: string[]): string[][] {
    const out: string[][] = []
    for (let i = 0; i < ids.length; i += SupabaseDataSource.ID_CHUNK) {
      out.push(ids.slice(i, i + SupabaseDataSource.ID_CHUNK))
    }
    return out
  }

  /**
   * Throws rather than returning what it managed to get.
   *
   * Swallowing the error made a failed fetch indistinguishable from a report
   * that genuinely has no photos -- the map would render every pin photo-less
   * with nothing to say anything had gone wrong.
   */
  private async fetchPhotosFor(ids: string[]): Promise<Array<Record<string, unknown>>> {
    const results = await Promise.all(
      SupabaseDataSource.chunk(ids).map(async (batch) => {
        const { data, error } = await this.client
          .from('public_report_photos')
          .select('id, report_id, storage_path, moderation_status')
          .in('report_id', batch)
        if (error) throw new Error(error.message)
        return data ?? []
      }),
    )
    return results.flat()
  }

  /** Same: a swallowed error here shows "confirm this" on something you already confirmed. */
  private async fetchVotedIdsFor(ids: string[], viewerId: string): Promise<Set<string>> {
    const voted = new Set<string>()
    const results = await Promise.all(
      SupabaseDataSource.chunk(ids).map(async (batch) => {
        const { data, error } = await this.client
          .from('votes')
          .select('report_id')
          .eq('user_id', viewerId)
          .in('report_id', batch)
        if (error) throw new Error(error.message)
        return data ?? []
      }),
    )
    for (const vote of results.flat()) voted.add(String(vote.report_id))
    return voted
  }

  /**
   * Build report views for a whole page in a bounded number of queries.
   *
   * Doing this per report meant one photo query and one vote query EACH: a
   * signed-in load of 500 reports was over a thousand HTTP requests, and every
   * moderation decision triggered the lot again through onDecided.
   */
  private async toReports(
    rows: Array<Record<string, unknown>>,
    viewerId: string | null,
  ): Promise<ReportView[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => String(row.id))

    const [photos, votedIds] = await Promise.all([
      this.fetchPhotosFor(ids),
      viewerId ? this.fetchVotedIdsFor(ids, viewerId) : Promise.resolve(new Set<string>()),
    ])

    const photosByReport = new Map<string, PhotoView[]>()
    for (const photo of photos) {
      const key = String(photo.report_id)
      const list = photosByReport.get(key) ?? []
      list.push(this.toPhoto(photo))
      photosByReport.set(key, list)
    }

    return rows.map((row) => {
      const id = String(row.id)
      return {
        id,
        lat: Number(row.lat),
        lng: Number(row.lng),
        note: (row.note as string | null) ?? null,
        noteStatus: row.note_status as ReportView['noteStatus'],
        moderationStatus: row.moderation_status as ReportView['moderationStatus'],
        status: row.status as ReportView['status'],
        voteCount: Number(row.vote_count ?? 0),
        createdAt: String(row.created_at),
        cells: cellsForPoint(Number(row.lat), Number(row.lng)),
        photos: photosByReport.get(id) ?? [],
        viewerHasVoted: votedIds.has(id),
        viewerIsReporter: viewerId !== null && row.reporter_id === viewerId,
        // From public_reports, which only fills it once the name is approved
        // (or for the reporter themselves). Never looked up from an id.
        reporterName: (row.reporter_name as string | null) ?? null,
        // Only ever filled for an admin; the view returns null to everybody else.
        removalReason: (row.removal_reason as string | null) ?? null,
      }
    })
  }

  async listReportsInView(bounds: ViewBounds, filters: RollupFilters): Promise<ReportView[]> {
    const user = await this.getCurrentUser()
    const { rows } = await this.filteredRows(bounds, filters, 'on', REPORT_PAGE_LIMIT)
    return this.toReports(rows, user?.id ?? null)
  }

  async listOffMapInView(
    bounds: ViewBounds,
    filters: RollupFilters,
  ): Promise<{ reports: ReportView[]; more: boolean }> {
    const user = await this.getCurrentUser()
    // Signed out, the view returns none of these, so do not ask.
    if (!user) return { reports: [], more: false }
    // The same filters as the live pins. Viewport alone drew every off-map pin
    // in the box for an admin who had asked for "Cleaned up" or a small radius.
    // One more than it draws, so a cut-short list can say so.
    const { rows, fetched } = await this.filteredRows(bounds, filters, 'off', OFF_MAP_IN_VIEW + 1)
    return {
      reports: await this.toReports(rows.slice(0, OFF_MAP_IN_VIEW), user.id),
      // From what the database returned, before the radius trimmed it. Hitting
      // the fetch limit means matching pins may lie beyond it, even if trimming
      // the box's corners then left fewer than a page to draw.
      more: fetched > OFF_MAP_IN_VIEW,
    }
  }

  /**
   * One query for both lists, so the live pins and the off-map ones can never
   * be filtered differently.
   */
  private async filteredRows(
    bounds: ViewBounds,
    filters: RollupFilters,
    map: 'on' | 'off',
    limit: number,
  ): Promise<{ rows: Array<Record<string, unknown>>; fetched: number }> {
    // Every filter is applied by the database. Applying them to a capped page
    // afterwards meant "Cleaned up" could legitimately return nothing while
    // cleaned reports sat right there -- the page just happened not to hold any.
    // Narrow the box to the radius BEFORE the cap applies. Filtering by
    // distance afterwards meant the pins were a distance-filtered slice of the
    // 500 most-confirmed rows rather than the reports actually within range, so
    // pins could be missing that the aggregated view included.
    const searched =
      filters.origin && filters.withinMetres
        ? intersectBounds(bounds, boundsAround(filters.origin, filters.withinMetres))
        : bounds

    let query = this.client.from('public_reports').select('*')
    // Live pins, or off-map ones, never both. Off-map pins come back only to
    // their reporter and to admins, and in the live list they took room in the
    // capped page and disagreed with the counts.
    query =
      map === 'on'
        ? query.neq('moderation_status', 'rejected')
        : query.eq('moderation_status', 'rejected')
    query = query.gte('lat', searched.minLat).lte('lat', searched.maxLat)

    // A viewport crossing the antimeridian arrives with minLng > maxLng, and a
    // plain between returns nothing at all there.
    query = crossesAntimeridian(searched)
      ? query.or('lng.gte.' + searched.minLng + ',lng.lte.' + searched.maxLng)
      : query.gte('lng', searched.minLng).lte('lng', searched.maxLng)

    if (filters.status !== 'all') query = query.eq('status', filters.status)
    if (filters.minConfirmations > 0) query = query.gte('vote_count', filters.minConfirmations)
    if (filters.since) query = query.gte('created_at', filters.since)

    // Ordered, so the cap takes the most-confirmed rather than an arbitrary
    // and non-deterministic slice.
    const { data, error } = await query
      .order('vote_count', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw new Error(error.message)

    // Distance is the one filter left to the client: PostgREST cannot express
    // st_dwithin on a plain select. It is safe here because it only ever
    // narrows what the viewport already bounded, and the viewport is always
    // smaller than the radius by the time anybody is looking at pins.
    const fetched = (data ?? []).length
    const rows =
      filters.origin && filters.withinMetres
        ? (data ?? []).filter(
            (row) =>
              distanceMetres(filters.origin!, {
                lat: Number(row.lat),
                lng: Number(row.lng),
              }) <= filters.withinMetres!,
          )
        : (data ?? [])
    return { rows, fetched }
  }

  /**
   * An exact count, so the panel never reports the page cap as if it were the
   * filters. Pass filters to count what is shown; omit them for the total.
   *
   * Through an RPC because PostgREST cannot express st_dwithin on a select, and
   * a count that quietly skipped the distance filter said "60 reports" while
   * twelve pins were drawn.
   */
  async countReportsInView(bounds: ViewBounds, filters?: RollupFilters): Promise<number> {
    const { data, error } = await this.client.rpc('count_reports_in_view', {
      min_lat: bounds.minLat,
      min_lng: bounds.minLng,
      max_lat: bounds.maxLat,
      max_lng: bounds.maxLng,
      status_filter: filters?.status ?? 'all',
      min_confirmations: filters?.minConfirmations ?? 0,
      since: filters?.since ?? null,
      origin_lat: filters?.origin?.lat ?? null,
      origin_lng: filters?.origin?.lng ?? null,
      within_metres: filters?.withinMetres ?? null,
    })
    if (error) throw new Error(error.message)
    return Number(data ?? 0)
  }

  /**
   * The aggregated view, computed in Postgres over every matching report --
   * not over the page the client happened to fetch.
   */
  async getRollup(
    bounds: ViewBounds,
    resolution: number,
    filters: RollupFilters,
  ): Promise<RollupCell[]> {
    const { data, error } = await this.client.rpc('reports_rollup', {
      min_lat: bounds.minLat,
      min_lng: bounds.minLng,
      max_lat: bounds.maxLat,
      max_lng: bounds.maxLng,
      resolution,
      status_filter: filters.status,
      min_confirmations: filters.minConfirmations,
      since: filters.since,
      origin_lat: filters.origin?.lat ?? null,
      origin_lng: filters.origin?.lng ?? null,
      within_metres: filters.withinMetres,
    })
    if (error) throw new Error(error.message)

    return (data ?? []).map((row: Record<string, unknown>) => ({
      cell: String(row.cell),
      weight: Number(row.weight ?? 0),
      reportCount: Number(row.report_count ?? 0),
    }))
  }

  async getReport(id: string): Promise<ReportView | null> {
    const user = await this.getCurrentUser()
    const { data, error } = await this.client
      .from('public_reports')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    return (await this.toReports([data], user?.id ?? null))[0] ?? null
  }

  async createReport(report: NewReport): Promise<{ id: string }> {
    const user = await this.getCurrentUser()
    if (!user) throw new Error('Please sign in to add a report.')
    if (report.photos.length === 0) throw new Error('Please add a photo.')

    // Taken before anything is written. The upload endpoint needs it, and a
    // missing token discovered halfway through would mean deleting a report
    // that was only just inserted.
    const { data: session } = await this.client.auth.getSession()
    const accessToken = session.session?.access_token
    if (!accessToken) throw new Error('Please sign in to add a report.')

    // Cells are computed here, client-side. Postgres cannot derive them without
    // the H3 extension, which is exactly why the schema stores them.
    const cells = cellsForPoint(report.lat, report.lng)

    const { data, error } = await this.client
      .from('reports')
      .insert({
        reporter_id: user.id,
        lat: report.lat,
        lng: report.lng,
        note: report.note || null,
        ...cells,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)

    const reportId = String(data.id)

    // A report is nothing without its photo, and there is no transaction across
    // the insert and the upload. If the upload fails the row must go, or the
    // person is told their report failed while the pin stays on the map for
    // good with nothing to show.
    try {
      for (const photo of report.photos) {
        const storagePath = await uploadPhoto({ reportId, file: photo, accessToken })
        const { error: photoError } = await this.client
          .from('report_photos')
          .insert({ report_id: reportId, storage_path: storagePath })
        if (photoError) throw new Error(photoError.message)
      }
    } catch (cause) {
      // Deleting the report also clears its moderation job, via the
      // cleanup_moderation_for_deleted trigger -- otherwise every failed
      // submission would seed a permanent orphan into the human queue.
      const { error: rollbackError } = await this.client
        .from('reports')
        .delete()
        .eq('id', reportId)
      if (rollbackError) {
        // The rollback is what keeps the promise made above, so its failure is
        // worse than the failure that triggered it: the person is told their
        // report failed while a pin with no photo stays on the map for good.
        // Swallowing it left that with nothing on screen and nothing in a log.
        console.error(
          `[mo] could not remove report ${reportId} after a failed upload:`,
          rollbackError.message,
        )
      }
      throw cause
    }

    return { id: reportId }
  }

  // --- votes, comments, cleaning -------------------------------------------

  async addVote(reportId: string): Promise<void> {
    const user = await this.getCurrentUser()
    if (!user) throw new Error('Please sign in to confirm a report.')
    const { error } = await this.client
      .from('votes')
      .insert({ report_id: reportId, user_id: user.id })
    if (error) throw new Error(error.message)
  }

  async removeVote(reportId: string): Promise<void> {
    const user = await this.getCurrentUser()
    if (!user) return
    const { error } = await this.client
      .from('votes')
      .delete()
      .eq('report_id', reportId)
      .eq('user_id', user.id)
    if (error) throw new Error(error.message)
  }

  async listComments(reportId: string): Promise<CommentView[]> {
    // The name comes with the comment. public_comments carries the author's
    // chosen name once it is approved, and withholds author_id from everybody
    // but the author: that id is the key of the marketplace's profiles table,
    // where a magic-link signup's name is their email prefix. There used to be
    // a second call here resolving ids to exactly those names.
    const { data, error } = await this.client
      .from('public_comments')
      .select('id, body, author_name, viewer_is_author, created_at, moderation_status')
      .eq('report_id', reportId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)

    return (data ?? []).map((row) => ({
      id: String(row.id),
      body: String(row.body),
      // Null until the author's name has been approved.
      authorName: (row.author_name as string | null) ?? 'someone',
      authorNamed: typeof row.author_name === 'string',
      viewerIsAuthor: row.viewer_is_author === true,
      createdAt: String(row.created_at),
      moderationStatus: row.moderation_status as CommentView['moderationStatus'],
    }))
  }

  async addComment(reportId: string, body: string): Promise<void> {
    const user = await this.getCurrentUser()
    if (!user) throw new Error('Please sign in to comment.')
    const { error } = await this.client
      .from('comments')
      .insert({ report_id: reportId, author_id: user.id, body })
    if (error) throw new Error(error.message)
  }

  async markCleaned(reportId: string): Promise<void> {
    // Goes through the RPC, not a table update, so no ordinary user needs
    // UPDATE permission on reports at all.
    const { error } = await this.client.rpc('mark_report_cleaned', { target_report: reportId })
    if (error) throw new Error(error.message)
  }

  async flag(subjectType: DirectFlagSubject, subjectId: string, reason: string): Promise<void> {
    const user = await this.getCurrentUser()
    if (!user) throw new Error('Please sign in to report this.')
    const { error } = await this.client.from('flags').insert({
      subject_type: subjectType,
      subject_id: subjectId,
      flagger_id: user.id,
      reason,
    })
    if (error) throw new Error(error.message)
  }

  async flagCommentAuthorName(commentId: string, reason: string): Promise<void> {
    // Through the RPC: the flag's subject is the author's id, which this
    // client is never given. The function files it and returns nothing.
    const { error } = await this.client.rpc('flag_comment_author', {
      target_comment: commentId,
      reason,
    })
    if (error) throw new Error(error.message)
  }

  async flagReporterName(reportId: string, reason: string): Promise<void> {
    const { error } = await this.client.rpc('flag_report_author', {
      target_report: reportId,
      reason,
    })
    if (error) throw new Error(error.message)
  }

  // --- tier 4: admin only ---------------------------------------------------

  /**
   * Read the review queue.
   *
   * Goes through an RPC rather than selecting the tables, because an admin has
   * to see the actual photo path that the public view withholds. The RPC is
   * SECURITY DEFINER and raises for non-admins, so a non-admin gets an error
   * rather than an empty list that would read as "queue is clear".
   */
  async listModerationQueue(): Promise<QueueItem[]> {
    const { data, error } = await this.client.rpc('admin_moderation_queue', {
      max_results: 50,
    })
    if (error) throw new Error(error.message)

    return (data ?? []).map((row: Record<string, unknown>) => ({
      jobId: String(row.job_id),
      subjectType: row.subject_type as QueueSubject,
      subjectId: String(row.subject_id),
      reportId: row.report_id ? String(row.report_id) : null,
      text: (row.content_text as string | null) ?? null,
      photoUrl:
        this.photoBaseUrl && row.storage_path
          ? `${this.photoBaseUrl}/${String(row.storage_path)}`
          : null,
      reason: (row.reason as string | null) ?? 'no reason recorded',
      tierResults: (row.tier_results as Record<string, unknown>) ?? {},
      flagCount: Number(row.flag_count ?? 0),
      pinOnMap: typeof row.pin_on_map === 'boolean' ? row.pin_on_map : null,
      createdAt: String(row.created_at),
    }))
  }

  async getModerationQueueSize(): Promise<number> {
    const { data, error } = await this.client.rpc('admin_queue_size')
    if (error) throw new Error(error.message)
    return Number(data ?? 0)
  }

  async setReportOnMap(reportId: string, onMap: boolean, reason?: string): Promise<boolean> {
    // The only writer of the pin's status. Refuses non-admins outright rather
    // than quietly updating nothing.
    const { data, error } = await this.client.rpc('admin_set_report_on_map', {
      target_report: reportId,
      on_map: onMap,
      reason: reason ?? null,
    })
    if (error) throw new Error(error.message)
    return data === true
  }

  async listReportsOffMap(): Promise<{ reports: ReportView[]; more: boolean }> {
    // public_reports returns a pin that is off the map only to its reporter and
    // to admins, so for an admin this is every one of them. Ordered by when it
    // was taken off, not when it was made: the one an admin just removed by
    // mistake must be at the top, however old the report.
    const user = await this.getCurrentUser()
    const { data, error } = await this.client
      .from('public_reports')
      .select('*')
      .eq('moderation_status', 'rejected')
      .order('removed_at', { ascending: false })
      .limit(OFF_MAP_PAGE + 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    return {
      reports: await this.toReports(rows.slice(0, OFF_MAP_PAGE), user?.id ?? null),
      more: rows.length > OFF_MAP_PAGE,
    }
  }

  async listRecentlyRejectedPhotos(): Promise<{ photos: RejectedPhoto[]; more: boolean }> {
    // One more than a page, so a list cut short can say so.
    const { data, error } = await this.client.rpc('admin_recent_rejected_photos', {
      max_results: REJECTED_PAGE + 1,
    })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<Record<string, unknown>>
    return { photos: rows.slice(0, REJECTED_PAGE).map((row) => ({
      photoId: String(row.photo_id),
      reportId: String(row.report_id),
      url:
        this.photoBaseUrl && row.storage_path
          ? `${this.photoBaseUrl}/${String(row.storage_path)}`
          : null,
      rejectedAt: String(row.rejected_at),
      // A person's decision is recorded as `human:<id>`; anything else is a tier.
      automatic: !String(row.decided_by ?? '').startsWith('human:'),
    })), more: rows.length > REJECTED_PAGE }
  }

  async allowRejectedPhoto(photoId: string): Promise<void> {
    const { error } = await this.client.rpc('admin_allow_rejected_photo', { target_photo: photoId })
    if (error) throw new Error(error.message)
  }

  async decideModerationItem(jobId: string, verdict: 'approved' | 'rejected'): Promise<void> {
    // Deliberately NOT the worker's record_moderation_verdict, which stays
    // revoked from browser roles. This one refuses non-admins outright.
    const { error } = await this.client.rpc('admin_decide_moderation', {
      job_id: jobId,
      new_verdict: verdict,
    })
    if (error) throw new Error(error.message)
  }
}
