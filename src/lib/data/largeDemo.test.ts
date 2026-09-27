import { describe, it, expect } from 'vitest'
import {
  largeDemoReports,
  ideaCountFromSearch,
  DEFAULT_LARGE_COUNT,
  MAX_LARGE_COUNT,
} from './largeDemo'
import { createDataSource, createIdeaSource } from './createDataSource'
import { REPORT_PAGE_LIMIT } from './types'

const WORLD = { minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 }
const NOW = Date.parse('2026-09-27T12:00:00Z')

describe('largeDemoReports', () => {
  it('gives the same reports every time, so a screenshot can be retaken', () => {
    expect(largeDemoReports(500, NOW)).toEqual(largeDemoReports(500, NOW))
  })

  it('gives exactly the count asked for, each with a distinct id', () => {
    const reports = largeDemoReports(2000, NOW)
    expect(reports).toHaveLength(2000)
    expect(new Set(reports.map((r) => r.id)).size).toBe(2000)
  })

  it('keeps every report on the map, with a sensible count and date', () => {
    for (const r of largeDemoReports(5000, NOW)) {
      expect(r.lat).toBeGreaterThanOrEqual(-85)
      expect(r.lat).toBeLessThanOrEqual(85)
      expect(r.lng).toBeGreaterThanOrEqual(-180)
      expect(r.lng).toBeLessThan(180)
      expect(r.voteCount).toBeGreaterThanOrEqual(0)
      const age = NOW - Date.parse(r.createdAt)
      expect(age).toBeGreaterThanOrEqual(0)
      expect(age).toBeLessThan(366 * 24 * 60 * 60 * 1000)
    }
  })

  it('has both open and cleaned reports, so both filters show something', () => {
    const statuses = new Set(largeDemoReports(1000, NOW).map((r) => r.status))
    expect(statuses).toEqual(new Set(['open', 'cleaned']))
  })
})

describe('ideaCountFromSearch', () => {
  it('uses the default count, or the one asked for within the limit', () => {
    expect(ideaCountFromSearch('')).toBe(DEFAULT_LARGE_COUNT)
    expect(ideaCountFromSearch('?count=abc')).toBe(DEFAULT_LARGE_COUNT)
    expect(ideaCountFromSearch('?count=-5')).toBe(DEFAULT_LARGE_COUNT)
    expect(ideaCountFromSearch('?world=idea&count=300')).toBe(300)
    expect(ideaCountFromSearch('?count=9999999')).toBe(MAX_LARGE_COUNT)
  })
})

describe('the demo sources', () => {
  it('keeps made-up reports out of the real side when no database is connected', async () => {
    const chosen = createDataSource({})
    expect(chosen.demo).toBe(true)
    expect(await chosen.source.countReportsInView(WORLD)).toBe(0)
  })

  it('fills "The idea" with the large set, at the count the address asks for', async () => {
    expect(await createIdeaSource('?count=300').countReportsInView(WORLD)).toBe(300)
  })
})

describe('the in-memory source at scale', () => {
  const ALL = { status: 'all', minConfirmations: 0, since: null, origin: null, withinMetres: null } as const

  it('hands back one page of reports, most confirmed first, as the real source does', async () => {
    const reports = await createIdeaSource('?count=2000').listReportsInView(WORLD, ALL)
    expect(reports).toHaveLength(REPORT_PAGE_LIMIT)
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i - 1].voteCount).toBeGreaterThanOrEqual(reports[i].voteCount)
    }
  })

  it('still colours the map from every report, not just that page', async () => {
    const cells = await createIdeaSource('?count=2000').getRollup(WORLD, 1, ALL)
    expect(cells.reduce((sum, cell) => sum + cell.reportCount, 0)).toBe(2000)
  })
})
