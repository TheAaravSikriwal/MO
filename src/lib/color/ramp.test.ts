import { describe, it, expect } from 'vitest'
import { oklch } from 'culori'
import { colorForT, RAMP_CLEAN, RAMP_HIGH, RAMP_STOPS } from './ramp'

const toOklch = (css: string) => {
  const converted = oklch(css)
  if (!converted) throw new Error(`not a parseable colour: ${css}`)
  return converted
}

const lightnessOf = (css: string) => toOklch(css).l
const chromaOf = (css: string) => toOklch(css).c
const hueOf = (css: string) => toOklch(css).h ?? 0

const samples = (step: number) => {
  const out: number[] = []
  for (let t = 0; t <= 1.0000001; t += step) out.push(Math.min(1, t))
  return out
}

describe('colorForT', () => {
  it('starts clean white and ends red', () => {
    expect(colorForT(0)).toBe(RAMP_CLEAN)
    expect(colorForT(1)).toBe(RAMP_HIGH)
  })

  it('builds through yellow and orange on the way', () => {
    expect(RAMP_STOPS).toHaveLength(4)
    // Yellow sits near hue 90 in OKLCH, orange near 50-70, red near 25.
    expect(hueOf(colorForT(0.25))).toBeGreaterThan(80)
    expect(hueOf(colorForT(0.65))).toBeLessThan(80)
    expect(hueOf(colorForT(0.65))).toBeGreaterThan(40)
    expect(hueOf(colorForT(1))).toBeLessThan(40)
  })

  it('returns a parseable hex colour across the whole range', () => {
    for (const t of samples(0.05)) {
      expect(colorForT(t)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('darkens monotonically, so the ramp survives greyscale', () => {
    let previous = Infinity
    for (const t of samples(0.1)) {
      const l = lightnessOf(colorForT(t))
      expect(l).toBeLessThan(previous)
      previous = l
    }
  })

  it('gains colour monotonically, so a clean area stays visibly clean', () => {
    let previous = -Infinity
    for (const t of samples(0.1)) {
      const c = chromaOf(colorForT(t))
      expect(c).toBeGreaterThan(previous)
      previous = c
    }
  })

  it('starts with no colour at all at the clean end', () => {
    expect(chromaOf(colorForT(0))).toBeCloseTo(0, 3)
  })

  it('builds slowly: the first third of the range stays pale', () => {
    for (const t of [0, 0.1, 0.2, 0.3]) {
      expect(lightnessOf(colorForT(t))).toBeGreaterThan(0.85)
    }
  })

  it('moves in steps small enough to read as a smooth gradient', () => {
    for (let t = 0; t < 1; t += 0.05) {
      const delta = Math.abs(lightnessOf(colorForT(t + 0.05)) - lightnessOf(colorForT(t)))
      expect(delta).toBeLessThan(0.05)
    }
  })

  it('never jumps hue abruptly between adjacent samples', () => {
    let previous: number | null = null
    for (const t of samples(0.05)) {
      const h = hueOf(colorForT(t))
      if (previous !== null && t > 0.1) {
        expect(Math.abs(h - previous)).toBeLessThan(20)
      }
      previous = h
    }
  })

  it('clamps out-of-range input rather than producing garbage', () => {
    expect(colorForT(-1)).toBe(RAMP_CLEAN)
    expect(colorForT(2)).toBe(RAMP_HIGH)
  })

  it('falls back to the clean end for a non-finite input', () => {
    expect(colorForT(Number.NaN)).toBe(RAMP_CLEAN)
  })

  it('is deterministic', () => {
    expect(colorForT(0.37)).toBe(colorForT(0.37))
  })
})
