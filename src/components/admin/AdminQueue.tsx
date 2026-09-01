import { useCallback, useEffect, useState } from 'react'
import type { DataSource, QueueItem } from '../../lib/data/types'
import { plainReason, plainError, summariseScores } from '../../lib/moderation/plainWords'

export interface AdminQueueProps {
  data: DataSource
  isAdmin: boolean
  onClose: () => void
  /** Called after a decision, so the map can pick up newly approved content. */
  onDecided?: () => void
}

const subjectLabel: Record<QueueItem['subjectType'], string> = {
  photo: 'Photo',
  comment: 'Comment',
  note: 'Report note',
}

export function AdminQueue({ data, isAdmin, onClose, onDecided }: AdminQueueProps) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [total, setTotal] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
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
  }, [data])

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    void load()
  }, [isAdmin, load])

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

  const reveal = (jobId: string) =>
    setRevealed((current) => new Set(current).add(jobId))

  return (
    <section className="rounded-xl bg-white p-4 shadow-lg" aria-label="Review queue">
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

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">
          {error}
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li key={item.jobId} className="rounded-lg border border-slate-200 p-3">
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
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
