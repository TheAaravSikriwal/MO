import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'

/**
 * Opening another pin must give a fresh panel. A reason typed for one pin was
 * otherwise carried to the next and recorded against it for good.
 */

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: unknown }) => <div data-testid="map">{children as never}</div>,
  TileLayer: () => <div data-testid="tiles" />,
  Polygon: () => <div data-testid="cell" />,
  CircleMarker: () => <span data-testid="pin" />,
  useMap: () => ({ flyTo: vi.fn() }),
  useMapEvents: () => null,
}))

describe('App — switching from one report to another', () => {
  it('does not carry a typed reason over to the next pin', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
    data.seed({ id: 'a', lat: 51.5074, lng: -0.1278, voteCount: 2 })
    data.seed({ id: 'b', lat: 51.5075, lng: -0.1279, voteCount: 1 })
    render(<App data={data} />)
    const user = userEvent.setup()

    const [first, second] = await screen.findAllByRole('button', { name: /^litter reported here —/i })
    await user.click(first)
    await user.type(await screen.findByLabelText(/why take it off/i), 'about the first pin')
    await user.click(second)

    expect(await screen.findByLabelText(/why take it off/i)).toHaveValue('')
  })
})
