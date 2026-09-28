import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'

/**
 * The review queue and a report open side by side. Taking the pin off from the
 * report has to reach the queue's list of pins off the map without closing it.
 */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

describe('App — the queue hears about a pin taken off from a report', () => {
  it('shows the pin in the queue’s off-map list straight away', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
    data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278 })
    render(<App data={data} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /review queue/i }))
    await screen.findByRole('region', { name: /review queue/i })
    await user.click(await screen.findByRole('button', { name: /^litter reported here —/i }))

    await user.type(await screen.findByLabelText(/why take it off/i), 'a pin in the sea')
    await user.click(screen.getByRole('button', { name: /take off the map/i }))

    const queue = screen.getByRole('region', { name: /review queue/i })
    expect(await within(queue).findByText(/taken off because: a pin in the sea/i)).toBeInTheDocument()
  })
})
