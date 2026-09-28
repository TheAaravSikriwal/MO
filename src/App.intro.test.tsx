import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { mapControl } from './test/globeMapMock'
import { forgetFindings } from './lib/worlddata/useFindings'
import { forgetWorldData } from './lib/worlddata/useWorldData'

/** The introduction, the way into the map after it, and About. */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

beforeEach(() => {
  // Nothing to fetch: the reel says it cannot load the figures, and carries on.
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
  localStorage.clear()
  mapControl.flyTo.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  forgetFindings()
  forgetWorldData()
})

const main = () => document.querySelector('main')!

describe('the introduction', () => {
  it('plays first, with the panels held back, then lets them in and flies to the whole Earth', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} intro />)
    const reel = screen.getByRole('dialog', { name: 'Introduction to tidy' })
    expect(main()).toHaveAttribute('data-entered', 'no')
    expect(mapControl.flyTo).not.toHaveBeenCalled()

    await user.click(within(reel).getByRole('button', { name: 'Skip introduction' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Introduction to tidy' })).not.toBeInTheDocument())
    expect(main()).toHaveAttribute('data-entered', 'yes')
    // The zoom into Earth: to the whole globe.
    expect(mapControl.flyTo).toHaveBeenCalledWith([20, 10], 2.9)
  })

  it('is remembered, so it does not play again on the next visit', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<App intro={undefined} />)
    await user.click(screen.getByRole('button', { name: 'Skip introduction' }))
    unmount()
    render(<App intro={undefined} />)
    expect(screen.queryByRole('dialog', { name: 'Introduction to tidy' })).not.toBeInTheDocument()
    expect(main()).toHaveAttribute('data-entered', 'yes')
  })

  it('does not play for a map shown without it, and the panels are in from the start', () => {
    render(<App data={new FakeDataSource(null)} />)
    expect(screen.queryByRole('dialog', { name: 'Introduction to tidy' })).not.toBeInTheDocument()
    expect(main()).toHaveAttribute('data-entered', 'yes')
    expect(mapControl.flyTo).not.toHaveBeenCalled()
  })
})

describe('About', () => {
  it('tells the story in the maker’s own words, asks to be shared, and can play the introduction again', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('button', { name: 'About' }))
    const about = screen.getByRole('region', { name: 'About tidy' })
    expect(within(about).getByText(/I travel a lot/)).toBeInTheDocument()
    expect(within(about).getByText(/I have not marketed it/)).toBeInTheDocument()
    expect(within(about).getByText(/share it with someone who would care/)).toBeInTheDocument()
    expect(within(about).getByRole('button', { name: 'Share tidy' })).toBeInTheDocument()

    await user.click(within(about).getByRole('button', { name: 'Watch the introduction again' }))
    expect(screen.getByRole('dialog', { name: 'Introduction to tidy' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'About tidy' })).not.toBeInTheDocument()
  })

  it('copies the link to share where the browser has no share sheet', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, share: undefined, clipboard: { writeText } })
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('button', { name: 'About' }))
    await user.click(screen.getByRole('button', { name: 'Share tidy' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^http/))
    expect(await screen.findByText('Link copied. Thank you!')).toBeInTheDocument()
  })

  it('closes', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('button', { name: 'About' }))
    await user.click(within(screen.getByRole('region', { name: 'About tidy' })).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('region', { name: 'About tidy' })).not.toBeInTheDocument()
  })
})
