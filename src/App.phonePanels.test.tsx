import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { mapControl } from './test/globeMapMock'

/**
 * On a phone the filters and the list of groups fold away so the globe shows,
 * and while a report, a form or the review queue is open the stack at the top
 * steps aside. All of it is Tailwind classes (phone:..., index.css), which jsdom never
 * applies, so these tests read whole class names and the toggle's state: that
 * is what decides what a phone shows. What must stay in sight is checked by
 * where it sits: outside what folds.
 */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))
// Place search answers at once with one place, so results can be shown.
vi.mock('./lib/geo/nominatim', async (original) => ({
  ...(await original<typeof import('./lib/geo/nominatim')>()),
  createDebouncedSearch: () => (query: string, onResults: (places: Array<{ name: string; lat: number; lng: number }>) => void) =>
    onResults(query.trim() ? [{ name: 'London', lat: 51.5074, lng: -0.1278 }] : []),
}))

const LONDON: [number, number] = [51.5074, -0.1278]
const ALICE = { id: 'alice', email: 'alice@example.com', isAdmin: false }
const ADMIN = { id: 'admin', email: 'admin@example.com', isAdmin: true }

const hasClass = (el: Element | null, name: string) => {
  expect(el).not.toBeNull()
  return el!.classList.contains(name)
}
const folded = (el: Element | null) => hasClass(el, 'phone:hidden')
const filters = () => document.getElementById('mo-filters')
const groupList = () => document.getElementById('mo-group-list')
/** The name row: what steps aside while something is open. */
const nameRow = () => screen.getByTestId('column-name')
/** Whether anything around `el` is folded away on a phone. */
const hiddenOnPhone = (el: Element) => {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const c = at.classList
    if (c.contains('phone:hidden') || c.contains('max-md:hidden')) return true
    // Plain `hidden` counts unless the phone variant shows it again.
    if (c.contains('hidden') && !c.contains('phone:block') && !c.contains('phone:flex')) return true
  }
  return false
}
const bottom = () => screen.getByTestId('column-bottom')

const openFilters = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Filters/ }))
  expect(folded(filters())).toBe(false)
}

