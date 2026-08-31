import { interpolate, formatHex } from 'culori'

/**
 * The severity ramp: clean white, building through yellow and orange to red.
 *
 * White is the resting state — an area with nothing reported reads as clean, and
 * the map only gains colour as people flag it. Red is reserved for the very top
 * of the scale, so it takes real, repeated confirmation from multiple people to
 * get there.
 */
export const RAMP_CLEAN = '#ffffff'
export const RAMP_LOW = '#ffd54a'
export const RAMP_MEDIUM = '#f2801d'
export const RAMP_HIGH = '#cc2b2b'

export const RAMP_STOPS = [RAMP_CLEAN, RAMP_LOW, RAMP_MEDIUM, RAMP_HIGH] as const

/**
 * Interpolation happens in OKLCH because it is perceptually uniform. The same
 * stops interpolated in sRGB dip through muddy midpoints, which the eye reads as
 * banding rather than a clean transition.
 *
 * Four stops rather than two keeps the build gradual: the first third of the
 * range stays white through pale yellow before any orange appears.
 */
const ramp = interpolate(RAMP_STOPS as unknown as string[], 'oklch')

/**
 * Colour for a normalised position on the ramp.
 *
 * Returns a hex string rather than an `oklch()` function so the value drops
 * straight into Leaflet's SVG path options without depending on browser support
 * for modern colour syntax. Input is clamped to 0..1.
 */
export function colorForT(t: number): string {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  return formatHex(ramp(clamped))
}
