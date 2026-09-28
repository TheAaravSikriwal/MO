import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { mapControl } from './test/globeMapMock'
import { cellsForPoint } from './lib/grid/cells'
import type { CatalogState } from './components/map/CellCatalog'

/**
 * What the screen shows in every render, not just once things settle: a test
 * that waits sees only the end, and these two mistakes lasted one render each.
 */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

const seen = vi.hoisted(() => ({
  catalog: [] as Array<{ status: string; notes: string[] }>,
  worldSizes: [] as number[],
}))

vi.mock('./components/map/CellCatalog', async (original) => {
  const real = await original<typeof import('./components/map/CellCatalog')>()
  return {
    ...real,
    CellCatalog: (props: Parameters<typeof real.CellCatalog>[0]) => {
      const state = props.state as CatalogState
      seen.catalog.push({ status: state.status, notes: state.status === 'ready' ? state.reports.map((r) => r.note ?? '') : [] })
      return real.CellCatalog(props)
    },
  }
})

vi.mock('./lib/worlddata/useWorldData', async (original) => {
  const real = await original<typeof import('./lib/worlddata/useWorldData')>()
  return {
    ...real,
    useWorldData: (...args: Parameters<typeof real.useWorldData>) => {
      seen.worldSizes.push(args[1])
      return real.useWorldData(...args)
    },
  }
})

beforeEach(() => {
  seen.catalog = []
  seen.worldSizes = []
})

describe('the list behind a tower, render by render', () => {
  it('never opens on the last area’s reports when another is picked', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'london', lat: 51.5074, lng: -0.1278, note: 'Bags by the bench', voteCount: 2 })
    data.seed({ id: 'north', lat: 51.545, lng: -0.09, note: 'Cans by the canal', voteCount: 1 })
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await screen.findAllByTestId('cell')
    const cellFor = (lat: number, lng: number) =>
      document.querySelector(`[data-cell="${cellsForPoint(lat, lng).cell_r6}"]`) as HTMLElement

    await user.click(cellFor(51.5074, -0.1278))
    const list = await screen.findByRole('region', { name: 'Reports in this area' })
    await within(list).findByText('Bags by the bench')
    await user.click(within(list).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reports in this area' })).not.toBeInTheDocument())

    seen.catalog = []
    await user.click(cellFor(51.545, -0.09))
    await within(await screen.findByRole('region', { name: 'Reports in this area' })).findByText('Cans by the canal')
    // From the first render of the new list, never London's.
    expect(seen.catalog.length).toBeGreaterThan(0)
    for (const render of seen.catalog) expect(render.notes).not.toContain('Bags by the bench')
    expect(seen.catalog[0].status).toBe('loading')
  })
})

describe('fires on the litter’s grid, render by render', () => {
  it('are asked for at the size the towers are drawn at, not the size the zoom is heading for', async () => {
    const data = new FakeDataSource(null)
    data.seed({ id: 'r', lat: 51.5074, lng: -0.1278, voteCount: 2 })
    // Hold the new towers back, so there is a stretch where the zoom has
    // moved on and the towers have not.
    let release: () => void = () => {}
    const listCells = data.getRollup.bind(data)
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await screen.findAllByTestId('cell')
    const drawnAt = Number(screen.getByTestId('map').getAttribute('data-cells-key'))
    vi.spyOn(data, 'getRollup').mockImplementation(
      (...args) => new Promise((resolve) => (release = () => resolve(listCells(...args)))),
    )
    seen.worldSizes = []
    await mapControl.moveTo(7)
    // The zoom is at another size now; the towers, and so the fires, are not.
    expect(seen.worldSizes.length).toBeGreaterThan(0)
    for (const size of seen.worldSizes) expect(size).toBe(drawnAt)
    release()
    await waitFor(() => expect(Number(screen.getByTestId('map').getAttribute('data-cells-key'))).not.toBe(drawnAt))
    const now = Number(screen.getByTestId('map').getAttribute('data-cells-key'))
    expect(seen.worldSizes[seen.worldSizes.length - 1]).toBe(now)
  })
})
