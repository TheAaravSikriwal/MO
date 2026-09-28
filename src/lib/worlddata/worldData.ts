import { interpolate, formatHex } from 'culori'
import { latLngToCell } from 'h3-js'
import { normaliseWeights } from '../severity/percentile'
import { cellRing } from '../map/features'
import { csvFields, type Fire } from './csv'

export { csvFields, parseFires, slimFires, type Fire } from './csv'

/**
 * Real data about the whole world, for the layers you can put on the globe.
 *
 * Each layer has its own colours, none of them the yellow-to-red of litter
 * reports, so a country's air can never be mistaken for litter somebody
 * reported. Everything here is pure: the fetching is in useWorldData.
 */

export type WorldLayerId = 'air' | 'plastic' | 'fires' | 'life' | 'water'

export interface WorldLayerInfo {
  id: WorldLayerId
  /** On the button. */
  label: string
  /** In a sentence: "Could not load {inSentence} right now." */
  inSentence: string
  /** What the colours and heights mean, in plain words. */
  measures: string
  unit: string
  source: string
  colors: readonly string[]
}

export const WORLD_LAYERS: Record<WorldLayerId, WorldLayerInfo> = {
  air: {
    id: 'air',
    label: 'Air pollution',
    inSentence: 'the air pollution figures',
    measures: 'Fine dust in the air people breathe, yearly average. A microgram is a millionth of a gram',
    // In words: the usual short form needs a dictionary.
    unit: 'micrograms per cubic metre',
    source: 'World Health Organization, via Our World in Data',
    colors: ['#dbeafe', '#818cf8', '#7c3aed', '#3b0764'],
  },
  plastic: {
    id: 'plastic',
    label: 'Plastic into the ocean',
    inSentence: 'the ocean plastic figures',
    measures: 'Plastic each country sends into the sea in a year',
    unit: 'tonnes',
    source: 'a 2021 study by Meijer and others, via Our World in Data',
    colors: ['#cffafe', '#22d3ee', '#0e7490', '#083344'],
  },
  fires: {
    id: 'fires',
    // Not "today": when the live file cannot be reached, the saved copy is
    // shown, and the panel names its day instead.
    label: 'Fires',
    inSentence: 'today’s fires',
    // "Hot spots", not "fires": each is one hot patch of ground a satellite
    // saw, and one fire is often seen as several.
    measures: 'Hot spots seen from space, where fires are burning',
    unit: 'hot spots',
    source: 'NASA satellites',
    colors: ['#fef08a', '#fb923c', '#dc2626', '#450a0a'],
  },
  life: {
    id: 'life',
    label: 'Quality of life',
    inSentence: 'the quality of life figures',
    measures: 'Health, schooling and income together, from 0 to 1. Higher is better',
    unit: 'out of 1',
    source: 'the UN’s Human Development Index, via Our World in Data',
    colors: ['#ecfccb', '#a3e635', '#4d7c0f', '#1a2e05'],
  },
  water: {
    id: 'water',
    label: 'Water quality',
    inSentence: 'the water quality figures',
    measures: 'Share of rivers, lakes and groundwater in good condition when tested. Higher is better',
    unit: 'per cent',
    source: 'UN Environment Programme, via Our World in Data',
    colors: ['#eff6ff', '#60a5fa', '#1d4ed8', '#172554'],
  },
}

/** The country layers: every world layer but fires, which are points. */
export type CountryLayerId = Exclude<WorldLayerId, 'fires'>

/** A colour on a layer's own scale, for a position from 0 to 1. */
export function worldColor(layer: WorldLayerId, t: number): string {
  const scale = interpolate(WORLD_LAYERS[layer].colors as string[], 'oklch')
  return formatHex(scale(Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))))
}

export interface CountryValue {
  name: string
  value: number
  year: number
}

/**
 * The latest figure for each country from an Our World in Data CSV, keyed on
 * its three-letter code. Regions and income groups (codes starting OWID_, or
 * none at all) are left out: they are not places on the map.
 */
