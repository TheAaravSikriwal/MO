import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilterPanel } from './FilterPanel'
import { DEFAULT_FILTERS, type ReportFilters } from '../../lib/filters/reportFilters'

const setup = (over: Partial<Parameters<typeof FilterPanel>[0]> = {}) => {
  const onChange = vi.fn()
  const onUseMyLocation = vi.fn()
  render(
    <FilterPanel
      filters={DEFAULT_FILTERS}
      onChange={onChange}
      showing={5}
      total={5}
      onUseMyLocation={onUseMyLocation}
      hasLocation={false}
      {...over}
    />,
  )
  return { onChange, onUseMyLocation, user: userEvent.setup() }
}

const withFilters = (over: Partial<ReportFilters>) => ({ ...DEFAULT_FILTERS, ...over })

describe('FilterPanel — status', () => {
  it('offers everything, still there, and cleaned up', () => {
    setup()
    expect(screen.getByRole('button', { name: /everything/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /still there/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cleaned up/i })).toBeInTheDocument()
  })

  it('marks the active one, so it is not only a colour difference', () => {
    setup({ filters: withFilters({ status: 'cleaned' }) })
    expect(screen.getByRole('button', { name: /cleaned up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /everything/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('reports a change', async () => {
    const { user, onChange } = setup()
    await user.click(screen.getByRole('button', { name: /still there/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }))
  })
})

describe('FilterPanel — confirmations', () => {
  it('says how many people, in words', () => {
    setup({ filters: withFilters({ minConfirmations: 3 }) })
    expect(screen.getByLabelText(/at least 3 people/i)).toBeInTheDocument()
  })

  it('uses the singular for one person', () => {
    setup({ filters: withFilters({ minConfirmations: 1 }) })
    expect(screen.getByLabelText(/at least 1 person/i)).toBeInTheDocument()
  })
})

describe('FilterPanel — date', () => {
  it('reports a chosen date', async () => {
    const { user, onChange } = setup()
    await user.type(screen.getByLabelText(/added since/i), '2026-07-01')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ since: '2026-07-01' }))
  })

  it('clears back to null rather than an empty string', async () => {
    const { user, onChange } = setup({ filters: withFilters({ since: '2026-07-01' }) })
    await user.clear(screen.getByLabelText(/added since/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ since: null }))
  })
})

describe('FilterPanel — distance and location', () => {
  it('offers a way to share your location', async () => {
    const { user, onUseMyLocation } = setup()
    await user.click(screen.getByRole('button', { name: /use my location/i }))
    expect(onUseMyLocation).toHaveBeenCalled()
  })

  it('says the distance filter needs a location before it will do anything', () => {
    setup({ filters: withFilters({ withinMetres: 2000 }), hasLocation: false })
    expect(screen.getByText(/share your location to use this/i)).toBeInTheDocument()
  })

  it('drops that note once a location is known', () => {
    setup({ filters: withFilters({ withinMetres: 2000 }), hasLocation: true })
    expect(screen.queryByText(/share your location to use this/i)).not.toBeInTheDocument()
  })

  it('offers to update a location it already has', () => {
    setup({ hasLocation: true })
    expect(screen.getByRole('button', { name: /update my location/i })).toBeInTheDocument()
  })

  it('shows a plain message when locating did not work', () => {
    setup({ locatingMessage: 'You have not shared your location, so the map is not centred on you.' })
    expect(screen.getByRole('status')).toHaveTextContent(/not shared your location/i)
  })
})

describe('FilterPanel — clearing', () => {
  it('offers nothing to clear when nothing is set', () => {
    setup()
    expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument()
  })

  it('offers to clear once something is set', () => {
    setup({ filters: withFilters({ status: 'open' }) })
    expect(screen.getByRole('button', { name: /^clear$/i })).toBeInTheDocument()
  })

  it('keeps your location when clearing', async () => {
    // Clearing filters should not throw away permission you already granted.
    const origin = { lat: 51.5, lng: -0.12 }
    const { user, onChange } = setup({ filters: withFilters({ status: 'open', origin }) })
    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, origin })
  })
})

describe('FilterPanel — the count', () => {
  it('says the plain total when nothing is filtered out', () => {
    setup({ showing: 5, total: 5 })
    expect(screen.getByText('5 reports')).toBeInTheDocument()
  })

  it('says how many of how many when something is', () => {
    // Without this a filtered map looks like an area with nothing reported.
    setup({ showing: 2, total: 5 })
    expect(screen.getByText('2 of 5 reports')).toBeInTheDocument()
  })

  it('uses the singular for one', () => {
    setup({ showing: 1, total: 1 })
    expect(screen.getByText('1 report')).toBeInTheDocument()
  })
})

describe('FilterPanel — language', () => {
  it('keeps internal concepts out of the interface', () => {
    setup()
    const text = (document.body.textContent ?? '').toLowerCase()
    expect(text.length).toBeGreaterThan(0)
    for (const jargon of ['severity', 'hexagon', 'h3', 'resolution', 'moderation', 'status']) {
      expect(text).not.toContain(jargon)
    }
  })

  it('never describes a place or the people in it', () => {
    setup()
    const text = (document.body.textContent ?? '').toLowerCase()
    for (const word of ['dirty', 'filthy', 'slum', 'bad area']) {
      expect(text).not.toContain(word)
    }
  })
})
