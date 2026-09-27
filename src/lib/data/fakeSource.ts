import { cellsForPoint } from '../grid/cells'
import { weighCells } from '../severity/weight'
import { applyFilters, DEFAULT_FILTERS } from '../filters/reportFilters'
import { containsPoint } from '../geo/bounds'
import {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  hasControlCharacter,
  nameLength,
  visibleLength,
} from '../names/displayName'
import type {
  CommentView,
  DirectFlagSubject,
  CurrentUser,
  DataSource,
  MyDisplayName,
  NewReport,
  RejectedPhoto,
  QueueItem,
  QueueSubject,
  ReportView,
  RollupCell,
  RollupFilters,
  ViewBounds,
} from './types'
import { OFF_MAP_IN_VIEW, OFF_MAP_PAGE, REJECTED_PAGE, REPORT_PAGE_LIMIT } from './types'

const DAY = 24 * 60 * 60 * 1000

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
  /** Who wrote each comment. Kept aside, as the real view withholds it. */
  private commentAuthors = new Map<string, string>()
  /** Who filed each report, for the same reason. */
  private reportAuthors = new Map<string, string>()
  private listeners = new Set<(user: CurrentUser | null) => void>()
  private names = new Map<
    string,
    MyDisplayName & { changedAt: number; changesInWindow: number; windowStarted: number }
  >()
  private nextId = 1

  /**
   * `displayName` gives the starting user a name already, so a test about
   * something else does not have to walk through choosing one. Without it the
   * user has none, exactly like a first sign-in against the real database.
   */
  constructor(
    user: CurrentUser | null = null,
    options: { displayName?: string; now?: () => number } = {},
  ) {
    this.user = user
    this.now = options.now ?? (() => Date.now())
    if (user && options.displayName) {
      this.names.set(user.id, {
        name: options.displayName,
        status: 'approved',
        changedAt: -Infinity,
        changesInWindow: 0,
        windowStarted: -Infinity,
      })
    }
  }

  private readonly now: () => number

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

  // --- the name you post under ----------------------------------------------

  async getMyDisplayName() {
    if (!this.user) return null
    const found = this.names.get(this.user.id)
    return found ? { name: found.name, status: found.status } : null
  }

  /** The same rules, and the same wording, as set_display_name in 0002. */
  async setDisplayName(name: string) {
    if (!this.user) throw new Error('you must be signed in to choose a name')
    const chosen = name.trim()
    if (nameLength(chosen) < MIN_NAME_LENGTH || nameLength(chosen) > MAX_NAME_LENGTH) {
      throw new Error('a name must be between 2 and 30 characters')
    }
    if (chosen.includes('@')) throw new Error('a name cannot contain @')
    if (hasControlCharacter(chosen)) {
      throw new Error('a name cannot contain tabs or line breaks')
    }
    if (visibleLength(chosen) < MIN_NAME_LENGTH) {
      throw new Error('a name must have at least 2 visible characters')
    }

    const existing = this.names.get(this.user.id)
    if (existing) {
      if (existing.status === 'rejected') {
        if (existing.name === chosen) {
          throw new Error('that name was not accepted; please choose a different one')
        }
      } else {
        if (existing.name === chosen) return
        if (existing.changedAt > this.now() - DAY) {
          throw new Error('a name can be changed once a day')
        }
      }
    }
    // The daily cap on submissions, whatever became of them, as in 0002.
    const windowOpen = existing !== undefined && existing.windowStarted > this.now() - DAY
    if (existing && windowOpen && existing.changesInWindow >= 3) {
      throw new Error('too many new names today; please try again tomorrow')
    }
    // Pending, as on the real backend: nothing a person types is approved on
    // arrival.
    this.names.set(this.user.id, {
      name: chosen,
      status: 'pending',
      changedAt: this.now(),
      changesInWindow: existing && windowOpen ? existing.changesInWindow + 1 : 1,
      windowStarted: existing && windowOpen ? existing.windowStarted : this.now(),
    })
    // A new name gets a new job, as set_display_name does: anybody still
    // holding the old one is deciding about text that is no longer the name.
    const me = this.user.id
    this.queue = this.queue.filter((item) => !(item.subjectType === 'name' && item.subjectId === me))
    // And complaints about the old name go, as set_display_name deletes them,
    // so the people who objected to it can object to the new one too.
    for (let i = this.raisedFlags.length - 1; i >= 0; i -= 1) {
      const f = this.raisedFlags[i]
      if (f.subjectType === 'name' && f.subjectId === me) this.raisedFlags.splice(i, 1)
    }
    this.queue.push({
      jobId: `name-job-${this.nextId++}`,
      subjectType: 'name',
      subjectId: me,
      reportId: null,
      text: chosen,
      photoUrl: null,
      reason: 'The automatic checks could not decide this one.',
      tierResults: {},
      flagCount: 0,
      pinOnMap: null,
      createdAt: new Date(this.now()).toISOString(),
    })
  }

  /** Test seam: somebody else's name, as it would already be in the table. */
  seedName(userId: string, name: string, status: MyDisplayName['status'] = 'pending') {
    this.names.set(userId, {
      name,
      status,
      changedAt: -Infinity,
      changesInWindow: 0,
      windowStarted: -Infinity,
    })
  }

  /** Test seam: read anybody's name, which no real client can do. */
  nameOf(userId: string): MyDisplayName | null {
    const found = this.names.get(userId)
    return found ? { name: found.name, status: found.status } : null
  }

  /** Test seam: what an admin or the worker would decide about a name. */
  decideName(userId: string, status: MyDisplayName['status']) {
    const existing = this.names.get(userId)
    if (existing) existing.status = status
  }

  /**
   * The rule reports_insert_own and comments_insert_own apply, refused in
   * Postgres's own words so the UI has to handle the message it will really get.
   */
  private requireName(table: 'reports' | 'comments') {
    const found = this.user ? this.names.get(this.user.id) : undefined
    if (!found || found.status === 'rejected') {
      throw new Error(`new row violates row-level security policy for table "${table}"`)
    }
    return found
  }

  setUser(user: CurrentUser | null) {
    this.user = user
    for (const listener of this.listeners) listener(user)
  }

  // --- reports ------------------------------------------------------------

  async listReportsInView(bounds: ViewBounds, filters?: RollupFilters) {
    // One page, in the real source's order: most confirmed first, then newest.
    // Handing back every report in the box let thousands of sample reports
    // through at once, which the real source never does.
    return this.matchingInView(bounds, filters)
      .sort((a, b) => b.voteCount - a.voteCount || b.createdAt.localeCompare(a.createdAt))
      .slice(0, REPORT_PAGE_LIMIT)
  }

  /** Every live report in the box that the filters allow, uncapped. */
  private matchingInView(bounds: ViewBounds, filters?: RollupFilters): ReportView[] {
    // containsPoint, not a plain between: a viewport straddling the dateline
    // arrives as minLng > maxLng, and a range test returns nothing there. The
    // fake has to match the real source or it hides that bug from every test.
    // Live pins only, as the real source asks for them.
    const inView = [...this.reports.values()]
      .filter((r) => containsPoint(bounds, r.lat, r.lng) && r.moderationStatus !== 'rejected')
      .map((r) => this.present(r))
    const matching = filters
      ? applyFilters(inView, {
          ...DEFAULT_FILTERS,
          status: filters.status,
          minConfirmations: filters.minConfirmations,
          since: filters.since,
          origin: filters.origin,
          withinMetres: filters.withinMetres,
        })
      : inView
    return matching
  }

  async countReportsInView(bounds: ViewBounds, filters?: RollupFilters): Promise<number> {
    const inView = [...this.reports.values()].filter(
      (r) => r.moderationStatus === 'approved' && containsPoint(bounds, r.lat, r.lng),
    )
    if (!filters) return inView.length
    return applyFilters(inView, {
      ...DEFAULT_FILTERS,
      status: filters.status,
      minConfirmations: filters.minConfirmations,
      since: filters.since,
      origin: filters.origin,
      withinMetres: filters.withinMetres,
    }).length
  }

  async getRollup(
    bounds: ViewBounds,
    resolution: number,
    filters: RollupFilters,
  ): Promise<RollupCell[]> {
    // Every matching report, not one page: the real rollup is a GROUP BY over
    // all of them, and colouring from a page would cool the busiest areas.
    const matching = this.matchingInView(bounds, filters)
    return weighCells(
      matching.map((report) => ({
        id: report.id,
        status: report.status,
        moderationStatus: report.moderationStatus,
        voteCount: report.voteCount,
        cells: report.cells,
      })),
      resolution,
      {
        statuses:
          filters.status === 'cleaned'
            ? ['cleaned']
            : filters.status === 'all'
              ? ['open', 'cleaned']
              : ['open'],
      },
    )
  }

  /**
   * The reporter's name, worked out at read time as public_reports does it:
   * shown once approved, and always to the reporter. Storing it once at
   * creation would keep showing a name after it was rejected, or show a
   * pending one to everybody. A seeded report with no known reporter keeps
   * whatever it was seeded with. Updated in place, like listComments.
   */
  private present(report: ReportView): ReportView {
    const authorId = this.reportAuthors.get(report.id)
    if (authorId !== undefined) {
      const name = this.names.get(authorId)
      const own = authorId === this.user?.id
      report.reporterName = name && (name.status === 'approved' || own) ? name.name : null
    }
    // Admins only, as public_reports gives it.
    report.removalReason = this.user?.isAdmin ? (this.removalReasons.get(report.id) ?? null) : null
    return report
  }

  async getReport(id: string) {
    const report = this.reports.get(id)
    return report && this.visibleTo(report) ? this.present(report) : null
  }

  async createReport(report: NewReport) {
    if (!this.user) throw new Error('you must be signed in to add a report')
    if (report.photos.length === 0) throw new Error('a report needs at least one photo')
    if (report.photos.length > 3) throw new Error('a report may have at most 3 photos')
    const reporter = this.requireName('reports')

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
      // The reporter sees their own name at once, as public_reports shows it.
      reporterName: reporter.name,
      removalReason: null,
    })
    this.reportAuthors.set(id, this.user.id)
    return { id }
  }

  // --- votes --------------------------------------------------------------

  async addVote(reportId: string) {
    const report = this.requireReport(reportId)
    if (!this.user) throw new Error('you must be signed in to confirm a report')
    // As refuse_vote_on_off_map_pin, which answers before the policy does.
    if (report.moderationStatus === 'rejected') throw new Error('this report is off the map')
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
    const list = this.comments.get(reportId) ?? []
    // Resolved at read time, the way public_comments does it: a name shows
    // once approved, and always to its owner. Updated in place, because tests
    // adjust a comment's status through the objects this returns.
    for (const comment of list) {
      const authorId = this.commentAuthors.get(comment.id)
      const name = authorId ? this.names.get(authorId) : undefined
      const own = authorId !== undefined && authorId === this.user?.id
      const shown = name && (name.status === 'approved' || own) ? name.name : null
      comment.authorName = shown ?? 'someone'
      comment.authorNamed = shown !== null
      comment.viewerIsAuthor = own
    }
    return list
  }

  /** Test seam: a comment by somebody else, with the name they chose. */
  seedComment(
    reportId: string,
    comment: {
      authorId: string
      body: string
      moderationStatus?: CommentView['moderationStatus']
    },
  ): string {
    const id = `comment-${this.nextId++}`
    const existing = this.comments.get(reportId) ?? []
    existing.push({
      id,
      body: comment.body,
      authorName: 'someone',
      authorNamed: false,
      viewerIsAuthor: false,
      createdAt: new Date().toISOString(),
      moderationStatus: comment.moderationStatus ?? 'approved',
    })
    this.comments.set(reportId, existing)
    this.commentAuthors.set(id, comment.authorId)
    return id
  }

  async addComment(reportId: string, body: string) {
    if (!this.user) throw new Error('you must be signed in to comment')
    if (body.trim() === '') throw new Error('a comment cannot be empty')
    const target = this.requireReport(reportId)
    // As refuse_post_on_off_map_pin, which answers before the policy does.
    if (target.moderationStatus === 'rejected') throw new Error('this report is off the map')
    const author = this.requireName('comments')

    const existing = this.comments.get(reportId) ?? []
    const id = `comment-${this.nextId++}`
    existing.push({
      id,
      body,
      // Never the email address. The author sees their own name at once, as
      // public_comments shows it to them.
      authorName: author.name,
      authorNamed: true,
      viewerIsAuthor: true,
      createdAt: new Date().toISOString(),
      moderationStatus: 'pending',
    })
    this.comments.set(reportId, existing)
    this.commentAuthors.set(id, this.user.id)
  }

  // --- cleaning -----------------------------------------------------------

  async markCleaned(reportId: string) {
    const report = this.requireReport(reportId)
    if (!this.user) throw new Error('you must be signed in to mark a report cleaned')
    if (report.moderationStatus === 'rejected') throw new Error('this report is off the map')
    if (report.status === 'cleaned') throw new Error('this report is already marked cleaned')
    report.status = 'cleaned'
  }

  readonly raisedFlags: Array<{
    subjectType: QueueSubject
    subjectId: string
    reason: string
    flaggerId: string
  }> = []

  async flag(subjectType: DirectFlagSubject, subjectId: string, reason: string) {
    // As flags_insert_own: never a name directly. The type already says so;
    // this is for callers that cast their way past it.
    if ((subjectType as QueueSubject) === 'name') {
      throw new Error('new row violates row-level security policy for table "flags"')
    }
    return this.raiseFlag(subjectType, subjectId, reason)
  }

  /** Every trigger on mo.flags, whichever route the flag came by. */
  private isOwnPost(subjectType: QueueSubject, subjectId: string): boolean {
    const me = this.user?.id
    if (!me) return false
    const reporterOf = (reportId: string) =>
      this.reportAuthors.get(reportId) ??
      (this.reports.get(reportId)?.viewerIsReporter ? me : undefined)
    if (subjectType === 'comment') return this.commentAuthors.get(subjectId) === me
    if (subjectType === 'note') return reporterOf(subjectId) === me
    if (subjectType === 'photo') {
      for (const report of this.reports.values()) {
        if (report.photos.some((photo) => photo.id === subjectId)) return reporterOf(report.id) === me
      }
    }
    return false
  }

  private async raiseFlag(subjectType: QueueSubject, subjectId: string, reason: string) {
    if (!this.user) throw new Error('you must be signed in to report this')
    if (subjectType === 'name' && subjectId === this.user.id) {
      throw new Error('you cannot report your own name')
    }
    // As validate_flag_subject: nobody complains about their own post.
    if (this.isOwnPost(subjectType, subjectId)) throw new Error('you cannot report your own post')
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
    if (subjectType === 'name') {
      const found = this.names.get(subjectId)
      if (found && found.status === 'approved') found.status = 'pending'
    }
  }

  /** The same checks, and the same wording, as flag_comment_author in 0005. */
  async flagCommentAuthorName(commentId: string, reason: string) {
    if (!this.user) throw new Error('you must be signed in to report this')
    let approved = false
    for (const list of this.comments.values()) {
      const comment = list.find((c) => c.id === commentId)
      if (comment) approved = comment.moderationStatus === 'approved'
    }
    const authorId = this.commentAuthors.get(commentId)
    if (!approved || !authorId || this.names.get(authorId)?.status !== 'approved') {
      throw new Error('no such name')
    }
    if (authorId === this.user.id) throw new Error('you cannot report your own name')
    await this.raiseFlag('name', authorId, reason)
  }

  /** Test seam: say who filed a seeded report. */
  seedReporter(reportId: string, userId: string) {
    this.reportAuthors.set(reportId, userId)
  }

  /** The same checks, and the same wording, as flag_report_author in 0005. */
  async flagReporterName(reportId: string, reason: string) {
    if (!this.user) throw new Error('you must be signed in to report this')
    const report = this.reports.get(reportId)
    const authorId = this.reportAuthors.get(reportId)
    if (
      !report ||
      report.moderationStatus === 'rejected' ||
      !authorId ||
      this.names.get(authorId)?.status !== 'approved'
    ) {
      throw new Error('no such name')
    }
    if (authorId === this.user.id) throw new Error('you cannot report your own name')
    await this.raiseFlag('name', authorId, reason)
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
    if (subjectType === 'name') return this.names.get(subjectId)?.name ?? null
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
    // Flagged items first, then oldest, matching admin_moderation_queue. The
    // pin's state is read now, as the real queue reads it.
    return this.queue
      .filter((item) => !this.decided.has(item.jobId))
      .map((item) => ({
        ...item,
        // Null when the report is gone, as the real queue gives it.
        pinOnMap:
          item.reportId && this.reports.has(item.reportId)
            ? this.reports.get(item.reportId)!.moderationStatus === 'approved'
            : null,
      }))
      .sort((a, b) =>
        b.flagCount - a.flagCount || a.createdAt.localeCompare(b.createdAt),
      )
  }

  async getModerationQueueSize(): Promise<number> {
    if (!this.user?.isAdmin) throw new Error('only an admin may read the moderation queue')
    return this.queue.filter((item) => !this.decided.has(item.jobId)).length
  }

  /** Every real change of a pin's place on the map, as mo.pin_history keeps it. */
  readonly pinHistory: Array<{
    reportId: string
    action: 'off' | 'on'
    actedBy: string
    reason: string | null
  }> = []

  private removalReasons = new Map<string, string | null>()
  private removedAt = new Map<string, number>()

  /**
   * As admin_set_report_on_map in 0005: admins only, a no-op when the pin is
   * already where it was asked to be, and every real change recorded.
   */
  async setReportOnMap(reportId: string, onMap: boolean, reason?: string) {
    if (!this.user?.isAdmin) throw new Error('only an admin may take a pin off the map')
    const report = this.reports.get(reportId)
    if (!report) throw new Error('no such report')
    const wanted = onMap ? 'approved' : 'rejected'
    if (report.moderationStatus === wanted) return false
    report.moderationStatus = wanted
    this.removalReasons.set(reportId, onMap ? null : (reason ?? null))
    if (onMap) this.removedAt.delete(reportId)
    else this.removedAt.set(reportId, this.now())
    this.pinHistory.push({
      reportId,
      action: onMap ? 'on' : 'off',
      actedBy: this.user.id,
      reason: reason ?? null,
    })
    return true
  }

  async listOffMapInView(bounds: ViewBounds, filters: RollupFilters) {
    if (!this.user) return { reports: [], more: false }
    const offMap = [...this.reports.values()]
      .filter(
        (r) =>
          r.moderationStatus === 'rejected' && containsPoint(bounds, r.lat, r.lng) && this.visibleTo(r),
      )
      .map((r) => this.present(r))
    // The same filters as the live pins, as the real source applies them.
    const matching = applyFilters(offMap, {
      ...DEFAULT_FILTERS,
      status: filters.status,
      minConfirmations: filters.minConfirmations,
      since: filters.since,
      origin: filters.origin,
      withinMetres: filters.withinMetres,
    })
    return { reports: matching.slice(0, OFF_MAP_IN_VIEW), more: matching.length > OFF_MAP_IN_VIEW }
  }

  async listReportsOffMap() {
    const all = [...this.reports.values()]
      .filter((report) => report.moderationStatus === 'rejected' && this.visibleTo(report))
      .map((report) => this.present(report))
      // Most recently taken off first, as the real source orders it.
      .sort((a, b) => (this.removedAt.get(b.id) ?? 0) - (this.removedAt.get(a.id) ?? 0))
    return { reports: all.slice(0, OFF_MAP_PAGE), more: all.length > OFF_MAP_PAGE }
  }

  /**
   * Whether this viewer can see a report at all, as public_reports decides it:
   * a pin off the map is visible only to its reporter and to admins.
   */
  private visibleTo(report: ReportView): boolean {
    if (report.moderationStatus !== 'rejected') return true
    if (this.user?.isAdmin) return true
    const authorId = this.reportAuthors.get(report.id)
    return authorId !== undefined ? authorId === this.user?.id : report.viewerIsReporter
  }

  /** Which rejected photos a machine rejected, for tests; the rest were people. */
  private automaticRejections = new Set<string>()

  /** Test seam: a photo on a report, rejected by a machine or a person. */
  seedRejectedPhoto(reportId: string, photoId: string, options: { automatic?: boolean } = {}) {
    const report = this.requireReport(reportId)
    report.photos.push({ id: photoId, url: null, moderationStatus: 'rejected' })
    if (options.automatic) this.automaticRejections.add(photoId)
  }

  async listRecentlyRejectedPhotos(): Promise<{ photos: RejectedPhoto[]; more: boolean }> {
    if (!this.user?.isAdmin) throw new Error('only an admin may read the moderation queue')
    const out: RejectedPhoto[] = []
    for (const report of this.reports.values()) {
      for (const photo of report.photos) {
        if (photo.moderationStatus !== 'rejected') continue
        out.push({
          photoId: photo.id,
          reportId: report.id,
          url: `https://img.example/${photo.id}.jpg`,
          rejectedAt: new Date(this.now()).toISOString(),
          automatic: this.automaticRejections.has(photo.id),
        })
      }
    }
    return { photos: out.slice(0, REJECTED_PAGE), more: out.length > REJECTED_PAGE }
  }

  async allowRejectedPhoto(photoId: string) {
    if (!this.user?.isAdmin) throw new Error('only an admin may decide moderation items')
    for (const report of this.reports.values()) {
      const photo = report.photos.find((p) => p.id === photoId && p.moderationStatus === 'rejected')
      if (photo) {
        photo.moderationStatus = 'approved'
        photo.url = `https://img.example/${photo.id}.jpg`
        this.automaticRejections.delete(photoId)
        return
      }
    }
    throw new Error('no such photo')
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

    // A name's subject is the person, as in admin_decide_moderation.
    if (item.subjectType === 'name') this.decideName(item.subjectId, verdict)
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
      pinOnMap: null,
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
      reporterName: null,
      removalReason: null,
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
