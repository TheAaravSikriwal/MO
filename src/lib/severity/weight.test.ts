import { describe, it, expect } from 'vitest'
import { weighCells } from './weight'
import type { WeighableReport } from '../../types/report'

const report = (over: Partial<WeighableReport> & { id: string }): WeighableReport => ({
  status: 'open',
  moderationStatus: 'approved',
  voteCount: 0,
  cells: { cell_r7: 'A' },
  ...over,
})

describe('weighCells', () => {
  it('weighs a lone unvoted report as 1', () => {
    expect(weighCells([report({ id: '1' })], 7)).toEqual([
      { cell: 'A', weight: 1, reportCount: 1 },
    ])
  })

  it('adds one per vote, so five votes make a report weigh 6', () => {
    expect(weighCells([report({ id: '1', voteCount: 5 })], 7)[0].weight).toBe(6)
  })

  it('sums every report in the same cell', () => {
    expect(
      weighCells([report({ id: '1', voteCount: 2 }), report({ id: '2', voteCount: 0 })], 7),
    ).toEqual([{ cell: 'A', weight: 4, reportCount: 2 }])
  })

  it('excludes cleaned reports, so cleaning cools the map', () => {
    expect(
      weighCells(
        [report({ id: '1', voteCount: 9, status: 'cleaned' }), report({ id: '2' })],
        7,
      ),
    ).toEqual([{ cell: 'A', weight: 1, reportCount: 1 }])
  })

  it('drops a cell entirely once its only report is cleaned', () => {
    expect(weighCells([report({ id: '1', status: 'cleaned' })], 7)).toEqual([])
  })

  it('excludes reports that are not approved', () => {
    expect(
      weighCells(
        [
          report({ id: '1', moderationStatus: 'pending' }),
          report({ id: '2', moderationStatus: 'rejected' }),
        ],
        7,
      ),
    ).toEqual([])
  })

  it('groups by the requested resolution', () => {
    expect(
      weighCells(
        [
          report({ id: '1', cells: { cell_r5: 'COARSE', cell_r7: 'A' } }),
          report({ id: '2', cells: { cell_r5: 'COARSE', cell_r7: 'B' } }),
        ],
        5,
      ),
    ).toEqual([{ cell: 'COARSE', weight: 2, reportCount: 2 }])
  })

  it('keeps separate cells separate at a fine resolution', () => {
    const cells = weighCells(
      [
        report({ id: '1', cells: { cell_r5: 'COARSE', cell_r7: 'A' } }),
        report({ id: '2', cells: { cell_r5: 'COARSE', cell_r7: 'B' } }),
      ],
      7,
    )
    expect(cells).toHaveLength(2)
    expect(cells.map((c) => c.cell).sort()).toEqual(['A', 'B'])
  })

  it('skips reports missing a cell at that resolution', () => {
    expect(weighCells([report({ id: '1', cells: { cell_r7: 'A' } })], 3)).toEqual([])
  })

  it('treats a negative vote count as zero rather than subtracting weight', () => {
    expect(weighCells([report({ id: '1', voteCount: -10 })], 7)[0].weight).toBe(1)
  })

  it('treats an empty input as an empty map', () => {
    expect(weighCells([], 7)).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = [report({ id: '1', voteCount: 3 })]
    const snapshot = JSON.parse(JSON.stringify(input))
    weighCells(input, 7)
    expect(input).toEqual(snapshot)
  })
})