describe('the filters, on a phone', () => {
  it('start folded, behind a phone-only button after the tabs', () => {
    render(<App data={new FakeDataSource(null)} />)
    const toggle = screen.getByRole('button', { name: 'Filters' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'mo-filters')
    // Shown only on a phone: hidden, and shown by the phone variant.
    expect(hasClass(toggle, 'hidden')).toBe(true)
    expect(hasClass(toggle, 'phone:block')).toBe(true)
    expect(hiddenOnPhone(toggle)).toBe(false)
    // After the tabs in reading order.
    const tabs = screen.getByRole('tablist')
    expect(tabs.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(folded(filters())).toBe(true)
  })

  it('show a "near me" message outside the fold while they are folded', async () => {
    const user = userEvent.setup()
    const geolocation = navigator.geolocation
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_ok: unknown, fail: (e: { code: number; message: string }) => void) => fail({ code: 1, message: 'denied' }) },
    })
    try {
      render(<App data={new FakeDataSource(null)} />)
      await openFilters(user)
      await user.click(within(filters()!).getByRole('button', { name: /use my location/i }))
      await user.click(screen.getByRole('button', { name: 'Hide filters' }))
      const shown = (await screen.findAllByRole('status')).filter(
        (el) => !hiddenOnPhone(el) && !filters()!.contains(el) && el.classList.contains('phone:block'),
      )
      expect(shown).toHaveLength(1)
      expect(shown[0].textContent).not.toBe('')
    } finally {
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation })
    }
  })

  it('fold inside their tab panel, which the tab keeps', () => {
    render(<App data={new FakeDataSource(null)} />)
    const panel = document.getElementById('panel-map')!
    expect(hiddenOnPhone(panel)).toBe(false)
    expect(panel).toContainElement(filters())
  })

  it('open on the button and fold again', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await openFilters(user)
    expect(screen.getByRole('button', { name: 'Hide filters' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Hide filters' }))
    expect(folded(filters())).toBe(true)
  })

  it('come back folded after another tab', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await openFilters(user)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    await user.click(screen.getByRole('tab', { name: /reports/i }))
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(folded(filters())).toBe(true))
  })

  it('say so when a filter is on, so folding never hides it', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await openFilters(user)
    await user.click(within(filters()!).getByRole('button', { name: 'Everything' }))
    await user.click(screen.getByRole('button', { name: 'Hide filters' }))
    expect(screen.getByRole('button', { name: 'Filters on' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('do not count a distance with no place to measure from, which filters nothing', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await openFilters(user)
    const distance = within(filters()!).getByRole('combobox')
    const options = within(distance).getAllByRole('option') as HTMLOptionElement[]
    await user.selectOptions(distance, options.find((o) => o.value !== '')!)
    await user.click(screen.getByRole('button', { name: 'Hide filters' }))
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
  })

  it('fold when an area’s list is opened from the map', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'london', lat: LONDON[0], lng: LONDON[1], note: 'Bags by the bench', voteCount: 2 })
    render(<App data={data} />)
    await mapControl.moveTo(10, LONDON)
    const [cell] = await screen.findAllByTestId('cell')
    await openFilters(user)
    await user.click(cell)
    expect(folded(filters())).toBe(true)
  })

  it('fold when a pin is opened', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'london', lat: LONDON[0], lng: LONDON[1], note: 'Bags by the bench', voteCount: 2 })
    render(<App data={data} />)
    await mapControl.moveTo(16, LONDON)
    const [pin] = await screen.findAllByTestId('pin')
    await openFilters(user)
    await user.click(pin)
    expect(folded(filters())).toBe(true)
  })

  it('a report opened from a pin puts an area’s list away on a phone', async () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    try {
      const user = userEvent.setup()
      const data = new FakeDataSource(null)
      data.seed({ id: 'london', lat: LONDON[0], lng: LONDON[1], note: 'Bags by the bench', voteCount: 2 })
      render(<App data={data} />)
      await mapControl.moveTo(10, LONDON)
      await user.click((await screen.findAllByTestId('cell'))[0])
      await screen.findByRole('region', { name: 'Reports in this area' })
      await mapControl.moveTo(16, LONDON)
      await user.click((await screen.findAllByTestId('pin'))[0])
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Reports in this area' })).not.toBeInTheDocument())
    } finally {
      window.matchMedia = real
    }
  })

  it('an area’s list stays for a report on a wide phone on its side, where it does not cover it', async () => {
    const real = window.matchMedia
    // Short, but not narrow: the list sits top right, beside the report.
    window.matchMedia = ((query: string) => ({ matches: query === '(max-width: 767.98px), (max-height: 480px)', media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    try {
      const user = userEvent.setup()
      const data = new FakeDataSource(null)
      data.seed({ id: 'london', lat: LONDON[0], lng: LONDON[1], note: 'Bags by the bench', voteCount: 2 })
      render(<App data={data} />)
      await mapControl.moveTo(10, LONDON)
      await user.click((await screen.findAllByTestId('cell'))[0])
      await screen.findByRole('region', { name: 'Reports in this area' })
      await mapControl.moveTo(16, LONDON)
      await user.click((await screen.findAllByTestId('pin'))[0])
      await screen.findByRole('heading', { name: /Litter reported here/ })
      expect(screen.getByRole('region', { name: 'Reports in this area' })).toBeInTheDocument()
    } finally {
      window.matchMedia = real
    }
  })

  it('fold when a report is started', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await openFilters(user)
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    expect(folded(filters())).toBe(true)
  })

  it('fold when the review queue is opened', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ADMIN, { displayName: 'Admin' })} />)
    await openFilters(user)
    await user.click(await screen.findByRole('button', { name: 'Review queue' }))
    expect(folded(filters())).toBe(true)
  })
})

