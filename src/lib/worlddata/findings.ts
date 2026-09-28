import {
  confidenceInterval,
  describe,
  kruskalWallis,
  median,
  partialSpearman,
  pValue,
  spearman,
  strength,
  type Describe,
  type Strength,
} from './stats'

/**
 * The findings: how quality of life, wealth and the environment go together,
 * country by country. Pure: the loading is in useFindings.
 *
 * What this can and cannot say. Every figure here is a link across countries,
 * measured once. A link is not a cause: countries that differ in quality of
 * life differ in a great many other ways too. The strongest of those is
 * wealth, so every link with quality of life is also given with wealth -- GDP
 * per person -- held level. What is left then is what quality of life goes
 * with beyond simply being richer. It narrows the question; it does not settle
 * which way anything runs.
 */

export type MetricId = 'life' | 'gdp' | 'air' | 'plasticPerPerson' | 'water' | 'fires'

export interface Metric {
  id: MetricId
  label: string
  unit: string
  /** Which way is better for people or the environment; null for wealth. */
  better: 'higher' | 'lower' | null
  kind: 'life' | 'wealth' | 'environment'
  /** What the figure is, in plain words, and anything to know before reading it. */
  about: string
  /** For "countries with a better quality of life tend to have ___". */
  good?: string
  bad?: string
}

export const METRICS: Record<MetricId, Metric> = {
  life: {
    id: 'life',
    label: 'Quality of life',
    unit: 'out of 1',
    better: 'higher',
    kind: 'life',
    about: 'The UN’s Human Development Index: health, schooling and income together, from 0 to 1.',
  },
  gdp: {
    id: 'gdp',
    label: 'Wealth',
    unit: 'dollars a person',
    better: null,
    kind: 'wealth',
    about: 'GDP per person, adjusted for what money buys in each country (World Bank).',
  },
  air: {
    id: 'air',
    label: 'Air pollution',
    unit: 'micrograms per cubic metre',
    better: 'lower',
    kind: 'environment',
    about: 'Fine dust in the air people breathe, yearly average (World Health Organization).',
    good: 'cleaner air',
    bad: 'dirtier air',
  },
  plasticPerPerson: {
    id: 'plasticPerPerson',
    label: 'Plastic not handled properly',
    unit: 'kg a person a year',
    better: 'lower',
    kind: 'environment',
    about:
      'Plastic waste per person that is dumped, burned in the open or leaked, rather than collected (Meijer and others). Per person, so large countries do not rank high for their size alone.',
    good: 'less plastic dumped or burned per person',
    bad: 'more plastic dumped or burned per person',
  },
  water: {
    id: 'water',
    label: 'Water quality',
    unit: 'per cent in good condition',
    better: 'higher',
    kind: 'environment',
    about:
      'Share of rivers, lakes and groundwater in good condition when tested (UN Environment Programme). Countries test different amounts of their water, so this is the least even of the figures.',
    good: 'cleaner rivers, lakes and groundwater',
    bad: 'dirtier rivers, lakes and groundwater',
  },
  fires: {
    id: 'fires',
    label: 'Fires',
    unit: 'hot spots per 10,000 km²',
    better: 'lower',
    kind: 'environment',
    about:
      'Fire hot spots seen from space in one day, per 10,000 km² of land (NASA). One day only, so it follows the season and the weather more than anything about a country.',
    good: 'fewer fires for their size',
    bad: 'more fires for their size',
  },
}

export const ENVIRONMENT: MetricId[] = ['air', 'plasticPerPerson', 'water', 'fires']

/** Every country's figures, by its three-letter code. */
export type CountryTable = Map<string, { name: string } & Partial<Record<MetricId, number>>>

export interface LinkFigure {
  /** How many countries have both figures. */
  n: number
  /** Rank link, from -1 to 1. */
  r: number
  /** Chance of a link this strong by luck alone. */
  p: number
  strength: Strength
  /** 95% confidence interval for r. */
  ci: [number, number]
}

export interface Link extends LinkFigure {
  a: MetricId
  b: MetricId
  /** The same link with wealth held level, where neither side is wealth. */
  heldLevel: LinkFigure | null
}

/** The countries with every one of these figures, in one order. */
function columns(table: CountryTable, ids: MetricId[]): number[][] {
  const out = ids.map(() => [] as number[])
  for (const row of table.values()) {
    if (ids.every((id) => Number.isFinite(row[id]))) ids.forEach((id, i) => out[i].push(row[id]!))
  }
  return out
}

/** How two measures go together across countries, and again with wealth held level. */
export function link(table: CountryTable, a: MetricId, b: MetricId): Link {
  const [x, y] = columns(table, [a, b])
  const r = spearman(x, y)
  const p = pValue(r, x.length)
  let heldLevel: LinkFigure | null = null
  if (a !== 'gdp' && b !== 'gdp') {
    const [hx, hy, hz] = columns(table, [a, b, 'gdp'])
    const hr = partialSpearman(hx, hy, hz)
    const hp = pValue(hr, hx.length, 1)
    heldLevel = { n: hx.length, r: hr, p: hp, strength: strength(hr, hp), ci: confidenceInterval(hr, hx.length, 1) }
  }
  return { a, b, n: x.length, r, p, strength: strength(r, p), ci: confidenceInterval(r, x.length), heldLevel }
}

