import { describe, it, expect } from 'vitest'
import air from '../../../public/data/air-saved.csv?raw'
import plastic from '../../../public/data/plastic-saved.csv?raw'
import fires from '../../../public/data/fires-saved.csv?raw'
import life from '../../../public/data/life-saved.csv?raw'
import water from '../../../public/data/water-saved.csv?raw'
import gdp from '../../../public/data/gdp-saved.csv?raw'
import plasticPerPerson from '../../../public/data/plastic-per-person-saved.csv?raw'
import { latestByCountry, parseFires } from './worldData'
import { COUNTRY_COLUMNS, SAVED_COPIES, SAVED_ON } from './sources'

/** The copies saved with the app, used when the live files cannot be reached. */

describe('the saved copies', () => {
  it('can be read by the same code, by the same column, as the live files', () => {
    const copies = { air, plastic, life, water, gdp, plasticPerPerson }
    for (const [id, text] of Object.entries(copies) as Array<[keyof typeof copies, string]>) {
      expect(latestByCountry(text, COUNTRY_COLUMNS[id]).size, id).toBeGreaterThan(100)
    }
    expect(parseFires(fires).length).toBeGreaterThan(1000)
  })

  it('hold figures in the range each measure can take', () => {
    for (const { value } of latestByCountry(life, COUNTRY_COLUMNS.life).values()) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    for (const { value } of latestByCountry(water, COUNTRY_COLUMNS.water).values()) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
  })

  it('are where the app asks for them', () => {
    expect(SAVED_COPIES).toEqual({
      air: '/data/air-saved.csv',
      plastic: '/data/plastic-saved.csv',
      fires: '/data/fires-saved.csv',
      life: '/data/life-saved.csv',
      water: '/data/water-saved.csv',
      gdp: '/data/gdp-saved.csv',
      plasticPerPerson: '/data/plastic-per-person-saved.csv',
    })
  })

  it('carry a real date', () => {
    expect(SAVED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isNaN(new Date(SAVED_ON).getTime())).toBe(false)
  })
})
