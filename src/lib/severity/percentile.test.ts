import { describe, it, expect } from 'vitest'
import { normaliseWeights } from './percentile'

const cell = (cellId: string, weight: number) => ({ cell: cellId, weight, reportCount: 1 })
const tFor = (result: ReturnType<typeof normaliseWeights>, id: string) =>
  result.find((r) => r.cell === id)!.t

describe('normaliseWeights', () => {
  it('spreads distinct weights across the full 0..1 range', () => {
    const result = normaliseWeights([cell('a', 1), cell('b', 5), cell('c', 100)])
    expect(tFor(result, 'a')).toBe(0)
    expect(tFor(result, 'b')).toBe(0.5)
    expect(tFor(result, 'c')).toBe(1)
  })

  it('ranks by order, not magnitude, so one outlier cannot flatten the rest', () => {
    const result = normaliseWeights([cell('a', 1), cell('b', 2), cell('c', 100000)])
    expect(tFor(result, 'b')).toBe(0.5)
  })

  it('gives tied weights the same t', () => {
    const result = normaliseWeights([cell('a', 7), cell('b', 7), cell('c', 9)])
    expect(tFor(result, 'a')).toBe(0)
    expect(tFor(result, 'b')).toBe(0)
    expect(tFor(result, 'c')).toBe(1)
  })

  it('places a single cell mid-ramp rather than at either extreme', () => {
    expect(normaliseWeights([cell('a', 3)])).toEqual([
      { cell: 'a', weight: 3, reportCount: 1, t: 0.5 },
    ])
  })

  it('places uniformly weighted cells mid-ramp', () => {
    const result = normaliseWeights([cell('a', 4), cell('b', 4), cell('c', 4)])
    expect(result.every((r) => r.t === 0.5)).toBe(true)
  })

  it('always produces t within 0..1', () => {
    const result = normaliseWeights([cell('a', 1), cell('b', 3), cell('c', 8), cell('d', 90)])
    for (const r of result) {
      expect(r.t).toBeGreaterThanOrEqual(0)
      expect(r.t).toBeLessThanOrEqual(1)
    }
  })

  it('orders t consistently with weight', () => {
    const result = normaliseWeights([cell('a', 50), cell('b', 2), cell('c', 11)])
    expect(tFor(result, 'b')).toBeLessThan(tFor(result, 'c'))
    expect(tFor(result, 'c')).toBeLessThan(tFor(result, 'a'))
  })

  it('handles an empty input', () => {
    expect(normaliseWeights([])).toEqual([])
  })

  it('preserves the input order', () => {
    const result = normaliseWeights([cell('z', 9), cell('y', 1)])
    expect(result.map((r) => r.cell)).toEqual(['z', 'y'])
  })

  it('carries weight and reportCount through untouched', () => {
    const result = normaliseWeights([{ cell: 'a', weight: 12, reportCount: 4 }])
    expect(result[0].weight).toBe(12)
    expect(result[0].reportCount).toBe(4)
  })

  it('does not mutate its input', () => {
    const input = [cell('a', 1), cell('b', 2)]
    const snapshot = JSON.parse(JSON.stringify(input))
    normaliseWeights(input)
    expect(input).toEqual(snapshot)
  })
})
