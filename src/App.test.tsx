import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

const flyToSpy = vi.fn()
const mapInstance = { flyTo: flyToSpy }

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => <div data-testid="tiles" />,
  Polygon: () => <div data-testid="cell" />,
  useMap: () => mapInstance,
  useMapEvents: () => null,
}))

const JARGON = [
  'hexagon',
  'h3',
  'geohash',
  'resolution',
  'cell',
  'aggregate',
  'polygon',
  'percentile',
  'oklch',
]

/** Visible text plus the attribute text a user actually reads. */
const collectVisibleText = (): string => {
  const parts: string[] = [document.body.textContent ?? '']
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of ['placeholder', 'aria-label', 'title', 'alt']) {
      const value = el.getAttribute(attr)
      if (value) parts.push(value)
    }
  }
  return parts.join(' ').toLowerCase()
}

const hydePark = [{ display_name: 'Hyde Park, London', lat: '51.5073', lon: '-0.1657' }]

describe('App', () => {
  beforeEach(() => {
    flyToSpy.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => hydePark }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lands directly on the map, not a splash page', () => {
    render(<App />)
    expect(screen.getByTestId('map')).toBeInTheDocument()
  })

  it('offers a place search box', () => {
    render(<App />)
    expect(screen.getByRole('searchbox', { name: /search for a place/i })).toBeInTheDocument()
  })

  it('shows no place suggestions before anyone types', () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: /hyde park/i })).not.toBeInTheDocument()
  })

  it('offers a way to add a report', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /add a report/i })).toBeInTheDocument()
  })

  it('says plainly when it is showing sample data rather than real reports', () => {
    render(<App />)
    expect(screen.getByText(/showing sample reports/i)).toBeInTheDocument()
  })

  it('asks people to sign in before they can add anything', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /add a report/i }))
    expect(await screen.findByText(/sign in to add a report/i)).toBeInTheDocument()
  })

  it('lists reports for people who cannot pick a pin out of the map', async () => {
    render(<App />)
    // Sample data is seeded, so there is something to reach by name.
    const listed = await screen.findAllByRole('button', { name: /confirmed/i })
    expect(listed.length).toBeGreaterThan(0)
  })

  it('shows a cleaned report as cleaned in that list', async () => {
    render(<App />)
    expect(await screen.findByRole('button', { name: /cleaned report/i })).toBeInTheDocument()
  })

  it('suggests places for a typed query and flies there when one is chosen', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByRole('searchbox', { name: /search for a place/i }), 'hyde park')

    const suggestion = await screen.findByRole('button', { name: /hyde park/i }, { timeout: 3000 })
    await user.click(suggestion)

    expect(flyToSpy).toHaveBeenCalledWith([51.5073, -0.1657], 16)
  })

  it('clears the suggestion list once a place is chosen', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByRole('searchbox', { name: /search for a place/i }), 'hyde park')
    const suggestion = await screen.findByRole('button', { name: /hyde park/i }, { timeout: 3000 })
    await user.click(suggestion)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /hyde park/i })).not.toBeInTheDocument()
    })
  })

  it('uses plain language, with no jargon in the interface', () => {
    render(<App />)
    // textContent alone is empty on first render, which would make this check
    // vacuous. Gather visible attribute text too, and assert there is something
    // to inspect before asserting what is absent from it.
    const visibleText = collectVisibleText()
    expect(visibleText.length).toBeGreaterThan(0)
    for (const jargon of JARGON) {
      expect(visibleText).not.toContain(jargon)
    }
  })

  it('keeps jargon out of the suggestion list too', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.type(screen.getByRole('searchbox', { name: /search for a place/i }), 'hyde park')
    await screen.findByRole('button', { name: /hyde park/i }, { timeout: 3000 })

    const visibleText = collectVisibleText()
    expect(visibleText).toContain('hyde park')
    for (const jargon of JARGON) {
      expect(visibleText).not.toContain(jargon)
    }
  })
})
