import { describe, it, expect } from 'vitest'
import { resolutionForZoom, edgePixels, PIN_ZOOM_THRESHOLD, REPORT_PLACE_ZOOM, TARGET_EDGE_PIXELS } from './zoomResolution'
import { STORED_RESOLUTIONS } from './cells'

describe('resolutionForZoom', () => {
  it('uses the biggest hexagons on the globe', () => {
    expect(resolutionForZoom(0)).toBe(1)
    expect(resolutionForZoom(3)).toBe(1)
  })

  it('steps down one size at a time as you zoom in, never skipping one', () => {
    const seen: number[] = []
    for (let zoom = 0; zoom < PIN_ZOOM_THRESHOLD; zoom += 0.25) {
      const resolution = resolutionForZoom(zoom)!
      if (seen[seen.length - 1] !== resolution) seen.push(resolution)
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps a hexagon the same size on screen at the equator at every zoom, give or take one size step', () => {
    // The largest size cannot grow past its own on the far-out globe; from
    // where it first reaches the range, every zoom stays inside it.
    const low = TARGET_EDGE_PIXELS / 1.65
    const high = TARGET_EDGE_PIXELS * 1.65
    const from = Math.log2(low / edgePixels(1, 0))
    for (let zoom = from; zoom < PIN_ZOOM_THRESHOLD; zoom += 0.05) {
      const px = edgePixels(resolutionForZoom(zoom)!, zoom)
      expect(px, `zoom ${zoom.toFixed(2)}`).toBeGreaterThanOrEqual(low - 1e-9)
      expect(px, `zoom ${zoom.toFixed(2)}`).toBeLessThanOrEqual(high)
    }
  })

  it('gives every size the same stretch of zoom, so none is over in a moment', () => {
    const starts: number[] = []
    let last: number | null = null
    for (let zoom = 0; zoom < PIN_ZOOM_THRESHOLD; zoom += 0.01) {
      const resolution = resolutionForZoom(zoom)
      if (resolution !== last) starts.push(zoom)
      last = resolution
    }
    // The widths of sizes 2 to 6: the first starts at the far-out edge and the
    // last ends where dots begin, so those two are open-ended.
    const widths = starts.slice(1).map((start, i) => start - starts[i]).slice(1)
    expect(widths).toHaveLength(5)
    for (const width of widths) expect(width).toBeCloseTo(widths[0], 1)
    expect(widths[0]).toBeGreaterThan(1.3)
    expect(widths[0]).toBeLessThan(1.5)
  })

  it('picks, at every zoom, the size whose edge is nearest the target on screen at the equator', () => {
    for (let zoom = 3.5; zoom < PIN_ZOOM_THRESHOLD; zoom += 0.1) {
      const chosen = resolutionForZoom(zoom)!
      const off = (r: number) => Math.abs(Math.log(edgePixels(r, zoom) / TARGET_EDGE_PIXELS))
      for (let r = 1; r <= 7; r++) expect(off(chosen), `zoom ${zoom.toFixed(1)}, size ${r}`).toBeLessThanOrEqual(off(r) + 1e-9)
    }
  })

  it('only ever asks for a size the database stores', () => {
    for (let zoom = 0; zoom < PIN_ZOOM_THRESHOLD; zoom += 0.25) {
      expect(STORED_RESOLUTIONS).toContain(resolutionForZoom(zoom))
    }
  })

  it('shows dots from city level', () => {
    expect(PIN_ZOOM_THRESHOLD).toBe(12)
    expect(resolutionForZoom(12)).toBeNull()
    expect(resolutionForZoom(20)).toBeNull()
  })

  it('still asks for street level before a report can be placed', () => {
    expect(REPORT_PLACE_ZOOM).toBe(15)
    expect(REPORT_PLACE_ZOOM).toBeGreaterThan(PIN_ZOOM_THRESHOLD)
  })

  it('clamps nonsense zooms to the world band', () => {
    expect(resolutionForZoom(-5)).toBe(1)
  })
})

describe('resolutionForZoom — by zoom alone', () => {
  it('takes nothing but the zoom, so panning north or south never swaps the grid', () => {
    expect(resolutionForZoom.length).toBe(1)
  })
})
