import type { ReportFilters, StatusFilter } from '../../lib/filters/reportFilters'
import { DEFAULT_FILTERS, isDefault } from '../../lib/filters/reportFilters'
import { Reveal } from '../Reveal'

export interface FilterPanelProps {
  filters: ReportFilters
  onChange: (filters: ReportFilters) => void
  /** How many reports survive the current filters, out of how many exist. */
  showing: number
  total: number
  onUseMyLocation: () => void
  locatingMessage?: string | null
  hasLocation: boolean
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Everything' },
  // "Reported" rather than "open": plain, and it describes the litter, not the
  // place it is in.
  { value: 'open', label: 'Still there' },
  { value: 'cleaned', label: 'Cleaned up' },
]

const DISTANCE_OPTIONS = [
  { value: null, label: 'Any distance' },
  { value: 500, label: 'Within 500 m' },
  { value: 2000, label: 'Within 2 km' },
  { value: 10000, label: 'Within 10 km' },
]

export function FilterPanel({
  filters,
  onChange,
  showing,
  total,
  onUseMyLocation,
  locatingMessage,
  hasLocation,
}: FilterPanelProps) {
  const set = (patch: Partial<ReportFilters>) => onChange({ ...filters, ...patch })

  return (
    <section className="mo-glass rounded-2xl p-3" aria-label="Filters">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Show</h2>
        {!isDefault(filters) && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTERS, origin: filters.origin })}
            className="text-xs text-slate-500 underline hover:text-slate-900"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filters.status === option.value}
            onClick={() => set({ status: option.value })}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filters.status === option.value
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <label htmlFor="filter-confirmations" className="block text-xs font-medium text-slate-800">
          Confirmed by at least {filters.minConfirmations}{' '}
          {filters.minConfirmations === 1 ? 'person' : 'people'}
        </label>
        <input
          id="filter-confirmations"
          type="range"
          min={0}
          max={10}
          step={1}
          value={filters.minConfirmations}
          onChange={(event) => set({ minConfirmations: Number(event.target.value) })}
          className="mt-1 w-full"
        />
      </div>

      <div className="mt-3">
        <label htmlFor="filter-since" className="block text-xs font-medium text-slate-800">
          Added since
        </label>
        <input
          id="filter-since"
          type="date"
          value={filters.since ?? ''}
          onChange={(event) => set({ since: event.target.value || null })}
          className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
        />
      </div>

      <div className="mt-3">
        <label htmlFor="filter-distance" className="block text-xs font-medium text-slate-800">
          Distance from me
        </label>
        <select
          id="filter-distance"
          value={filters.withinMetres ?? ''}
          onChange={(event) =>
            set({ withinMetres: event.target.value ? Number(event.target.value) : null })
          }
          className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
        >
          {DISTANCE_OPTIONS.map((option) => (
            <option key={option.label} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </select>

        <Reveal show={!!(!hasLocation && filters.withinMetres !== null)}>{(!hasLocation && filters.withinMetres !== null) && (
          <p className="mt-1 text-xs text-amber-800">
            Share your location to use this.
          </p>
        )}</Reveal>
      </div>

      <button
        type="button"
        onClick={onUseMyLocation}
        className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50"
      >
        {hasLocation ? 'Update my location' : 'Use my location'}
      </button>

      <Reveal show={!!(locatingMessage)}>{(locatingMessage) && (
        <p role="status" className="mt-2 text-xs text-slate-600">
          {locatingMessage}
        </p>
      )}</Reveal>

      <p className="mt-3 text-xs text-slate-500">
        {showing === total
          ? `${total} ${total === 1 ? 'report' : 'reports'}`
          : `${showing} of ${total} reports`}
      </p>
    </section>
  )
}
