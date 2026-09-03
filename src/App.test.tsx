import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { CROSSFADE_MS } from './components/map/CellLayer'

const flyToSpy = vi.fn()
const mapInstance = { flyTo: flyToSpy }

/**
 * Captured so tests can actually move the map.
 *
 * With useMapEvents stubbed to null the view was pinned at the world zoom for
 * the whole file, so the pin layer never mounted and every assertion about pins
 * passed no matter what the code did.
 */
let mapEvents: Record<string, (event: unknown) => void> = {}

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => <div data-testid="tiles" />,
  Polygon: () => <div data-testid="cell" />,
  CircleMarker: ({ eventHandlers }: any) => (
    <button type="button" data-testid="pin" onClick={eventHandlers?.click} />
  ),
  useMap: () => mapInstance,
  useMapEvents: (handlers: Record<string, (event: unknown) => void>) => {
    mapEvents = handlers
    return null
  },
}))

/** Drive the map the way Leaflet would after a pan or zoom. */
const moveMapTo = async (zoom: number, center: [number, number] = [51.5074, -0.1278]) => {
  await act(async () => {
    mapEvents.moveend?.({
      target: {
        getCenter: () => ({ lat: center[0], lng: center[1] }),
        getZoom: () => zoom,
        getBounds: () => ({
          getSouth: () => center[0] - 0.05,
          getWest: () => center[1] - 0.05,
          getNorth: () => center[0] + 0.05,
          getEast: () => center[1] + 0.05,
        }),
      },
    })
  })
}

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
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('searchbox')

    // The default view shows what is still there, so ask for everything first.
    await user.click(screen.getByRole('button', { name: /everything/i }))
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

describe('App — the admin gate', () => {
  const adminSource = (isAdmin: boolean) => {
    const data = new FakeDataSource({ id: 'u1', email: 'a@b.com', isAdmin })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    return data
  }

  it('offers no way in for a signed-out visitor', async () => {
    render(<App data={new FakeDataSource(null)} />)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /review queue/i })).not.toBeInTheDocument(),
    )
  })

  it('offers no way in for an ordinary signed-in person', async () => {
    render(<App data={adminSource(false)} />)
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /review queue/i })).not.toBeInTheDocument()
  })

  it('offers it to an admin', async () => {
    render(<App data={adminSource(true)} />)
    expect(await screen.findByRole('button', { name: /review queue/i })).toBeInTheDocument()
  })

  it('opens the queue for an admin', async () => {
    const user = userEvent.setup()
    render(<App data={adminSource(true)} />)
    await user.click(await screen.findByRole('button', { name: /review queue/i }))
    expect(await screen.findByRole('region', { name: /review queue/i })).toBeInTheDocument()
  })

  it('does not ask a non-admin backend for the queue at all', async () => {
    const data = adminSource(false)
    const spy = vi.spyOn(data, 'listModerationQueue')
    render(<App data={data} />)
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeInTheDocument())
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('App — pins and cells never draw together', () => {
  const withReports = () => {
    const data = new FakeDataSource(null)
    data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278, voteCount: 2 })
    return data
  }

  it('aggregates into cells when zoomed out, with no pins', async () => {
    render(<App data={withReports()} />)
    // The map opens at the world view.
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument())
    expect(screen.queryByTestId('pin')).not.toBeInTheDocument()
  })

  it('draws pins once you are close enough to tell reports apart', async () => {
    render(<App data={withReports()} />)
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument())
    expect(screen.queryByTestId('pin')).not.toBeInTheDocument()

    await moveMapTo(16)
    await waitFor(() => expect(screen.getAllByTestId('pin').length).toBeGreaterThan(0))

    // The hexagons fade out rather than vanishing in one frame, so they may
    // still be on screen for a moment. What must not happen is both being shown
    // together once things settle -- that says the same thing twice.
    await waitFor(() => expect(screen.queryByTestId('cell')).not.toBeInTheDocument())
  })

  it('leaves rejected reports off the map entirely', async () => {
    const data = new FakeDataSource(null)
    data.seed({ id: 'ok', lat: 51.5074, lng: -0.1278 })
    data.seed({ id: 'gone', lat: 51.5075, lng: -0.1279, moderationStatus: 'rejected' })
    render(<App data={data} />)
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument())

    // At pin zoom, so the assertion can actually fail.
    await moveMapTo(16)
    await waitFor(() => expect(screen.getAllByTestId('pin')).toHaveLength(1))
  })
})

