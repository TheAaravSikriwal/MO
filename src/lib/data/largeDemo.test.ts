import { describe, it, expect } from 'vitest'
import {
  largeDemoReports,
  largeDemoCountFromSearch,
  DEFAULT_LARGE_COUNT,
  MAX_LARGE_COUNT,
} from './largeDemo'
import { createDemoSource } from './createDataSource'

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

describe('largeDemoCountFromSearch', () => {
  it('is off unless the address asks for it', () => {
    expect(largeDemoCountFromSearch('')).toBeNull()
    expect(largeDemoCountFromSearch('?demo=small')).toBeNull()
  })

  it('uses the default count, or the one asked for within the limit', () => {
    expect(largeDemoCountFromSearch('?demo=large')).toBe(DEFAULT_LARGE_COUNT)
    expect(largeDemoCountFromSearch('?demo=large&count=abc')).toBe(DEFAULT_LARGE_COUNT)
    expect(largeDemoCountFromSearch('?demo=large&count=-5')).toBe(DEFAULT_LARGE_COUNT)
    expect(largeDemoCountFromSearch('?demo=large&count=300')).toBe(300)
    expect(largeDemoCountFromSearch('?demo=large&count=9999999')).toBe(MAX_LARGE_COUNT)
  })
})

describe('createDemoSource', () => {
  it('keeps the ordinary five reports without the switch', async () => {
    const source = createDemoSource('')
    expect(await source.countReportsInView(WORLD)).toBe(5)
  })

  it('loads the large set with ?demo=large', async () => {
    const source = createDemoSource('?demo=large&count=300')
    expect(await source.countReportsInView(WORLD)).toBe(300)
  })
})
