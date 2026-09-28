import { describe, it, expect } from 'vitest'
import {
  csvFields,
  latestByCountry,
  countryFeatures,
  parseFires,
  fireCellFeatures,
  savedDay,
  worldColor,
  valueRange,
  WORLD_LAYERS,
} from './worldData'
import { RAMP_HIGH, RAMP_LOW, RAMP_MEDIUM } from '../color/ramp'

describe('csvFields', () => {
  it('keeps a quoted name with a comma in it as one field', () => {
    expect(csvFields('"Saint Helena, Ascension",SHN,2019,4')).toEqual(['Saint Helena, Ascension', 'SHN', '2019', '4'])
    expect(csvFields('"A ""quoted"" name",X,1,2')).toEqual(['A "quoted" name', 'X', '1', '2'])
  })
})

describe('latestByCountry', () => {
  const csv = [
    'entity,code,year,population_weighted_pm25',
    'India,IND,2018,80.1',
    'India,IND,2019,83.2',
    'Asia,OWID_ASI,2019,40',
    'World,,2019,31',
    'Iceland,ISL,2019,5.2',
    'Nowhere,NWH,2019,',
  ].join('\n')

  it('takes each country’s latest year', () => {
    expect(latestByCountry(csv).get('IND')).toEqual({ name: 'India', value: 83.2, year: 2019 })
  })

  it('leaves out regions, the world and empty figures, which are not places on the map', () => {
    const found = latestByCountry(csv)
    expect([...found.keys()].sort()).toEqual(['IND', 'ISL'])
  })
})

describe('countryFeatures', () => {
  const countries: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: ['IND', 'ISL', 'FRA'].map((iso) => ({
      type: 'Feature',
      properties: { iso, name: iso },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    })),
  }
  const values = new Map([
    ['IND', { name: 'India', value: 83, year: 2019 }],
    ['ISL', { name: 'Iceland', value: 5, year: 2019 }],
  ])

  it('ranks the countries it has figures for, highest at the top', () => {
    const { features } = countryFeatures(countries, values, 'air')
    const t = Object.fromEntries(features.map((f) => [f.properties.iso, f.properties.t]))
    expect(t.IND).toBeGreaterThan(t.ISL)
  })

  it('leaves out a country with no figure rather than drawing it as clean', () => {
    const { features } = countryFeatures(countries, values, 'air')
    expect(features.map((f) => f.properties.iso)).not.toContain('FRA')
  })
})

describe('parseFires', () => {
  it('reads NASA’s columns by name, and skips what it cannot read', () => {
    const csv = [
      'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight',
      '-26.03,-55.49,304.2,1.7,1.2,2026-09-26,0013,T,59,6.1NRT,293.2,13.11,N',
      'bad,row',
      '95,10,1,1,1,d,t,T,1,v,1,1,N',
    ].join('\n')
    expect(parseFires(csv)).toEqual([{ lat: -26.03, lng: -55.49, power: 13.11 }])
  })

  it('gives nothing for a file that is not NASA’s', () => {
    expect(parseFires('<html>error</html>')).toEqual([])
  })
})

describe('fireCellFeatures', () => {
  it('groups fires into areas, the busiest ranked highest', () => {
    const fires = [
      { lat: -10, lng: -60, power: 1 },
      { lat: -10.01, lng: -60.01, power: 1 },
      { lat: 40, lng: 20, power: 1 },
    ]
    const { features } = fireCellFeatures(fires, 2)
    expect(features).toHaveLength(2)
    const busiest = features.find((f) => f.properties.count === 2)!
    const quiet = features.find((f) => f.properties.count === 1)!
    expect(busiest.properties.t).toBeGreaterThan(quiet.properties.t)
  })
})

describe('fireCellFeatures — when they were seen', () => {
  const fires = [{ lat: -10, lng: -60, power: 1 }]
  it('says today for the live file', () => {
    expect(fireCellFeatures(fires, 2).features[0].properties.when).toBe('today')
  })
  it('names the saved copy’s day, never today', () => {
    expect(fireCellFeatures(fires, 2, '2026-09-28').features[0].properties.when).toBe('in the 24 hours to 28 Sep 2026')
  })
})

