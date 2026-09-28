import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { mapControl } from './test/globeMapMock'
import { forgetWorldData } from './lib/worlddata/useWorldData'
import { AIR_POLLUTION_CSV, COUNTRIES_URL } from './lib/worlddata/sources'
import { REPORT_PAGE_LIMIT } from './lib/data/types'

/** What is on the map: the switches, and the world data. */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

afterEach(() => {
  vi.unstubAllGlobals()
  forgetWorldData()
})

const withReports = () => {
  const data = new FakeDataSource(null)
  data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278, voteCount: 3 })
  data.seed({ id: 'r2', lat: 51.52, lng: -0.1, voteCount: 1 })
  return data
}

describe('the layer switches', () => {
  it('takes the litter towers off the map and puts them back', async () => {
    const user = userEvent.setup()
    render(<App data={withReports()} />)
    await mapControl.moveTo(10)
    await waitFor(() => expect(screen.getAllByTestId('cell').length).toBeGreaterThan(0))

    await user.click(screen.getByRole('switch', { name: /Litter reports/ }))
    expect(screen.queryAllByTestId('cell')).toHaveLength(0)

    await user.click(screen.getByRole('switch', { name: /Litter reports/ }))
    await waitFor(() => expect(screen.getAllByTestId('cell').length).toBeGreaterThan(0))
  })

  it('takes the reports off the list read out to screen readers too', async () => {
    const user = userEvent.setup()
    render(<App data={withReports()} />)
    await mapControl.moveTo(10)
    const readOut = () => screen.queryAllByRole('button', { name: /Litter reported here — \d+ confirmed/ })
    await waitFor(() => expect(readOut()).toHaveLength(2))
    await user.click(screen.getByRole('switch', { name: /Litter reports/ }))
    expect(readOut()).toHaveLength(0)
  })

  it('lets the left column scroll on its own when it is taller than the window', () => {
    render(<App data={withReports()} />)
    const column = screen.getByRole('searchbox', { name: 'Search for a place' }).closest('.mo-column')
    expect(column).not.toBeNull()
    expect(column!.className).toContain('overflow-y-auto')
  })

  it('takes individual pins off too, up close', async () => {
    const user = userEvent.setup()
    render(<App data={withReports()} />)
    await mapControl.moveTo(16)
    await waitFor(() => expect(screen.getAllByTestId('pin').length).toBeGreaterThan(0))
    await user.click(screen.getByRole('switch', { name: /Litter reports/ }))
    expect(screen.queryAllByTestId('pin')).toHaveLength(0)
  })

  it('says when there are more dots than it can draw at once, and not otherwise', async () => {
    const data = new FakeDataSource(null)
    for (let i = 0; i <= REPORT_PAGE_LIMIT; i++) {
      data.seed({ id: `many-${i}`, lat: 51.5 + (i % 25) * 0.001, lng: -0.13 + Math.floor(i / 25) * 0.001, voteCount: i })
    }
    render(<App data={data} />)
    await mapControl.moveTo(13)
    expect(await screen.findByText(/Zoom in to see the rest/)).toBeInTheDocument()
    expect(screen.getAllByTestId('pin')).toHaveLength(REPORT_PAGE_LIMIT)
  })

  it('does not say it for a handful of dots', async () => {
    render(<App data={withReports()} />)
    await mapControl.moveTo(16)
    await waitFor(() => expect(screen.getAllByTestId('pin').length).toBeGreaterThan(0))
    expect(screen.queryByText(/Zoom in to see the rest/)).not.toBeInTheDocument()
  })
})

describe('world data', () => {
  const files = () =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === AIR_POLLUTION_CSV) return new Response('entity,code,year,population_weighted_pm25\nIndia,IND,2024,83.2\n')
      if (url === COUNTRIES_URL) {
        return new Response(
          JSON.stringify({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: { iso: 'IND', name: 'India' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
          }),
        )
      }
      return new Response('[]')
    })

  it('puts the chosen layer on the map, and takes it off again', async () => {
    vi.stubGlobal('fetch', files())
    const user = userEvent.setup()
    render(<App data={withReports()} />)
    expect(screen.getByTestId('map')).toHaveAttribute('data-world', '')

    await user.click(screen.getByRole('radio', { name: 'Air pollution' }))
    await waitFor(() => expect(screen.getByTestId('map')).toHaveAttribute('data-world', 'air'))
    expect(await screen.findByText(/1 country, 2024/)).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'No world data' }))
    await waitFor(() => expect(screen.getByTestId('map')).toHaveAttribute('data-world', ''))
  })

  it('says so when a source cannot be reached, and draws nothing in its place', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const user = userEvent.setup()
    render(<App data={withReports()} />)
    await user.click(screen.getByRole('radio', { name: 'Air pollution' }))
    expect(await screen.findByText(/Could not load the air pollution figures right now/)).toBeInTheDocument()
    expect(screen.getByTestId('map')).toHaveAttribute('data-world', '')
  })
})

describe('the layers on a phone', () => {
  it('fold behind a button that opens and closes them', async () => {
    const user = userEvent.setup()
    render(<App data={withReports()} />)
    const button = screen.getByRole('button', { name: 'Layers' })
    const panel = document.getElementById('mo-layers')!
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel.className).toMatch(/(^|\s)hidden(\s|$)/)
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel.className).toMatch(/(^|\s)block(\s|$)/)
    expect(screen.getByRole('button', { name: 'Hide layers' })).toBeInTheDocument()
  })
})