export function latestByCountry(csv: string, column?: string): Map<string, CountryValue> {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '')
  const found = new Map<string, CountryValue>()
  if (lines.length === 0) return found
  // Found by name, not position: if Our World in Data adds a column, the
  // figures must not quietly start coming from the wrong one. The figure is
  // the column asked for, or else the one column that is none of the others.
  // Its region label is words, not a figure, and never the one.
  const header = csvFields(lines[0]).map((h) => h.trim().toLowerCase())
  const at = { name: header.indexOf('entity'), code: header.indexOf('code'), year: header.indexOf('year') }
  const others = header
    .map((_, i) => i)
    .filter((i) => i !== at.name && i !== at.code && i !== at.year && header[i] !== 'owid_region')
  const valueAt = column ? header.indexOf(column.toLowerCase()) : others.length === 1 ? others[0] : -1
  if (at.code < 0 || at.year < 0 || valueAt < 0) return found
  for (const line of lines.slice(1)) {
    const fields = csvFields(line)
    const [name, code, yearText, valueText] = [fields[at.name] ?? '', fields[at.code], fields[at.year], fields[valueAt] ?? '']
    if (!code || code.startsWith('OWID_')) continue
    const year = Number(yearText)
    const value = Number(valueText)
    if (!Number.isFinite(year) || valueText === '' || !Number.isFinite(value)) continue
    const existing = found.get(code)
    if (!existing || year > existing.year) found.set(code, { name, value, year })
  }
  return found
}

export interface CountryFeatureProps {
  iso: string
  name: string
  value: number
  year: number
  t: number
  color: string
}

/**
 * Countries coloured and ranked by a value.
 *
 * Ranked rather than scaled by size, like the litter cells: one country with
 * an enormous figure would otherwise flatten every other one into the palest
 * colour, and the map would say nothing about them. The legend gives the real
 * numbers. A country with no figure is left out rather than drawn as zero.
 */
export function countryFeatures(
  countries: GeoJSON.FeatureCollection,
  values: Map<string, CountryValue>,
  layer: WorldLayerId,
): GeoJSON.FeatureCollection<GeoJSON.Geometry, CountryFeatureProps> {
  const present = countries.features.filter((f) => values.has(String(f.properties?.iso)))
  const ranked = normaliseWeights(
    present.map((f) => ({ cell: String(f.properties?.iso), weight: values.get(String(f.properties?.iso))!.value, reportCount: 1 })),
  )
  const tByIso = new Map(ranked.map((r) => [r.cell, r.t]))
  return {
    type: 'FeatureCollection',
    features: present.map((f) => {
      const iso = String(f.properties?.iso)
      const v = values.get(iso)!
      const t = tByIso.get(iso) ?? 0
      return {
        type: 'Feature',
        properties: { iso, name: String(f.properties?.name ?? v.name), value: v.value, year: v.year, t, color: worldColor(layer, t) },
        geometry: f.geometry,
      }
    }),
  }
}

export interface FireCellProps {
  cell: string
  count: number
  t: number
  color: string
  /** When these were seen, for the words on hover: "today", or the saved copy's day. */
  when: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A saved copy's day, as people write it: "28 Sep 2026". Spelled out here:
 * the browser's own short months vary ("Sep", "Sept").
 */
export function savedDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}`
}

/**
 * Fires grouped into hexagons, one tower per area, taller where more burned.
 * Drawn at the same hexagon size as the litter at the same zoom, so the two
 * share one grid.
 */
export function fireCellFeatures(
  fires: readonly Fire[],
  resolution: number,
  savedOn: string | null = null,
): GeoJSON.FeatureCollection<GeoJSON.Polygon, FireCellProps> {
  const when = savedOn ? `in the 24 hours to ${savedDay(savedOn)}` : 'today'
  const counts = new Map<string, number>()
  for (const fire of fires) {
    const cell = latLngToCell(fire.lat, fire.lng, resolution)
    counts.set(cell, (counts.get(cell) ?? 0) + 1)
  }
  const ranked = normaliseWeights([...counts].map(([cell, count]) => ({ cell, weight: count, reportCount: count })))
  return {
    type: 'FeatureCollection',
    features: ranked.map((r) => ({
      type: 'Feature',
      properties: { cell: r.cell, count: r.reportCount, t: r.t, color: worldColor('fires', 0.2 + 0.8 * r.t), when },
      geometry: { type: 'Polygon', coordinates: [cellRing(r.cell)] },
    })),
  }
}

/** The lowest, middle and highest figures, for the legend. */
export function valueRange(values: readonly number[]): { low: number; middle: number; high: number } | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return { low: sorted[0], middle: sorted[Math.floor(sorted.length / 2)], high: sorted[sorted.length - 1] }
}
