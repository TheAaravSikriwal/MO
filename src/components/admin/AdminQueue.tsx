import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataSource, QueueItem, RejectedPhoto, ReportView } from '../../lib/data/types'
import { REJECTED_HOLD_DAYS } from '../../lib/data/types'

/** The date a rejected photo's hold ends, or a plain word if it already has. */
const deletionDate = (rejectedAt: string): string => {
  const due = new Date(new Date(rejectedAt).getTime() + REJECTED_HOLD_DAYS * 24 * 60 * 60 * 1000)
  return due.getTime() <= Date.now()
    ? 'Due to be deleted now.'
    : `To be deleted on ${due.toLocaleDateString()}.`
}
import { plainReason, plainError, summariseScores } from '../../lib/moderation/plainWords'
import { Reveal, useLingeringList } from '../Reveal'

export interface AdminQueueProps {
  data: DataSource
  isAdmin: boolean
  onClose: () => void
  /** Called after a decision, so the map can pick up newly approved content. */
  onDecided?: () => void
  /**
   * Changes whenever a pin is taken off or put back somewhere else -- from a
   * report's own screen -- so the list of pins off the map is reloaded.
   */
  pinsVersion?: number
  /** Take focus now: the Review queue button has just opened the queue. */
  takeFocus?: boolean
  /** Called once focus has been taken, so it is not taken again. */
  onFocused?: () => void
}

const subjectLabel: Record<QueueItem['subjectType'], string> = {
  photo: 'Photo',
  comment: 'Comment',
  note: 'Report note',
  name: 'Name someone chose',
  group: 'Cleaning group',
}

