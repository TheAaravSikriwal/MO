import type { ModerationStatus, ReportStatus } from '../../types/report'

export interface CurrentUser {
  id: string
  email?: string
  isAdmin: boolean
  /**
   * True when the permission check itself failed.
   *
   * `isAdmin` is false in that case, which is safe but indistinguishable
   * from genuinely not being an admin -- so a real admin would lose the
   * review queue with nothing on screen to explain it. This lets the UI
   * say so.
   */
  adminUnknown?: boolean
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
  /** The author's chosen name, or "someone" while it is still being checked. */
  authorName: string
  /** Whether a real name is shown, as opposed to the "someone" fallback. */
  authorNamed: boolean
  /** Whether the signed-in person wrote this. */
  viewerIsAuthor: boolean
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
  /** The reporter's chosen name, or null while it is still being checked. */
  reporterName: string | null
  /** Why an admin took the pin off the map. Given to admins only. */
  removalReason: string | null
}

export type QueueSubject = 'photo' | 'comment' | 'note' | 'name'

/**
 * What a reader may flag directly. Not a name: its subject is a person's id,
 * and the only one a client knows is its own. Names go through
 * flagCommentAuthorName and flagReporterName instead.
 */
export type DirectFlagSubject = Exclude<QueueSubject, 'name'>

/**
 * The name you post under, and where its review has got to.
 *
 * Other people see it only once it is approved. A rejected name has to be
 * replaced before you can post again.
 */
export interface MyDisplayName {
  name: string
  status: ModerationStatus
}

/** One item a person has to judge, because no machine tier could. */
export interface QueueItem {
  jobId: string
  subjectType: QueueSubject
  subjectId: string
  reportId: string | null
  /** The comment body, report note or chosen name. Null for photos. */
  text: string | null
  /** The actual image. Admins see it even while it is withheld from everyone else. */
  photoUrl: string | null
  /** Why the machine tiers could not settle it. */
  reason: string
  /** Raw per-tier scores, so a decision can be sanity-checked. */
  tierResults: Record<string, unknown>
  /** How many people complained about it. */
  flagCount: number
  /**
   * Whether the report it sits on is on the map right now, from the database
   * at the time the queue was read. Null when it sits on no report.
   */
  pinOnMap: boolean | null
  createdAt: string
}

/**
 * How many individual reports one viewport will return.
 *
 * The aggregated view does not use this — it is a real GROUP BY over every
 * matching row — so a capped page only ever limits how many pins are drawn at
 * street level, where far fewer than this are on screen anyway.
 */
export const REPORT_PAGE_LIMIT = 500

/** How many off-map pins the review queue lists at once. */
export const OFF_MAP_PAGE = 50

/** How many rejected photos the review queue lists at once. */
export const REJECTED_PAGE = 50

/** How long a rejected photo's bytes are kept, so a mistake can be undone. */
export const REJECTED_HOLD_DAYS = 30

/** How many off-map pins are drawn in one viewport. */
export const OFF_MAP_IN_VIEW = 100

/**
 * A photo rejected within the thirty-day hold, before its bytes are deleted.
 * Listed so an admin can undo a wrong rejection, above all an automatic one.
 */
export interface RejectedPhoto {
  photoId: string
  reportId: string
  /** The actual image; admins may see a withheld photo. Null with no photo host. */
  url: string | null
  rejectedAt: string
  /** True when a machine tier rejected it, so no person has seen it. */
  automatic: boolean
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

  /** Null when you have not chosen one yet. */
  getMyDisplayName(): Promise<MyDisplayName | null>
  /**
   * Choose or change the name shown next to your comments. Required before
   * your first report or comment, so nothing is ever signed with a name
   * derived from your email address.
   */
  setDisplayName(name: string): Promise<void>

  /** Pins on the map. Never one that is off it: those are listOffMapInView's. */
  listReportsInView(bounds: ViewBounds, filters: RollupFilters): Promise<ReportView[]>
  /**
   * Pins off the map in this viewport that the viewer may still see: their own,
   * or every one for an admin. Kept apart from listReportsInView so they take no
   * room in its page and are never counted as reports on the map.
   */
  listOffMapInView(
    bounds: ViewBounds,
    filters: RollupFilters,
  ): Promise<{ reports: ReportView[]; more: boolean }>

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

  flag(subjectType: DirectFlagSubject, subjectId: string, reason: string): Promise<void>
  /**
   * Complain about the name shown on a comment. Takes the comment, because a
   * reader is never given the author's id to complain about directly.
   */
  flagCommentAuthorName(commentId: string, reason: string): Promise<void>
  /** The same, for the name shown on a report. */
  flagReporterName(reportId: string, reason: string): Promise<void>

  // --- tier 4: admin only -------------------------------------------------

  listModerationQueue(): Promise<QueueItem[]>
  /** Total waiting, which can exceed the page listModerationQueue returns. */
  getModerationQueueSize(): Promise<number>
  decideModerationItem(jobId: string, verdict: 'approved' | 'rejected'): Promise<void>
  /**
   * Take a pin off the map, or put it back. Separate from judging its photo or
   * note: this is for the pin itself. Refused to anybody but an admin.
   */
  /** Resolves true if the pin moved, false if it was already there. */
  setReportOnMap(reportId: string, onMap: boolean, reason?: string): Promise<boolean>
  /**
   * Pins that are off the map, most recently taken off first, so an admin can
   * put one back. Capped at OFF_MAP_PAGE; `more` says there are others.
   */
  listReportsOffMap(): Promise<{ reports: ReportView[]; more: boolean }>
  /**
   * Photos rejected and not yet deleted, the closest to deletion first, so an
   * admin sees those soonest. Capped at REJECTED_PAGE; `more` says there are
   * others. Admins only.
   */
  listRecentlyRejectedPhotos(): Promise<{ photos: RejectedPhoto[]; more: boolean }>
  /** Allow a rejected photo after all, before its bytes are deleted. Admins only. */
  allowRejectedPhoto(photoId: string): Promise<void>
}
