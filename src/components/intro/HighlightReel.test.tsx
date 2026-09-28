import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HighlightReel, leafSpots, SLIDE_EXIT_MS } from './HighlightReel'
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

// Moving on waits for the slide to leave, so what comes next is waited for.
const next = async (user: ReturnType<typeof userEvent.setup>, name: RegExp | string = /Begin|Next/) =>
  user.click(screen.getByRole('button', { name }))

describe('HighlightReel', () => {
  it('opens with a welcome to tidy, then one big figure at a time with its cause and source', async () => {
    const user = userEvent.setup()
    render(<HighlightReel state={ready} onDone={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Introduction to tidy' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'tidy' })).toBeInTheDocument()
    expect(screen.getByText('Welcome to')).toBeInTheDocument()

    await next(user, 'Begin')
    // Air: 40 - 0.6i is above the WHO's 5 for i up to 58, so 59 of the 60.
    expect(await screen.findByText('59 of 60')).toBeInTheDocument()
    expect(screen.getByText(/breathe air with more fine dust than the World Health Organization says is safe/)).toBeInTheDocument()
    expect(screen.getByText(/Most of it comes from burning things/)).toBeInTheDocument()
    expect(screen.getByText(/World Health Organization, latest yearly figures/)).toBeInTheDocument()

    await next(user, 'Next')
    expect(await screen.findByText('979,000 tonnes')).toBeInTheDocument()
    await next(user, 'Next')
    expect(await screen.findByText('16,387')).toBeInTheDocument()
    await next(user, 'Next')
    expect(await screen.findByText(/of the rivers, lakes and groundwater tested are in good condition/)).toBeInTheDocument()
    await next(user, 'Next')
    expect(await screen.findByText(/A link, not proof of cause/)).toBeInTheDocument()
  })

  it('ends on what anyone can do, and hands over to the map once that slide has left', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<HighlightReel state={ready} onDone={onDone} />)
    for (const expected of ['59 of 60', '979,000 tonnes', '16,387', /in good condition/, /not proof of cause/, 'Litter is local.']) {
      await next(user)
      await screen.findByText(expected)
    }
    expect(screen.getByText('So is cleaning it up.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start exploring' }))
    expect(onDone).not.toHaveBeenCalled()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('lets each slide leave before the next arrives: words fade off and leaves drift away', async () => {
    vi.useFakeTimers()
    try {
      render(<HighlightReel state={ready} onDone={vi.fn()} />)
      const foliage = screen.getByTestId('foliage')
      expect(foliage).toHaveAttribute('data-leaving', 'no')
      expect(screen.getAllByTestId('leaf').every((l) => l.getAttribute('class') === 'mo-leaf-in')).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Begin' }))
      expect(screen.getByTestId('foliage')).toHaveAttribute('data-leaving', 'yes')
      expect(screen.getAllByTestId('leaf').every((l) => l.getAttribute('class') === 'mo-leaf-out')).toBe(true)
      expect(screen.getByText('Welcome to').closest('.mo-reel-leave')).not.toBeNull()
      // Still the welcome while it leaves.
      expect(screen.queryByText('59 of 60')).not.toBeInTheDocument()

      act(() => vi.advanceTimersByTime(SLIDE_EXIT_MS))
      expect(screen.getByText('59 of 60')).toBeInTheDocument()
      expect(screen.getByTestId('foliage')).toHaveAttribute('data-leaving', 'no')
      expect(screen.getAllByTestId('leaf').every((l) => l.getAttribute('class') === 'mo-leaf-in')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives every slide its own leaves, the same each time', () => {
    const where = (n: number) => JSON.stringify(leafSpots(n))
    expect(where(0)).not.toBe(where(1))
    expect(where(1)).not.toBe(where(2))
    expect(where(3)).toBe(where(3))
    // Always round the edges, never in the middle over the words.
    for (let n = 0; n < 8; n++) {
      for (const s of leafSpots(n)) expect(s.x < 150 || s.x > 950).toBe(true)
    }
  })

  it('has a large skip at the top, and another under the button, both straight to the map', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<HighlightReel state={ready} onDone={onDone} />)
    await user.click(screen.getByRole('button', { name: 'Skip intro' }))
    expect(onDone).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'or skip straight to the map' }))
    expect(onDone).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDone).toHaveBeenCalledTimes(3)
  })

  it('skips at once even while a slide is leaving', () => {
    vi.useFakeTimers()
    try {
      const onDone = vi.fn()
      render(<HighlightReel state={ready} onDone={onDone} />)
      fireEvent.click(screen.getByRole('button', { name: 'Begin' }))
      fireEvent.click(screen.getByRole('button', { name: 'Skip intro' }))
      expect(onDone).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(SLIDE_EXIT_MS * 2))
      expect(onDone).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves on with the arrow keys too, and back', async () => {
    render(<HighlightReel state={ready} onDone={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await screen.findByText('59 of 60')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(await screen.findByText('Welcome to')).toBeInTheDocument()
  })

  it('says it is gathering the figures while they load, and shows them when they come', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<HighlightReel state={{ status: 'loading' }} onDone={vi.fn()} />)
    await next(user, 'Begin')
    expect(await screen.findByRole('status')).toHaveTextContent('Gathering the latest figures…')
    rerender(<HighlightReel state={ready} onDone={vi.fn()} />)
    expect(screen.getByText('59 of 60')).toBeInTheDocument()
  })

  it('still welcomes and hands over when the figures cannot be loaded', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<HighlightReel state={{ status: 'failed', message: 'x', retry: vi.fn() }} onDone={onDone} />)
    await next(user, 'Begin')
    expect(await screen.findByText('Litter is local.')).toBeInTheDocument()
    expect(screen.getByText(/could not be loaded just now/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start exploring' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('puts the button to move on in reach of the keyboard on every slide', async () => {
    const user = userEvent.setup()
    render(<HighlightReel state={ready} onDone={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Begin' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus())
  })
})
