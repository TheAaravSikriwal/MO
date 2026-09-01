import { distanceMetres, type Point } from '../geo/distance'
import type { ReportView } from '../data/types'

export type StatusFilter = 'all' | 'open' | 'cleaned'

export interface ReportFilters {
  status: StatusFilter
  /** Hide anything fewer than this many people have confirmed. */
  minConfirmations: number
  /** Only reports added on or after this date. ISO `YYYY-MM-DD`, or null. */
  since: string | null
  /** Only reports within this many metres of `origin`. Needs `origin` set. */
  withinMetres: number | null
  origin: Point | null
}

export const DEFAULT_FILTERS: ReportFilters = {
  status: 'all',
  minConfirmations: 0,
  since: null,
  withinMetres: null,
  origin: null,
}

export const isDefault = (filters: ReportFilters): boolean =>
  filters.status === DEFAULT_FILTERS.status &&
  filters.minConfirmations === DEFAULT_FILTERS.minConfirmations &&
  filters.since === DEFAULT_FILTERS.since &&
  filters.withinMetres === DEFAULT_FILTERS.withinMetres

/**
 * Narrow a set of reports.
 *
 * Search takes you TO a place; this decides WHAT you see once you are there.
 *
 * Every unusable filter value is ignored rather than treated as "match
 * nothing": a half-typed date or a distance with no location yet would
 * otherwise empty the map with no explanation, which reads as "there is
 * nothing here" — the opposite of the truth.
 */
export function applyFilters(
  reports: readonly ReportView[],
  filters: ReportFilters,
): ReportView[] {
  const sinceTime = filters.since ? Date.parse(filters.since) : Number.NaN
  const useSince = Number.isFinite(sinceTime)

  const useDistance =
    filters.origin !== null &&
    filters.withinMetres !== null &&
    Number.isFinite(filters.withinMetres) &&
    filters.withinMetres > 0

  const minConfirmations = Number.isFinite(filters.minConfirmations)
    ? Math.max(0, filters.minConfirmations)
    : 0

  return reports.filter((report) => {
    if (filters.status !== 'all' && report.status !== filters.status) return false
    if (report.voteCount < minConfirmations) return false

    if (useSince) {
      const created = Date.parse(report.createdAt)
      if (Number.isFinite(created) && created < sinceTime) return false
    }

    if (useDistance) {
      const away = distanceMetres(filters.origin!, { lat: report.lat, lng: report.lng })
      if (away > filters.withinMetres!) return false
    }

    return true
  })
}

/** Nearest first. Only meaningful with an origin; otherwise the order is kept. */
export function sortByDistance(
  reports: readonly ReportView[],
  origin: Point | null,
): ReportView[] {
  if (!origin) return [...reports]
  return [...reports].sort(
    (a, b) =>
      distanceMetres(origin, { lat: a.lat, lng: a.lng }) -
      distanceMetres(origin, { lat: b.lat, lng: b.lng }),
  )
}
