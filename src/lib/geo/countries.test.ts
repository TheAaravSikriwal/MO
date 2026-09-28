import { describe, it, expect } from 'vitest'
import countriesText from '../../../public/data/countries.geojson?raw'
import { countryShapes, countryAt, perArea } from './countries'

const shapes = countryShapes(JSON.parse(countriesText) as GeoJSON.FeatureCollection)

describe('countryAt', () => {
  it('finds the country a point is in', () => {
    expect(countryAt(48.86, 2.35, shapes)).toBe('FRA')
    expect(countryAt(-33.87, 151.21, shapes)).toBe('AUS')
    expect(countryAt(40.71, -74.0, shapes)).toBe('USA')
  })

  it('says none out at sea', () => {
    expect(countryAt(0, -30, shapes)).toBeNull()
  })
})

describe('the size of a country', () => {
  it('is close to its real area', () => {
    // Real areas: France about 550,000 km² (mainland and Corsica), Brazil 8.5 million.
    const area = (iso: string) => shapes.find((s) => s.iso === iso)!.areaKm2
    expect(area('BRA') / 8_515_000).toBeGreaterThan(0.95)
    expect(area('BRA') / 8_515_000).toBeLessThan(1.05)
    expect(area('FRA')).toBeGreaterThan(500_000)
  })
})

describe('perArea', () => {
  it('counts points per 10,000 km², and gives every country a figure, 0 where none fell', () => {
    const paris = { lat: 48.86, lng: 2.35 }
    const found = perArea([paris, paris, { lat: 0, lng: -30 }], shapes)
    const france = shapes.find((s) => s.iso === 'FRA')!.areaKm2
    expect(found.get('FRA')).toBeCloseTo((2 / france) * 10_000)
    expect(found.get('DEU')).toBe(0)
  })
})
