import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { cellsForPoint } from '../grid/cells'
import type {
  CommentView,
  CurrentUser,
  DataSource,
  NewReport,
  PhotoView,
  QueueItem,
  QueueSubject,
  ReportView,
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
   * Build report views for a whole page in a fixed number of queries.
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

    const { data: photos } = await this.client
      .from('public_report_photos')
      .select('id, report_id, storage_path, moderation_status')
      .in('report_id', ids)

    const photosByReport = new Map<string, PhotoView[]>()
    for (const photo of photos ?? []) {
      const key = String(photo.report_id)
      const list = photosByReport.get(key) ?? []
      list.push(this.toPhoto(photo))
      photosByReport.set(key, list)
    }

    const voted = new Set<string>()
    if (viewerId) {
      const { data: votes } = await this.client
        .from('votes')
        .select('report_id')
        .eq('user_id', viewerId)
        .in('report_id', ids)
      for (const vote of votes ?? []) voted.add(String(vote.report_id))
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
        viewerHasVoted: voted.has(id),
        viewerIsReporter: viewerId !== null && row.reporter_id === viewerId,
      }
    })
  }

  async listReportsInView(bounds: {
    minLat: number
    minLng: number
    maxLat: number
    maxLng: number
  }): Promise<ReportView[]> {
    const user = await this.getCurrentUser()
    // A viewport crossing the antimeridian arrives with minLng > maxLng, and a
    // plain between returns nothing at all there. reports_rollup already
    // handles this; the list query has to agree with it.
    const crossesAntimeridian = bounds.minLng > bounds.maxLng

    let query = this.client
      .from('public_reports')
      .select('*')
      .gte('lat', bounds.minLat)
      .lte('lat', bounds.maxLat)

    query = crossesAntimeridian
      ? query.or('lng.gte.' + bounds.minLng + ',lng.lte.' + bounds.maxLng)
      : query.gte('lng', bounds.minLng).lte('lng', bounds.maxLng)

    const { data, error } = await query.limit(500)
    if (error) throw new Error(error.message)
    return this.toReports(data ?? [], user?.id ?? null)
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

    // Names come from public_profiles, which carries id and display_name only.
    // Reading `profiles` directly would expose `role` and let anyone enumerate
    // admins, which is why that table is revoked.
    const authorIds = [...new Set(rows.map((row) => String(row.author_id)))]
    const { data: profiles } = await this.client
      .from('public_profiles')
      .select('id, display_name')
      .in('id', authorIds)

    const nameById = new Map(
      (profiles ?? []).map((p) => [String(p.id), (p.display_name as string | null) ?? null]),
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
