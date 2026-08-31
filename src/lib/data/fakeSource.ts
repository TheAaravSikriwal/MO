import { cellsForPoint } from '../grid/cells'
import type {
  CommentView,
  CurrentUser,
  DataSource,
  NewReport,
  ReportView,
} from './types'

/**
 * An in-memory DataSource.
 *
 * Used by every UI test, and usable as a demo mode. It enforces the same rules
 * the database does — you cannot vote twice, you cannot confirm your own
 * report, nothing is approved on arrival — so a component that behaves here has
 * been tested against the real contract rather than a permissive stub.
 */
export class FakeDataSource implements DataSource {
  private user: CurrentUser | null
  private reports = new Map<string, ReportView>()
  private comments = new Map<string, CommentView[]>()
  private listeners = new Set<(user: CurrentUser | null) => void>()
  private nextId = 1

  constructor(user: CurrentUser | null = null) {
    this.user = user
  }

  // --- auth ---------------------------------------------------------------

  async getCurrentUser() {
    return this.user
  }

  onAuthChange(listener: (user: CurrentUser | null) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async signInWithEmail(email: string) {
    if (!email.includes('@')) throw new Error('that does not look like an email address')
    this.setUser({ id: `user-${this.nextId++}`, email, isAdmin: false })
  }

  async signOut() {
    this.setUser(null)
  }

  setUser(user: CurrentUser | null) {
    this.user = user
    for (const listener of this.listeners) listener(user)
  }

  // --- reports ------------------------------------------------------------

  async listReportsInView(bounds: {
    minLat: number
    minLng: number
    maxLat: number
    maxLng: number
  }) {
    return [...this.reports.values()].filter(
      (r) =>
        r.lat >= bounds.minLat &&
        r.lat <= bounds.maxLat &&
        r.lng >= bounds.minLng &&
        r.lng <= bounds.maxLng,
    )
  }

  async getReport(id: string) {
    return this.reports.get(id) ?? null
  }

  async createReport(report: NewReport) {
    if (!this.user) throw new Error('you must be signed in to add a report')
    if (report.photos.length === 0) throw new Error('a report needs at least one photo')
    if (report.photos.length > 3) throw new Error('a report may have at most 3 photos')

    const id = `report-${this.nextId++}`
    this.reports.set(id, {
      id,
      lat: report.lat,
      lng: report.lng,
      // Nothing arrives approved. The note is withheld until the worker rules.
      note: null,
      noteStatus: 'pending',
      status: 'open',
      voteCount: 0,
      createdAt: new Date().toISOString(),
      cells: cellsForPoint(report.lat, report.lng),
      photos: report.photos.map((_, index) => ({
        id: `${id}-photo-${index}`,
        url: null,
        moderationStatus: 'pending' as const,
      })),
      viewerHasVoted: false,
      viewerIsReporter: true,
    })
    return { id }
  }

  // --- votes --------------------------------------------------------------

  async addVote(reportId: string) {
    const report = this.requireReport(reportId)
    if (!this.user) throw new Error('you must be signed in to confirm a report')
    if (report.viewerIsReporter) throw new Error('you cannot confirm your own report')
    if (report.viewerHasVoted) throw new Error('you have already confirmed this report')
    report.voteCount += 1
    report.viewerHasVoted = true
  }

  async removeVote(reportId: string) {
    const report = this.requireReport(reportId)
    if (!report.viewerHasVoted) return
    report.voteCount = Math.max(0, report.voteCount - 1)
    report.viewerHasVoted = false
  }

  // --- comments -----------------------------------------------------------

  async listComments(reportId: string) {
    return this.comments.get(reportId) ?? []
  }

  async addComment(reportId: string, body: string) {
    if (!this.user) throw new Error('you must be signed in to comment')
    if (body.trim() === '') throw new Error('a comment cannot be empty')
    this.requireReport(reportId)

    const existing = this.comments.get(reportId) ?? []
    existing.push({
      id: `comment-${this.nextId++}`,
      body,
      authorName: this.user.email ?? 'someone',
      createdAt: new Date().toISOString(),
      moderationStatus: 'pending',
    })
    this.comments.set(reportId, existing)
  }

  // --- cleaning -----------------------------------------------------------

  async markCleaned(reportId: string) {
    const report = this.requireReport(reportId)
    if (!this.user) throw new Error('you must be signed in to mark a report cleaned')
    if (report.status === 'cleaned') throw new Error('this report is already marked cleaned')
    report.status = 'cleaned'
  }

  async flag() {
    // Accepted and ignored; flagging has no visible effect for the person who
    // raised it, by design.
  }

  // --- test helpers -------------------------------------------------------

  private requireReport(id: string): ReportView {
    const report = this.reports.get(id)
    if (!report) throw new Error(`no such report: ${id}`)
    return report
  }

  /** Seed a report directly, bypassing the submit rules. */
  seed(report: Partial<ReportView> & { id: string; lat: number; lng: number }): ReportView {
    const full: ReportView = {
      note: 'Bags of rubbish by the bus stop',
      noteStatus: 'approved',
      status: 'open',
      voteCount: 0,
      createdAt: new Date().toISOString(),
      cells: cellsForPoint(report.lat, report.lng),
      photos: [],
      viewerHasVoted: false,
      viewerIsReporter: false,
      ...report,
    }
    this.reports.set(full.id, full)
    return full
  }
}
