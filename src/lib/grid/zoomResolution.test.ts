import { describe, it, expect } from 'vitest'
import { resolutionForZoom, PIN_ZOOM_THRESHOLD } from './zoomResolution'

describe('resolutionForZoom', () => {
  it('returns r1 at world zoom', () => {
    expect(resolutionForZoom(0)).toBe(1)
    expect(resolutionForZoom(3)).toBe(1)
  })

  it('steps through the resolution bands', () => {
    expect(resolutionForZoom(4)).toBe(3)
    expect(resolutionForZoom(6)).toBe(3)
    expect(resolutionForZoom(7)).toBe(5)
    expect(resolutionForZoom(9)).toBe(5)
    expect(resolutionForZoom(10)).toBe(7)
    expect(resolutionForZoom(12)).toBe(7)
    expect(resolutionForZoom(13)).toBe(9)
    expect(resolutionForZoom(14)).toBe(9)
  })

  it('returns null at pin zoom, meaning render individual reports', () => {
    expect(resolutionForZoom(15)).toBeNull()
    expect(resolutionForZoom(20)).toBeNull()
  })

  it('exposes the reporting threshold as 15', () => {
    expect(PIN_ZOOM_THRESHOLD).toBe(15)
  })

  it('clamps nonsense zooms to the world band', () => {
    expect(resolutionForZoom(-5)).toBe(1)
  })

  it('never skips a zoom level between 0 and 14', () => {
    for (let zoom = 0; zoom < PIN_ZOOM_THRESHOLD; zoom += 1) {
      expect(resolutionForZoom(zoom)).not.toBeNull()
    }
  })

  it('never increases resolution as you zoom out', () => {
    let previous = Infinity
    for (let zoom = 14; zoom >= 0; zoom -= 1) {
      const resolution = resolutionForZoom(zoom)!
      expect(resolution).toBeLessThanOrEqual(previous)
      previous = resolution
    }
  })
})
