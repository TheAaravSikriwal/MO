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
  status: ReportStatus
  voteCount: number
  createdAt: string
  cells: Record<string, string>
  photos: PhotoView[]
  /** Whether the signed-in person has already confirmed this one. */
  viewerHasVoted: boolean
  viewerIsReporter: boolean
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

  listReportsInView(bounds: {
    minLat: number
    minLng: number
    maxLat: number
    maxLng: number
  }): Promise<ReportView[]>

  getReport(id: string): Promise<ReportView | null>
  createReport(report: NewReport): Promise<{ id: string }>

  addVote(reportId: string): Promise<void>
  removeVote(reportId: string): Promise<void>

  listComments(reportId: string): Promise<CommentView[]>
  addComment(reportId: string, body: string): Promise<void>

  markCleaned(reportId: string): Promise<void>

  flag(subjectType: 'photo' | 'comment' | 'note', subjectId: string, reason: string): Promise<void>
}
