import { betterTogether, link, FIRM_P, type CountryTable } from './findings'
import { median } from './stats'
import type { Findings } from './useFindings'
import { savedDay } from './worldData'

/**
 * The introduction's highlights: where the planet stands, in a few big
 * figures, what is behind each, and where it comes from. Worked out from the
 * same data as the Findings tab, so a figure here is always one that can be
 * checked there.
 *
 * Plain words, and about the litter, the air and the water, never about the
 * places or people in them: no country is named.
 */

/** The World Health Organization's guideline for yearly fine dust, micrograms per cubic metre (2021). */
export const WHO_PM25_GUIDELINE = 5

export interface Highlight {
  id: 'air' | 'plastic' | 'fires' | 'water' | 'link'
  /** The big figure or phrase. */
  big: string
  /** What it means, in one sentence. */
  line: string
  /** What is behind it. */
  cause: string
  /** Where it comes from. */
  source: string
}

const round = (n: number) => Math.round(n).toLocaleString('en-GB')

function air(table: CountryTable): Highlight | null {
  const values = [...table.values()].map((r) => r.air).filter((v): v is number => Number.isFinite(v))
  if (values.length === 0) return null
  const above = values.filter((v) => v > WHO_PM25_GUIDELINE).length
  return {
    id: 'air',
    big: `${above} of ${values.length}`,
    line: 'countries and territories breathe air with more fine dust than the World Health Organization says is safe.',
    cause: 'Most of it comes from burning things: fuel in engines, power stations and homes, and crops and rubbish in the open.',
    source: `World Health Organization, latest yearly figures, via Our World in Data. Safe limit: ${WHO_PM25_GUIDELINE} micrograms per cubic metre.`,
  }
}

function plastic(findings: Findings): Highlight | null {
  const { oceanPlasticTonnes: t, oceanPlasticYear: year } = findings.totals
  if (!Number.isFinite(t) || t <= 0) return null
  const big = t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)} million tonnes` : `${round(t / 1000)},000 tonnes`
  return {
    id: 'plastic',
    big,
    line: 'of plastic washes into the ocean every year.',
    cause: 'Most of it is rubbish that was never collected. Rain and rivers carry it from streets and dumps to the sea.',
    source: `Meijer and others (2021), estimates for ${Number.isFinite(year) ? year : 'the latest year'}, via Our World in Data.`,
  }
}

function fires(findings: Findings): Highlight | null {
  const { firesToday: n, firesSavedOn } = findings.totals
  if (!Number.isFinite(n)) return null
  return {
    id: 'fires',
    big: round(n),
    line: firesSavedOn
      ? `fire hot spots were seen from space in the 24 hours to ${savedDay(firesSavedOn)}.`
      : 'fire hot spots have been seen from space in the last 24 hours.',
    cause: 'Land cleared by burning for farms and grazing, dry seasons, and heat that turns a spark into a wildfire.',
    source: 'NASA’s fire-watching satellites (MODIS).',
  }
}

function water(table: CountryTable): Highlight | null {
  const values = [...table.values()].map((r) => r.water).filter((v): v is number => Number.isFinite(v))
  if (values.length === 0) return null
  return {
    id: 'water',
    big: `${Math.round(median(values))}%`,
    line: 'of the rivers, lakes and groundwater tested are in good condition, in the typical country.',
    cause: 'Sewage that is never treated, fertiliser washing off fields, and waste from factories and mines.',
    source: `UN Environment Programme, ${values.length} countries, via Our World in Data.`,
  }
}

/** What goes with a cleaner planet, from the findings, said with care: a link, not a cause. */
function together(table: CountryTable): Highlight | null {
  const a = link(table, 'life', 'air')
  const p = link(table, 'life', 'plasticPerPerson')
  const good = (l: typeof a) => l.p < FIRM_P && betterTogether(l, l.b)
  const heldGood = (l: typeof a) => !!l.heldLevel && l.heldLevel.p < FIRM_P && betterTogether(l.heldLevel, l.b)
  if (!Number.isFinite(a.r) || !Number.isFinite(p.r)) return null
  if (!good(a) && !good(p)) {
    return {
      id: 'link',
      big: 'No simple answer',
      line: 'Across countries, a better quality of life does not clearly go with cleaner air or less plastic waste.',
      cause: 'What people can do where they live still counts, wherever that is.',
      source: 'Findings tab: every country with the figures, compared by rank.',
    }
  }
  const beyond = heldGood(a) || heldGood(p)
  return {
    id: 'link',
    big: 'Better lives, cleaner planet',
    line: `Countries with a better quality of life tend to have cleaner air and less plastic dumped or burned${
      beyond ? ', even compared with countries just as rich.' : ', though much of that comes down to wealth.'
    }`,
    cause: 'A link, not proof of cause: health, schooling and income may help clean things up, and a clean place helps people live well.',
    source: `Findings tab: ${a.n} countries for air, ${p.n} for plastic, compared by rank with wealth held level.`,
  }
}

/** The highlights there are figures for, in the order the reel shows them. */
export function highlights(findings: Findings): Highlight[] {
  return [air(findings.table), plastic(findings), fires(findings), water(findings.table), together(findings.table)].filter(
    (h): h is Highlight => h !== null,
  )
}
