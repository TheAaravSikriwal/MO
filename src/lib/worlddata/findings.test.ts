import { describe, it, expect } from 'vitest'
import {
  link,
  allLinks,
  byLifeBand,
  sayFinding,
  withinWealth,
  bandTest,
  METRICS,
  ENVIRONMENT,
  MAIN_TESTS,
  FIRM_P,
  type CountryTable,
} from './findings'

/**
 * Made-up countries with known relations, so each finding can be checked
 * against the answer it should give.
 */
const made = (rows: Array<Record<string, number>>): CountryTable =>
  new Map(rows.map((row, i) => [`C${String(i).padStart(2, '0')}`, { name: `Country ${i}`, ...row }]))

// Wealth drives both quality of life and cleaner air; nothing else joins them.
const wealthOnly = made(
  Array.from({ length: 60 }, (_, i) => ({
    gdp: 1000 + i * 1000,
    life: 0.3 + i * 0.01 + (((i * 7) % 11) - 5) * 0.006,
    air: 80 - i + (((i * 13) % 17) - 8) * 0.9,
  })),
)

// Quality of life goes with cleaner water beyond wealth: water follows life, not gdp.
const beyondWealth = made(
  Array.from({ length: 60 }, (_, i) => ({
    gdp: 1000 + ((i * 37) % 60) * 1000,
    life: 0.3 + i * 0.01,
    water: 20 + i + (((i * 5) % 7) - 3),
  })),
)

describe('link', () => {
  it('measures the rank link, the number of countries, and the chance it is luck', () => {
    const l = link(wealthOnly, 'life', 'air')
    expect(l.n).toBe(60)
    expect(l.r).toBeLessThan(-0.8)
    expect(l.p).toBeLessThan(0.001)
    expect(l.strength).toBe('strong')
  })

  it('finds a link that wealth explains disappears once wealth is held level', () => {
    const l = link(wealthOnly, 'life', 'air')
    expect(l.heldLevel!.strength).toBe('no clear')
  })

  it('keeps a link that goes beyond wealth', () => {
    const l = link(beyondWealth, 'life', 'water')
    expect(l.heldLevel!.strength).toBe('strong')
    expect(l.heldLevel!.r).toBeGreaterThan(0.5)
  })

  it('does not hold wealth level against wealth itself', () => {
    expect(link(wealthOnly, 'life', 'gdp').heldLevel).toBeNull()
  })

  it('uses only countries with both figures', () => {
    const table = made([{ life: 0.5, air: 10 }, { life: 0.6 }, { air: 5 }, { life: 0.7, air: 3 }, { life: 0.8, air: 1 }])
    expect(link(table, 'life', 'air').n).toBe(3)
  })
})

describe('allLinks', () => {
  it('pairs every measure with every other once', () => {
    const count = Object.keys(METRICS).length
    expect(allLinks(wealthOnly)).toHaveLength((count * (count - 1)) / 2)
  })
})

describe('byLifeBand', () => {
  it('gives the middle figure in each of the UN’s quality-of-life bands', () => {
    const table = made([
      { life: 0.4, air: 50 },
      { life: 0.5, air: 40 },
      { life: 0.6, air: 30 },
      { life: 0.75, air: 20 },
      { life: 0.9, air: 10 },
      { life: 0.95, air: 6 },
    ])
    expect(byLifeBand(table, 'air')).toEqual([
      { band: 'Low', n: 2, median: 45 },
      { band: 'Medium', n: 1, median: 30 },
      { band: 'High', n: 1, median: 20 },
      { band: 'Very high', n: 2, median: 8 },
    ])
  })
})

describe('sayFinding', () => {
  it('says which way the environment goes, how strongly, and what wealth leaves of it', () => {
    expect(sayFinding(link(wealthOnly, 'life', 'air'))).toBe(
      'Countries with a better quality of life tend to have cleaner air: a strong link, across 60 countries. With wealth held level, the link disappears: wealth accounts for it.',
    )
    expect(sayFinding(link(beyondWealth, 'life', 'water'))).toMatch(
      /^Countries with a better quality of life tend to have cleaner rivers, lakes and groundwater: a strong link, across 60 countries\. With wealth held level, a strong link remains/,
    )
  })

  it('says plainly when there is no clear link', () => {
    const table = made(Array.from({ length: 30 }, (_, i) => ({ life: 0.3 + i * 0.02, fires: (i * 7) % 5, gdp: i })))
    expect(sayFinding(link(table, 'life', 'fires'))).toMatch(/^There is no clear link between quality of life and fires, across 30 countries\./)
  })

  it('has words for every environmental measure, both ways', () => {
    for (const id of ENVIRONMENT) {
      expect(METRICS[id].good, id).toBeTruthy()
      expect(METRICS[id].bad, id).toBeTruthy()
    }
  })
})

describe('withinWealth', () => {
  it('splits countries into equal groups by wealth, and finds the link inside each', () => {
    const groups = withinWealth(beyondWealth, 'life', 'water')
    expect(groups).toHaveLength(4)
    expect(groups.map((g) => g.n)).toEqual([15, 15, 15, 15])
    for (let i = 1; i < groups.length; i++) expect(groups[i].from).toBeGreaterThanOrEqual(groups[i - 1].to)
    // Water follows quality of life at every level of wealth.
    for (const g of groups) expect(g.r).toBeGreaterThan(0.5)
  })

  it('finds a link wealth alone made mostly gone inside groups of equal wealth', () => {
    const inside = withinWealth(wealthOnly, 'life', 'air')
    expect(Math.max(...inside.map((g) => Math.abs(g.r)))).toBeLessThan(Math.abs(link(wealthOnly, 'life', 'air').r))
  })
})

describe('bandTest', () => {
  it('finds a measure that falls with quality of life differs across the bands', () => {
    expect(bandTest(wealthOnly, 'air').p).toBeLessThan(0.001)
  })
})

describe('the confidence interval on each link', () => {
  it('holds the link inside it', () => {
    const l = link(wealthOnly, 'life', 'air')
    expect(l.ci[0]).toBeLessThan(l.r)
    expect(l.ci[1]).toBeGreaterThan(l.r)
    expect(l.heldLevel!.ci[0]).toBeLessThan(l.heldLevel!.r)
  })
})

describe('FIRM_P', () => {
  it('shares 0.05 across the eight main questions', () => {
    expect(MAIN_TESTS).toBe(8)
    expect(FIRM_P).toBeCloseTo(0.00625)
  })
})
