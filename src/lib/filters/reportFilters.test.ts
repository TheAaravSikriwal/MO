import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  sortByDistance,
  isDefault,
  DEFAULT_FILTERS,
  type ReportFilters,
} from './reportFilters'
import { distanceMetres, formatDistance } from '../geo/distance'
import type { ReportView } from '../data/types'

const report = (over: Partial<ReportView> & { id: string }): ReportView => ({
  reporterName: null,
  lat: 51.5,
  lng: -0.12,
  note: null,
  noteStatus: 'approved',
  moderationStatus: 'approved',
  status: 'open',
  voteCount: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  cells: {},
  photos: [],
  viewerHasVoted: false,
  viewerIsReporter: false,
  ...over,
})

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  ...DEFAULT_FILTERS,
  ...over,
})

const ids = (list: ReportView[]) => list.map((r) => r.id)

describe('distanceMetres', () => {
  it('is zero for the same point', () => {
    expect(distanceMetres({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0)
  })

  it('matches a known distance', () => {
    // London to Paris is about 344 km.
    const away = distanceMetres({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 })
    expect(away).toBeGreaterThan(330_000)
    expect(away).toBeLessThan(350_000)
  })

  it('takes the short way across the antimeridian', () => {
    // Two points either side of the line are close, not most of a planet apart.
    const away = distanceMetres({ lat: 0, lng: 179.95 }, { lat: 0, lng: -179.95 })
    expect(away).toBeLessThan(15_000)
  })

  it('is symmetric', () => {
    const a = { lat: 10, lng: 20 }
    const b = { lat: -30, lng: 100 }
    expect(distanceMetres(a, b)).toBeCloseTo(distanceMetres(b, a), 6)
  })
})

describe('formatDistance', () => {
  it('uses metres close by and kilometres further out', () => {
    expect(formatDistance(450)).toBe('450 m away')
    expect(formatDistance(2400)).toBe('2.4 km away')
    expect(formatDistance(42_000)).toBe('42 km away')
  })

  it('says nothing rather than nonsense for an unusable value', () => {
    expect(formatDistance(Number.NaN)).toBe('')
    expect(formatDistance(-5)).toBe('')
  })
})

describe('applyFilters — status', () => {
  const both = [report({ id: 'open' }), report({ id: 'cleaned', status: 'cleaned' })]

  it('shows what is still there by default, so cleanups cool the map', () => {
    expect(ids(applyFilters(both, filters()))).toEqual(['open'])
  })

  it('shows both when everything is asked for', () => {
    expect(ids(applyFilters(both, filters({ status: 'all' })))).toEqual(['open', 'cleaned'])
  })

  it('narrows to reported spots', () => {
    expect(ids(applyFilters(both, filters({ status: 'open' })))).toEqual(['open'])
  })

  it('narrows to cleaned spots', () => {
    expect(ids(applyFilters(both, filters({ status: 'cleaned' })))).toEqual(['cleaned'])
  })
})

describe('applyFilters — confirmations', () => {
  const some = [
    report({ id: 'none', voteCount: 0 }),
    report({ id: 'few', voteCount: 2 }),
    report({ id: 'many', voteCount: 10 }),
  ]

  it('hides anything below the threshold', () => {
    expect(ids(applyFilters(some, filters({ minConfirmations: 2 })))).toEqual(['few', 'many'])
  })

  it('includes reports exactly at the threshold', () => {
    expect(ids(applyFilters(some, filters({ minConfirmations: 10 })))).toEqual(['many'])
  })

  it('ignores an unusable threshold rather than emptying the map', () => {
    expect(applyFilters(some, filters({ minConfirmations: Number.NaN }))).toHaveLength(3)
    expect(applyFilters(some, filters({ minConfirmations: -5 }))).toHaveLength(3)
  })
})

describe('applyFilters — date', () => {
  const across = [
    report({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    report({ id: 'recent', createdAt: '2026-08-01T00:00:00.000Z' }),
  ]

  it('keeps only what is new enough', () => {
    expect(ids(applyFilters(across, filters({ since: '2026-07-01' })))).toEqual(['recent'])
  })

  it('ignores a half-typed date instead of showing nothing', () => {
    // Emptying the map mid-keystroke reads as "there is nothing here".
    expect(applyFilters(across, filters({ since: '2026-0' }))).toHaveLength(2)
    expect(applyFilters(across, filters({ since: 'not a date' }))).toHaveLength(2)
  })

  it('keeps a report whose own date is unreadable', () => {
    const odd = [report({ id: 'odd', createdAt: 'whenever' })]
    expect(applyFilters(odd, filters({ since: '2026-07-01' }))).toHaveLength(1)
  })
})

describe('applyFilters — distance', () => {
  const here = { lat: 51.5074, lng: -0.1278 }
  const spread = [
    report({ id: 'close', lat: 51.5079, lng: -0.1281 }),
    report({ id: 'far', lat: 48.8566, lng: 2.3522 }),
  ]

  it('keeps only what is near enough', () => {
    expect(
      ids(applyFilters(spread, filters({ origin: here, withinMetres: 2000 }))),
    ).toEqual(['close'])
  })

  it('does nothing without a location, rather than hiding everything', () => {
    // The distance filter is set but "near me" has not been allowed yet.
    expect(applyFilters(spread, filters({ withinMetres: 2000 }))).toHaveLength(2)
  })

  it('ignores an unusable radius', () => {
    expect(applyFilters(spread, filters({ origin: here, withinMetres: 0 }))).toHaveLength(2)
    expect(
      applyFilters(spread, filters({ origin: here, withinMetres: Number.NaN })),
    ).toHaveLength(2)
  })
})

describe('applyFilters — together', () => {
  it('applies every active filter at once', () => {
    const here = { lat: 51.5074, lng: -0.1278 }
    const list = [
      report({ id: 'wanted', lat: 51.5079, lng: -0.1281, voteCount: 5, createdAt: '2026-08-01T00:00:00.000Z' }),
      report({ id: 'too-few', lat: 51.5079, lng: -0.1281, voteCount: 0, createdAt: '2026-08-01T00:00:00.000Z' }),
      report({ id: 'too-old', lat: 51.5079, lng: -0.1281, voteCount: 5, createdAt: '2026-01-01T00:00:00.000Z' }),
      report({ id: 'too-far', lat: 48.8566, lng: 2.3522, voteCount: 5, createdAt: '2026-08-01T00:00:00.000Z' }),
      report({ id: 'cleaned', lat: 51.5079, lng: -0.1281, voteCount: 5, createdAt: '2026-08-01T00:00:00.000Z', status: 'cleaned' }),
    ]
    const result = applyFilters(
      list,
      filters({ status: 'open', minConfirmations: 3, since: '2026-07-01', origin: here, withinMetres: 2000 }),
    )
    expect(ids(result)).toEqual(['wanted'])
  })

  it('does not mutate the input', () => {
    const list = [report({ id: 'a' })]
    const snapshot = JSON.parse(JSON.stringify(list))
    applyFilters(list, filters({ status: 'cleaned' }))
    expect(list).toEqual(snapshot)
  })

  it('handles an empty list', () => {
    expect(applyFilters([], filters({ status: 'open' }))).toEqual([])
  })
})

describe('isDefault', () => {
  it('recognises untouched filters', () => {
    expect(isDefault(DEFAULT_FILTERS)).toBe(true)
  })

  it('notices any change', () => {
    expect(isDefault(filters({ status: 'cleaned' }))).toBe(false)
    expect(isDefault(filters({ status: 'all' }))).toBe(false)
    expect(isDefault(filters({ minConfirmations: 1 }))).toBe(false)
    expect(isDefault(filters({ since: '2026-01-01' }))).toBe(false)
    expect(isDefault(filters({ withinMetres: 1000 }))).toBe(false)
  })

  it('does not count merely knowing where you are as a filter', () => {
    // Allowing location should not make the map look filtered.
    expect(isDefault(filters({ origin: { lat: 1, lng: 2 } }))).toBe(true)
  })
})

describe('sortByDistance', () => {
  it('puts the nearest first', () => {
    const here = { lat: 51.5074, lng: -0.1278 }
    const list = [
      report({ id: 'far', lat: 48.8566, lng: 2.3522 }),
      report({ id: 'close', lat: 51.5079, lng: -0.1281 }),
    ]
    expect(ids(sortByDistance(list, here))).toEqual(['close', 'far'])
  })

  it('keeps the order when there is no location', () => {
    const list = [report({ id: 'b' }), report({ id: 'a' })]
    expect(ids(sortByDistance(list, null))).toEqual(['b', 'a'])
  })

  it('does not mutate the input', () => {
    const list = [report({ id: 'far', lat: 0, lng: 0 }), report({ id: 'close' })]
    sortByDistance(list, { lat: 51.5, lng: -0.12 })
    expect(ids(list)).toEqual(['far', 'close'])
  })
})
