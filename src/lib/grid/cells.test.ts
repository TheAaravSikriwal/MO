import { describe, it, expect } from 'vitest'
import { getResolution, cellToParent } from 'h3-js'
import { STORED_RESOLUTIONS, FINEST_RESOLUTION, cellsForPoint, cellBoundary } from './cells'

const LONDON = { lat: 51.5007, lng: -0.1246 }
const SYDNEY = { lat: -33.8568, lng: 151.2153 }

describe('cellsForPoint', () => {
  it('stores exactly the six documented resolutions', () => {
    expect(STORED_RESOLUTIONS).toEqual([1, 3, 5, 7, 9, 12])
    expect(FINEST_RESOLUTION).toBe(12)
  })

  it('returns one cell per stored resolution, each at that resolution', () => {
    const cells = cellsForPoint(LONDON.lat, LONDON.lng)
    expect(Object.keys(cells).sort()).toEqual([
      'cell_r1',
      'cell_r12',
      'cell_r3',
      'cell_r5',
      'cell_r7',
      'cell_r9',
    ])
    for (const resolution of STORED_RESOLUTIONS) {
      expect(getResolution(cells[`cell_r${resolution}`])).toBe(resolution)
    }
  })

  it('is deterministic for the same point', () => {
    expect(cellsForPoint(LONDON.lat, LONDON.lng)).toEqual(cellsForPoint(LONDON.lat, LONDON.lng))
  })

  it('gives different cells to points far apart', () => {
    const london = cellsForPoint(LONDON.lat, LONDON.lng)
    const sydney = cellsForPoint(SYDNEY.lat, SYDNEY.lng)
    expect(london.cell_r12).not.toBe(sydney.cell_r12)
    expect(london.cell_r1).not.toBe(sydney.cell_r1)
  })

  it('nests: every coarse cell is a genuine ancestor of the fine cell', () => {
    // This is the property the whole GROUP BY rollup strategy depends on.
    const cells = cellsForPoint(40.7128, -74.006)
    for (const resolution of STORED_RESOLUTIONS) {
      if (resolution === FINEST_RESOLUTION) continue
      expect(cells[`cell_r${resolution}`]).toBe(cellToParent(cells.cell_r12, resolution))
    }
  })

  it('nests for points all over the world, not just one', () => {
    const points = [
      [0, 0],
      [89.9, 179.9],
      [-89.9, -179.9],
      [SYDNEY.lat, SYDNEY.lng],
      [LONDON.lat, LONDON.lng],
    ] as const
    for (const [lat, lng] of points) {
      const cells = cellsForPoint(lat, lng)
      expect(cells.cell_r1).toBe(cellToParent(cells.cell_r12, 1))
      expect(cells.cell_r9).toBe(cellToParent(cells.cell_r12, 9))
    }
  })

  it('groups nearby points into the same coarse cell but keeps fine detail apart', () => {
    const a = cellsForPoint(LONDON.lat, LONDON.lng)
    const b = cellsForPoint(LONDON.lat + 0.01, LONDON.lng + 0.01)
    expect(a.cell_r5).toBe(b.cell_r5)
    expect(a.cell_r12).not.toBe(b.cell_r12)
  })

  it('rejects out-of-range coordinates', () => {
    expect(() => cellsForPoint(91, 0)).toThrow(RangeError)
    expect(() => cellsForPoint(-91, 0)).toThrow(RangeError)
    expect(() => cellsForPoint(0, 181)).toThrow(RangeError)
    expect(() => cellsForPoint(0, -181)).toThrow(RangeError)
    expect(() => cellsForPoint(Number.NaN, 0)).toThrow(RangeError)
  })
})

describe('cellBoundary', () => {
  it('returns a ring of valid lat/lng pairs', () => {
    const { cell_r7 } = cellsForPoint(LONDON.lat, LONDON.lng)
    const ring = cellBoundary(cell_r7)
    expect(ring.length).toBeGreaterThanOrEqual(6)
    for (const [lat, lng] of ring) {
      expect(lat).toBeGreaterThanOrEqual(-90)
      expect(lat).toBeLessThanOrEqual(90)
      expect(lng).toBeGreaterThanOrEqual(-180)
      expect(lng).toBeLessThanOrEqual(180)
    }
  })
})