describe('while something is open at the bottom, on a phone', () => {
  it('the name row steps aside, and the bottom keeps to 40% of the screen', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ALICE, { displayName: 'Alice' })} />)
    expect(folded(nameRow())).toBe(false)
    expect(hasClass(bottom(), 'upright:max-h-[40svh]')).toBe(true)
    expect(hasClass(bottom(), 'upright:overflow-y-auto')).toBe(true)
    // Scrolling on its own, it must never be squashed by a full column.
    expect(hasClass(bottom(), 'shrink-0')).toBe(true)

    const top = screen.getByTestId('column-top')
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(false)
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    expect(folded(nameRow())).toBe(true)
    // On a phone on its side the bottom takes the height that is left instead.
    expect(hasClass(bottom(), 'short:flex-1')).toBe(true)
    expect(hasClass(bottom(), 'short:min-h-24')).toBe(true)
    // The top is held to a quarter of the screen, so the middle of the map shows.
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(true)
    expect(hasClass(top, 'phone:overflow-y-auto')).toBe(true)
    expect(hasClass(top, 'shrink-0')).toBe(true)
    // The tabs, where a half-written report waits, and the search stay.
    expect(hiddenOnPhone(screen.getByRole('tablist'))).toBe(false)
    expect(hiddenOnPhone(screen.getByRole('searchbox', { name: 'Search for a place' }))).toBe(false)
    // About is still one tap away, beside the search.
    const abouts = screen.getAllByRole('button', { name: 'About' }).filter((b) => !hiddenOnPhone(b))
    expect(abouts).toHaveLength(1)
    expect(hasClass(abouts[0], 'phone:block')).toBe(true)
    // Short, so the search keeps room for what is typed in it.
    expect(abouts[0].textContent).toBe('?')

    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(folded(nameRow())).toBe(false))
    // With nothing open the bottom is only its button: it must not stretch
    // over the map, where it would take the pointer.
    expect(hasClass(bottom(), 'short:flex-1')).toBe(false)
  })

  it('nothing moves when the form only says to sign in', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    await screen.findByText('Sign in to add a report.')
    expect(folded(nameRow())).toBe(false)
  })

  it('signing in stays in sight while a report is open', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'london', lat: LONDON[0], lng: LONDON[1], note: 'Bags by the bench', voteCount: 2 })
    render(<App data={data} />)
    await mapControl.moveTo(16, LONDON)
    const signIn = screen.getByRole('form', { name: 'Sign in' })
    await user.click((await screen.findAllByTestId('pin'))[0])
    await waitFor(() => expect(folded(nameRow())).toBe(true))
    expect(hiddenOnPhone(signIn)).toBe(false)
    // Reading a report holds the top to a quarter as well, scrolling: sign-in
    // is in it, a scroll away, and the middle of the map stays in sight.
    expect(hasClass(screen.getByTestId('column-top'), 'phone:max-h-[25svh]')).toBe(true)
    expect(hasClass(screen.getByTestId('column-top'), 'phone:overflow-y-auto')).toBe(true)
    expect(hasClass(bottom(), 'short:flex-1')).toBe(true)
  })

  it('picking a group on the globe with a report open brings the tabs back', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(null)
    data.seed({ id: 'london', lat: LONDON[0], lng: LONDON[1], note: 'Bags by the bench', voteCount: 2 })
    data.seedGroup({ id: 'riverside', lat: LONDON[0], lng: LONDON[1] })
    render(<App data={data} />)
    await mapControl.moveTo(16, LONDON)
    await user.click((await screen.findAllByTestId('pin'))[0])
    await waitFor(() => expect(folded(nameRow())).toBe(true))

    await user.click(await screen.findByTestId('group-marker'))
    expect(screen.getByRole('tab', { name: /cleaning groups/i })).toHaveAttribute('aria-selected', 'true')
    expect(folded(nameRow())).toBe(false)
    await waitFor(() => expect(folded(groupList())).toBe(false))
  })

  it('the column is narrower on a short screen, so the middle of the map is beside it', () => {
    render(<App data={new FakeDataSource(null)} />)
    const short = '[@media(max-height:480px)]:w-[min(18rem,45vw)]'
    expect(hasClass(screen.getByTestId('column-top'), short)).toBe(true)
    expect(hasClass(bottom(), short)).toBe(true)
  })

  it('the map’s own controls step aside while the column is in use', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ALICE, { displayName: 'Alice' })} />)
    const main = document.querySelector('main.mo-space')!
    const corner = screen.getByTestId('layers-corner')
    expect(main).not.toHaveAttribute('data-busy')
    expect(hasClass(corner, 'upright:hidden')).toBe(false)
    await openFilters(user)
    expect(main).toHaveAttribute('data-busy', 'yes')
    expect(hasClass(corner, 'upright:hidden')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Hide filters' }))
    expect(main).not.toHaveAttribute('data-busy')
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    expect(main).toHaveAttribute('data-busy', 'yes')
    expect(hasClass(corner, 'upright:hidden')).toBe(true)
  })

  it('on a short screen the top’s cap lifts for the filters asked for, as upright', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ALICE, { displayName: 'Alice' })} />)
    const top = screen.getByTestId('column-top')
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(false)
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(true)
    // Held to a quarter, the filters opened out of sight inside it. The
    // bottom keeps its 6rem below them.
    await openFilters(user)
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(false)
    expect(hasClass(bottom(), 'short:min-h-24')).toBe(true)
  })

  it('the compass steps aside for the open layers panel too', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    const main = document.querySelector('main.mo-space')!
    expect(main).not.toHaveAttribute('data-layers-open')
    await user.click(screen.getByRole('button', { name: 'Layers' }))
    expect(main).toHaveAttribute('data-layers-open', 'yes')
    // Not the column in use, so the Layers button itself stays.
    expect(main).not.toHaveAttribute('data-busy')
  })

  it('on a short screen the cap lifts for search results, as upright', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ALICE, { displayName: 'Alice' })} />)
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    const top = screen.getByTestId('column-top')
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(true)
    await user.type(screen.getByRole('searchbox', { name: 'Search for a place' }), 'Lon')
    await waitFor(() => expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(false))
  })

  it('scrolls the column to the filters when they are opened on a phone', async () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      // The column is the screen, 390px tall; the filters open 300px below its edge.
      if (this.classList.contains('mo-column')) return { top: 0, bottom: 390, left: 0, right: 300, height: 390, width: 300, x: 0, y: 0, toJSON() {} } as DOMRect
      if (this.id === 'mo-filters') return { top: 690, bottom: 1000, left: 0, right: 300, height: 310, width: 300, x: 0, y: 690, toJSON() {} } as DOMRect
      return rect.call(this)
    }
    try {
      const user = userEvent.setup()
      render(<App data={new FakeDataSource(null)} />)
      await openFilters(user)
      const column = document.querySelector('.mo-column') as HTMLElement
      // Just far enough to show all of them: their bottom to the column's.
      await waitFor(() => expect(column.scrollTop).toBe(610))
    } finally {
      window.matchMedia = real
      Element.prototype.getBoundingClientRect = rect
    }
  })

  it('errors lead the column, so a capped top never scrolls one out of sight', async () => {
    const data = new FakeDataSource(null)
    data.getCurrentUser = () => Promise.reject(new Error('offline'))
    render(<App data={data} />)
    const alert = await screen.findByText('Could not check whether you are signed in.')
    // Before the name row, the tabs and the search in the column's top.
    expect(nameRow().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(screen.getByTestId('column-top')).toContainElement(alert)
  })

  it('on a short screen the top keeps to 35% at rest, so Add a report is on the screen', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    const top = screen.getByTestId('column-top')
    expect(hasClass(top, 'short:max-h-[35svh]')).toBe(true)
    // Not once the filters are asked for.
    await openFilters(user)
    expect(hasClass(top, 'short:max-h-[35svh]')).toBe(false)
  })

  it('only the layers button and panel take the pointer, not the strip beside them', () => {
    render(<App data={new FakeDataSource(null)} />)
    const wrapper = screen.getByRole('button', { name: 'Layers' }).parentElement!
    expect(hasClass(wrapper, 'pointer-events-auto')).toBe(false)
    expect(hasClass(wrapper, '[&>*]:pointer-events-auto')).toBe(true)
  })

  it('the layers panel keeps under half the screen and scrolls, so its button stays on it', () => {
    render(<App data={new FakeDataSource(null)} />)
    const panel = screen.getByTestId('layers-panel')
    expect(hasClass(panel, 'phone:max-h-[50svh]')).toBe(true)
    expect(hasClass(panel, 'phone:overflow-y-auto')).toBe(true)
    // Painted over the column, which is nearly the screen's width on a phone.
    expect(hasClass(screen.getByTestId('layers-corner'), 'phone:z-[1001]')).toBe(true)
  })

  it('the map clips its own edges, so panels waiting to slide in never widen the page', () => {
    render(<App data={new FakeDataSource(null)} />)
    expect(hasClass(document.querySelector('main.mo-space'), 'overflow-hidden')).toBe(true)
  })

  it('opening the groups while starting one lifts the cap on the top, where the list is', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(ALICE, { displayName: 'Alice' })
    data.seedGroup({ id: 'riverside', lat: LONDON[0], lng: LONDON[1] })
    render(<App data={data} />)
    await mapControl.moveTo(14, LONDON)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    await user.click(await screen.findByRole('button', { name: 'Start a cleaning group here' }))
    await screen.findByRole('form', { name: 'Start a cleaning group' })
    const top = screen.getByTestId('column-top')
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Groups' }))
    expect(hasClass(top, 'phone:max-h-[25svh]')).toBe(false)
  })

  it('the groups list can always be folded again, even with a group form open', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(ALICE, { displayName: 'Alice' })
    data.seedGroup({ id: 'riverside', lat: LONDON[0], lng: LONDON[1] })
    render(<App data={data} />)
    await mapControl.moveTo(14, LONDON)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    await user.click(await screen.findByRole('button', { name: 'Start a cleaning group here' }))
    await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.click(await screen.findByTestId('group-marker'))
    await waitFor(() => expect(folded(groupList())).toBe(false))
    const hide = screen.getByRole('button', { name: 'Hide groups' })
    expect(hiddenOnPhone(hide)).toBe(false)
    await user.click(hide)
    expect(folded(groupList())).toBe(true)
  })

  it('the review queue takes focus as it opens, and not again on coming back to it', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ADMIN, { displayName: 'Admin' })} />)
    await user.click(await screen.findByRole('button', { name: 'Review queue' }))
    const queue = await screen.findByRole('region', { name: 'Review queue' })
    await waitFor(() => expect(queue).toHaveFocus())

    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    const reports = screen.getByRole('tab', { name: /reports/i })
    await user.click(reports)
    await screen.findByRole('region', { name: 'Review queue' })
    expect(reports).toHaveFocus()
  })

  it('the name row comes back if an admin signs out with the queue open', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(ADMIN, { displayName: 'Admin' })} />)
    await user.click(await screen.findByRole('button', { name: 'Review queue' }))
    await waitFor(() => expect(folded(nameRow())).toBe(true))
    await user.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(folded(nameRow())).toBe(false))
  })
})

