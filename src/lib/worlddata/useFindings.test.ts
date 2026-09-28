import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { loadFindings, useFindings, forgetFindings } from './useFindings'
import { forgetWorldData } from './useWorldData'
import {
  AIR_POLLUTION_CSV,
  COUNTRIES_URL,
  FIRES_ENDPOINT,
  GDP_PER_PERSON_CSV,
  PLASTIC_PER_PERSON_CSV,
  QUALITY_OF_LIFE_CSV,
  SAVED_COPIES,
  WATER_QUALITY_CSV,
} from './sources'

// Twenty-five made-up countries, each a square on the map, so fires can be
// placed in one on purpose.
const codes = Array.from({ length: 25 }, (_, i) => `C${String.fromCharCode(65 + i)}A`)
const square = (i: number) => {
  const x = -100 + i * 5
  return [[[x, 0], [x + 4, 0], [x + 4, 4], [x, 4], [x, 0]]]
}
const COUNTRIES = JSON.stringify({
  type: 'FeatureCollection',
  features: codes.map((iso, i) => ({ type: 'Feature', properties: { iso, name: iso }, geometry: { type: 'Polygon', coordinates: square(i) } })),
})
const csv = (column: string, value: (i: number) => number) =>
  [`entity,code,year,${column},owid_region`, ...codes.map((iso, i) => `${iso},${iso},2023,${value(i)},Somewhere`)].join('\n')

const LIVE: Record<string, string> = {
  [QUALITY_OF_LIFE_CSV]: csv('hdi__sex_total', (i) => 0.4 + i * 0.02),
  [GDP_PER_PERSON_CSV]: csv('ny_gdp_pcap_pp_kd', (i) => 1000 + i * 2000),
  [AIR_POLLUTION_CSV]: csv('population_weighted_pm25', (i) => 60 - i * 2),
  [PLASTIC_PER_PERSON_CSV]: csv('mismanaged_plastic_waste_per_capita__kg_per_year', (i) => 20 - i * 0.5),
  // Like the real file: one figure per kind of water, the one wanted among them.
  [WATER_QUALITY_CSV]: csv('_6_3_2__en_h2o_wbambq', (i) => 40 + i * 2).replace(/owid_region/, 'owid_region,_6_3_2__en_h2o_rvambq').replace(/Somewhere/g, 'Somewhere,99'),
  [COUNTRIES_URL]: COUNTRIES,
  // Three fires in the first country, none elsewhere.
  [FIRES_ENDPOINT]: ['latitude,longitude,frp', '1,-99,5', '2,-98,5', '3,-97,5'].join('\n'),
}

const files = (over: Record<string, string | Error> = {}) =>
  vi.fn(async (url: string) => {
    const table: Record<string, string | Error> = { ...LIVE, ...over }
    const found = table[url]
    if (found instanceof Error || found === undefined) throw found ?? new Error(`unexpected ${url}`)
    return found
  })

beforeEach(() => {
  forgetFindings()
  forgetWorldData()
})

describe('loadFindings', () => {
  it('joins every figure country by country, by the named column, past the region label', async () => {
    const { table, fromSaved } = await loadFindings(files())
    expect(fromSaved).toEqual([])
    expect(table.get('CAA')).toMatchObject({ life: 0.4, gdp: 1000, air: 60, plasticPerPerson: 20, water: 40 })
  })

  it('counts fires per 10,000 km² of each country, 0 where none fell', async () => {
    const { table } = await loadFindings(files())
    expect(table.get('CAA')!.fires).toBeGreaterThan(0)
    expect(table.get('CBA')!.fires).toBe(0)
  })

  it('uses the saved copy of a figure whose live file cannot be reached, and says which', async () => {
    const get = files({ [WATER_QUALITY_CSV]: new Error('offline'), [SAVED_COPIES.water]: LIVE[WATER_QUALITY_CSV] })
    const { table, fromSaved } = await loadFindings(get)
    expect(fromSaved).toEqual(['water'])
    expect(table.get('CAA')!.water).toBe(40)
  })

  it('fails when a figure can be had neither live nor saved', async () => {
    await expect(loadFindings(files({ [WATER_QUALITY_CSV]: new Error('offline') }))).rejects.toThrow()
  })
})

describe('useFindings', () => {
  it('loads nothing until opened', () => {
    const get = files()
    const { result } = renderHook(() => useFindings(false, get))
    expect(result.current.status).toBe('idle')
    expect(get).not.toHaveBeenCalled()
  })

  it('loads once opened, and asks again from "Try again" after a failure', async () => {
    let online = false
    const get = vi.fn(async (url: string) => {
      if (!online) throw new Error('offline')
      return files()(url)
    })
    const { result } = renderHook(() => useFindings(true, get))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    online = true
    forgetWorldData()
    act(() => (result.current as { retry: () => void }).retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})
