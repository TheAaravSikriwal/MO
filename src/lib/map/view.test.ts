import { describe, it, expect } from 'vitest'
import { viewFromMap, toAppZoom, toLibreZoom, towerHeight, GLOBE_UNTIL, FLAT_FROM } from './view'
import { WHOLE_WORLD } from '../geo/bounds'
import { PIN_ZOOM_THRESHOLD } from '../grid/zoomResolution'

const box = { minLat: 51, minLng: -1, maxLat: 52, maxLng: 1 }

describe('the zoom numbers', () => {
  it('convert both ways, so street level is still street level', () => {
    expect(toLibreZoom(toAppZoom(7.5))).toBe(7.5)
    // Pins still appear at street level, which is flat map, well past the globe.
    expect(toLibreZoom(PIN_ZOOM_THRESHOLD)).toBeGreaterThan(FLAT_FROM)
  })
})

describe('viewFromMap', () => {
  it('asks for the whole world while the globe is showing', () => {
    const view = viewFromMap({ lat: 10, lng: 20, libreZoom: 1.5, bounds: box })
    expect(view.bounds).toEqual(WHOLE_WORLD)
    expect(view.zoom).toBe(toAppZoom(1.5))
  })

  it('asks for just what is on screen once the map is flat', () => {
    const view = viewFromMap({ lat: 51.5, lng: 0, libreZoom: 9, bounds: box })
    expect(view.bounds).toEqual(box)
  })

  it('wraps a centre a whole world east back onto the map', () => {
    const view = viewFromMap({ lat: 51.5, lng: 359.88, libreZoom: 9, bounds: box })
    expect(view.center[1]).toBeCloseTo(-0.12)
  })
})

describe('towerHeight', () => {
  it('stands tallest on the globe and lies flat once the map is flat', () => {
    const expr = towerHeight(1_000_000) as unknown[]
    expect(expr.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']])
    // Stops: zoom 0, the end of the globe, and flat.
    expect(expr[3]).toBe(0)
    expect(expr[5]).toBe(GLOBE_UNTIL)
    expect(expr[7]).toBe(FLAT_FROM)
    expect(expr[8]).toBe(0)
  })
})

describe('the heights of countries and litter', () => {
  it('keeps even the lowest litter tower above the tallest country, so litter always shows', async () => {
    const { COUNTRY_MAX_METRES, LITTER_MAX_METRES, LITTER_FLOOR } = await import('./view')
    expect(LITTER_MAX_METRES * LITTER_FLOOR).toBeGreaterThan(COUNTRY_MAX_METRES)
  })
})
