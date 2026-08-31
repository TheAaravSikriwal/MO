import { describe, it, expect } from 'vitest'
import { classifyScore, isUsableBand, worstScore, actionFromJudge } from './decide.js'
import type { Band } from './types.js'

const band: Band = { rejectAbove: 0.85, approveBelow: 0.15 }

describe('classifyScore', () => {
  it('rejects a confidently bad score', () => {
    expect(classifyScore(0.99, band)).toBe('reject')
    expect(classifyScore(0.86, band)).toBe('reject')
  })

  it('approves a confidently good score', () => {
    expect(classifyScore(0.0, band)).toBe('approve')
    expect(classifyScore(0.14, band)).toBe('approve')
  })

  it('sends the uncertain middle to a human', () => {
    expect(classifyScore(0.5, band)).toBe('escalate')
    expect(classifyScore(0.15, band)).toBe('escalate')
    expect(classifyScore(0.85, band)).toBe('escalate')
  })

  it('treats the thresholds themselves as uncertain, not as decisions', () => {
    // Exactly on a boundary is not "confident", so it escalates rather than
    // silently falling to whichever side the comparison happens to pick.
    expect(classifyScore(band.approveBelow, band)).toBe('escalate')
    expect(classifyScore(band.rejectAbove, band)).toBe('escalate')
  })

  it('fails closed on a missing score', () => {
    expect(classifyScore(undefined, band)).toBe('escalate')
  })

  it('fails closed on unreadable numbers', () => {
    expect(classifyScore(Number.NaN, band)).toBe('escalate')
    expect(classifyScore(Number.POSITIVE_INFINITY, band)).toBe('escalate')
    expect(classifyScore(Number.NEGATIVE_INFINITY, band)).toBe('escalate')
  })

  it('never approves anything it cannot read', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(classifyScore(bad as number | undefined, band)).not.toBe('approve')
    }
  })

  it('widening the bands shrinks the human queue', () => {
    const narrow: Band = { rejectAbove: 0.95, approveBelow: 0.05 }
    const wide: Band = { rejectAbove: 0.6, approveBelow: 0.4 }
    expect(classifyScore(0.3, narrow)).toBe('escalate')
    expect(classifyScore(0.3, wide)).toBe('approve')
    expect(classifyScore(0.7, narrow)).toBe('escalate')
    expect(classifyScore(0.7, wide)).toBe('reject')
  })
})

describe('isUsableBand', () => {
  it('accepts a band that leaves both ends unambiguous', () => {
    expect(isUsableBand({ rejectAbove: 0.85, approveBelow: 0.15 })).toBe(true)
  })

  it('rejects an inverted band', () => {
    expect(isUsableBand({ rejectAbove: 0.15, approveBelow: 0.85 })).toBe(false)
  })

  it('rejects a band with no uncertain middle at all', () => {
    expect(isUsableBand({ rejectAbove: 0.5, approveBelow: 0.5 })).toBe(false)
  })

  it('rejects bounds outside 0..1', () => {
    expect(isUsableBand({ rejectAbove: 1.5, approveBelow: 0.1 })).toBe(false)
    expect(isUsableBand({ rejectAbove: 0.9, approveBelow: -0.1 })).toBe(false)
  })

  it('rejects unreadable bounds', () => {
    expect(isUsableBand({ rejectAbove: Number.NaN, approveBelow: 0.1 })).toBe(false)
  })
})

describe('worstScore', () => {
  it('takes the highest category, however calm the others', () => {
    expect(worstScore({ toxicity: 0.1, insult: 0.92, threat: 0.02 })).toBe(0.92)
  })

  it('handles a single category', () => {
    expect(worstScore({ nsfw: 0.4 })).toBe(0.4)
  })

  it('returns undefined for no scores at all, so the caller fails closed', () => {
    expect(worstScore({})).toBeUndefined()
  })

  it('ignores unreadable values rather than letting NaN swallow the max', () => {
    expect(worstScore({ a: Number.NaN, b: 0.7 })).toBe(0.7)
  })

  it('returns undefined when every value is unreadable', () => {
    expect(worstScore({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBeUndefined()
  })
})

describe('actionFromJudge', () => {
  it('approves a safe verdict', () => {
    expect(actionFromJudge({ verdict: 'safe', reason: '' })).toBe('approve')
  })

  it('rejects an unsafe verdict', () => {
    expect(actionFromJudge({ verdict: 'unsafe', reason: '' })).toBe('reject')
  })

  it('sends an uncertain verdict to a human', () => {
    expect(actionFromJudge({ verdict: 'uncertain', reason: '' })).toBe('escalate')
  })

  it('fails closed on a verdict it does not recognise', () => {
    expect(actionFromJudge({ verdict: 'banana' as never, reason: '' })).toBe('escalate')
  })
})
