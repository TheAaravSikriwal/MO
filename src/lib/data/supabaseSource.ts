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
    const { data: profile } = await this.client
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle()
    return {
      id: data.user.id,
      email: data.user.email ?? undefined,
      isAdmin: profile?.role === 'admin',
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

  private toPhoto = (row: Record<string, unknown>): PhotoView => ({
    id: String(row.id),
    url: row.storage_path ? `${this.photoBaseUrl}/${String(row.storage_path)}` : null,
    moderationStatus: row.moderation_status as PhotoView['moderationStatus'],
  })

  private async toReport(
    row: Record<string, unknown>,
    viewerId: string | null,
  ): Promise<ReportView> {
    const id = String(row.id)
    const { data: photos } = await this.client
      .from('public_report_photos')
      .select('id, storage_path, moderation_status')
      .eq('report_id', id)

    let viewerHasVoted = false
    if (viewerId) {
      const { data: vote } = await this.client
        .from('votes')
        .select('report_id')
        .eq('report_id', id)
        .eq('user_id', viewerId)
        .maybeSingle()
      viewerHasVoted = Boolean(vote)
    }

    return {
      id,
      lat: Number(row.lat),
      lng: Number(row.lng),
      note: (row.note as string | null) ?? null,
      noteStatus: row.note_status as ReportView['noteStatus'],
      status: row.status as ReportView['status'],
      voteCount: Number(row.vote_count ?? 0),
      createdAt: String(row.created_at),
      cells: cellsForPoint(Number(row.lat), Number(row.lng)),
      photos: (photos ?? []).map(this.toPhoto),
      viewerHasVoted,
      viewerIsReporter: viewerId !== null && row.reporter_id === viewerId,
    }
  }

  async listReportsInView(bounds: {
    minLat: number
    minLng: number
    maxLat: number
    maxLng: number
  }): Promise<ReportView[]> {
    const user = await this.getCurrentUser()
    const { data, error } = await this.client
      .from('public_reports')
      .select('*')
      .gte('lat', bounds.minLat)
      .lte('lat', bounds.maxLat)
      .gte('lng', bounds.minLng)
      .lte('lng', bounds.maxLng)
      .limit(500)
    if (error) throw new Error(error.message)
    return Promise.all((data ?? []).map((row) => this.toReport(row, user?.id ?? null)))
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
    return this.toReport(data, user?.id ?? null)
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
    for (const photo of report.photos) {
      const storagePath = await uploadPhoto(reportId, photo)
      const { error: photoError } = await this.client
        .from('report_photos')
        .insert({ report_id: reportId, storage_path: storagePath })
      if (photoError) throw new Error(photoError.message)
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
    return (data ?? []).map((row) => ({
      id: String(row.id),
      body: String(row.body),
      authorName: 'someone',
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
      photoUrl: row.storage_path ? `${this.photoBaseUrl}/${String(row.storage_path)}` : null,
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
