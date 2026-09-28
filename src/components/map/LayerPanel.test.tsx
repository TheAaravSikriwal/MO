import { describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LayerPanel, legendNumber, type LayerPanelProps } from './LayerPanel'

const setup = (over: Partial<LayerPanelProps> = {}) => {
  const props: LayerPanelProps = {
    showReports: true,
    onShowReports: vi.fn(),
    showGroups: true,
    onShowGroups: vi.fn(),
    world: null,
    onWorld: vi.fn(),
    worldData: { status: 'off' },
    ...over,
  }
  render(<LayerPanel {...props} />)
  return { props, user: userEvent.setup() }
}

describe('LayerPanel', () => {
  it('switches litter reports and cleaning groups on and off, each on its own', async () => {
    const { props, user } = setup({ showGroups: false })
    const reports = screen.getByRole('switch', { name: /Litter reports/ })
    const groups = screen.getByRole('switch', { name: /Cleaning groups/ })
    expect(reports).toHaveAttribute('aria-checked', 'true')
    expect(groups).toHaveAttribute('aria-checked', 'false')
    await user.click(reports)
    expect(props.onShowReports).toHaveBeenCalledWith(false)
    await user.click(groups)
    expect(props.onShowGroups).toHaveBeenCalledWith(true)
  })

  it('offers one world layer at a time, or none', async () => {
    const { props, user } = setup()
    expect(screen.getByRole('radio', { name: 'No world data' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'Plastic into the ocean' }))
    expect(props.onWorld).toHaveBeenCalledWith('plastic')
  })

  it('says what a layer measures, its real range and where it comes from, once loaded', () => {
    setup({
      world: 'air',
      worldData: {
        status: 'ready',
        layer: 'air',
        overlay: { layer: 'air', features: { type: 'FeatureCollection', features: [] } },
        legend: { range: { low: 5.1, middle: 20, high: 75.5 }, count: 172, year: 2024, savedOn: null },
      },
    })
    expect(screen.getByText(/Fine dust in the air people breathe/)).toBeInTheDocument()
    expect(screen.getByText('5.1')).toBeInTheDocument()
    expect(screen.getByText(/75\.5 micrograms per cubic metre/)).toBeInTheDocument()
    expect(screen.getByText(/172 countries, 2024\. Source: World Health Organization/)).toBeInTheDocument()
  })

  it('counts hot spots, not fires, for today’s fires', () => {
    setup({
      world: 'fires',
      worldData: {
        status: 'ready',
        layer: 'fires',
        overlay: { layer: 'fires', features: { type: 'FeatureCollection', features: [] } },
        legend: { range: { low: 1, middle: 3, high: 240 }, count: 18565, year: null, savedOn: null },
      },
    })
    expect(screen.getByText(/18,565 hot spots seen in the last 24 hours/)).toBeInTheDocument()
  })

  it('says so when it is showing a saved copy, and from which day', () => {
    setup({
      world: 'fires',
      worldData: {
        status: 'ready',
        layer: 'fires',
        overlay: { layer: 'fires', features: { type: 'FeatureCollection', features: [] } },
        legend: { range: { low: 1, middle: 3, high: 240 }, count: 13627, year: null, savedOn: '2026-09-28' },
      },
    })
    expect(screen.getByText(/13,627 hot spots seen in the 24 hours to 28 Sep 2026/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'The live file could not be reached, so this is a copy saved on 28 Sep 2026.',
    )
  })

  it('says one country, not one countries', () => {
    setup({
      world: 'air',
      worldData: {
        status: 'ready',
        layer: 'air',
        overlay: { layer: 'air', features: { type: 'FeatureCollection', features: [] } },
        legend: { range: { low: 5, middle: 5, high: 5 }, count: 1, year: 2024, savedOn: null },
      },
    })
    expect(screen.getByText(/^1 country, 2024\./)).toBeInTheDocument()
  })

  it('heads live fires "today", and a saved copy with its own day', () => {
    const fires = (savedOn: string | null) => ({
      world: 'fires' as const,
      worldData: {
        status: 'ready' as const,
        layer: 'fires' as const,
        overlay: { layer: 'fires' as const, features: { type: 'FeatureCollection' as const, features: [] } },
        legend: { range: { low: 1, middle: 3, high: 240 }, count: 10, year: null, savedOn },
      },
    })
    setup(fires(null))
    expect(screen.getByText('Fires today')).toBeInTheDocument()
    cleanup()
    setup(fires('2026-09-28'))
    expect(screen.getByText('Fires in the 24 hours to 28 Sep 2026')).toBeInTheDocument()
    expect(screen.queryByText(/today/)).not.toBeInTheDocument()
  })

  it('says nothing of saved copies when the live file came', () => {
    setup({
      world: 'air',
      worldData: {
        status: 'ready',
        layer: 'air',
        overlay: { layer: 'air', features: { type: 'FeatureCollection', features: [] } },
        legend: { range: { low: 5.1, middle: 20, high: 75.5 }, count: 172, year: 2024, savedOn: null },
      },
    })
    expect(screen.queryByText(/copy saved on/)).not.toBeInTheDocument()
  })

  it('says plainly while it loads, and when a source cannot be reached', () => {
    setup({ world: 'fires', worldData: { status: 'loading', layer: 'fires' } })
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
  })

  it('shows the failure in words when a source cannot be reached, with a way to ask again', async () => {
    const retry = vi.fn()
    setup({ world: 'fires', worldData: { status: 'failed', layer: 'fires', message: 'Could not load today’s fires right now.', retry } })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load today’s fires right now.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('legendNumber', () => {
  it('rounds big figures and keeps one decimal on small ones', () => {
    expect(legendNumber(356371.4)).toBe('356,371')
    expect(legendNumber(5.14)).toBe('5.1')
  })
})