describe('the findings, on a narrow screen', () => {
  it('have the column to themselves under the tabs', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    const search = screen.getByRole('searchbox', { name: 'Search for a place' })
    expect(hiddenOnPhone(search)).toBe(false)
    await user.click(screen.getByRole('tab', { name: /findings/i }))
    // The search steps aside below md; the name row, with About, and the tabs stay.
    expect(hasClass(search.parentElement, 'max-md:hidden')).toBe(true)
    expect(hiddenOnPhone(nameRow())).toBe(false)
    let at: Element | null = screen.getByRole('tablist')
    for (; at; at = at.parentElement) expect(at.classList.contains('max-md:hidden')).toBe(false)
  })

  it('start where the tabs are measured to end, so an error above them cannot push them under', async () => {
    const rect = Element.prototype.getBoundingClientRect
    let tabsBottom = 100
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'column-tabs') return { top: tabsBottom - 40, bottom: tabsBottom, left: 0, right: 300, height: 40, width: 300, x: 0, y: tabsBottom - 40, toJSON() {} } as DOMRect
      if (this.tagName === 'MAIN') return { top: 0, bottom: 800, left: 0, right: 390, height: 800, width: 390, x: 0, y: 0, toJSON() {} } as DOMRect
      return rect.call(this)
    }
    try {
      const user = userEvent.setup()
      render(<App data={new FakeDataSource(null)} />)
      await user.click(screen.getByRole('tab', { name: /findings/i }))
      const place = screen.getByTestId('findings-place')
      expect(hasClass(place, 'top-[var(--findings-top,7.25rem)]')).toBe(true)
      expect(place.style.getPropertyValue('--findings-top')).toBe('108px')
      // An error opens above the tabs and moves them down 40px; the window is
      // the stand-in for what notices the move.
      tabsBottom = 140
      act(() => void window.dispatchEvent(new Event('resize')))
      expect(place.style.getPropertyValue('--findings-top')).toBe('148px')
    } finally {
      Element.prototype.getBoundingClientRect = rect
    }
  })
})