describe('App — filters', () => {
  const mixed = () => {
    const data = new FakeDataSource(null)
    // Far enough apart to land in different H3 cells at r7 and r9. The earlier
    // pair shared a cell at both, so "exactly one cell" held whatever the
    // filter did.
    data.seed({ id: 'still-there', lat: 51.5074, lng: -0.1278, status: 'open', voteCount: 3 })
    data.seed({ id: 'cleaned', lat: 51.5274, lng: -0.1278, status: 'cleaned', voteCount: 1 })
    return data
  }

  it('shows what is still there to begin with, out of everything in view', async () => {
    render(<App data={mixed()} />)
    // One of the two is cleaned, so the default view shows one of two.
    expect(await screen.findByText('1 of 2 reports')).toBeInTheDocument()
  })

  it('narrows the map when a filter is chosen', async () => {
    const user = userEvent.setup()
    render(<App data={mixed()} />)
    await screen.findByText('1 of 2 reports')

    await user.click(screen.getByRole('button', { name: /everything/i }))

    expect(await screen.findByText('2 reports')).toBeInTheDocument()
  })

  it('says how many are hidden, so a filtered map is not mistaken for an empty one', async () => {
    render(<App data={mixed()} />)

    // "1 of 2" rather than a bare "1": the difference between filtered and empty.
    expect(await screen.findByText('1 of 2 reports')).toBeInTheDocument()
  })

  it('keeps the filter applied in the aggregated view, not just the list', async () => {
    // Zooming out must not quietly bring back what was filtered away. Asserting
    // on the screen-reader list alone proved nothing about the cells.
    const user = userEvent.setup()
    render(<App data={mixed()} />)
    await screen.findByText('1 of 2 reports')
    await moveMapTo(13)

    // Everything: both reports, and they sit in different cells at r9.
    await user.click(screen.getByRole('button', { name: /everything/i }))
    await waitFor(() => expect(screen.getAllByTestId('cell')).toHaveLength(2))

    // Each narrower filter must leave exactly one.
    await user.click(screen.getByRole('button', { name: /still there/i }))
    await waitFor(() => expect(screen.getAllByTestId('cell')).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: /cleaned up/i }))
    await waitFor(() => expect(screen.getAllByTestId('cell')).toHaveLength(1))
  })

  it('does not blank the map when asked to show cleaned spots', async () => {
    // weighCells drops cleaned reports by default, so the aggregated view went
    // completely empty at the zoom the app opens at.
    const user = userEvent.setup()
    render(<App data={mixed()} />)
    await screen.findByText('1 of 2 reports')
    await moveMapTo(13)

    await user.click(screen.getByRole('button', { name: /cleaned up/i }))
    await waitFor(() => expect(screen.getAllByTestId('cell').length).toBeGreaterThan(0))
  })

  it('restores the default view when cleared', async () => {
    const user = userEvent.setup()
    render(<App data={mixed()} />)
    await screen.findByText('1 of 2 reports')

    await user.click(screen.getByRole('button', { name: /everything/i }))
    await screen.findByText('2 reports')

    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(await screen.findByText('1 of 2 reports')).toBeInTheDocument()
  })
})

describe('App — the pin threshold', () => {
  const withReports2 = () => {
    const data = new FakeDataSource(null)
    data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278, voteCount: 2 })
    return data
  }

  it('fades the hexagons out rather than cutting them at the pin threshold', async () => {
    // Swapping the cell layer for the pin layer unmounted every hexagon in a
    // single frame -- the harshest cut on the map, and the one zoom boundary
    // that had no fade at all.
    render(<App data={withReports2()} />)
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument())

    await moveMapTo(13)
    await waitFor(() => expect(screen.getAllByTestId('cell').length).toBeGreaterThan(0))

    await moveMapTo(16)
    // Still present for the length of the fade, alongside the arriving pins.
    expect(screen.queryAllByTestId('cell').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByTestId('pin').length).toBeGreaterThan(0))
  })
})

describe('App — coming back from the pin view', () => {
  const seeded = () => {
    const data = new FakeDataSource(null)
    data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278, voteCount: 2 })
    return data
  }

  it('does not leave a bare basemap on the way back out', async () => {
    // Clearing the cells on entering the pin view meant that zooming out
    // unmounted the pins, found no cells, and showed nothing at all until the
    // rollup returned.
    //
    // The rollup is made to hang for the return trip on purpose: the fake
    // normally resolves in a microtask, so the cells would be back before any
    // assertion could run and the test would pass either way.
    const data = seeded()
    render(<App data={data} />)
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument())

    await moveMapTo(13)
    await waitFor(() => expect(screen.getAllByTestId('cell').length).toBeGreaterThan(0))

    await moveMapTo(16)
    await waitFor(() => expect(screen.getAllByTestId('pin').length).toBeGreaterThan(0))

    vi.spyOn(data, 'getRollup').mockImplementation(() => new Promise(() => {}))
    await moveMapTo(13)

    // Wait past the fade window before looking. The hexagons that were fading
    // OUT on the way in are still drawn for CROSSFADE_MS, so without this the
    // assertion cannot tell a retained set from a fading remnant.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CROSSFADE_MS + 80))
    })

    // Nothing has come back from the rollup, so this can only be the set that
    // was kept rather than cleared.
    expect(screen.getAllByTestId('cell').length).toBeGreaterThan(0)
  })
})
