import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HighlightReel } from './HighlightReel'
import type { CountryTable } from '../../lib/worlddata/findings'
import type { Findings, FindingsState } from '../../lib/worlddata/useFindings'

const table: CountryTable = new Map(
  Array.from({ length: 60 }, (_, i) => [
    `C${i}`,
    {
      name: `Country ${i}`,
      gdp: 1000 + i * 1000,
      life: 0.35 + i * 0.01 + (((i * 7) % 11) - 5) * 0.004,
      air: 40 - i * 0.6,
      plasticPerPerson: 15 - i * 0.2,
      water: 30 + ((i * 29) % 60),
      fires: (i * 7) % 5,
    },
  ]),
)
const findings: Findings = {
  table,
  fromSaved: [],
  savedOn: '2026-09-28',
  readOn: '2026-09-28',
  years: {},
  totals: { oceanPlasticTonnes: 979_000, oceanPlasticYear: 2019, firesToday: 16387, firesSavedOn: null },
}
const ready: FindingsState = { status: 'ready', findings }

describe('HighlightReel', () => {
  it('opens with a welcome to tidy, then one big figure at a time with its cause and source', async () => {
    const user = userEvent.setup()
    render(<HighlightReel state={ready} onDone={vi.fn()} />)
    const reel = screen.getByRole('dialog', { name: 'Introduction to tidy' })
    expect(reel).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'tidy' })).toBeInTheDocument()
    expect(screen.getByText('Welcome to')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Begin' }))
    // Air: 40 - 0.6i is above the WHO's 5 for i up to 58, so 59 of the 60.
    expect(screen.getByText('59 of 60')).toBeInTheDocument()
    expect(screen.getByText(/breathe air with more fine dust than the World Health Organization says is safe/)).toBeInTheDocument()
    expect(screen.getByText(/Most of it comes from burning things/)).toBeInTheDocument()
    expect(screen.getByText(/World Health Organization, latest yearly figures/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('979,000 tonnes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('16,387')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/of the rivers, lakes and groundwater tested are in good condition/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/A link, not proof of cause/)).toBeInTheDocument()
  })

  it('ends on what anyone can do, and hands over to the map', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<HighlightReel state={ready} onDone={onDone} />)
    for (let i = 0; i < 6; i++) await user.click(screen.getByRole('button', { name: /Begin|Next/ }))
    expect(screen.getByText('Litter is local.')).toBeInTheDocument()
    expect(screen.getByText('So is cleaning it up.')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Start exploring' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('can be skipped, by button or by Escape', async () => {
    const onDone = vi.fn()
    render(<HighlightReel state={ready} onDone={onDone} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip introduction' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDone).toHaveBeenCalledTimes(2)
  })

  it('moves on with the arrow keys too, and back', () => {
    render(<HighlightReel state={ready} onDone={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('59 of 60')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('Welcome to')).toBeInTheDocument()
  })

  it('says it is gathering the figures while they load, and shows them when they come', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<HighlightReel state={{ status: 'loading' }} onDone={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Begin' }))
    expect(screen.getByRole('status')).toHaveTextContent('Gathering the latest figures…')
    rerender(<HighlightReel state={ready} onDone={vi.fn()} />)
    expect(screen.getByText('59 of 60')).toBeInTheDocument()
  })

  it('still welcomes and hands over when the figures cannot be loaded', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<HighlightReel state={{ status: 'failed', message: 'x', retry: vi.fn() }} onDone={onDone} />)
    await user.click(screen.getByRole('button', { name: 'Begin' }))
    expect(screen.getByText('Litter is local.')).toBeInTheDocument()
    expect(screen.getByText(/could not be loaded just now/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start exploring' }))
    expect(onDone).toHaveBeenCalled()
  })

  it('puts the button to move on in reach of the keyboard on every slide', async () => {
    const user = userEvent.setup()
    render(<HighlightReel state={ready} onDone={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Begin' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus()
  })
})
