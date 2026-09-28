import {
  allLinks,
  bandTest,
  byLifeBand,
  betterTogether,
  describeMetric,
  ENVIRONMENT,
  FIRM_P,
  LIFE_BANDS,
  link,
  MAIN_TESTS,
  METRICS,
  withinWealth,
  type Link,
  type LinkFigure,
  type MetricId,
} from './findings'
import type { Findings } from './useFindings'
import {
  AIR_POLLUTION_CSV,
  FIRES_UPSTREAM,
  GDP_PER_PERSON_CSV,
  PLASTIC_PER_PERSON_CSV,
  QUALITY_OF_LIFE_CSV,
  WATER_QUALITY_CSV,
} from './sources'

/**
 * The findings written up as a research paper: question, data, methods,
 * results with the full statistics, discussion, limitations, references. Built
 * from the same figures as the Explore view, every number worked out when it
 * is read, so the paper can never disagree with the screen.
 *
 * This is the one place in the app that uses statistical terms, because a
 * formal write-up needs them to be checked and cited. Each is defined in the
 * glossary at its end.
 */

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; id: string; caption: string; head: string[]; rows: string[][]; note?: string }

export interface Section {
  id: string
  heading: string
  blocks: Block[]
}

export interface Paper {
  title: string
  subtitle: string
  sections: Section[]
}

// --- how numbers are written -------------------------------------------------

const MINUS = '−'
export const rho = (r: number) => (Number.isFinite(r) ? `${r < 0 ? MINUS : ''}${Math.abs(r).toFixed(2)}` : 'n/a')
export const pText = (p: number) => (!Number.isFinite(p) ? 'n/a' : p < 0.001 ? '< 0.001' : p.toFixed(3))
export const ciText = ([lo, hi]: [number, number]) => `[${rho(lo)}, ${rho(hi)}]`
const num = (id: MetricId, v: number) => {
  if (!Number.isFinite(v)) return 'n/a'
  if (id === 'gdp') return Math.round(v).toLocaleString('en-GB')
  if (id === 'life') return v.toFixed(3)
  if (id === 'water') return v.toFixed(1)
  return v.toFixed(2)
}
const firm = (l: LinkFigure) => Number.isFinite(l.p) && l.p < FIRM_P
const stat = (l: LinkFigure) => `ρ = ${rho(l.r)}, 95% CI ${ciText(l.ci)}, p ${l.p < 0.001 ? '< 0.001' : `= ${pText(l.p)}`}, n = ${l.n}`

/** The variables, their indicators and where each came from. */
const SOURCES: Record<MetricId, { indicator: string; source: string; url: string }> = {
  life: { indicator: 'Human Development Index (HDI)', source: 'UNDP Human Development Report, via Our World in Data', url: QUALITY_OF_LIFE_CSV },
  gdp: {
    indicator: 'GDP per capita, PPP (constant international $)',
    source: 'World Bank World Development Indicators, via Our World in Data',
    url: GDP_PER_PERSON_CSV,
  },
  air: {
    indicator: 'Population-weighted mean annual PM2.5 exposure (µg/m³)',
    source: 'WHO Global Health Observatory, via Our World in Data',
    url: AIR_POLLUTION_CSV,
  },
  plasticPerPerson: {
    indicator: 'Mismanaged plastic waste per capita (kg/year)',
    source: 'Meijer et al. (2021), via Our World in Data',
    url: PLASTIC_PER_PERSON_CSV,
  },
  water: {
    indicator: 'Proportion of water bodies with good ambient water quality, SDG 6.3.2 (%)',
    source: 'UN Environment Programme, via Our World in Data',
    url: WATER_QUALITY_CSV,
  },
  fires: {
    indicator: 'MODIS active-fire detections in 24 h per 10,000 km² of land area',
    source: 'NASA FIRMS, MODIS Collection 6.1, Global 24 h',
    url: FIRES_UPSTREAM,
  },
}

const ORDER: MetricId[] = ['life', 'gdp', ...ENVIRONMENT]

