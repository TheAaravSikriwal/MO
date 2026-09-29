import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { mapControl } from './test/globeMapMock'
import { cellsForPoint } from './lib/grid/cells'
import { cellRing } from './lib/map/features'
import { REPORT_PAGE_LIMIT } from './lib/data/types'

/** Picking a tower lists the reports in its area, on the right. */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

// Three reports in one r6 area of central London, and one far away in Leeds.
const LONDON_AREA = cellsForPoint(51.5074, -0.1278).cell_r6
const londonArea = async () => {
  await screen.findAllByTestId('cell')
  return document.querySelector(`[data-cell="${LONDON_AREA}"]`) as HTMLElement
}
const withArea = () => {
  const data = new FakeDataSource(null)
  data.seed({ id: 'a', lat: 51.5074, lng: -0.1278, note: 'Bags by the bench', voteCount: 2 })
  data.seed({ id: 'b', lat: 51.5078, lng: -0.1272, note: 'Cans in the hedge', voteCount: 9 })
  data.seed({ id: 'c', lat: 51.5071, lng: -0.128, note: 'Wrappers on the grass', voteCount: 5 })
  data.seed({ id: 'far', lat: 53.8, lng: -1.55, note: 'Far away', voteCount: 1 })
  // Just inside the area's bounding box but outside the hexagon itself: the
  // box is how the list is fetched, the hexagon is what it must keep to.
  const ring = cellRing(cellsForPoint(51.5074, -0.1278).cell_r6)
  const corner = { lat: Math.min(...ring.map(([, lat]) => lat)) + 0.0005, lng: Math.min(...ring.map(([lng]) => lng)) + 0.0005 }
  if (cellsForPoint(corner.lat, corner.lng).cell_r6 === cellsForPoint(51.5074, -0.1278).cell_r6) {
    throw new Error('the corner report landed inside the hexagon; move it')
  }
  data.seed({ id: 'corner', ...corner, note: 'Just outside the area', voteCount: 20 })
  return data
}

