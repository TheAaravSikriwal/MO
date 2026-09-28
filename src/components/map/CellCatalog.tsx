import { Reveal, Swap, useLingeringList } from '../Reveal'
import type { ReportView } from '../../lib/data/types'

export type CatalogState =
  | { status: 'loading' }
  /** `capped`: the area holds more than one page, so only the most confirmed are here. */
  | { status: 'ready'; reports: ReportView[]; capped: boolean }
  | { status: 'failed'; message: string }

export interface CellCatalogProps {
  /** How many reports the area holds, as its tower counted them when picked. Shown until the list arrives. */
  reportCount: number
  state: CatalogState
  onOpen: (report: ReportView) => void
  onClose: () => void
}

const confirmed = (n: number) => (n === 1 ? '1 person confirmed' : `${n} people confirmed`)

const added = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The note as its title, only once it is approved. The reporter is handed their
 * own note whatever its status, and the report screen tells them a pending or
 * removed one is not shown: the list must not show it either.
 */
const title = (report: ReportView) =>
  (report.noteStatus === 'approved' ? report.note : null) ?? 'Litter reported here'

/**
 * Every report in one area of the map, most confirmed first: the log behind a
 * tower. Picking one opens it, and the map flies to it.
 */
export function CellCatalog({ reportCount, state, onOpen, onClose }: CellCatalogProps) {
  const reports = state.status === 'ready' ? state.reports : []
  // Once loaded, the list itself is the count: the filters may have changed
  // since the tower was picked, and a stale number would invent a cut-off.
  const count = state.status === 'ready' ? reports.length : reportCount
  const capped = state.status === 'ready' && state.capped
  const shown = useLingeringList(reports, (report) => report.id)
  return (
    <section aria-label="Reports in this area" className="mo-glass flex max-h-[45vh] flex-col rounded-2xl p-3 md:max-h-[60vh]">
      <header className="flex items-start justify-between gap-2 px-1">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Reports in this area</h2>
          <p className="text-xs text-slate-500">
            {count === 1 ? '1 report' : `${count.toLocaleString('en-GB')}${capped ? ' or more' : ''} reports`}, most confirmed first
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-900/5">
          Close
        </button>
      </header>

      <Swap id={state.status}>
        {state.status === 'loading' ? (
          <p role="status" className="px-1 pt-3 text-xs text-slate-500">
            Loading…
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert" className="px-1 pt-3 text-xs text-rose-700">
            {state.message}
          </p>
        ) : reports.length === 0 ? (
          <p role="status" className="px-1 pt-3 text-xs text-slate-500">
            Nothing to list here with the filters as they are.
          </p>
        ) : (
          <Reveal show={capped}>
            <p className="px-1 pt-2 text-[11px] text-slate-500">
              Showing the {reports.length.toLocaleString('en-GB')} most confirmed here.
            </p>
          </Reveal>
        )}
      </Swap>

      <ul className="mt-1 min-h-0 overflow-auto">
        {shown.map(({ item: report, key, leaving }) => (
          <li key={key}>
            <Reveal show={!leaving} gap="pt-2">
              <button
                type="button"
                onClick={() => onOpen(report)}
                className="block w-full rounded-xl border border-slate-900/10 bg-white/60 p-2.5 text-left transition-colors duration-200 hover:bg-white"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {title(report)}
                  </span>
                  {report.status === 'cleaned' && (
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                      Cleaned
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {confirmed(report.voteCount)}
                  {added(report.createdAt) ? ` · ${added(report.createdAt)}` : ''}
                </span>
              </button>
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  )
}
