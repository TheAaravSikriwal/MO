import type { WeightedCell } from '../../types/report'

export interface NormalisedCell extends WeightedCell {
  /** Position on the colour ramp, 0 = coldest, 1 = warmest. */
  t: number
}

/**
 * Rank cells against each other and map them onto 0..1.
 *
 * Ranking by position among *distinct* weights rather than by raw magnitude is
 * deliberate: it means a single extreme cell cannot crush every other cell into
 * the cold end, so a quiet area still shows its own internal variation and the
 * map stays informative at every scale.
 *
 * When every cell weighs the same there is no variation to show, so they all sit
 * mid-ramp — neither alarming nor invisible.
 */
export function normaliseWeights(cells: readonly WeightedCell[]): NormalisedCell[] {
  if (cells.length === 0) return []

  const distinct = [...new Set(cells.map((c) => c.weight))].sort((a, b) => a - b)

  if (distinct.length === 1) {
    return cells.map((c) => ({ ...c, t: 0.5 }))
  }

  const rankOf = new Map(
    distinct.map((weight, index) => [weight, index / (distinct.length - 1)]),
  )
  return cells.map((c) => ({ ...c, t: rankOf.get(c.weight)! }))
}
