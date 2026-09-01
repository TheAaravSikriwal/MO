import type { ModerationStatus, ReportStatus } from '../../types/report'

export interface CurrentUser {
  id: string
  email?: string
  isAdmin: boolean
}

export interface PhotoView {
  id: string
  /** Null while the photo is still being reviewed. Withheld, not merely hidden. */
  url: string | null
  moderationStatus: ModerationStatus
}

export interface CommentView {
  id: string
  body: string
  authorName: string
  createdAt: string
  moderationStatus: ModerationStatus
}

export interface ReportView {
  id: string
  lat: number
  lng: number
  /** Null while the note is still being reviewed. */
  note: string | null
  noteStatus: ModerationStatus
  /** The PIN's own status, separate from the note's. */
  moderationStatus: ModerationStatus
  status: ReportStatus
  voteCount: number
  createdAt: string
  cells: Record<string, string>
  photos: PhotoView[]
  /** Whether the signed-in person has already confirmed this one. */
  viewerHasVoted: boolean
  viewerIsReporter: boolean
}

export type QueueSubject = 'photo' | 'comment' | 'note'

/** One item a person has to judge, because no machine tier could. */
export interface QueueItem {
  jobId: string
  subjectType: QueueSubject
  subjectId: string
  reportId: string | null
  /** The comment body or report note. Null for photos. */
  text: string | null
  /** The actual image. Admins see it even while it is withheld from everyone else. */
  photoUrl: string | null
  /** Why the machine tiers could not settle it. */
  reason: string
  /** Raw per-tier scores, so a decision can be sanity-checked. */
  tierResults: Record<string, unknown>
  /** How many people complained about it. */
  flagCount: number
  createdAt: string
}

export interface ViewBounds {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

/**
 * The filters, pushed down to wherever the data is.
 *
 * Applying any of these on the client instead means applying them to whatever
 * page happened to come back, which both drops results that should have matched
 * and makes the pin view and the aggregated view disagree.
 */
export interface RollupFilters {
  status: 'all' | 'open' | 'cleaned'
  minConfirmations: number
  since: string | null
  origin: { lat: number; lng: number } | null
  withinMetres: number | null
}

export interface RollupCell {
  cell: string
  weight: number
  reportCount: number
}

export interface NewReport {
  lat: number
  lng: number
  note: string
  photos: File[]
}

/**
 * Everything the UI needs from the outside world.
 *
 * The UI depends on this interface and never on Supabase directly. That keeps
 * every screen testable with a fake, and means the backend could be replaced
 * without touching a single component.
 */
export interface DataSource {
  getCurrentUser(): Promise<CurrentUser | null>
  onAuthChange(listener: (user: CurrentUser | null) => void): () => void
  signInWithEmail(email: string): Promise<void>
  signOut(): Promise<void>

  listReportsInView(bounds: ViewBounds, filters: RollupFilters): Promise<ReportView[]>

  /**
   * Aggregated cells for a viewport, computed where the data is.
   *
   * Rolling up on the client means rolling up whatever page happened to come
   * back, which silently drops the cells that should be hottest.
   */
  /**
   * How many approved reports are in this viewport, ignoring the filters.
   *
   * The panel needs it to say "2 of 5" rather than a bare "2" -- without the
   * comparison a filtered map is indistinguishable from an empty one.
   */
  countReportsInView(bounds: ViewBounds, filters?: RollupFilters): Promise<number>

  getRollup(
    bounds: ViewBounds,
    resolution: number,
    filters: RollupFilters,
  ): Promise<RollupCell[]>

  getReport(id: string): Promise<ReportView | null>
  createReport(report: NewReport): Promise<{ id: string }>

  addVote(reportId: string): Promise<void>
  removeVote(reportId: string): Promise<void>

  listComments(reportId: string): Promise<CommentView[]>
  addComment(reportId: string, body: string): Promise<void>

  markCleaned(reportId: string): Promise<void>

  flag(subjectType: QueueSubject, subjectId: string, reason: string): Promise<void>

  // --- tier 4: admin only -------------------------------------------------

  listModerationQueue(): Promise<QueueItem[]>
  /** Total waiting, which can exceed the page listModerationQueue returns. */
  getModerationQueueSize(): Promise<number>
  decideModerationItem(jobId: string, verdict: 'approved' | 'rejected'): Promise<void>
}
