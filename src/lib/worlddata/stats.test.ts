import { describe, it, expect } from 'vitest'
import {
  ranks,
  pearson,
  spearman,
  partialSpearman,
  incompleteBeta,
  pValue,
  strength,
  median,
  confidenceInterval,
  incompleteGamma,
  kruskalWallis,
  describe as spread,
} from './stats'

describe('ranks', () => {
  it('places each value in order, ties sharing the average place', () => {
    expect(ranks([30, 10, 20, 20])).toEqual([4, 1, 2.5, 2.5])
    expect(ranks([5, 5, 5])).toEqual([2, 2, 2])
  })
})

describe('pearson and spearman', () => {
  it('are 1 and -1 for lines up and down', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1)
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1)
  })

  it('rank a curve that always rises as a perfect link, where a straight-line measure does not', () => {
    const x = [1, 2, 3, 4, 5, 6]
    const y = x.map((v) => 10 ** v)
    expect(spearman(x, y)).toBeCloseTo(1)
    expect(pearson(x, y)).toBeLessThan(0.9)
  })

  it('is not a number when one side never changes', () => {
    expect(spearman([1, 2, 3], [4, 4, 4])).toBeNaN()
  })
})

describe('partialSpearman', () => {
  // x and y both follow z, with unrelated wobbles of their own.
  const z = Array.from({ length: 60 }, (_, i) => i + 1)
  const x = z.map((v, i) => v + (((i * 7) % 11) - 5) * 0.8)
  const y = z.map((v, i) => v + (((i * 13) % 17) - 8) * 0.8)

  it('finds almost nothing left between two things that only share a cause', () => {
    expect(spearman(x, y)).toBeGreaterThan(0.9)
    expect(Math.abs(partialSpearman(x, y, z))).toBeLessThan(0.3)
  })

  it('keeps a link that is there beyond the shared cause', () => {
    const w = x.map((v, i) => v * 2 + (((i * 5) % 7) - 3))
    expect(partialSpearman(x, w, z)).toBeGreaterThan(0.5)
  })
})

describe('the chance a link is luck', () => {
  it('gives the textbook incomplete beta values', () => {
    expect(incompleteBeta(1, 1, 0.3)).toBeCloseTo(0.3, 10)
    expect(incompleteBeta(2, 3, 0.5)).toBeCloseTo(0.6875, 10)
  })

  it('gives the textbook p-value for a correlation', () => {
    // r = 0.5 over 20 pairs: t = 2.449 on 18 degrees of freedom, p = 0.0248.
    expect(pValue(0.5, 20)).toBeCloseTo(0.0248, 3)
    expect(pValue(0, 50)).toBeCloseTo(1, 10)
    expect(pValue(0.9, 100)).toBeLessThan(1e-10)
  })

  it('counts a measure held level as one fewer degree of freedom', () => {
    expect(pValue(0.5, 21, 1)).toBeCloseTo(pValue(0.5, 20), 10)
  })

  it('refuses to guess from too few countries', () => {
    expect(pValue(0.9, 2)).toBeNaN()
  })
})

describe('strength', () => {
  it('names the size of a link, and calls one that could be luck no clear link', () => {
    expect(strength(0.7, 0.001)).toBe('strong')
    expect(strength(-0.4, 0.001)).toBe('moderate')
    expect(strength(0.2, 0.01)).toBe('weak')
    expect(strength(0.05, 0.001)).toBe('no clear')
    expect(strength(0.6, 0.2)).toBe('no clear')
  })
})

describe('confidenceInterval', () => {
  it('matches Fisher’s z with the Spearman standard error', () => {
    // r = 0.5, n = 103: se = sqrt(1.06 / 100) = 0.10296; z = 0.54931.
    const [lo, hi] = confidenceInterval(0.5, 103)
    expect(lo).toBeCloseTo(Math.tanh(0.54931 - 1.959964 * 0.10296), 4)
    expect(hi).toBeCloseTo(Math.tanh(0.54931 + 1.959964 * 0.10296), 4)
  })

  it('narrows with more countries, and widens with a measure held level', () => {
    const width = ([lo, hi]: [number, number]) => hi - lo
    expect(width(confidenceInterval(0.4, 200))).toBeLessThan(width(confidenceInterval(0.4, 50)))
    expect(width(confidenceInterval(0.4, 50, 1))).toBeGreaterThan(width(confidenceInterval(0.4, 50)))
  })
})

describe('incompleteGamma', () => {
  it('gives the textbook chi-squared values', () => {
    // Chi-squared with 2 degrees of freedom: P(X ≤ x) = 1 - e^(-x/2).
    expect(incompleteGamma(1, 1.5)).toBeCloseTo(1 - Math.exp(-1.5), 10)
    // 3.841 is the 95th percentile of chi-squared with 1 degree of freedom.
    expect(incompleteGamma(0.5, 3.841459 / 2)).toBeCloseTo(0.95, 5)
    // 7.815 is the 95th percentile with 3.
    expect(incompleteGamma(1.5, 7.814728 / 2)).toBeCloseTo(0.95, 5)
  })
})

describe('kruskalWallis', () => {
  it('gives the textbook H for groups with no ties', () => {
    // Three groups: ranks 1-3, 4-6, 7-9. H = 12/(9·10) · (36+225+576)/3 - 30 = 7.2.
    const { h, df, p } = kruskalWallis([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
    expect(h).toBeCloseTo(7.2, 10)
    expect(df).toBe(2)
    expect(p).toBeCloseTo(Math.exp(-3.6), 6)
  })

  it('corrects for ties, as the textbook does', () => {
    // Ranks 1.5, 1.5, 3.5 | 3.5, 5.5, 5.5: H = 3.0476 before the correction,
    // which divides by 1 - 18/210, giving 3.3333.
    expect(kruskalWallis([[1, 1, 2], [2, 3, 3]]).h).toBeCloseTo(10 / 3, 6)
  })

  it('finds no difference between groups drawn the same way', () => {
    expect(kruskalWallis([[1, 4, 7], [2, 5, 8], [3, 6, 9]]).p).toBeGreaterThan(0.5)
  })
})

describe('describe', () => {
  it('gives the count, extremes, quartiles and median', () => {
    expect(spread([1, 2, 3, 4, 5])).toEqual({ n: 5, min: 1, q1: 2, median: 3, q3: 4, max: 5 })
  })
})

describe('median', () => {
  it('is the middle value, or the middle two averaged', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNaN()
  })
})
