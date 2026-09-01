import type { ReportStatus, WeighableReport, WeightedCell } from '../../types/report'

/**
 * Aggregate reports into weighted cells at one resolution.
 *
 *   weight = sum over contributing reports of (1 + voteCount)
 *
 * Severity is derived from how many people have flagged an area, never chosen by
 * whoever happened to report it first.
 *
 * A report contributes only while it is open and approved. Cleaned reports drop
 * out entirely, which is what makes a cleanup visibly cool the map — the payoff
 * the whole product is built around.
 */
export interface WeighOptions {
  /**
   * Which statuses contribute.
   *
   * Defaults to open only, which is what makes a cleanup visibly cool the map.
   * The exception is when somebody has explicitly asked to SEE cleaned spots:
   * weighing only open reports then leaves every cell empty and the map blank,
   * which reads as "nothing was ever cleaned here" rather than as the answer to
   * the question they asked.
   */
  statuses?: readonly ReportStatus[]
}

export function weighCells(
  reports: readonly WeighableReport[],
  resolution: number,
  options: WeighOptions = {},
): WeightedCell[] {
  const statuses = options.statuses ?? (['open'] as const)
  const column = `cell_r${resolution}`
  const byCell = new Map<string, WeightedCell>()

  for (const report of reports) {
    if (!statuses.includes(report.status)) continue
    if (report.moderationStatus !== 'approved') continue

    const cell = report.cells[column]
    if (!cell) continue

    const contribution = 1 + Math.max(0, report.voteCount)
    const existing = byCell.get(cell)

    if (existing) {
      existing.weight += contribution
      existing.reportCount += 1
    } else {
      byCell.set(cell, { cell, weight: contribution, reportCount: 1 })
    }
  }

  return [...byCell.values()]
}