export function AdminQueue({ data, isAdmin, onClose, onDecided, pinsVersion = 0, takeFocus = false, onFocused }: AdminQueueProps) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [total, setTotal] = useState(0)
  // What the queue knows about each item's pin: taken off here, or already off.
  const [pinsOff, setPinsOff] = useState<Map<string, 'now' | 'already'>>(new Map())
  const [pinBusy, setPinBusy] = useState(false)
  const [offMap, setOffMap] = useState<ReportView[]>([])
  const [offMapMore, setOffMapMore] = useState(false)
  const [offMapError, setOffMapError] = useState<string | null>(null)
  // Focus comes here when the Review queue button opens it: the button goes
  // away as it does, and focus fell to the page. Only then, not on every
  // mount, or coming back to the tab would take focus from the tab.
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!takeFocus) return
    root.current?.focus({ preventScroll: true })
    onFocused?.()
  }, [takeFocus, onFocused])
  const [rejected, setRejected] = useState<RejectedPhoto[]>([])
  const [rejectedMore, setRejectedMore] = useState(false)
  const [rejectedError, setRejectedError] = useState<string | null>(null)
  const [shownRejected, setShownRejected] = useState<Set<string>>(new Set())
  // A decided item, a photo allowed back, a pin put back: each fades out of
  // its list rather than vanishing the moment the list reloads.
  const shownItems = useLingeringList(items, (item) => item.jobId)
  const shownRejectedPhotos = useLingeringList(rejected, (photo) => photo.photoId)
  const shownOffMap = useLingeringList(offMap, (report) => report.id)

  const loadOffMap = useCallback(async () => {
    try {
      const { reports, more } = await data.listReportsOffMap()
      setOffMap(reports)
      setOffMapMore(more)
      setOffMapError(null)
    } catch {
      setOffMapError('Could not load the pins that are off the map.')
    }
  }, [data])

  // Photos rejected inside the thirty-day hold. The hold exists so a wrong
  // rejection -- above all an automatic one nobody has seen -- can be undone
  // before the bytes are deleted, and this is the one place to do it.
  const loadRejected = useCallback(async () => {
    try {
      const { photos, more } = await data.listRecentlyRejectedPhotos()
      setRejected(photos)
      setRejectedMore(more)
      setRejectedError(null)
    } catch {
      setRejectedError('Could not load the photos removed recently.')
    }
  }, [data])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    // Pins off the map live here too, because this is the one screen an admin
    // always has: without it, a pin taken off by mistake could only be found
    // again by stumbling on it. Started before the queue and not awaited, so
    // neither one failing takes the other down.
    void loadOffMap()
    void loadRejected()
    try {
      const [loaded, waiting] = await Promise.all([
        data.listModerationQueue(),
        data.getModerationQueueSize(),
      ])
      setItems(loaded)
      setTotal(waiting)
    } catch (cause) {
      setError(plainError(cause instanceof Error ? cause.message : null))
    } finally {
      setLoading(false)
    }
  }, [data, loadOffMap, loadRejected])

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    void load()
  }, [isAdmin, load])

  // A pin changed on a report's screen while this was open. The whole queue is
  // re-read, not just the off-map list: each item carries its pin's state, and
  // what this screen did itself is no longer the latest word on it.
  useEffect(() => {
    if (!isAdmin || pinsVersion === 0) return
    setPinsOff(new Map())
    void load()
  }, [isAdmin, pinsVersion, load])

  if (!isAdmin) return null

  const decide = async (item: QueueItem, verdict: 'approved' | 'rejected') => {
    setDeciding(item.jobId)
    setError(null)
    try {
      await data.decideModerationItem(item.jobId, verdict)
      // Drop it locally so the next item is immediately actionable, rather than
      // waiting on a round trip before anything can be reviewed.
      setItems((current) => current.filter((i) => i.jobId !== item.jobId))
      // The total has to come down too, or the header claims more are waiting
      // than there are -- the exact misreport the count exists to prevent.
      const remaining = Math.max(0, total - 1)
      setTotal(remaining)
      onDecided?.()

      // Clearing the visible page does not mean the queue is empty: it is
      // capped at 50 and only loaded on mount. Without this, an admin who works
      // through a page is told "Nothing to review." with the rest still waiting.
      if (remaining > 0 && items.length <= 1) await load()
    } catch (cause) {
      const message = plainError(cause instanceof Error ? cause.message : null)
      // The local list may now disagree with the server, so re-read it -- but
      // load() clears the error banner on the way in, so the message has to be
      // set AFTER it. Setting it first would leave a failed decision looking
      // exactly like a successful one.
      await load()
      setError(message)
    } finally {
      setDeciding(null)
    }
  }

  /**
   * Take the pin this item sits on off the map. Separate from Allow and
   * Remove, which judge the item itself: a spam note usually means a spam pin,
   * and rejecting the note alone would leave the pin colouring the map.
   */
  const takePinOff = async (item: QueueItem) => {
    if (!item.reportId || pinBusy) return
    setPinBusy(true)
    setError(null)
    try {
      // No reason. Anything written here would be which button was pressed,
      // shown later as "Taken off because". The report's own screen is where an
      // admin can say why in their own words; pin_history records who and when.
      const moved = await data.setReportOnMap(item.reportId, false)
      setPinsOff((current) => new Map(current).set(item.reportId!, moved ? 'now' : 'already'))
      await loadOffMap()
      onDecided?.()
    } catch (cause) {
      setError(plainError(cause instanceof Error ? cause.message : null))
    } finally {
      setPinBusy(false)
    }
  }

  const putPinBack = async (reportId: string) => {
    if (pinBusy) return
    setPinBusy(true)
    setError(null)
    try {
      await data.setReportOnMap(reportId, true)
      // Everything re-read, not just dropped locally: when the off-map list was
      // cut short the next one has to move up into it, and every item on this
      // pin has to stop saying it is off the map.
      setPinsOff(new Map())
      await load()
      onDecided?.()
    } catch (cause) {
      setError(plainError(cause instanceof Error ? cause.message : null))
    } finally {
      setPinBusy(false)
    }
  }

  const allowAfterAll = async (photoId: string) => {
    // Busy-guarded like the other buttons: a double click otherwise sent a
    // second allow that failed, reading "could not be found" after a success.
    if (pinBusy) return
    setPinBusy(true)
    setError(null)
    try {
      await data.allowRejectedPhoto(photoId)
      await loadRejected()
      onDecided?.()
    } catch (cause) {
      setError(plainError(cause instanceof Error ? cause.message : null))
      await loadRejected()
    } finally {
      setPinBusy(false)
    }
  }

  const reveal = (jobId: string) =>
    setRevealed((current) => new Set(current).add(jobId))

  return (
    <section ref={root} tabIndex={-1} className="mo-glass rounded-2xl p-4 outline-none" aria-label="Review queue">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Review queue</h2>
          <p className="text-xs text-slate-500">
            {loading
              ? 'Loading…'
              : total === 0
                ? 'Nothing to review.'
                : total > items.length
                  ? `${total} waiting, showing the first ${items.length}`
                  : `${items.length} waiting`}
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

      <Reveal show={!!(error)}>{(error) && (
        <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">
          {error}
        </p>
      )}</Reveal>

      <ul className="mt-0">
        {shownItems.map(({ item, key, leaving }) => (
          <li key={key}>
          <Reveal show={!leaving} gap="pt-3">
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">
                {subjectLabel[item.subjectType]}
              </span>
              {item.flagCount > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                  {item.flagCount} {item.flagCount === 1 ? 'person' : 'people'} reported this
                </span>
              )}
            </div>

            {item.subjectType === 'photo' ? (
              item.photoUrl ? (
                revealed.has(item.jobId) ? (
                  <img
                    src={item.photoUrl}
                    alt="Waiting for review"
                    className="mt-2 max-h-64 w-full rounded-lg object-contain"
                  />
                ) : (
                  // Not shown until asked for. Whoever is reviewing may be in
                  // public, and this queue holds precisely the content most
                  // likely to be unpleasant.
                  <button
                    type="button"
                    onClick={() => reveal(item.jobId)}
                    className="mt-2 flex h-32 w-full items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-600 hover:bg-slate-200"
                  >
                    Show photo
                  </button>
                )
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  This photo is no longer available.
                </p>
              )
            ) : item.text ? (
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-sm text-slate-800">
                {item.text}
              </p>
            ) : (
              <p className="mt-2 text-sm text-slate-500">This content is no longer available.</p>
            )}

            {item.reportId && (
              // Without this an admin judging a bare comment has no idea which
              // report it sits on.
              <p className="mt-2 text-xs text-slate-500">
                On the report at <span className="font-mono">{item.reportId.slice(0, 8)}</span>
              </p>
            )}

            <p className="mt-2 text-xs text-slate-600">{plainReason(item.reason)}</p>

            {summariseScores(item.tierResults).length > 0 && (
              <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                {summariseScores(item.tierResults).map((score) => (
                  <div key={score.label} className="flex gap-1">
                    <dt>{score.label}</dt>
                    <dd className="font-medium text-slate-700">{score.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void decide(item, 'approved')}
                disabled={deciding !== null}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => void decide(item, 'rejected')}
                disabled={deciding !== null}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 disabled:opacity-50"
              >
                Remove
              </button>
              {item.reportId &&
                item.pinOnMap !== null &&
                (pinsOff.get(item.reportId) === 'now' ? (
                  <span className="self-center text-xs text-slate-500">Pin taken off the map.</span>
                ) : pinsOff.get(item.reportId) === 'already' || item.pinOnMap === false ? (
                  <span className="self-center text-xs text-slate-500">This pin is off the map.</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void takePinOff(item)}
                    disabled={deciding !== null || pinBusy}
                    className="rounded-lg px-3 py-2 text-sm text-slate-600 underline hover:text-slate-900 disabled:opacity-50"
                  >
                    Take the pin off the map
                  </button>
                ))}
            </div>
          </div>
          </Reveal>
          </li>
        ))}
      </ul>

      <Reveal show={!!(rejectedError)}>{(rejectedError) && <p className="mt-4 text-xs text-slate-600">{rejectedError}</p>}</Reveal>

      <Reveal show={!!(rejected.length > 0)}>{(rejected.length > 0) && (
        <div className="mt-5 border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">Removed photos</h3>
          <p className="text-xs text-slate-500">
            A removed photo is kept for {REJECTED_HOLD_DAYS} days and then deleted for good, once
            photo cleanup is running. Allow one here if it was removed by mistake. The ones due
            soonest are first.
          </p>
          <Reveal show={!!(rejectedMore)}>{(rejectedMore) && (
            <p className="text-xs text-slate-500">
              Showing the {rejected.length} due to be deleted soonest.
            </p>
          )}</Reveal>
          <ul className="mt-0">
            {shownRejectedPhotos.map(({ item: photo, key, leaving }) => (
              <li key={key}>
              <Reveal show={!leaving} gap="pt-2">
              <div className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="text-xs text-slate-600">
                  {photo.automatic ? 'Removed automatically. Nobody has looked at it.' : 'Removed by a person.'}{' '}
                  {deletionDate(photo.rejectedAt)}
                </p>
                {photo.url &&
                  (shownRejected.has(photo.photoId) ? (
                    <img
                      src={photo.url}
                      alt="Removed photo"
                      className="mt-2 max-h-48 w-full rounded-lg object-contain"
                    />
                  ) : (
                    // Not shown until asked for, like everything in this queue.
                    <button
                      type="button"
                      onClick={() => setShownRejected((current) => new Set(current).add(photo.photoId))}
                      className="mt-2 flex h-24 w-full items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-600 hover:bg-slate-200"
                    >
                      Show photo
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() => void allowAfterAll(photo.photoId)}
                  disabled={pinBusy}
                  className="mt-2 rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-800"
                >
                  Allow after all
                </button>
              </div>
              </Reveal>
              </li>
            ))}
          </ul>
        </div>
      )}</Reveal>

      <Reveal show={!!(offMapError)}>{(offMapError) && <p className="mt-4 text-xs text-slate-600">{offMapError}</p>}</Reveal>

      <Reveal show={!!(offMap.length > 0)}>{(offMap.length > 0) && (
        <div className="mt-5 border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">Off the map</h3>
          <Reveal show={!!(offMapMore)}>{(offMapMore) && (
            <p className="text-xs text-slate-500">
              Showing the {offMap.length} most recently taken off.
            </p>
          )}</Reveal>
          <ul className="mt-0">
            {shownOffMap.map(({ item: report, key, leaving }) => (
              <li key={key}>
              <Reveal show={!leaving} gap="pt-2">
              <div className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="text-slate-800">
                  Added {new Date(report.createdAt).toLocaleDateString()}
                  {report.reporterName ? ` by ${report.reporterName}` : ''}
                </p>
                <Reveal show={!!(report.removalReason)}>{(report.removalReason) && (
                  <p className="mt-1 text-xs text-slate-600">Taken off because: {report.removalReason}</p>
                )}</Reveal>
                <button
                  type="button"
                  onClick={() => void putPinBack(report.id)}
                  disabled={pinBusy}
                  className="mt-2 rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-800 disabled:opacity-50"
                >
                  Put back on the map
                </button>
              </div>
              </Reveal>
              </li>
            ))}
          </ul>
        </div>
      )}</Reveal>
    </section>
  )
}