/** Each indicator's formal name, and what a better or worse outcome is, for the paper's sentences. */
const FORMAL: Record<string, { name: string; good: string; bad: string }> = {
  air: { name: 'PM2.5 exposure', good: 'lower PM2.5 exposure', bad: 'higher PM2.5 exposure' },
  plasticPerPerson: {
    name: 'mismanaged plastic waste per capita',
    good: 'less mismanaged plastic waste per capita',
    bad: 'more mismanaged plastic waste per capita',
  },
  water: {
    name: 'ambient water quality',
    good: 'a higher share of water bodies in good condition',
    bad: 'a lower share of water bodies in good condition',
  },
  fires: { name: 'fire density', good: 'lower fire density', bad: 'higher fire density' },
}

// --- the paper ------------------------------------------------------------------

export function researchPaper(findings: Findings): Paper {
  const { table } = findings
  const main: Link[] = ENVIRONMENT.map((id) => link(table, 'life', id))
  const wealth = ENVIRONMENT.map((id) => link(table, 'gdp', id))
  const collinear = link(table, 'life', 'gdp')
  // The countries actually compared: the smallest and largest n of the main tests.
  const ns = main.map((l) => l.n)
  const envName = (id: MetricId) => FORMAL[id].name
  const direction = (l: LinkFigure, id: MetricId) =>
    l.strength === 'no clear'
      ? 'no statistically distinguishable association'
      : `a ${l.strength} association with ${betterTogether(l, id) ? FORMAL[id].good : FORMAL[id].bad}` +
        (firm(l) ? '' : ', which does not survive the Bonferroni correction')
  const supportedH1 = main.filter((l) => firm(l) && betterTogether(l, l.b)).map((l) => envName(l.b))
  const supportedH2 = main.filter((l) => l.heldLevel && firm(l.heldLevel) && betterTogether(l.heldLevel, l.b)).map((l) => envName(l.b))
  const contrary = main.filter((l) => firm(l) && !betterTogether(l, l.b)).map((l) => envName(l.b))
  const contraryWeak = main
    .filter((l) => !firm(l) && l.strength !== 'no clear' && !betterTogether(l, l.b))
    .map((l) => envName(l.b))
  const listOf = (items: string[]) =>
    items.length === 0 ? 'none of the indicators' : items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  const savedNote =
    findings.fromSaved.length > 0
      ? ` The live files for ${listOf(findings.fromSaved.map(envNameOrLabel))} could not be reached when this was generated; archived copies saved on ${findings.savedOn} were used for them.`
      : ''

  const sections: Section[] = [
    {
      id: 'abstract',
      heading: 'Abstract',
      blocks: [
        {
          kind: 'p',
          text:
            `This study asks whether national quality of life is associated with environmental condition. Quality of life was measured by the Human Development Index (HDI) and compared with four environmental indicators — ambient fine-particulate air pollution (PM2.5), mismanaged plastic waste per capita, the proportion of water bodies with good ambient water quality, and active-fire density — across ${Math.min(...ns)} to ${Math.max(...ns)} countries per comparison, using each country's latest available figure.` +
            `Associations were estimated by Spearman rank correlation, and by partial rank correlation holding GDP per capita (PPP) constant, with ${MAIN_TESTS} primary tests evaluated at a Bonferroni-corrected α of ${FIRM_P.toFixed(5)}. ` +
            main
              .map((l) => `For ${envName(l.b)}, HDI showed ${direction(l, l.b)} (${stat(l)}); holding GDP per capita constant, ${stat(l.heldLevel!)}.`)
              .join(' ') +
            ` HDI and GDP per capita were themselves strongly collinear (ρ = ${rho(collinear.r)}, n = ${collinear.n}). ` +
            `The results are cross-sectional associations and do not establish a causal effect of quality of life on the environment.`,
        },
      ],
    },
    {
      id: 'introduction',
      heading: '1. Question and hypotheses',
      blocks: [
        {
          kind: 'p',
          text:
            'The study asks whether countries with a higher quality of life have a healthier environment, and whether any such association goes beyond what national wealth alone would predict. Wealth is the obvious rival explanation: it raises quality of life directly (income is one of the three components of the HDI) and pays for pollution control, waste collection and water treatment.',
        },
        {
          kind: 'list',
          items: [
            'H1. HDI is associated with better environmental outcomes on each indicator: lower PM2.5, less mismanaged plastic per capita, a higher share of water bodies in good condition, and lower fire density.',
            'H2. Each association in H1 persists when GDP per capita is held constant.',
            'Null hypotheses in each case: no monotonic association (ρ = 0).',
          ],
        },
      ],
    },
    {
      id: 'data',
      heading: '2. Data',
      blocks: [
        {
          kind: 'table',
          id: 'table-1',
          caption: 'Table 1. Variables, indicators and sources',
          head: ['Variable', 'Indicator', 'Source', 'Years used', 'Countries'],
          rows: ORDER.map((id) => {
            const years = findings.years[id]
            return [
              METRICS[id].label,
              SOURCES[id].indicator,
              SOURCES[id].source,
              id === 'fires' ? `24 h to ${findings.readOn}` : years ? (years[0] === years[1] ? `${years[0]}` : `${years[0]}–${years[1]}`) : 'n/a',
              String(describeMetric(table, id).n),
            ]
          }),
          note: 'Each country contributes its most recent year with a figure. Regional and income-group aggregates were excluded.',
        },
        {
          kind: 'p',
          text:
            `All data are public and were read directly from their publishers on ${findings.readOn}.${savedNote} Country figures were matched on ISO 3166-1 alpha-3 codes. Plastic is expressed per capita so that national totals, which mainly reflect population and coastline, do not dominate. Fire density was computed by assigning each MODIS detection from the preceding 24 hours to a country by point-in-polygon on Natural Earth 1:110m boundaries, and dividing the count by the country's spherical land area; countries with no detections were given zero. Analyses used pairwise deletion: each correlation includes every country with both figures.`,
        },
      ],
    },
    {
      id: 'methods',
      heading: '3. Methods',
      blocks: [
        {
          kind: 'list',
          items: [
            'Association: Spearman’s rank correlation ρ (Spearman, 1904), chosen because several indicators are strongly skewed and because a monotonic, not necessarily linear, relation is of interest; ρ is unchanged by any monotonic transformation such as a log of GDP.',
            'Adjustment for wealth: first-order partial Spearman correlation of HDI with each indicator, controlling for GDP per capita, computed from the pairwise rank correlations. As a model-free check, ρ was also computed within quartiles of GDP per capita.',
            'Inference: two-sided p-values from the t distribution with n − 2 degrees of freedom (n − 3 for partial correlations). 95% confidence intervals by Fisher’s z-transformation with the standard error √(1.06 / (n − 3)) recommended for Spearman’s ρ (Fieller, Hartley and Pearson, 1957), one further degree of freedom removed for the partial correlation.',
            `Multiple comparisons: the ${MAIN_TESTS} primary tests (four indicators, unadjusted and adjusted) were evaluated at a Bonferroni-corrected α = 0.05 / ${MAIN_TESTS} = ${FIRM_P.toFixed(5)}. Results significant at this level are marked †.`,
            'Differences between HDI groups: countries were grouped by the UNDP’s HDI bands (low < 0.550, medium 0.550–0.699, high 0.700–0.799, very high ≥ 0.800) and compared by the Kruskal–Wallis H test with a correction for ties (Kruskal and Wallis, 1952).',
            'Strength labels, used in the plain-language summaries: |ρ| ≥ 0.5 strong, ≥ 0.3 moderate, ≥ 0.1 weak; any association with p ≥ 0.05 is reported as no clear association.',
            'Software: all statistics were computed in the application’s own TypeScript implementation (src/lib/worlddata/stats.ts), verified against textbook values for the t, χ² and incomplete beta and gamma functions.',
          ],
        },
      ],
    },
    {
      id: 'results',
      heading: '4. Results',
      blocks: [
        {
          kind: 'table',
          id: 'table-2',
          caption: 'Table 2. Descriptive statistics',
          head: ['Variable', 'Unit', 'n', 'Median', 'IQR', 'Min', 'Max'],
          rows: ORDER.map((id) => {
            const d = describeMetric(table, id)
            return [METRICS[id].label, METRICS[id].unit, String(d.n), num(id, d.median), `${num(id, d.q1)}–${num(id, d.q3)}`, num(id, d.min), num(id, d.max)]
          }),
        },
        {
          kind: 'table',
          id: 'table-3',
          caption: 'Table 3. Association of HDI with each environmental indicator, unadjusted and holding GDP per capita constant',
          head: ['Indicator', 'Better when', 'ρ (unadjusted)', '95% CI', 'p', 'n', 'Partial ρ (GDP held)', '95% CI', 'p', 'n', 'ρ with GDP'],
          rows: main.map((l, i) => {
            const h = l.heldLevel!
            return [
              METRICS[l.b].label,
              METRICS[l.b].better === 'lower' ? 'lower' : 'higher',
              `${rho(l.r)}${firm(l) ? ' †' : ''}`,
              ciText(l.ci),
              pText(l.p),
              String(l.n),
              `${rho(h.r)}${firm(h) ? ' †' : ''}`,
              ciText(h.ci),
              pText(h.p),
              String(h.n),
              rho(wealth[i].r),
            ]
          }),
          note: `† significant at the Bonferroni-corrected α = ${FIRM_P.toFixed(5)}. A negative ρ for PM2.5, plastic or fires, and a positive ρ for water quality, indicate better environmental outcomes at higher HDI.`,
        },
        ...main.map((l): Block => {
          const h = l.heldLevel!
          return {
            kind: 'p',
            text:
              `${METRICS[l.b].label}. HDI showed ${direction(l, l.b)} (${stat(l)}). ` +
              (h.strength === 'no clear'
                ? l.strength === 'no clear'
                  ? `Holding GDP per capita constant, there was still no association (${stat(h)}).`
                  : `Holding GDP per capita constant, the association was not distinguishable from zero (${stat(h)}), consistent with wealth accounting for it.`
                : `Holding GDP per capita constant, the association remained (${stat(h)}).`),
          }
        }),
        {
          kind: 'table',
          id: 'table-4',
          caption: 'Table 4. Median of each indicator by UNDP HDI band, with the Kruskal–Wallis test across bands',
          head: ['Indicator', ...LIFE_BANDS.map((b) => b.label), 'H', 'df', 'p'],
          rows: ENVIRONMENT.map((id) => {
            const bands = byLifeBand(table, id)
            const kw = bandTest(table, id)
            return [
              METRICS[id].label,
              ...bands.map((b) => `${num(id, b.median)} (n = ${b.n})`),
              Number.isFinite(kw.h) ? kw.h.toFixed(2) : 'n/a',
              String(kw.df),
              pText(kw.p),
            ]
          }),
        },
        {
          kind: 'table',
          id: 'table-5',
          caption: 'Table 5. ρ between HDI and each indicator within quartiles of GDP per capita',
          head: ['Indicator', ...['Q1 (poorest)', 'Q2', 'Q3', 'Q4 (richest)']],
          rows: ENVIRONMENT.map((id) => [
            METRICS[id].label,
            ...withinWealth(table, 'life', id).map((g) => `${rho(g.r)} (n = ${g.n}, p ${g.p < 0.001 ? '< 0.001' : `= ${pText(g.p)}`})`),
          ]),
          note: 'Within a quartile, countries have similar GDP per capita, so any remaining association is not explained by differences in wealth between them. Sub-samples are small and intervals wide.',
        },
        {
          kind: 'table',
          id: 'table-6',
          caption: 'Table 6. Spearman correlation matrix of all variables (pairwise n in parentheses)',
          head: ['', ...ORDER.map((id) => METRICS[id].label)],
          rows: ORDER.map((a) => [
            METRICS[a].label,
            ...ORDER.map((b) => {
              if (a === b) return '—'
              const l = allLinksCache(table).find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))
              return l ? `${rho(l.r)} (${l.n})` : 'n/a'
            }),
          ]),
        },
      ],
    },
    {
      id: 'discussion',
      heading: '5. Discussion',
      blocks: [
        {
          kind: 'p',
          text:
            `H1 was supported, at the corrected threshold, for ${listOf(supportedH1)}. ` +
            (contrary.length > 0 ? `For ${listOf(contrary)}, the association ran in the opposite direction to H1. ` : '') +
            (contraryWeak.length > 0
              ? `For ${listOf(contraryWeak)}, a weak association in the opposite direction reached p < 0.05 but not the corrected threshold, and should be treated as unconfirmed. `
              : '') +
            `H2 — that the association persists with GDP per capita held constant — was supported for ${listOf(supportedH2)}. ` +
            `Because HDI and GDP per capita are collinear (ρ = ${rho(collinear.r)}), partly by construction since income is an HDI component, the partial correlations have limited independent variation to work with; associations that survive the adjustment are therefore the more notable, and attenuation under adjustment should not by itself be read as evidence that quality of life is irrelevant.`,
        },
        {
          kind: 'p',
          text:
            'The water-quality indicator should be interpreted with particular care. SDG 6.3.2 reports the share of monitored water bodies meeting national standards, and monitoring coverage and standards vary widely between countries; wealthier countries typically monitor more water bodies and apply stricter standards, which can lower the reported share independently of actual water condition. Fire density reflects a single 24-hour window and is dominated by season, climate and land cover.',
        },
        {
          kind: 'p',
          text:
            'None of these associations establishes a causal effect of quality of life on the environment, or the reverse. Plausible pathways run in both directions — higher incomes fund cleaner technology and waste systems, while cleaner air and water improve health, one component of the HDI — and other shared factors (industrial structure, urbanisation, governance, geography) are not modelled.',
        },
      ],
    },
    {
      id: 'limitations',
      heading: '6. Limitations',
      blocks: [
        {
          kind: 'list',
          items: [
            'Cross-sectional design: one figure per country, so the analysis cannot separate cause from effect or follow change over time.',
            'Ecological fallacy: national associations need not hold for regions, communities or individuals within countries.',
            'Mixed reference years: each country contributes its latest figure, and the latest year differs between indicators and countries (Table 1).',
            'Single adjustment variable: only GDP per capita is held constant; other confounders are not.',
            'Data coverage and quality: water quality in particular depends on national monitoring; small countries and territories may be missing from the 1:110m boundaries used for fire density.',
            'Snapshot fire data: 24 hours of detections, not an annual rate.',
            `Multiple comparisons: the Bonferroni correction applies to the ${MAIN_TESTS} primary tests only; the matrix in Table 6 and the within-quartile results in Table 5 are exploratory.`,
          ],
        },
      ],
    },
    {
      id: 'reproducibility',
      heading: '7. Reproducibility',
      blocks: [
        {
          kind: 'p',
          text: `Figures read on ${findings.readOn}.${savedNote} Every number in this paper is computed when it is displayed, from the same data as the Explore view; the country-level data can be downloaded alongside it. Archived copies of each source are kept in the application (public/data, dated ${findings.savedOn}) and refreshed with scripts/save-world-data.mjs.`,
        },
        { kind: 'list', items: ORDER.map((id) => `${METRICS[id].label}: ${SOURCES[id].url}`) },
      ],
    },
    {
      id: 'references',
      heading: 'References',
      blocks: [
        {
          kind: 'list',
          items: [
            'Fieller, E. C., Hartley, H. O. and Pearson, E. S. (1957). Tests for rank correlation coefficients. I. Biometrika, 44(3/4), 470–481.',
            'Fisher, R. A. (1915). Frequency distribution of the values of the correlation coefficient in samples from an indefinitely large population. Biometrika, 10(4), 507–521.',
            'Kruskal, W. H. and Wallis, W. A. (1952). Use of ranks in one-criterion variance analysis. Journal of the American Statistical Association, 47(260), 583–621.',
            'Meijer, L. J. J., van Emmerik, T., van der Ent, R., Schmidt, C. and Lebreton, L. (2021). More than 1000 rivers account for 80% of global riverine plastic emissions into the ocean. Science Advances, 7(18), eaaz5803.',
            'NASA FIRMS (2026). MODIS Collection 6.1 Near Real-Time Active Fire Detections, Global 24 h. Fire Information for Resource Management System.',
            'Natural Earth (2024). Admin 0 – Countries, 1:110m. naturalearthdata.com.',
            'Our World in Data (2026). Grapher data downloads for the indicators in Table 1. ourworldindata.org.',
            'Spearman, C. (1904). The proof and measurement of association between two things. American Journal of Psychology, 15(1), 72–101.',
            'UNDP (2025). Human Development Report 2025. United Nations Development Programme.',
            'UNEP (2024). Progress on Ambient Water Quality: SDG indicator 6.3.2. United Nations Environment Programme.',
            'World Bank (2026). World Development Indicators: GDP per capita, PPP (constant international $).',
            'World Health Organization (2024). Global Health Observatory: concentrations of fine particulate matter (PM2.5).',
          ],
        },
      ],
    },
    {
      id: 'glossary',
      heading: 'Glossary',
      blocks: [
        {
          kind: 'list',
          items: [
            'Spearman’s ρ (rho): how closely two rankings of the same countries agree, from −1 (exact opposite order) through 0 (no relation) to +1 (same order).',
            'Partial correlation: the association between two measures after removing the part of each that follows a third — here, GDP per capita.',
            'p-value: the probability of an association at least this strong arising by chance if there were none.',
            '95% confidence interval (CI): the range within which the true association is likely to lie, given the sample.',
            'Bonferroni correction: dividing the 0.05 threshold by the number of tests, so that asking several questions does not raise the chance of a false finding.',
            'Kruskal–Wallis H: a test of whether several groups differ in their typical value, using ranks.',
            'IQR (interquartile range): the middle half of the figures, from the lower to the upper quartile.',
            'PPP (purchasing power parity): money adjusted for what it buys in each country.',
            'Confounder: a third factor that affects both measures and can create an association between them.',
          ],
        },
      ],
    },
  ]
  return {
    title: 'Quality of life and environmental condition across countries',
    subtitle: 'A cross-sectional rank-correlation analysis, adjusting for GDP per capita',
    sections,
  }
}