/** Every pair of measures, once each. */
export function allLinks(table: CountryTable, ids: MetricId[] = Object.keys(METRICS) as MetricId[]): Link[] {
  return ids.flatMap((a, i) => ids.slice(i + 1).map((b) => link(table, a, b)))
}

/** The UN's own bands for its Human Development Index. */
export const LIFE_BANDS = [
  { label: 'Low', from: 0, below: 0.55 },
  { label: 'Medium', from: 0.55, below: 0.7 },
  { label: 'High', from: 0.7, below: 0.8 },
  { label: 'Very high', from: 0.8, below: Infinity },
] as const

/** The middle figure of a measure in each quality-of-life band. */
export function byLifeBand(table: CountryTable, metric: MetricId): Array<{ band: string; n: number; median: number }> {
  return LIFE_BANDS.map((band) => {
    const values = [...table.values()]
      .filter((row) => Number.isFinite(row.life) && row.life! >= band.from && row.life! < band.below && Number.isFinite(row[metric]))
      .map((row) => row[metric]!)
    return { band: band.label, n: values.length, median: median(values) }
  })
}

/** Does this link mean the environment is better where quality of life is? */
export function betterTogether(l: LinkFigure, metric: MetricId): boolean {
  const better = METRICS[metric].better
  return better === 'higher' ? l.r > 0 : l.r < 0
}

/** One environmental measure's finding against quality of life, in plain words. */
export function sayFinding(l: Link): string {
  const metric = METRICS[l.b]
  const countries = `${l.n} countries`
  const first =
    l.strength === 'no clear'
      ? `There is no clear link between quality of life and ${metric.label.toLowerCase()}, across ${countries}.`
      : `Countries with a better quality of life tend to have ${betterTogether(l, l.b) ? metric.good : metric.bad}: a ${l.strength} link, across ${countries}.`
  if (!l.heldLevel) return first
  const held = l.heldLevel
  const then =
    held.strength === 'no clear'
      ? l.strength === 'no clear'
        ? 'With wealth held level, there is still none.'
        : 'With wealth held level, the link disappears: wealth accounts for it.'
      : betterTogether(held, l.b) !== betterTogether(l, l.b) && l.strength !== 'no clear'
        ? `With wealth held level, it turns round: among countries equally rich, a better quality of life goes with ${betterTogether(held, l.b) ? metric.good : metric.bad} (a ${held.strength} link).`
        : `With wealth held level, a ${held.strength} link remains, so it is not only about being richer.`
  return `${first} ${then}`
}

// --- more, for exploring and for the write-up --------------------------------

export interface WealthGroup extends LinkFigure {
  /** GDP per person, lowest and highest in the group. */
  from: number
  to: number
}

/**
 * The link between two measures inside groups of countries about as rich as
 * each other: the countries with both figures and a GDP per person, split
 * into `groups` equal-sized groups by wealth. The plain way to hold wealth
 * level, and the one the partial correlation stands in for.
 */
export function withinWealth(table: CountryTable, a: MetricId, b: MetricId, groups = 4): WealthGroup[] {
  const rows = [...table.values()]
    .filter((row) => Number.isFinite(row[a]) && Number.isFinite(row[b]) && Number.isFinite(row.gdp))
    .sort((p, q) => p.gdp! - q.gdp!)
  return Array.from({ length: groups }, (_, g) => {
    const part = rows.slice(Math.floor((g * rows.length) / groups), Math.floor(((g + 1) * rows.length) / groups))
    const r = spearman(part.map((row) => row[a]!), part.map((row) => row[b]!))
    const p = pValue(r, part.length)
    return {
      from: part[0]?.gdp ?? Number.NaN,
      to: part[part.length - 1]?.gdp ?? Number.NaN,
      n: part.length,
      r,
      p,
      strength: strength(r, p),
      ci: confidenceInterval(r, part.length),
    }
  })
}

/** Whether a measure differs across the four quality-of-life bands, by rank. */
export function bandTest(table: CountryTable, metric: MetricId) {
  const groups = LIFE_BANDS.map((band) =>
    [...table.values()]
      .filter((row) => Number.isFinite(row.life) && row.life! >= band.from && row.life! < band.below && Number.isFinite(row[metric]))
      .map((row) => row[metric]!),
  )
  return kruskalWallis(groups)
}

/** The spread of one measure across every country with it. */
export function describeMetric(table: CountryTable, metric: MetricId): Describe {
  return describe([...table.values()].filter((row) => Number.isFinite(row[metric])).map((row) => row[metric]!))
}

/**
 * The main questions are eight: each environmental measure with quality of
 * life, alone and with wealth held level. Asking eight questions of the same
 * data makes a chance hit likelier, so a finding counts as firm only below
 * 0.05 / 8 (Bonferroni's correction).
 */
export const MAIN_TESTS = ENVIRONMENT.length * 2
export const FIRM_P = 0.05 / MAIN_TESTS
