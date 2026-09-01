import { cellsForPoint } from '../grid/cells'
import type {
  CommentView,
  CurrentUser,
  DataSource,
  NewReport,
  QueueItem,
  QueueSubject,
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
      moderationStatus: 'approved',
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

  readonly raisedFlags: Array<{
    subjectType: QueueSubject
    subjectId: string
    reason: string
    flaggerId: string
  }> = []

  async flag(subjectType: QueueSubject, subjectId: string, reason: string) {
    if (!this.user) throw new Error('you must be signed in to report this')
    // Matching the unique constraint on flags: one PERSON, one complaint --
    // not one complaint in total, which would stop a second person reporting
    // the same thing and make the two-person withholding rule unreachable.
    if (
      this.raisedFlags.some(
        (f) =>
          f.subjectType === subjectType &&
          f.subjectId === subjectId &&
          f.flaggerId === this.user!.id,
      )
    ) {
      throw new Error('you have already reported this')
    }
    this.raisedFlags.push({ subjectType, subjectId, reason, flaggerId: this.user.id })

    // Mirrors the flag_reopens_review and flag_withholds_content triggers: a
    // complaint puts the item back in front of a person AND withholds it while
    // it waits. Modelling both here is what stops a UI test passing against
    // behaviour the database does not actually have.
    const existing = this.queue.find(
      (q) => q.subjectType === subjectType && q.subjectId === subjectId,
    )
    if (existing) {
      existing.flagCount += 1
      this.decided.delete(existing.jobId)
      existing.reason = 'people reported this'
    } else {
      this.seedQueueItem({
        jobId: `flag-job-${this.nextId++}`,
        subjectType,
        subjectId,
        reportId: this.findReportIdFor(subjectType, subjectId),
        text: this.findTextFor(subjectType, subjectId),
        reason: 'people reported this',
        flagCount: 1,
      })
    }

    // Mirrors flag_withholds_content: it takes two independent people to take
    // content down, so one account cannot unpublish the map one flag at a time.
    const complaints = this.raisedFlags.filter(
      (f) => f.subjectType === subjectType && f.subjectId === subjectId,
    ).length
    if (complaints < 2) return

    if (subjectType === 'comment') {
      for (const list of this.comments.values()) {
        const comment = list.find((c) => c.id === subjectId)
        if (comment && comment.moderationStatus === 'approved') {
          comment.moderationStatus = 'pending'
        }
      }
    }
    if (subjectType === 'photo') {
      for (const report of this.reports.values()) {
        const photo = report.photos.find((p) => p.id === subjectId)
        if (photo && photo.moderationStatus === 'approved') {
          photo.moderationStatus = 'pending'
          photo.url = null
        }
      }
    }
    if (subjectType === 'note') {
      const report = this.reports.get(subjectId)
      if (report && report.noteStatus === 'approved') {
        report.noteStatus = 'pending'
        report.note = null
      }
    }
  }

  /** A complaint from somebody else, for tests that need a second one. */
  seedFlagFromAnotherPerson(subjectType: QueueSubject, subjectId: string): void {
    this.raisedFlags.push({
      subjectType,
      subjectId,
      reason: 'reported by a reader',
      flaggerId: `someone-else-${this.nextId++}`,
    })
  }

  private findReportIdFor(subjectType: QueueSubject, subjectId: string): string | null {
    if (subjectType === 'note') return subjectId
    for (const [reportId, list] of this.comments) {
      if (subjectType === 'comment' && list.some((c) => c.id === subjectId)) return reportId
    }
    for (const report of this.reports.values()) {
      if (subjectType === 'photo' && report.photos.some((p) => p.id === subjectId)) {
        return report.id
      }
    }
    return null
  }

  private findTextFor(subjectType: QueueSubject, subjectId: string): string | null {
    if (subjectType === 'note') return this.reports.get(subjectId)?.note ?? null
    if (subjectType === 'comment') {
      for (const list of this.comments.values()) {
        const comment = list.find((c) => c.id === subjectId)
        if (comment) return comment.body
      }
    }
    return null
  }

  // --- tier 4 ---------------------------------------------------------------

  private queue: QueueItem[] = []
  private decided = new Set<string>()

  async listModerationQueue(): Promise<QueueItem[]> {
    if (!this.user?.isAdmin) throw new Error('only an admin may read the moderation queue')
    // Flagged items first, then oldest, matching admin_moderation_queue.
    return this.queue
      .filter((item) => !this.decided.has(item.jobId))
      .slice()
      .sort((a, b) =>
        b.flagCount - a.flagCount || a.createdAt.localeCompare(b.createdAt),
      )
  }

  async getModerationQueueSize(): Promise<number> {
    if (!this.user?.isAdmin) throw new Error('only an admin may read the moderation queue')
    return this.queue.filter((item) => !this.decided.has(item.jobId)).length
  }

  async decideModerationItem(jobId: string, verdict: 'approved' | 'rejected') {
    if (!this.user?.isAdmin) throw new Error('only an admin may decide moderation items')
    const item = this.queue.find((q) => q.jobId === jobId)
    if (!item) throw new Error(`no such moderation job: ${jobId}`)
    if (this.decided.has(jobId)) throw new Error('this item has already been decided')
    this.decided.add(jobId)

    // Apply it the way admin_decide_moderation does, so the UI is tested
    // against real effects rather than a decision that only marks the job.
    if (item.subjectType === 'photo' && item.reportId) {
      const report = this.reports.get(item.reportId)
      const photo = report?.photos.find((p) => p.id === item.subjectId)
      if (photo) {
        photo.moderationStatus = verdict
        photo.url = verdict === 'approved' ? `https://img.example/${photo.id}.jpg` : null
      }
    }

    if (item.subjectType === 'comment' && item.reportId) {
      const comment = (this.comments.get(item.reportId) ?? []).find(
        (c) => c.id === item.subjectId,
      )
      if (comment) comment.moderationStatus = verdict
    }

    if (item.subjectType === 'note' && item.reportId) {
      const report = this.reports.get(item.reportId)
      if (report) {
        report.noteStatus = verdict
        // An approved note becomes readable; a rejected one is withheld.
        report.note = verdict === 'approved' ? (item.text ?? report.note) : null
      }
    }
  }

  /** Seed a queue item directly. */
  seedQueueItem(item: Partial<QueueItem> & { jobId: string }): QueueItem {
    const full: QueueItem = {
      subjectType: 'comment',
      subjectId: `subject-${this.nextId++}`,
      reportId: null,
      text: 'something a person wrote',
      photoUrl: null,
      reason: 'the judge was not sure',
      tierResults: {},
      flagCount: 0,
      createdAt: new Date().toISOString(),
      ...item,
    }
    this.queue.push(full)
    return full
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
      moderationStatus: 'approved',
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
