import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App, { IDEA_VISITOR_EMAIL } from './App'

/**
 * The switch between "The idea" (made-up reports) and "Real world".
 *
 * Rendered with NO injected source, the way the app actually starts, and with
 * no database configured -- which is how it runs locally, and the case where
 * mistaking one side for the other is easiest.
 */

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => <div data-testid="tiles" />,
  Polygon: () => <div data-testid="cell" />,
  CircleMarker: () => <div data-testid="pin" />,
  useMap: () => ({ flyTo: vi.fn() }),
  useMapEvents: () => null,
}))

const switchGroup = () => screen.getByRole('radiogroup', { name: 'Which reports to show' })
const side = (name: RegExp) => within(switchGroup()).getByRole('radio', { name })

/** Long enough for every pending load to land, so an absence is a real one. */
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100))
})

beforeEach(() => {
  // No database, whatever a local .env says: that is the case under test.
  vi.stubEnv('VITE_SUPABASE_URL', '')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
  // A small idea, so each render seeds forty reports rather than twenty thousand.
  window.history.replaceState(null, '', '/?count=40')
})

afterEach(() => {
  vi.unstubAllEnvs()
  window.history.replaceState(null, '', '/')
})

describe('the switch between the idea and the real world', () => {
  it('opens on The idea when no database is connected, and says every report is made up', async () => {
    render(<App />)
    expect(side(/The idea/)).toHaveAttribute('aria-checked', 'true')
    expect(side(/Real world/)).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Every report on this map is made up/)).toBeInTheDocument()
    expect(screen.getByTestId('world-frame')).toHaveAttribute('data-world', 'idea')
    await waitFor(() => expect(screen.getByText(/of 40 reports/)).toBeInTheDocument())
    expect(new URLSearchParams(window.location.search).get('world')).toBe('idea')
  })

  it('says plainly that the real world is not connected, and offers nothing that would look real', async () => {
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText(/of 40 reports/)).toBeInTheDocument())
    await user.click(side(/Real world/))
    await settle()

    expect(side(/Real world/)).toHaveAttribute('aria-checked', 'true')
    expect(side(/Real world/)).toHaveTextContent('Not connected yet')
    expect(screen.getByText(/not connected to the real reports yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Every report on this map is made up/)).not.toBeInTheDocument()
    expect(screen.getByTestId('world-frame')).toHaveAttribute('data-world', 'real')
    // Nowhere real to save a report or send a sign-in link to.
    expect(screen.queryByRole('button', { name: /Add a report/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send link' })).not.toBeInTheDocument()
    // And none of the idea's reports leak across.
    expect(screen.queryByText(/of 40 reports/)).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('world')).toBe('real')
  })

  it('goes back to the same made-up reports, and keeps the rest of the address', async () => {
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText(/of 40 reports/)).toBeInTheDocument())
    await user.click(side(/Real world/))
    await user.click(side(/The idea/))

    expect(side(/The idea/)).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByText(/of 40 reports/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Add a report/ })).toBeInTheDocument()
    const params = new URLSearchParams(window.location.search)
    expect(params.get('world')).toBe('idea')
    expect(params.get('count')).toBe('40')
  })

  it('keeps what was done on the made-up side when switching away and back', async () => {
    // A fresh idea would also hold forty reports, so the count alone cannot
    // tell a kept source from a rebuilt one. Being signed in can.
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Try it signed in' }))
    expect(await screen.findByText(IDEA_VISITOR_EMAIL)).toBeInTheDocument()
    await user.click(side(/Real world/))
    await settle()
    expect(screen.queryByText(IDEA_VISITOR_EMAIL)).not.toBeInTheDocument()
    await user.click(side(/The idea/))
    expect(await screen.findByText(IDEA_VISITOR_EMAIL)).toBeInTheDocument()
  })

  it('never asks for a real email address on the made-up side', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Send link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try it signed in' }))
    expect(await screen.findByText(IDEA_VISITOR_EMAIL)).toBeInTheDocument()
  })

  it('opens on whichever side the address names', () => {
    window.history.replaceState(null, '', '/?world=real')
    render(<App />)
    expect(side(/Real world/)).toHaveAttribute('aria-checked', 'true')
  })
})