describe('the groups list, on a phone', () => {
  const withGroup = (user: typeof ALICE | null = null) => {
    const data = new FakeDataSource(user, { displayName: user ? 'Alice' : undefined })
    data.seedGroup({ id: 'riverside', lat: LONDON[0], lng: LONDON[1] })
    return data
  }

  it('folds only the list, behind its own button', async () => {
    const user = userEvent.setup()
    render(<App data={withGroup()} />)
    await mapControl.moveTo(12, LONDON)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    const toggle = await screen.findByRole('button', { name: 'Groups' })
    expect(toggle).toHaveAttribute('aria-controls', 'mo-group-list')
    expect(folded(groupList())).toBe(true)
    // The heading, and with it any error or "no groups here", stays in sight.
    expect(folded(screen.getByRole('region', { name: 'Cleaning groups' }))).toBe(false)
    expect(folded(document.getElementById('panel-groups'))).toBe(false)

    await user.click(toggle)
    expect(folded(groupList())).toBe(false)
    expect(screen.getByRole('button', { name: 'Hide groups' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps its Hide button while the list is open, even where there are no groups', async () => {
    const user = userEvent.setup()
    render(<App data={withGroup()} />)
    await mapControl.moveTo(12, LONDON)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    await user.click(await screen.findByRole('button', { name: 'Groups' }))
    await mapControl.moveTo(12, [0, 0]) // somewhere with no groups
    await screen.findByText(/No groups here yet/)
    const hide = screen.getByRole('button', { name: 'Hide groups' })
    await user.click(hide)
    expect(folded(groupList())).toBe(true)
  })

  it('has no button when there are no groups to show', async () => {
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    await screen.findByText(/No groups here yet/)
    expect(screen.queryByRole('button', { name: 'Groups' })).not.toBeInTheDocument()
  })

  it('opens when a group is picked on the globe', async () => {
    const user = userEvent.setup()
    render(<App data={withGroup()} />)
    await mapControl.moveTo(12, LONDON)
    await user.click(await screen.findByTestId('group-marker'))
    await waitFor(() => expect(folded(groupList())).toBe(false))
    expect(within(groupList()!).getAllByText('Riverside Litter Pickers').length).toBeGreaterThan(0)
  })

  it('folds when a group is started, and opens on the new group when it is made', async () => {
    const user = userEvent.setup()
    render(<App data={withGroup(ALICE)} />)
    await mapControl.moveTo(14, LONDON)
    await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
    await user.click(await screen.findByRole('button', { name: 'Groups' }))
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))
    expect(folded(groupList())).toBe(true)

    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.type(within(form).getByLabelText('Group name'), 'Canal Clean Crew')
    await user.type(within(form).getByLabelText('What you do'), 'Evenings along the towpath.')
    await user.click(within(form).getByRole('button', { name: 'Start the group' }))
    await waitFor(() => expect(folded(groupList())).toBe(false))
    expect(await within(groupList()!).findByText('Canal Clean Crew')).toBeInTheDocument()
  })

  /** jsdom lays nothing out: the list is 100px tall at the top, the picked card 400px down. */
  const layOut = () => {
    const real = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.id === 'mo-group-list') return { top: 0, bottom: 100, left: 0, right: 300, height: 100, width: 300, x: 0, y: 0, toJSON() {} } as DOMRect
      if (this.hasAttribute('data-selected')) return { top: 400, bottom: 480, left: 0, right: 300, height: 80, width: 300, x: 0, y: 400, toJSON() {} } as DOMRect
      return real.call(this)
    }
    return () => { Element.prototype.getBoundingClientRect = real }
  }
  const phone = () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    return () => { window.matchMedia = real }
  }

  it('scrolls the list, and only the list, to the picked group on a phone', async () => {
    const undoLayout = layOut()
    const undoPhone = phone()
    try {
      const user = userEvent.setup()
      render(<App data={withGroup()} />)
      await mapControl.moveTo(12, LONDON)
      await user.click(await screen.findByTestId('group-marker'))
      // The card's bottom is 380px below the list's.
      await waitFor(() => expect(groupList()!.scrollTop).toBe(380))
    } finally {
      undoPhone()
      undoLayout()
    }
  })

  /** Picks the first of three groups, one of them out of view until the map zooms out. */
  const pickThenReload = async (between: () => void | Promise<void>) => {
    const user = userEvent.setup()
    const data = withGroup()
    data.seedGroup({ id: 'park', lat: LONDON[0] + 0.01, lng: LONDON[1] + 0.01, name: 'Park Friends' })
    data.seedGroup({ id: 'far', lat: LONDON[0] + 2, lng: LONDON[1] + 2, name: 'Far Afield' })
    render(<App data={data} />)
    await mapControl.moveTo(12, LONDON)
    await user.click((await screen.findAllByTestId('group-marker'))[0])
    await waitFor(() => expect(groupList()!.scrollTop).toBe(380))
    await between()
    groupList()!.scrollTop = 0 // the reload moved the card out of view
    await mapControl.moveTo(6, LONDON, 3) // the list reloads, with one more group
    await waitFor(() => expect(within(groupList()!).queryAllByText('Far Afield').length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 400))
  }

  it('keeps following the picked group while the list reloads under the flying map', async () => {
    const undoLayout = layOut()
    const undoPhone = phone()
    try {
      await pickThenReload(() => {})
      expect(groupList()!.scrollTop).toBe(380)
    } finally {
      undoPhone()
      undoLayout()
    }
  })

  it('stops following the moment the person scrolls the list themselves', async () => {
    const undoLayout = layOut()
    const undoPhone = phone()
    try {
      await pickThenReload(() => {
        fireEvent.wheel(groupList()!)
      })
      expect(groupList()!.scrollTop).toBe(0)
    } finally {
      undoPhone()
      undoLayout()
    }
  })

  it('stops following a few seconds after the pick, so a later move never pulls them back', async () => {
    const undoLayout = layOut()
    const undoPhone = phone()
    const now = Date.now
    try {
      await pickThenReload(() => {
        const later = now() + 5000
        Date.now = () => later
      })
      expect(groupList()!.scrollTop).toBe(0)
    } finally {
      Date.now = now
      undoPhone()
      undoLayout()
    }
  })

  it('folds the list on a phone when a group is picked from it, to show where the map went', async () => {
    const undoPhone = phone()
    try {
      const user = userEvent.setup()
      render(<App data={withGroup()} />)
      await mapControl.moveTo(12, LONDON)
      await user.click(screen.getByRole('tab', { name: /cleaning groups/i }))
      await user.click(await screen.findByRole('button', { name: 'Groups' }))
      await user.click(within(groupList()!).getByRole('button', { name: /^Show .* on the map$/ }))
      expect(folded(groupList())).toBe(true)
    } finally {
      undoPhone()
    }
  })

  it('scrolls to a group again after the list was folded, the same group included', async () => {
    const undoLayout = layOut()
    const undoPhone = phone()
    try {
      const user = userEvent.setup()
      render(<App data={withGroup()} />)
      await mapControl.moveTo(12, LONDON)
      await user.click(await screen.findByTestId('group-marker'))
      await waitFor(() => expect(groupList()!.scrollTop).toBe(380))
      await user.click(screen.getByRole('button', { name: 'Hide groups' }))
      groupList()!.scrollTop = 0 // folded, the list lost its place
      await user.click(screen.getByTestId('group-marker'))
      await waitFor(() => expect(groupList()!.scrollTop).toBe(380))
    } finally {
      undoPhone()
      undoLayout()
    }
  })

  it('does not scroll the list on a wide screen', async () => {
    const undoLayout = layOut()
    try {
      const user = userEvent.setup()
      render(<App data={withGroup()} />)
      await mapControl.moveTo(12, LONDON)
      await user.click(await screen.findByTestId('group-marker'))
      await waitFor(() => expect(folded(groupList())).toBe(false))
      // Past the wait before a phone would scroll (GroupsPanel, CARDS_OPEN_MS).
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(groupList()!.scrollTop).toBe(0)
    } finally {
      undoLayout()
    }
  })
})

