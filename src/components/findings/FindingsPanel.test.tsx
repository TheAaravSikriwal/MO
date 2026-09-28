import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingsPanel, chance, signed, figure } from './FindingsPanel'
import type { CountryTable } from '../../lib/worlddata/findings'
import type { Findings } from '../../lib/worlddata/useFindings'

// Sixty made-up countries: richer ones have a better quality of life and
// cleaner air; fires follow nothing.
const table: CountryTable = new Map(
  Array.from({ length: 60 }, (_, i) => [
    `C${i}`,
    {
      name: i === 7 ? 'Examplestan' : `Country ${i}`,
      gdp: 1000 + i * 1000,
      life: 0.35 + i * 0.01 + (((i * 7) % 11) - 5) * 0.004,
      air: 70 - i + (((i * 13) % 17) - 8),
      plasticPerPerson: 15 - i * 0.2,
      water: 30 + ((i * 29) % 60),
      fires: (i * 7) % 5,
    },
  ]),
)
const findings = (over: Partial<Findings> = {}): Findings => ({
  table,
  fromSaved: [],
  savedOn: '2026-09-28',
  readOn: '2026-09-28',
  years: { life: [2023, 2023] },
  totals: { oceanPlasticTonnes: 1_000_000, oceanPlasticYear: 2019, firesToday: 16000, firesSavedOn: null },
  ...over,
})
const ready = (over: Partial<Findings> = {}) => ({ status: 'ready' as const, findings: findings(over) })

afterEach(() => vi.restoreAllMocks())

