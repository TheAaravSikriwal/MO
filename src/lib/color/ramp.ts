import { interpolate, formatHex } from 'culori'

/**
 * The ramp anchors.
 *
 * Teal to amber, deliberately not green to red. A red ramp reads as "danger
 * zone", and since pollution reports cluster in the places least able to fix
 * them, that would paint the poorest areas the most alarming colour on the map.
 * Teal to amber reads as "needs attention" instead, which is the honest message.
 *
 * Lightness rises along the ramp as well as hue, so the map stays legible in
 * greyscale and under colour-vision deficiency.
 */
export const RAMP_COLD = '#1f7a6e'
export const RAMP_WARM = '#f2b544'

/**
 * Interpolation happens in OKLCH because it is perceptually uniform. The same
 * two anchors interpolated in sRGB dip through a muddy, darker midpoint, which
 * the eye reads as a band rather than a clean transition.
 */
const ramp = interpolate([RAMP_COLD, RAMP_WARM], 'oklch')

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