describe('what stays in sight on a phone, on The idea', () => {
  // As the app starts with no database: on The idea, signed out.
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    window.history.replaceState(null, '', '/?count=40')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    window.history.replaceState(null, '', '/')
  })

  it('the search, the try-it card and the made-up notice are never folded', async () => {
    render(<App />)
    const tryIt = await screen.findByRole('button', { name: 'Try it signed in' })
    const panel = filters()!
    expect(folded(panel)).toBe(true)
    expect(hiddenOnPhone(screen.getByRole('searchbox', { name: 'Search for a place' }))).toBe(false)
    expect(hiddenOnPhone(tryIt)).toBe(false)
    expect(hiddenOnPhone(await screen.findByText(/Every report and group on this map is made up/))).toBe(false)
    expect(hiddenOnPhone(screen.getByRole('radiogroup', { name: 'Which reports to show' }))).toBe(false)
  })

  it('the world switch is compact on any phone, a phone on its side included', async () => {
    render(<App />)
    const sides = within(await screen.findByRole('radiogroup', { name: 'Which reports to show' })).getAllByRole('radio')
    for (const side of sides) {
      // Its roomy padding is for roomy screens, not for anything 768px wide.
      expect(hasClass(side, 'roomy:px-4')).toBe(true)
      expect(hasClass(side, 'md:px-4')).toBe(false)
    }
  })

  it('which world this is stays said while something is open', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Try it signed in' }))
    await user.click(await screen.findByRole('button', { name: /Add a report/ }))
    await waitFor(() => expect(folded(nameRow())).toBe(true))
    expect(hiddenOnPhone(screen.getByRole('radiogroup', { name: 'Which reports to show' }))).toBe(false)
    expect(hiddenOnPhone(screen.getByText(/Every report and group on this map is made up/))).toBe(false)
  })
})
