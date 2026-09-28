import { describe, it, expect } from 'vitest'
import { researchPaper, paperToMarkdown, tableToCsv, rho, pText, ciText, type Block } from './research'
import { FIRM_P, link } from './findings'
import type { CountryTable } from './findings'
import type { Findings } from './useFindings'

// Sixty made-up countries: wealth drives quality of life and cleaner air;
// water follows quality of life beyond wealth; fires follow nothing.
const table: CountryTable = new Map(
  Array.from({ length: 60 }, (_, i) => [
    `C${String(i).padStart(2, '0')}`,
    {
      name: i === 3 ? 'Côte, "Coast"' : `Country ${i}`,
      gdp: 1000 + i * 1000,
      life: 0.35 + i * 0.01 + (((i * 7) % 11) - 5) * 0.004,
      air: 70 - i + (((i * 13) % 17) - 8),
      plasticPerPerson: 15 - i * 0.2 + (((i * 5) % 7) - 3),
      water: 30 + i * 0.8 + (((i * 29) % 11) - 5),
      fires: (i * 7) % 5,
    },
  ]),
)
const findings: Findings = {
  table,
  fromSaved: [],
  savedOn: '2026-09-28',
  readOn: '2026-09-28',
  years: { life: [2023, 2023], gdp: [2022, 2024], air: [2024, 2024], plasticPerPerson: [2019, 2019], water: [2020, 2023] },
}
const paper = researchPaper(findings)
const section = (id: string) => paper.sections.find((s) => s.id === id)!
const text = (id: string) =>
  section(id)
    .blocks.map((b: Block) => (b.kind === 'p' ? b.text : b.kind === 'list' ? b.items.join(' ') : [b.caption, ...b.rows.flat()].join(' ')))
    .join(' ')
const tableById = (id: string) =>
  paper.sections.flatMap((s) => s.blocks).find((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table' && b.id === id)!

describe('the research paper', () => {
  it('has the sections a formal write-up needs, in order', () => {
    expect(paper.sections.map((s) => s.id)).toEqual([
      'abstract',
      'introduction',
      'data',
      'methods',
      'results',
      'discussion',
      'limitations',
      'reproducibility',
      'references',
      'glossary',
    ])
  })

  it('reports each main link with its interval, p and n, as worked out', () => {
    const air = link(table, 'life', 'air')
    const row = tableById('table-3').rows.find((r) => r[0] === 'Air pollution')!
    expect(row[2]).toBe(`${rho(air.r)}${air.p < FIRM_P ? ' †' : ''}`)
    expect(row[3]).toBe(ciText(air.ci))
    expect(row[4]).toBe(pText(air.p))
    expect(row[5]).toBe(String(air.n))
    expect(text('abstract')).toContain(`ρ = ${rho(air.r)}, 95% CI ${ciText(air.ci)}`)
  })

  it('states its hypotheses, its correction for several tests, and its methods with citations', () => {
    expect(text('introduction')).toMatch(/H1\..*H2\./)
    expect(text('methods')).toContain(`0.05 / 8 = ${FIRM_P.toFixed(5)}`)
    expect(text('methods')).toMatch(/Spearman, 1904/)
    expect(text('methods')).toMatch(/Kruskal and Wallis, 1952/)
    expect(text('references')).toMatch(/Meijer, L\. J\. J\./)
  })

  it('gives the descriptive table, the bands with their test, the wealth quartiles and the full matrix', () => {
    expect(tableById('table-2').rows).toHaveLength(6)
    expect(tableById('table-4').head).toEqual(['Indicator', 'Low', 'Medium', 'High', 'Very high', 'H', 'df', 'p'])
    expect(tableById('table-5').rows).toHaveLength(4)
    expect(tableById('table-6').rows).toHaveLength(6)
  })

  it('says a link is not a cause, and names its limits', () => {
    expect(text('abstract')).toMatch(/do not establish a causal effect/)
    expect(text('limitations')).toMatch(/Cross-sectional design/)
    expect(text('limitations')).toMatch(/Ecological fallacy/)
  })

  it('says when saved copies were used, and which', () => {
    const saved = researchPaper({ ...findings, fromSaved: ['water'] })
    const data = saved.sections.find((s) => s.id === 'data')!.blocks.map((b) => (b.kind === 'p' ? b.text : '')).join(' ')
    expect(data).toMatch(/live files for water quality could not be reached.*saved on 2026-09-28/)
  })

  it('never says wealth accounts for a link that was not there to begin with', () => {
    // Fires follow nothing, alone or with wealth held.
    expect(text('results')).toMatch(/Fires\. HDI showed no statistically distinguishable association .* there was still no association/)
  })
})

describe('paperToMarkdown', () => {
  const md = paperToMarkdown(paper)
  it('writes headings, tables and notes a document reader understands', () => {
    expect(md.startsWith(`# ${paper.title}`)).toBe(true)
    expect(md).toMatch(/^## 4\. Results$/m)
    expect(md).toMatch(/^\| Indicator \| Better when \| ρ \(unadjusted\) \|/m)
    expect(md).toMatch(/^\| --- \| --- \|/m)
  })
})

describe('tableToCsv', () => {
  it('gives every country’s figures, with names quoted safely', () => {
    const csv = tableToCsv(findings)
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('code,country,life,gdp,air,plasticPerPerson,water,fires')
    expect(lines).toHaveLength(61)
    expect(csv).toContain('"Côte, ""Coast"""')
  })
})
