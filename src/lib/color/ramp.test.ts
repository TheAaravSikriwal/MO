import { describe, it, expect } from 'vitest'
import { oklch } from 'culori'
import { colorForT, RAMP_COLD, RAMP_WARM } from './ramp'

const toOklch = (css: string) => {
  const converted = oklch(css)
  if (!converted) throw new Error(`not a parseable colour: ${css}`)
  return converted
}

const lightnessOf = (css: string) => toOklch(css).l
const hueOf = (css: string) => toOklch(css).h ?? 0

const samples = (step: number) => {
  const out: number[] = []
  for (let t = 0; t <= 1.0000001; t += step) out.push(Math.min(1, t))
  return out
}

describe('colorForT', () => {
  it('lands on the cold anchor at 0 and the warm anchor at 1', () => {
    expect(colorForT(0)).toBe(RAMP_COLD)
    expect(colorForT(1)).toBe(RAMP_WARM)
  })

  it('returns a parseable hex colour across the whole range', () => {
    for (const t of samples(0.05)) {
      expect(colorForT(t)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('increases lightness monotonically, so the ramp survives greyscale', () => {
    let previous = -Infinity
    for (const t of samples(0.1)) {
      const l = lightnessOf(colorForT(t))
      expect(l).toBeGreaterThan(previous)
      previous = l
    }
  })

  it('never passes through a red hue, per the tone rule', () => {
    // Red sits near hue 20-30 in OKLCH. A teal-to-amber ramp must stay clear of it.
    for (const t of samples(0.02)) {
      expect(hueOf(colorForT(t))).toBeGreaterThan(40)
    }
  })

  it('moves in steps small enough to read as a smooth gradient', () => {
    for (let t = 0; t < 1; t += 0.05) {
      const delta = Math.abs(lightnessOf(colorForT(t + 0.05)) - lightnessOf(colorForT(t)))
      expect(delta).toBeLessThan(0.05)
    }
  })

  it('produces a visibly different colour at each end', () => {
    expect(colorForT(0)).not.toBe(colorForT(1))
    expect(Math.abs(lightnessOf(colorForT(1)) - lightnessOf(colorForT(0)))).toBeGreaterThan(0.15)
  })

  it('clamps out-of-range input rather than producing garbage', () => {
    expect(colorForT(-1)).toBe(RAMP_COLD)
    expect(colorForT(2)).toBe(RAMP_WARM)
  })

  it('falls back to the cold anchor for a non-finite input', () => {
    expect(colorForT(Number.NaN)).toBe(RAMP_COLD)
  })

  it('is deterministic', () => {
    expect(colorForT(0.37)).toBe(colorForT(0.37))
  })
})