describe('savedDay', () => {
  it('writes the day the same way in every browser', () => {
    expect(savedDay('2026-09-28')).toBe('28 Sep 2026')
    expect(savedDay('2027-01-05')).toBe('5 Jan 2027')
  })
})

describe('the world layers’ colours', () => {
  it('never use the litter colours, so a country’s air cannot be read as reported litter', () => {
    const litter = [RAMP_LOW, RAMP_MEDIUM, RAMP_HIGH].map((c) => c.toLowerCase())
    for (const layer of Object.values(WORLD_LAYERS)) {
      for (const c of layer.colors) expect(litter).not.toContain(c.toLowerCase())
    }
  })

  it('run from light to dark on each layer’s own scale', () => {
    expect(worldColor('air', 0)).toBe(WORLD_LAYERS.air.colors[0])
    expect(worldColor('air', 1)).toBe(WORLD_LAYERS.air.colors[3])
  })

  it('say plainly what each layer measures, and where it comes from', () => {
    for (const layer of Object.values(WORLD_LAYERS)) {
      expect(layer.measures.length).toBeGreaterThan(10)
      expect(layer.source.length).toBeGreaterThan(3)
    }
  })
})

describe('valueRange', () => {
  it('gives the lowest, middle and highest figure for the legend', () => {
    expect(valueRange([5, 83, 20])).toEqual({ low: 5, middle: 20, high: 83 })
    expect(valueRange([])).toBeNull()
  })
})

describe('latestByCountry, against the real files’ headers', () => {
  // The first line of each file as Our World in Data serves it (checked 2026-09-28).
  it.each([
    ['entity,code,year,population_weighted_pm25', 'air'],
    ['entity,code,year,mismanaged_waste_emitted_to_the_ocean__metric_tons_year_1', 'plastic'],
  ])('reads %s', (header) => {
    expect(latestByCountry(`${header}\nIndia,IND,2019,12.5`).get('IND')).toEqual({ name: 'India', value: 12.5, year: 2019 })
  })

  it('finds the columns by name, so a reordered file still reads right', () => {
    expect(latestByCountry('year,code,entity,pm25\n2019,IND,India,12.5').get('IND')).toEqual({
      name: 'India',
      value: 12.5,
      year: 2019,
    })
  })

  it('reads nothing rather than guess, if a second figure column appears', () => {
    expect(latestByCountry('entity,code,year,pm25,pm10\nIndia,IND,2019,12.5,40').size).toBe(0)
  })

  it('passes over Our World in Data’s region label, which is words, not a figure', () => {
    expect(latestByCountry('entity,code,year,hdi,owid_region\nIndia,IND,2023,0.68,Asia').get('IND')).toEqual({
      name: 'India',
      value: 0.68,
      year: 2023,
    })
  })

  it('reads the column asked for, where a file has several figures', () => {
    expect(latestByCountry('entity,code,year,rivers,all\nIndia,IND,2023,40,55', 'all').get('IND')!.value).toBe(55)
    expect(latestByCountry('entity,code,year,rivers,all\nIndia,IND,2023,40,55', 'lakes').size).toBe(0)
  })
})

describe('the fires layer’s words', () => {
  it('counts hot spots, not fires, since one fire is often seen as several', () => {
    expect(WORLD_LAYERS.fires.unit).toBe('hot spots')
    expect(WORLD_LAYERS.fires.measures).toMatch(/^Hot spots seen from space/)
  })
})

describe('the world layers’ words', () => {
  it('need no dictionary: no bare units, abbreviations or citation shorthand', () => {
    for (const info of Object.values(WORLD_LAYERS)) {
      const shown = [info.label, info.measures, info.unit, info.source].join(' | ')
      expect(shown, info.id).not.toMatch(/µg|m³|et al|FIRMS|MODIS|PM2\.5/)
    }
  })

  it('never promise "today" in the parts shown for a saved copy too', () => {
    expect(WORLD_LAYERS.fires.label).not.toMatch(/today/i)
    expect(WORLD_LAYERS.fires.measures).not.toMatch(/today|last 24 hours/i)
  })
})