function envNameOrLabel(id: MetricId): string {
  return METRICS[id].label.toLowerCase()
}

const pairCache = new WeakMap<object, Link[]>()
function allLinksCache(table: Findings['table']): Link[] {
  let found = pairCache.get(table)
  if (!found) {
    found = allLinks(table, ORDER)
    pairCache.set(table, found)
  }
  return found
}

// --- as a document -----------------------------------------------------------

const cell = (text: string) => text.replace(/\|/g, '\\|')

/** The paper as Markdown, for downloading and reading anywhere. */
export function paperToMarkdown(paper: Paper): string {
  const out: string[] = [`# ${paper.title}`, '', `*${paper.subtitle}*`, '']
  for (const section of paper.sections) {
    out.push(`## ${section.heading}`, '')
    for (const block of section.blocks) {
      if (block.kind === 'p') out.push(block.text, '')
      else if (block.kind === 'list') out.push(...block.items.map((item) => `- ${item}`), '')
      else {
        out.push(`**${block.caption}**`, '')
        out.push(`| ${block.head.map(cell).join(' | ')} |`, `| ${block.head.map(() => '---').join(' | ')} |`)
        for (const row of block.rows) out.push(`| ${row.map(cell).join(' | ')} |`)
        out.push('')
        if (block.note) out.push(`*${block.note}*`, '')
      }
    }
  }
  return out.join('\n')
}

/** Every country's figures as CSV, for checking the analysis elsewhere. */
export function tableToCsv(findings: Findings): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const head = ['code', 'country', ...ORDER]
  const rows = [...findings.table.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, row]) => [code, row.name, ...ORDER.map((id) => (Number.isFinite(row[id]) ? String(row[id]) : ''))].map(quote).join(','))
  return [head.join(','), ...rows].join('\n') + '\n'
}