describe('Findings — Explore', () => {
  it('opens on Explore, with a card per part of the environment saying its answer', () => {
    render(<FindingsPanel state={ready()} />)
    expect(screen.getByRole('button', { name: 'Explore' })).toHaveAttribute('aria-pressed', 'true')
    const pick = screen.getByRole('heading', { name: '1. Pick part of the environment' }).parentElement!
    const cards = within(pick).getAllByRole('button')
    expect(cards).toHaveLength(4)
    expect(cards[0]).toHaveAccessibleName(/^Air pollution\s*Strong link: cleaner air$/)
    expect(within(pick).getByRole('button', { name: /^Fires\s*No clear link$/ })).toBeInTheDocument()
  })

  it('answers for the part picked, in a sentence and on a bar from −1 to +1', async () => {
    const user = userEvent.setup()
    render(<FindingsPanel state={ready()} />)
    expect(screen.getByRole('heading', { name: '2. The answer for air pollution' })).toBeInTheDocument()
    expect(screen.getByText(/^Countries with a better quality of life tend to have cleaner air: a strong link, across 60 countries\./)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^All countries: −0\.\d\d, likely between −/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Countries compared only with others as rich:/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Fires/ }))
    expect(screen.getByRole('heading', { name: '2. The answer for fires' })).toBeInTheDocument()
    expect(screen.getByText(/^There is no clear link between quality of life and fires/)).toBeInTheDocument()
  })

  it('narrows to countries of similar wealth, says what it finds there, and lights only those dots', async () => {
    const user = userEvent.setup()
    render(<FindingsPanel state={ready()} />)
    const dots = () => screen.getAllByTestId('country-dot')
    expect(dots().every((d) => d.getAttribute('data-in-group') === 'yes')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Richest quarter' }))
    expect(screen.getByText(/^Among the richest quarter of countries \(\$46,000 to \$60,000 a person\):/)).toBeInTheDocument()
    expect(dots().filter((d) => d.getAttribute('data-in-group') === 'yes')).toHaveLength(15)
    await user.click(screen.getByRole('button', { name: 'All countries' }))
    expect(dots().every((d) => d.getAttribute('data-in-group') === 'yes')).toBe(true)
  })

  it('finds a country by name and shows its figures', async () => {
    const user = userEvent.setup()
    render(<FindingsPanel state={ready()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a country' }), 'examp')
    expect(screen.getAllByTestId('country-dot').filter((d) => d.getAttribute('data-picked') === 'yes')).toHaveLength(1)
    const card = screen.getByRole('status', { name: 'Country' })
    expect(card).toHaveTextContent('Examplestan')
    expect(card).toHaveTextContent('Wealth: $8,000 a person')
  })

  it('shows a country’s figures on hover', () => {
    render(<FindingsPanel state={ready()} />)
    fireEvent.mouseEnter(screen.getAllByTestId('country-dot')[0])
    expect(screen.getByRole('status', { name: 'Country' })).toHaveTextContent('Country 0')
  })

  it('draws the middle figure in each quality-of-life band', () => {
    render(<FindingsPanel state={ready()} />)
    const bars = screen.getByRole('list', { name: 'Middle air pollution figure in each quality-of-life band' })
    expect(within(bars).getAllByRole('listitem').map((li) => li.textContent?.replace(/\d.*$/, '').trim())).toEqual([
      'Low',
      'Medium',
      'High',
      'Very high',
    ])
  })

  it('shows every pair, and the same with wealth held level', async () => {
    const user = userEvent.setup()
    render(<FindingsPanel state={ready()} />)
    const section = screen.getByRole('heading', { name: '5. Every measure against every other' }).parentElement!.parentElement!
    const cell = () => within(within(section).getByRole('rowheader', { name: 'Quality of life' }).parentElement!).getAllByRole('cell')[2].textContent
    const plain = cell()
    await user.click(within(section).getByRole('checkbox', { name: 'Hold wealth level' }))
    expect(cell()).not.toBe(plain)
  })

  it('says plainly that a link is not a cause', () => {
    render(<FindingsPanel state={ready()} />)
    expect(screen.getByText(/A link is not a cause\./)).toBeInTheDocument()
  })
})

describe('Findings — Research paper', () => {
  it('switches to the formal write-up, with every section and its tables', async () => {
    const user = userEvent.setup()
    render(<FindingsPanel state={ready()} />)
    await user.click(screen.getByRole('button', { name: 'Research paper' }))
    const paper = screen.getByRole('article', { name: 'Research paper' })
    for (const heading of ['Abstract', '1. Question and hypotheses', '2. Data', '3. Methods', '4. Results', '5. Discussion', '6. Limitations', 'References', 'Glossary']) {
      expect(within(paper).getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    expect(within(paper).getByRole('table', { name: /^Table 3\. Association of HDI/ })).toBeInTheDocument()
    expect(within(paper).getByRole('navigation', { name: 'Contents' })).toBeInTheDocument()
  })

  it('hands over the paper and the data as files to save', async () => {
    const user = userEvent.setup()
    const made: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      made.push(blob as Blob)
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<FindingsPanel state={ready()} />)
    await user.click(screen.getByRole('button', { name: 'Research paper' }))
    await user.click(screen.getByRole('button', { name: 'Download the paper' }))
    await user.click(screen.getByRole('button', { name: 'Download the data' }))
    expect(clicked).toHaveBeenCalledTimes(2)
    expect(made.map((b) => b.type)).toEqual(['text/markdown', 'text/csv'])
    expect(await made[0].text()).toMatch(/^# Quality of life and environmental condition across countries/)
    expect((await made[1].text()).split('\n')[0]).toBe('code,country,life,gdp,air,plasticPerPerson,water,fires')
  })
})

describe('Findings — around the figures', () => {
  it('says which figures come from a saved copy', () => {
    render(<FindingsPanel state={ready({ fromSaved: ['water', 'fires'] })} />)
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('saved copies from 28 Sep 2026 are used for: water quality, fires.')
  })

  it('says so when the figures cannot be loaded, with a way to ask again', async () => {
    const retry = vi.fn()
    render(<FindingsPanel state={{ status: 'failed', message: 'Could not load the figures right now.', retry }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the figures right now.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalled()
  })
})

describe('the words and figures', () => {
  it('writes a link with a true minus, and the chance of luck in words', () => {
    expect(signed(-0.482)).toBe('−0.48')
    expect(signed(0.3)).toBe('+0.30')
    expect(chance(0.0001)).toBe('under 1 in 1,000')
    expect(chance(0.02)).toBe('about 1 in 50')
    expect(chance(0.3)).toBe('could easily be luck')
  })

  it('writes each measure the usual way', () => {
    expect(figure('gdp', 12345.6)).toBe('$12,346')
    expect(figure('water', 71.6)).toBe('72%')
    expect(figure('life', 0.8123)).toBe('0.81')
  })
})
