import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { cellsForPoint } from '../grid/cells'
import { crossesAntimeridian } from '../geo/bounds'
import { distanceMetres } from '../geo/distance'

/**
 * How many individual reports one viewport will return.
 *
 * The aggregated view does not use this — it is a real GROUP BY over every
 * matching row — so a capped page only ever limits how many pins are drawn at
 * street level, where far fewer than this are on screen anyway.
 */
export const REPORT_PAGE_LIMIT = 500
import type {
  CommentView,
  CurrentUser,
  DataSource,
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
 * It reads through the public_reports and public_report_photos views rather
 * than the tables, so a note or photo that has not been approved comes back as
 * null rather than as content the UI has to remember to hide.
 */
export class SupabaseDataSource implements DataSource {
  private readonly client: SupabaseClient
  private readonly photoBaseUrl: string

  constructor(url: string, anonKey: string, photoBaseUrl: string) {
    this.client = createClient(url, anonKey)
    this.photoBaseUrl = photoBaseUrl.replace(/\/$/, '')
  }

  // --- auth ---------------------------------------------------------------

  async getCurrentUser(): Promise<CurrentUser | null> {
    const { data } = await this.client.auth.getUser()
    if (!data.user) return null

    // Through the RPC, not the table. `profiles` is revoked from browser roles
    // so nobody can enumerate admins by reading `role`; reading it directly
    // returns "permission denied", and swallowing that error made isAdmin
    // silently false for everyone -- including real admins, which left the
    // review queue impossible to open.
    const { data: isAdmin, error } = await this.client.rpc('is_admin')
    if (error) {
      console.error('[mo] could not determine admin status:', error.message)
    }

    return {
      id: data.user.id,
      email: data.user.email ?? undefined,
      isAdmin: isAdmin === true,
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
      }
    })
  }

  async listReportsInView(bounds: ViewBounds, filters: RollupFilters): Promise<ReportView[]> {
    const user = await this.getCurrentUser()
    // Every filter is applied by the database. Applying them to a capped page
    // afterwards meant "Cleaned up" could legitimately return nothing while
    // cleaned reports sat right there -- the page just happened not to hold any.
    let query = this.client
      .from('public_reports')
      .select('*')
      .gte('lat', bounds.minLat)
      .lte('lat', bounds.maxLat)

    // A viewport crossing the antimeridian arrives with minLng > maxLng, and a
    // plain between returns nothing at all there.
    query = crossesAntimeridian(bounds)
      ? query.or('lng.gte.' + bounds.minLng + ',lng.lte.' + bounds.maxLng)
      : query.gte('lng', bounds.minLng).lte('lng', bounds.maxLng)

    if (filters.status !== 'all') query = query.eq('status', filters.status)
    if (filters.minConfirmations > 0) query = query.gte('vote_count', filters.minConfirmations)
    if (filters.since) query = query.gte('created_at', filters.since)

    // Ordered, so the cap takes the most-confirmed rather than an arbitrary
    // and non-deterministic slice.
    const { data, error } = await query
      .order('vote_count', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(REPORT_PAGE_LIMIT)

    if (error) throw new Error(error.message)

    // Distance is the one filter left to the client: PostgREST cannot express
    // st_dwithin on a plain select. It is safe here because it only ever
    // narrows what the viewport already bounded, and the viewport is always
    // smaller than the radius by the time anybody is looking at pins.
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

    return this.toReports(rows, user?.id ?? null)
  }

  /**
   * An exact count, so the panel never reports the page cap as if it were the
   * filters. Pass filters to count what is shown; omit them for the total.
   */
  async countReportsInView(bounds: ViewBounds, filters?: RollupFilters): Promise<number> {
    let query = this.client
      .from('public_reports')
      .select('id', { count: 'exact', head: true })
      // public_reports deliberately returns rejected rows to their author and
      // to admins, and the map strips those. Counting them would tell those two
      // people a filter was hiding something that has actually been removed.
      .eq('moderation_status', 'approved')
      .gte('lat', bounds.minLat)
      .lte('lat', bounds.maxLat)

    query = crossesAntimeridian(bounds)
      ? query.or('lng.gte.' + bounds.minLng + ',lng.lte.' + bounds.maxLng)
      : query.gte('lng', bounds.minLng).lte('lng', bounds.maxLng)

    if (filters) {
      if (filters.status !== 'all') query = query.eq('status', filters.status)
      if (filters.minConfirmations > 0) query = query.gte('vote_count', filters.minConfirmations)
      if (filters.since) query = query.gte('created_at', filters.since)
    }

    const { count, error } = await query
    if (error) throw new Error(error.message)
    return count ?? 0
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
        const storagePath = await uploadPhoto(reportId, photo)
        const { error: photoError } = await this.client
          .from('report_photos')
          .insert({ report_id: reportId, storage_path: storagePath })
        if (photoError) throw new Error(photoError.message)
      }
    } catch (cause) {
      // Deleting the report also clears its moderation job, via the
      // cleanup_moderation_for_deleted trigger -- otherwise every failed
      // submission would seed a permanent orphan into the human queue.
      await this.client.from('reports').delete().eq('id', reportId)
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
    const { data, error } = await this.client
      .from('public_comments')
      .select('id, body, author_id, created_at, moderation_status')
      .eq('report_id', reportId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    const rows = data ?? []
    if (rows.length === 0) return []

    // Names come from the profile_names RPC, which takes the ids you already
    // hold and returns id and display_name only. Reading `profiles` directly
    // would expose `role` and let anyone enumerate admins, and a listable view
    // would let anyone enumerate every account.
    const authorIds = [...new Set(rows.map((row) => String(row.author_id)))]
    const { data: profiles, error: nameError } = await this.client.rpc('profile_names', {
      ids: authorIds,
    })
    if (nameError) {
      // Names are a nicety; the comments still matter. Say so rather than
      // silently rendering everyone as "someone" forever.
      console.error('[mo] could not load comment author names:', nameError.message)
    }

    const nameById = new Map(
      ((profiles ?? []) as Array<{ id: string; display_name: string | null }>).map((p) => [
        String(p.id),
        p.display_name ?? null,
      ]),
    )

    return rows.map((row) => ({
      id: String(row.id),
      body: String(row.body),
      // Nobody is required to set a name, so "someone" is the honest fallback.
      authorName: nameById.get(String(row.author_id)) ?? 'someone',
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

  async flag(subjectType: QueueSubject, subjectId: string, reason: string): Promise<void> {
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
      createdAt: String(row.created_at),
    }))
  }

  async getModerationQueueSize(): Promise<number> {
    const { data, error } = await this.client.rpc('admin_queue_size')
    if (error) throw new Error(error.message)
    return Number(data ?? 0)
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

/**
 * Upload a photo and return its object key.
 *
 * NOT BUILT. Photos live in Cloudflare R2, and uploading to R2 from a browser
 * needs a short-lived signed URL, which needs a small server endpoint holding
 * the R2 credentials. That endpoint does not exist yet, so this throws rather
 * than pretending to succeed and leaving a report with a broken photo row.
 */
async function uploadPhoto(_reportId: string, _file: File): Promise<string> {
  throw new Error(
    'Photo upload is not connected yet. It needs the R2 signing endpoint (see supabase/README.md).',
  )
}
