import type { Action, Band, JudgeResult } from './types.js'

/**
 * Turn a classifier score into an action.
 *
 * The two thresholds carve the range into three: confident bad, confident good,
 * and a band in the middle that no machine should settle. Only that middle band
 * costs a person any time, which is why both bounds are configurable — a queue
 * that is too noisy is fixed by widening the bands, not by editing code.
 *
 * Anything unreadable — NaN, Infinity, a missing score — escalates. It never
 * approves. An unreviewed photo is exactly the risk this pipeline exists to
 * prevent, so every unknown fails closed.
 */
export function classifyScore(score: number | undefined, band: Band): Action {
  if (score === undefined || !Number.isFinite(score)) return 'escalate'
  if (score > band.rejectAbove) return 'reject'
  if (score < band.approveBelow) return 'approve'
  return 'escalate'
}

/**
 * A band is only usable if it leaves the confident ends unambiguous. An inverted
 * or overlapping band (approveBelow above rejectAbove) would let one score be
 * both, so it is rejected at config time rather than silently preferring one.
 */
export function isUsableBand(band: Band): boolean {
  return (
    Number.isFinite(band.rejectAbove) &&
    Number.isFinite(band.approveBelow) &&
    band.approveBelow >= 0 &&
    band.rejectAbove <= 1 &&
    band.approveBelow < band.rejectAbove
  )
}

/** The worst category wins: one high insult score is enough, however calm the rest. */
export function worstScore(scores: Record<string, number>): number | undefined {
  const values = Object.values(scores).filter((v) => Number.isFinite(v))
  if (values.length === 0) return undefined
  return Math.max(...values)
}

/**
 * Tier 3's verdict, mapped onto an action.
 *
 * "uncertain" is a first-class answer here, not a failure. A judge that admits
 * it does not know is more useful than one forced to guess, because the whole
 * point of tier 4 is to catch exactly those.
 */
export function actionFromJudge(result: JudgeResult): Action {
  switch (result.verdict) {
    case 'safe':
      return 'approve'
    case 'unsafe':
      return 'reject'
    default:
      return 'escalate'
  }
}