describe('the report catalog', () => {
  it('lists the reports in a picked area, most confirmed first, and only those', async () => {
    const user = userEvent.setup()
    render(<App data={withArea()} />)
    await mapControl.moveTo(10)
    const cell = await londonArea()
    await user.click(cell)

    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    expect(within(catalog).getByText(/3 reports, most confirmed first/)).toBeInTheDocument()
    await waitFor(() => expect(within(catalog).getAllByRole('button', { name: /confirmed/ })).toHaveLength(3))
    const names = within(catalog)
      .getAllByRole('button', { name: /confirmed/ })
      .map((b) => b.querySelector('span span')?.textContent)
    expect(names).toEqual(['Cans in the hedge', 'Wrappers on the grass', 'Bags by the bench'])
    expect(within(catalog).queryByText('Far away')).not.toBeInTheDocument()
    expect(within(catalog).queryByText('Just outside the area')).not.toBeInTheDocument()
    // The area is outlined on the map.
    expect(cell).toHaveAttribute('data-selected', 'yes')
  })

  it('opens a report from the list and flies the map to it', async () => {
    const user = userEvent.setup()
    render(<App data={withArea()} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await user.click(await within(catalog).findByRole('button', { name: /Cans in the hedge/ }))

    expect(await screen.findByRole('heading', { name: /Litter reported here/ })).toBeInTheDocument()
    expect(mapControl.flyTo).toHaveBeenLastCalledWith([51.5078, -0.1272], expect.any(Number))
  })

  it('closes', async () => {
    const user = userEvent.setup()
    render(<App data={withArea()} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await user.click(within(catalog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reports in this area' })).not.toBeInTheDocument())
  })

  it('says plainly when the list cannot be loaded', async () => {
    const user = userEvent.setup()
    const data = withArea()
    render(<App data={data} />)
    await mapControl.moveTo(10)
    const cell = await londonArea()
    vi.spyOn(data, 'listReportsInCell').mockRejectedValue(new Error('network down'))
    await user.click(cell)
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    expect(await within(catalog).findByRole('alert')).toBeInTheDocument()
  })
  it('leaves out reports still waiting to be checked, as the tower does', async () => {
    const user = userEvent.setup()
    const data = withArea()
    data.seed({ id: 'waiting', lat: 51.5075, lng: -0.1277, note: 'Not checked yet', voteCount: 30, moderationStatus: 'pending' })
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await waitFor(() => expect(within(catalog).getAllByRole('button', { name: /confirmed/ })).toHaveLength(3))
    expect(within(catalog).queryByText('Not checked yet')).not.toBeInTheDocument()
    expect(within(catalog).getByText(/^3 reports, most confirmed first/)).toBeInTheDocument()
  })

  it('reads the list again after a report in it changes', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource({ id: 'u1', email: 'a@b.com', isAdmin: false })
    data.seedName('u1', 'Sam', 'approved')
    data.seed({ id: 'b', lat: 51.5078, lng: -0.1272, note: 'Cans in the hedge', voteCount: 9 })
    // The real source hands back new rows on every read; the fake updates its
    // own in place, which would show a new count without any second read.
    const list = data.listReportsInCell.bind(data)
    vi.spyOn(data, 'listReportsInCell').mockImplementation(async (...args) => structuredClone(await list(...args)))
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await user.click(await within(catalog).findByRole('button', { name: /Cans in the hedge/ }))
    await user.click(await screen.findByRole('button', { name: 'Confirm this is here' }))
    expect(await within(catalog).findByText(/10 people confirmed/)).toBeInTheDocument()
  })

  it('says when an area holds more than one page, and only then', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    for (let i = 0; i <= REPORT_PAGE_LIMIT; i++) {
      data.seed({ id: `many-${i}`, lat: 51.5074 + (i % 20) * 0.00001, lng: -0.1278 + Math.floor(i / 20) * 0.00001, voteCount: i })
    }
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    expect(await within(catalog).findByText(/Showing the \d+ most confirmed here\./)).toBeInTheDocument()
    expect(within(catalog).getByText(/or more reports/)).toBeInTheDocument()
  })

  it('does not claim a cut-off when the whole area fits', async () => {
    const user = userEvent.setup()
    render(<App data={withArea()} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await waitFor(() => expect(within(catalog).getAllByRole('button', { name: /confirmed/ })).toHaveLength(3))
    expect(within(catalog).queryByText(/most confirmed here\./)).not.toBeInTheDocument()
  })
  it('counts what the list holds, not what the tower held when it was picked', async () => {
    const user = userEvent.setup()
    render(<App data={withArea()} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await waitFor(() => expect(within(catalog).getAllByRole('button', { name: /confirmed/ })).toHaveLength(3))
    fireEvent.change(screen.getByLabelText(/Confirmed by at least/), { target: { value: '6' } })
    await waitFor(() => expect(within(catalog).getAllByRole('button', { name: /confirmed/ })).toHaveLength(1))
    expect(within(catalog).getByText(/^1 report, most confirmed first/)).toBeInTheDocument()
  })
  it('shows the reporter’s own note only once it is approved, as the report screen does', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'w', lat: 51.5074, lng: -0.1278, note: 'My note, being checked', noteStatus: 'pending', viewerIsReporter: true, voteCount: 2 })
    data.seed({ id: 'x', lat: 51.5078, lng: -0.1272, note: 'My removed note', noteStatus: 'rejected', viewerIsReporter: true, voteCount: 1 })
    data.seed({ id: 'y', lat: 51.5071, lng: -0.128, note: 'Cans in the hedge', voteCount: 0 })
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await waitFor(() => expect(within(catalog).getAllByRole('button', { name: /confirmed/ })).toHaveLength(3))
    expect(within(catalog).queryByText('My note, being checked')).not.toBeInTheDocument()
    expect(within(catalog).queryByText('My removed note')).not.toBeInTheDocument()
    expect(within(catalog).getAllByText('Litter reported here')).toHaveLength(2)
    expect(within(catalog).getByText('Cans in the hedge')).toBeInTheDocument()
  })
  describe('on a phone', () => {
    const asPhone = () =>
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
    afterEach(() => vi.unstubAllGlobals())

    it('puts the list away when a report is opened from it, so the report can be read', async () => {
      asPhone()
      const user = userEvent.setup()
      render(<App data={withArea()} />)
      await mapControl.moveTo(10)
      await user.click(await londonArea())
      const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
      await user.click(await within(catalog).findByRole('button', { name: /Cans in the hedge/ }))
      expect(await screen.findByRole('heading', { name: /Litter reported here/ })).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Reports in this area' })).not.toBeInTheDocument())
    })

    // What this can check is the class: `max-md:hidden` hides the corner at
    // phone widths only, where the list is a sheet over it, and the test browser applies no styles, so whether
    // it is hidden on a real phone is up to Tailwind, not proven here.
    it('marks the layer switches to be hidden at phone widths while the list is open', async () => {
      asPhone()
      const user = userEvent.setup()
      render(<App data={withArea()} />)
      await mapControl.moveTo(10)
      expect(screen.getByTestId('layers-corner').classList.contains('max-md:hidden')).toBe(false)
      await user.click(await londonArea())
      await screen.findByRole('region', { name: 'Reports in this area' })
      expect(screen.getByTestId('layers-corner').classList.contains('max-md:hidden')).toBe(true)
    })
  })

  it('keeps the list open on a wide screen when a report is opened from it', async () => {
    const user = userEvent.setup()
    render(<App data={withArea()} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    await user.click(await within(catalog).findByRole('button', { name: /Cans in the hedge/ }))
    expect(await screen.findByRole('heading', { name: /Litter reported here/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Reports in this area' })).toBeInTheDocument()
  })
  it('lists the area’s own reports even when a busier neighbour fills the box round it', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'mine', lat: 51.5074, lng: -0.1278, note: 'Bags by the bench', voteCount: 1 })
    // A page and more of better-confirmed reports just outside the hexagon,
    // inside its bounding box.
    const ring = cellRing(LONDON_AREA)
    const corner = { lat: Math.min(...ring.map(([, lat]) => lat)) + 0.0005, lng: Math.min(...ring.map(([lng]) => lng)) + 0.0005 }
    expect(cellsForPoint(corner.lat, corner.lng).cell_r6).not.toBe(LONDON_AREA)
    for (let i = 0; i <= REPORT_PAGE_LIMIT; i++) data.seed({ id: `next-door-${i}`, ...corner, voteCount: 100 })
    render(<App data={data} />)
    await mapControl.moveTo(10)
    await user.click(await londonArea())
    const catalog = await screen.findByRole('region', { name: 'Reports in this area' })
    expect(await within(catalog).findByText('Bags by the bench')).toBeInTheDocument()
    expect(within(catalog).getByText(/^1 report, most confirmed first/)).toBeInTheDocument()
    expect(within(catalog).queryByText(/most confirmed here\./)).not.toBeInTheDocument()
  })
  describe('when the towers change', () => {
    const openList = async () => {
      const user = userEvent.setup()
      render(<App data={withArea()} />)
      await mapControl.moveTo(10)
      await user.click(await londonArea())
      await screen.findByRole('region', { name: 'Reports in this area' })
      return user
    }
    const gone = () =>
      waitFor(() => expect(screen.queryByRole('region', { name: 'Reports in this area' })).not.toBeInTheDocument())

    it('puts the list away when litter is switched off', async () => {
      const user = await openList()
      await user.click(screen.getByRole('switch', { name: /Litter reports/ }))
      await gone()
    })

    it('puts it away when the map moves to hexagons of another size', async () => {
      await openList()
      await mapControl.moveTo(8)
      await gone()
    })

    it('keeps it while the same size is showing, and among the dots', async () => {
      await openList()
      await mapControl.moveTo(10.3)
      expect(screen.getByRole('region', { name: 'Reports in this area' })).toBeInTheDocument()
      await mapControl.moveTo(14)
      expect(screen.getByRole('region', { name: 'Reports in this area' })).toBeInTheDocument()
    })
  })
  describe('the right side holds the list or the layers, never both', () => {
    it('folds the layers into their button while the list is open', async () => {
      const user = userEvent.setup()
      render(<App data={withArea()} />)
      await mapControl.moveTo(10)
      const panel = screen.getByTestId('layers-panel')
      expect(panel.classList.contains('roomy:block')).toBe(true)
      await user.click(await londonArea())
      await screen.findByRole('region', { name: 'Reports in this area' })
      expect(panel.classList.contains('roomy:block')).toBe(false)
      expect(panel.className).toContain('hidden')
      const button = screen.getByRole('button', { name: 'Layers' })
      expect(button.classList.contains('roomy:hidden')).toBe(false)
    })

    it('puts the list away and opens the layers from that button', async () => {
      const user = userEvent.setup()
      render(<App data={withArea()} />)
      await mapControl.moveTo(10)
      await user.click(await londonArea())
      await screen.findByRole('region', { name: 'Reports in this area' })
      await user.click(screen.getByRole('button', { name: 'Layers' }))
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Reports in this area' })).not.toBeInTheDocument())
      const panel = screen.getByTestId('layers-panel')
      expect(panel.className).toMatch(/(^|\s)block(\s|$)/)
      expect(screen.getByRole('button', { name: 'Hide layers' })).toHaveAttribute('aria-expanded', 'true')
    })
  })
})
