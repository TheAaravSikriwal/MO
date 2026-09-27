import { useEffect, useState } from 'react'
import { checkText } from '../../lib/moderation/clientGate'
import { NAME_NEEDED, plainError } from '../../lib/moderation/plainWords'
import type { CommentView, DataSource, ReportView } from '../../lib/data/types'
import { NameField, nameProblem, useDisplayName } from './NameField'

export interface ReportDetailProps {
  data: DataSource
  report: ReportView
  signedIn: boolean
  /** Shows the controls for taking a pin off the map and putting it back. */
  isAdmin?: boolean
  onChanged: () => void
  /** Called only when this screen actually moved a pin on or off the map. */
  onPinChanged?: () => void
  onClose: () => void
}

/** Plain, and about the litter — never about the place or the people there. */
const confirmLabel = (count: number) =>
  count === 0 ? 'No one else has confirmed this yet' : `${count} confirmed this is here`

export function ReportDetail({
  data,
  report,
  signedIn,
  isAdmin = false,
  onChanged,
  onPinChanged,
  onClose,
}: ReportDetailProps) {
  const [comments, setComments] = useState<CommentView[]>([])
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [justCleaned, setJustCleaned] = useState(false)
  const [reported, setReported] = useState<Set<string>>(new Set())
  const [nameDraft, setNameDraft] = useState('')
  const [removalReason, setRemovalReason] = useState('')
  // Set when somebody else moved the pin first, so nothing was recorded here.
  const [pinNotice, setPinNotice] = useState<string | null>(null)
  const name = useDisplayName(data, signedIn)

  useEffect(() => {
    let live = true
    void data.listComments(report.id).then((loaded) => {
      if (live) setComments(loaded)
    })
    return () => {
      live = false
    }
  }, [data, report.id])

  const run = async (action: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await action()
      onChanged()
    } catch (cause) {
      // Never the raw message. run() wraps voting, commenting, marking cleaned
      // and flagging, so without this a member of the public can be shown a
      // Postgres constraint name.
      setError(plainError(cause instanceof Error ? cause.message : null))
    } finally {
      setBusy(false)
    }
  }

  const onToggleVote = () =>
    run(() => (report.viewerHasVoted ? data.removeVote(report.id) : data.addVote(report.id)))

  const onMarkCleaned = () =>
    run(async () => {
      await data.markCleaned(report.id)
      setJustCleaned(true)
    })

  const onComment = async () => {
    if (draft.trim() === '') return
    if (name.needed) {
      const problem = nameProblem(nameDraft)
      if (problem) {
        setError(problem)
        return
      }
    }
    await run(async () => {
      try {
        if (name.needed) {
          const chosen = nameDraft.trim()
          await data.setDisplayName(chosen)
          name.saved(chosen)
        }
        await data.addComment(report.id, draft.trim())
      } catch (cause) {
        // Refused for want of a name the lookup did not know was missing.
        // Rethrown so run() still shows the plain sentence.
        if (plainError(cause instanceof Error ? cause.message : null) === NAME_NEEDED) name.ask()
        throw cause
      }
      setDraft('')
      setNotice(null)
      setComments(await data.listComments(report.id))
    })
  }

  const cleaned = report.status === 'cleaned'
  // Only its reporter and admins can see a pin that is off the map at all.
  const offMap = report.moderationStatus === 'rejected'

  // The reason is the admin's own words, or nothing. A fixed placeholder would
  // record which button was pressed and pass it off as why.
  const onSetOnMap = (onMap: boolean) =>
    run(async () => {
      setPinNotice(null)
      const moved = await data.setReportOnMap(
        report.id,
        onMap,
        onMap ? undefined : removalReason.trim() || undefined,
      )
      if (!moved) {
        // Somebody else got there first, and nothing was recorded. The typed
        // reason is kept rather than silently thrown away.
        setPinNotice(
          onMap
            ? 'Somebody else already put this pin back on the map.'
            : 'Somebody else already took this pin off the map. Your reason was not saved.',
        )
        return
      }
      setRemovalReason('')
      onPinChanged?.()
    })

  return (
    <section
      className="rounded-xl bg-white p-4 shadow-lg"
      aria-label={cleaned ? 'Cleaned report' : 'Report'}
    >
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {cleaned ? 'Cleaned' : 'Litter reported here'}
          </h2>
          <p className="text-xs text-slate-500">
            Added {new Date(report.createdAt).toLocaleDateString()}
            {/* Null until the name is approved. No "by someone": saying nothing
                reads better than a placeholder on every new report. */}
            {report.reporterName && <> by {report.reporterName}</>}
            {signedIn &&
              report.reporterName &&
              !report.viewerIsReporter &&
              // flag_report_author refuses a pin off the map: nobody else can
              // see its name, so there is nothing to complain about.
              !offMap &&
              (reported.has(`reporter:${report.id}`) ? (
                <span className="ml-2">Thanks. Someone will look at this name.</span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await data.flagReporterName(report.id, 'reported by a reader')
                      setReported((current) => new Set(current).add(`reporter:${report.id}`))
                    })
                  }
                  disabled={busy}
                  className="ml-2 underline hover:text-slate-800"
                >
                  Report this name
                </button>
              ))}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
        >
          Close
        </button>
      </header>

      {/* The signature moment: a dirty pin visibly wiped clean. Motion only,
          no words -- it should read the same in any language. */}
      {(cleaned || justCleaned) && (
        <div
          data-testid="cleaned-mark"
          className={`mo-scrub mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 ${
            justCleaned ? 'mo-scrub--playing' : ''
          }`}
        >
          <span aria-hidden="true" className="mo-sparkle text-xl">
            ✦
          </span>
          <p className="text-sm text-emerald-900">Someone cleaned this up.</p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        {report.photos.map((photo) => (
          <div key={photo.id}>
            {/*
              Branching on the URL alone was wrong in both directions: a
              rejected photo shows the author "being checked" forever, and shows
              an admin the live image, so Remove looked like it had done nothing.
            */}
            {photo.moderationStatus === 'rejected' ? (
              <div
                data-testid="photo-removed"
                className="flex aspect-square w-full items-center justify-center rounded-lg bg-slate-100 p-2 text-center text-xs text-slate-500"
              >
                Photo removed
              </div>
            ) : photo.url ? (
              <img
                src={photo.url}
                alt="Litter reported at this spot"
                className="aspect-square w-full rounded-lg object-cover"
              />
            ) : (
              <div
                data-testid="photo-pending"
                className="flex aspect-square w-full items-center justify-center rounded-lg bg-slate-100 p-2 text-center text-xs text-slate-500"
              >
                Photo is being checked
              </div>
            )}
            {signedIn &&
              photo.url &&
              photo.moderationStatus === 'approved' &&
              (reported.has(photo.id) ? (
                <p className="mt-1 text-xs text-slate-500">Thanks.</p>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await data.flag('photo', photo.id, 'reported by a reader')
                      setReported((current) => new Set(current).add(photo.id))
                    })
                  }
                  disabled={busy}
                  className="mt-1 text-xs text-slate-500 underline hover:text-slate-800"
                >
                  Report this photo
                </button>
              ))}
          </div>
        ))}
      </div>

      {/*
        A note's review outcome is the author's business, not everybody's.
        note_status is public, so announcing it to every visitor told passers-by
        that a note on this pin had been removed -- which is both none of their
        concern and a nudge to wonder what it said.
      */}
      {report.viewerIsReporter && report.noteStatus === 'pending' ? (
        // The author receives their own note whatever its status, so checking
        // `report.note` first made this branch unreachable for the one person
        // who can see an unpublished note.
        <p className="mt-3 text-sm text-slate-500">Your note is being checked.</p>
      ) : report.viewerIsReporter && report.noteStatus === 'rejected' ? (
        <p className="mt-3 text-sm text-slate-500">
          Your note was removed and is not shown on the map.
        </p>
      ) : report.note ? (
        <div className="mt-3">
          <p className="text-sm text-slate-800">{report.note}</p>
          {signedIn &&
            (reported.has(`note:${report.id}`) ? (
              <p className="mt-1 text-xs text-slate-500">Thanks. Someone will look at this.</p>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await data.flag('note', report.id, 'reported by a reader')
                    setReported((current) => new Set(current).add(`note:${report.id}`))
                  })
                }
                disabled={busy}
                className="mt-1 text-xs text-slate-500 underline hover:text-slate-800"
              >
                Report this note
              </button>
            ))}
        </div>
      ) : null}

      <p className="mt-3 text-sm text-slate-600">{confirmLabel(report.voteCount)}</p>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">
          {error}
        </p>
      )}

      {offMap && (
        <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {report.viewerIsReporter
            ? 'This report has been taken off the map. Other people can no longer see it.'
            : 'This report is off the map. Other people can no longer see it.'}
        </p>
      )}

      {isAdmin && (
        <div className="mt-3 space-y-2">
          {pinNotice && (
            <p role="status" className="text-xs text-slate-600">
              {pinNotice}
            </p>
          )}
          {offMap && report.removalReason && (
            <p className="text-xs text-slate-600">Taken off because: {report.removalReason}</p>
          )}
          {!offMap && (
            <>
              <label htmlFor="removal-reason" className="block text-xs text-slate-600">
                Why take it off? <span className="text-slate-400">(optional)</span>
              </label>
              <input
                id="removal-reason"
                type="text"
                value={removalReason}
                maxLength={500}
                onChange={(event) => setRemovalReason(event.target.value)}
                className="w-full rounded-lg border border-slate-300 p-2 text-sm"
              />
            </>
          )}
          <button
            type="button"
            onClick={() => void onSetOnMap(offMap)}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 disabled:opacity-50"
          >
            {offMap ? 'Put back on the map' : 'Take off the map'}
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!cleaned && !offMap && signedIn && !report.viewerIsReporter && (
          <button
            type="button"
            onClick={onToggleVote}
            disabled={busy}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
          >
            {report.viewerHasVoted ? 'Remove my confirmation' : 'Confirm this is here'}
          </button>
        )}
        {!cleaned && !offMap && signedIn && (
          <button
            type="button"
            onClick={onMarkCleaned}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 disabled:opacity-50"
          >
            Mark as cleaned
          </button>
        )}
        {!signedIn && <p className="text-sm text-slate-600">Sign in to confirm or mark cleaned.</p>}
      </div>

      <div className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="text-sm font-semibold text-slate-900">Comments</h3>
        {comments.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No comments yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-lg bg-slate-50 p-3 text-sm">
                <p className="text-xs text-slate-500">
                  {comment.authorName}
                  {/* Only a real name someone else chose: "someone" is not a
                      name, and your own is yours to change. */}
                  {signedIn &&
                    comment.moderationStatus === 'approved' &&
                    comment.authorNamed &&
                    !comment.viewerIsAuthor &&
                    (reported.has(`name:${comment.id}`) ? (
                      <span className="ml-2">Thanks. Someone will look at this name.</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            await data.flagCommentAuthorName(comment.id, 'reported by a reader')
                            setReported((current) => new Set(current).add(`name:${comment.id}`))
                          })
                        }
                        disabled={busy}
                        className="ml-2 underline hover:text-slate-800"
                      >
                        Report this name
                      </button>
                    ))}
                </p>
                <p className="text-slate-800">{comment.body}</p>
                {comment.moderationStatus === 'pending' && (
                  <p className="mt-1 text-xs text-slate-500">Being checked before it appears.</p>
                )}
                {comment.moderationStatus === 'rejected' && (
                  <p className="mt-1 text-xs text-slate-500">Removed and not shown to others.</p>
                )}
                {signedIn &&
                  comment.moderationStatus === 'approved' &&
                  (reported.has(comment.id) ? (
                    <p className="mt-1 text-xs text-slate-500">Thanks. Someone will look at this.</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await data.flag('comment', comment.id, 'reported by a reader')
                          setReported((current) => new Set(current).add(comment.id))
                        })
                      }
                      disabled={busy}
                      className="mt-1 text-xs text-slate-500 underline hover:text-slate-800"
                    >
                      Report this comment
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        )}

        {offMap ? (
          // The database refuses a comment on a pin off the map. Offering the
          // box anyway meant a refusal that read as "choose a name".
          <p className="mt-2 text-sm text-slate-600">
            Comments are closed while this report is off the map.
          </p>
        ) : signedIn ? (
          <div className="mt-3">
            {name.needed && (
              <div className="mb-2">
                <NameField
                  id="comment-name"
                  value={nameDraft}
                  onChange={setNameDraft}
                  rejected={name.mine?.status === 'rejected' ? name.mine.name : null}
                />
              </div>
            )}
            <label htmlFor="comment-body" className="sr-only">
              Add a comment
            </label>
            <textarea
              id="comment-body"
              value={draft}
              rows={2}
              maxLength={1000}
              placeholder="Add a comment"
              onChange={(event) => {
                setDraft(event.target.value)
                setNotice(checkText(event.target.value).message ?? null)
              }}
              className="w-full rounded-lg border border-slate-300 p-2 text-sm"
            />
            {notice && (
              <p role="status" className="mt-1 text-xs text-slate-600">
                {notice}
              </p>
            )}
            <button
              type="button"
              onClick={onComment}
              disabled={busy || draft.trim() === ''}
              className="mt-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            >
              Post comment
            </button>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">Sign in to comment.</p>
        )}
      </div>
    </section>
  )
}
