import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'

/**
 * A pin off the map, through the whole app.
 *
 * App used to drop every off-map report before drawing anything, so the
 * reporter was never told their pin was taken off and an admin who closed it
 * could never find it again to put it back. Rendering ReportDetail on its own
 * hid that, which is why these go through App.
 */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

const offMapFor = (viewer: { id: string; isAdmin: boolean }) => {
  const data = new FakeDataSource(viewer, { displayName: 'Sam' })
  data.seed({
    id: 'r1',
    lat: 51.5074,
    lng: -0.1278,
    moderationStatus: 'rejected',
    viewerIsReporter: viewer.id === 'u1',
  })
  data.seedReporter('r1', 'u1')
  // A live pin too, so a test can wait for the reports to load before saying
  // anything about what is not there.
  data.seed({ id: 'r2', lat: 51.5075, lng: -0.1279 })
  return data
}

describe('App — a pin off the map', () => {
  it('can still be found by the person who added it, and tells them it was taken off', async () => {
    const user = userEvent.setup()
    render(<App data={offMapFor({ id: 'u1', isAdmin: false })} />)
    await user.click(await screen.findByRole('button', { name: /off the map/i }))
    expect(
      await screen.findByText(/taken off the map. Other people can no longer see it/i),
    ).toBeInTheDocument()
  })

  it('can still be found by an admin, who can put it back', async () => {
    const user = userEvent.setup()
    const data = offMapFor({ id: 'admin-1', isAdmin: true })
    render(<App data={data} />)
    await user.click(await screen.findByRole('button', { name: /litter reported here \(off the map\)/i }))
    await user.click(await screen.findByRole('button', { name: /put back on the map/i }))
    await waitFor(async () => expect((await data.getReport('r1'))!.moderationStatus).toBe('approved'))
  })

  it('is not there at all for anybody else', async () => {
    const data = offMapFor({ id: 'u2', isAdmin: false })
    const offMapLookup = vi.spyOn(data, 'listOffMapInView')
    render(<App data={data} />)
    // Wait for the reports -- live and off the map -- to have loaded, or this
    // passes before anything could have been drawn.
    expect(await screen.findByRole('button', { name: /^litter reported here —/i })).toBeInTheDocument()
    await waitFor(() => expect(offMapLookup).toHaveBeenCalled())
    await offMapLookup.mock.results[0].value
    expect(screen.queryByRole('button', { name: /off the map/i })).not.toBeInTheDocument()
  })

  it('does not count an off-map pin among the reports on the map', async () => {
    // What the panel SAYS, with the off-map pin drawn beside the live one.
    render(<App data={offMapFor({ id: 'admin-1', isAdmin: true })} />)
    await screen.findByRole('button', { name: /off the map/i })
    expect(await screen.findByText(/^1 report$/)).toBeInTheDocument()
  })

  it('hides an off-map pin that the filters would hide, like any other', async () => {
    const user = userEvent.setup()
    render(<App data={offMapFor({ id: 'admin-1', isAdmin: true })} />)
    await screen.findByRole('button', { name: /off the map/i })
    // The off-map pin is still open, so asking for cleaned spots hides it.
    await user.click(screen.getByRole('button', { name: /cleaned up/i }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /off the map/i })).not.toBeInTheDocument(),
    )
  })
})
