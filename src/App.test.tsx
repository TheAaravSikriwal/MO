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

  it('shows no suggestions before anyone types', () => {
    render(<App />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
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
    const text = document.body.textContent ?? ''
    for (const jargon of ['hexagon', 'H3', 'cell', 'resolution', 'geohash']) {
      expect(text.toLowerCase()).not.toContain(jargon.toLowerCase())
    }
  })
})
