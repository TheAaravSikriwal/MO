import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { OFF_MAP_IN_VIEW } from './lib/data/types'

/**
 * A cut-short or failed list of off-map pins has to say so. Showing fewer, or
 * none, without a word would pass a partial list off as the whole one.
 */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

describe('App — the off-map pins it could not show', () => {
  it('says when there are more than it draws', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    for (let i = 0; i <= OFF_MAP_IN_VIEW; i += 1) {
      data.seed({ id: `r${i}`, lat: 51.5074, lng: -0.1278 })
      await data.setReportOnMap(`r${i}`, false)
    }
    render(<App data={data} />)
    expect(await screen.findByText(/not every pin taken off the map here is shown/i)).toBeInTheDocument()
  })

  it('says when they could not be loaded, rather than showing none', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    vi.spyOn(data, 'listOffMapInView').mockRejectedValue(new Error('network is down'))
    render(<App data={data} />)
    expect(await screen.findByText(/could not load the pins taken off the map here/i)).toBeInTheDocument()
  })

  it('says nothing when there is nothing to say', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    const lookup = vi.spyOn(data, 'listOffMapInView')
    render(<App data={data} />)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled())
    await lookup.mock.results[0].value
    expect(screen.queryByText(/taken off the map here/i)).not.toBeInTheDocument()
  })
})
