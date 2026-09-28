import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { mapControl } from './test/globeMapMock'

/** The "Cleaning groups" tab, driven through the whole app. */


vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

const LONDON: [number, number] = [51.5074, -0.1278]

/** Drive the map the way Leaflet would after a pan or zoom. */
const moveMapTo = (zoom: number, center: [number, number] = LONDON) => mapControl.moveTo(zoom, center)

const ALICE = { id: 'alice', email: 'alice@example.com', isAdmin: false }

function withGroups(user: typeof ALICE | null = ALICE) {
  const data = new FakeDataSource(user, { displayName: user ? 'Alice' : undefined })
  data.seedGroup(
    { id: 'g1', name: 'Riverside Litter Pickers', description: 'Saturdays by the bridge.', lat: 51.507, lng: -0.128 },
    { members: 11 },
  )
  data.seedGroup({ id: 'g2', name: 'Park Friends', lat: 51.508, lng: -0.127 }, { members: 2 })
  return data
}

const openGroups = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: 'Cleaning groups' }))
  return screen.findByRole('region', { name: 'Cleaning groups' })
}

describe('the Cleaning groups tab', () => {
  it('sits beside Reports, and swaps the panel and the button at the bottom', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    expect(screen.getByRole('tab', { name: 'Reports' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /Add a report/ })).toBeInTheDocument()

    await openGroups(user)
    expect(screen.getByRole('tab', { name: 'Cleaning groups' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Start a cleaning group here' })).toBeInTheDocument()
    // The reports' own controls go (hidden while they fade, then removed).
    await waitFor(() => expect(screen.queryByRole('button', { name: /Add a report/ })).not.toBeInTheDocument())
  })

  it('lists the groups in view, busiest first, with how many people and never who', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    const panel = await openGroups(user)
    const names = await within(panel).findAllByRole('button', { name: /^Show .* on the map$/ })
    expect(names.map((b) => b.textContent)).toEqual([
      'Riverside Litter Pickers11 people',
      'Park Friends2 people',
    ])
    expect(within(panel).getByText('Saturdays by the bridge.')).toBeInTheDocument()
    // One marker per group on the map.
    expect(screen.getAllByTestId('group-marker').map((m) => m.textContent)).toEqual(
      expect.arrayContaining(['Riverside Litter Pickers', 'Park Friends']),
    )
  })

  it('shows groups on the map on either tab exactly while the switch is on', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    const groupMarkers = () => screen.queryAllByTestId('group-marker')
    // On from the start, before the tab is ever opened.
    await waitFor(() => expect(groupMarkers()).toHaveLength(2))

    await openGroups(user)
    await user.click(screen.getByRole('tab', { name: 'Reports' }))
    expect(groupMarkers()).toHaveLength(2)

    // The map fades them out itself (lib/map/fades): the app's part is to
    // stop handing it any.
    await user.click(screen.getByRole('switch', { name: /Cleaning groups/ }))
    expect(groupMarkers()).toHaveLength(0)
    // The map follows the switch on their own tab too, so the two never
    // disagree; the list there still shows them.
    const panel = await openGroups(user)
    expect(groupMarkers()).toHaveLength(0)
    expect(await within(panel).findByText('Park Friends')).toBeInTheDocument()
  })

  it('opens a group’s card when its marker is picked on the map', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    await waitFor(() => expect(screen.queryAllByTestId('group-marker')).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'Park Friends' }))
    expect(screen.getByRole('tab', { name: 'Cleaning groups' })).toHaveAttribute('aria-selected', 'true')
    const panel = await screen.findByRole('region', { name: 'Cleaning groups' })
    const card = (await within(panel).findByText('Park Friends')).closest('li') as HTMLElement
    await waitFor(() => expect(card.querySelector('.border-emerald-500')).not.toBeNull())
    expect(mapControl.flyTo).toHaveBeenLastCalledWith([51.508, -0.127], expect.any(Number))
  })

  it('says when there are more groups here than it shows', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    for (let i = 0; i < 205; i += 1) data.seedGroup({ id: `busy-${i}`, name: `Busy Group ${i}`, lat: 51.507, lng: -0.128 })
    render(<App data={data} />)
    const panel = await openGroups(user)
    expect(await within(panel).findByText(/Not every group here is shown/)).toBeInTheDocument()
    expect(within(panel).getAllByRole('button', { name: /^Show .* on the map$/ })).toHaveLength(200)
  })

  it('leaves "no groups here" alone while the map reloads, rather than flickering it', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(ALICE, { displayName: 'Alice' })
    render(<App data={data} />)
    const panel = await openGroups(user)
    const empty = await within(panel).findByText(/No groups here yet/)
    const box = () => empty.closest('[data-reveal]')
    await waitFor(() => expect(box()).toHaveAttribute('data-reveal', 'in'))

    // The next load never answers, as a slow network would not for a while.
    vi.spyOn(data, 'listGroupsInView').mockReturnValue(new Promise(() => {}))
    await moveMapTo(12, [40, 10])
    expect(box()).toHaveAttribute('data-reveal', 'in')
    expect(box()).not.toHaveAttribute('aria-hidden')
  })

  it('says nothing about more when it shows them all', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    const panel = await openGroups(user)
    await within(panel).findByText('Park Friends')
    expect(within(panel).queryByText(/Not every group here is shown/)).not.toBeInTheDocument()
  })

  it('lets somebody join and leave, and counts them', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    const panel = await openGroups(user)
    const card = (await within(panel).findByText('Park Friends')).closest('li') as HTMLElement

    await user.click(within(card).getByRole('button', { name: 'Join' }))
    await waitFor(() => expect(within(card).getByText('3 people')).toBeInTheDocument())
    // Join fades into Leave rather than being replaced in one frame.
    const oldJoin = within(card).queryByText('Join')
    if (oldJoin) expect(oldJoin.parentElement).toHaveAttribute('aria-hidden', 'true')
    expect(within(card).getByRole('button', { name: 'Leave' }).closest('[data-swap]')).toHaveAttribute('data-swap', 'leave')
    await user.click(within(card).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(within(card).getByText('2 people')).toBeInTheDocument())
  })

  it('asks people who are signed out to sign in, rather than offering to join', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups(null)} />)
    const panel = await openGroups(user)
    await within(panel).findByText('Park Friends')
    expect(within(panel).queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
    expect(within(panel).getAllByText('Sign in to join.').length).toBeGreaterThan(0)
  })

  it('starts a group where the map is looking, which waits to be checked', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    render(<App data={data} />)
    await openGroups(user)
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))

    // Too far out, the home would be vague.
    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    expect(within(form).getByText(/Zoom in to the area/)).toBeInTheDocument()

    await moveMapTo(14)
    await user.type(within(form).getByLabelText('Group name'), 'Canal Clean Crew')
    await user.type(within(form).getByLabelText('What you do'), 'Evenings along the towpath.')
    await user.click(within(form).getByRole('button', { name: 'Start the group' }))

    const panel = screen.getByRole('region', { name: 'Cleaning groups' })
    expect(await within(panel).findByText('Canal Clean Crew')).toBeInTheDocument()
    expect(within(panel).getByText(/Waiting to be checked/)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Start a cleaning group' })).not.toBeInTheDocument(),
    )
  })

  it('keeps a half-written group when you look at the Reports tab and come back', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    await openGroups(user)
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))
    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.type(within(form).getByLabelText('Group name'), 'Half Written Crew')

    await user.click(screen.getByRole('tab', { name: 'Reports' }))
    // Right through its fade, to where it would have been removed, and kept.
    await waitFor(() => expect(form.closest('[data-reveal]')).toHaveAttribute('hidden'))
    await user.click(screen.getByRole('tab', { name: 'Cleaning groups' }))

    const back = await screen.findByRole('form', { name: 'Start a cleaning group' })
    expect(within(back).getByLabelText('Group name')).toHaveValue('Half Written Crew')
  })

  it('keeps a half-written report the same way', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    await user.click(screen.getByRole('button', { name: /Add a report/ }))
    const form = await screen.findByRole('form', { name: 'Add a report' })
    await user.type(within(form).getByLabelText(/^Note/), 'Bags by the bench')

    await openGroups(user)
    await waitFor(() => expect(form.closest('[data-reveal]')).toHaveAttribute('hidden'))
    await user.click(screen.getByRole('tab', { name: 'Reports' }))
    const back = await screen.findByRole('form', { name: 'Add a report' })
    expect(within(back).getByLabelText(/^Note/)).toHaveValue('Bags by the bench')
  })

  it('says plainly when a group name is too short, before asking the database', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    const create = vi.spyOn(data, 'createGroup')
    render(<App data={data} />)
    await openGroups(user)
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))
    await moveMapTo(14)
    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.type(within(form).getByLabelText('Group name'), 'ab')
    await user.click(within(form).getByRole('button', { name: 'Start the group' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('at least 3 letters')
    expect(create).not.toHaveBeenCalled()
  })

  it('says a tab in the description is the problem, before asking the database', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    const create = vi.spyOn(data, 'createGroup')
    render(<App data={data} />)
    await openGroups(user)
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))
    await moveMapTo(14)
    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.type(within(form).getByLabelText('Group name'), 'Canal Clean Crew')
    // Pasted, as a tab would arrive: typing one moves focus instead.
    fireEvent.change(within(form).getByLabelText('What you do'), { target: { value: 'Bring\tgloves' } })
    await user.click(within(form).getByRole('button', { name: 'Start the group' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('take the tabs out')
    expect(create).not.toHaveBeenCalled()
  })

  it('shows a report pin picked on this tab on the Reports side, rather than keeping it unseen', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278, note: 'Bags by the bench' })
    render(<App data={data} />)
    await openGroups(user)
    await moveMapTo(17)
    const [reportPin] = await screen.findAllByTestId('pin')
    await user.click(reportPin)
    expect(screen.getByRole('tab', { name: 'Reports' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Bags by the bench')).toBeInTheDocument()
  })

  it('opens a report picked from the read-out list on this tab, on the Reports side', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    data.seed({ id: 'r1', lat: 51.5074, lng: -0.1278, note: 'Bags by the bench' })
    render(<App data={data} />)
    await openGroups(user)
    await user.click(await screen.findByRole('button', { name: /Litter reported here/ }))
    expect(screen.getByRole('tab', { name: 'Reports' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Bags by the bench')).toBeInTheDocument()
  })

  it('behaves as tabs do: each names its panel, and the arrow keys move between them', async () => {
    const user = userEvent.setup()
    render(<App data={withGroups()} />)
    const reports = screen.getByRole('tab', { name: 'Reports' })
    const groups = screen.getByRole('tab', { name: 'Cleaning groups' })
    expect(reports).toHaveAttribute('aria-controls', 'panel-map')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-map')
    // Every id a tab names is on the page: the unchosen tab names none.
    expect(groups).not.toHaveAttribute('aria-controls')
    for (const tab of [reports, groups]) {
      const controls = tab.getAttribute('aria-controls')
      if (controls) expect(document.getElementById(controls)).not.toBeNull()
    }
    // Only the chosen tab is in the Tab order.
    expect(reports).toHaveAttribute('tabindex', '0')
    expect(groups).toHaveAttribute('tabindex', '-1')

    reports.focus()
    await user.keyboard('{ArrowRight}')
    expect(groups).toHaveAttribute('aria-selected', 'true')
    expect(groups).toHaveFocus()
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-groups'))
    await waitFor(() => expect(document.getElementById('panel-map')).toBeNull())
    expect(reports).not.toHaveAttribute('aria-controls')
    expect(groups).toHaveAttribute('aria-controls', 'panel-groups')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-groups')

    await user.keyboard('{Home}')
    expect(reports).toHaveAttribute('aria-selected', 'true')
    expect(reports).toHaveFocus()
  })

  it('does not suggest starting a group where none can be started', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?world=real')
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    try {
      render(<App />)
      const panel = await openGroups(user)
      expect(await within(panel).findByText('No groups here yet.')).toBeInTheDocument()
      expect(within(panel).queryByText(/start the first one/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Start a cleaning group here' })).not.toBeInTheDocument()
    } finally {
      vi.unstubAllEnvs()
      window.history.replaceState(null, '', '/')
    }
  })

  it('asks for a name first when the person has not chosen one', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource(ALICE)
    render(<App data={data} />)
    await openGroups(user)
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))
    await moveMapTo(14)
    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.type(await within(form).findByLabelText('Your name'), 'Alice')
    await user.type(within(form).getByLabelText('Group name'), 'Canal Clean Crew')
    await user.click(within(form).getByRole('button', { name: 'Start the group' }))
    const panel = screen.getByRole('region', { name: 'Cleaning groups' })
    expect(await within(panel).findByText('Canal Clean Crew')).toBeInTheDocument()
    expect(data.nameOf(ALICE.id)).toEqual({ name: 'Alice', status: 'pending' })
  })

  it('lets a founder who left their group waiting for review join it again', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    data.seedGroup(
      { id: 'mine', name: 'My Own Group', lat: 51.507, lng: -0.128, status: 'pending' },
      { founderId: ALICE.id, members: [ALICE.id] },
    )
    render(<App data={data} />)
    const panel = await openGroups(user)
    const mine = (await within(panel).findByText('My Own Group')).closest('li') as HTMLElement
    await user.click(within(mine).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(within(mine).getByText('0 people')).toBeInTheDocument())
    await user.click(within(mine).getByRole('button', { name: 'Join' }))
    await waitFor(() => expect(within(mine).getByText('1 person')).toBeInTheDocument())
  })

  it('starts a group after the map has been panned a whole world round', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    render(<App data={data} />)
    await openGroups(user)
    await user.click(screen.getByRole('button', { name: 'Start a cleaning group here' }))
    await moveMapTo(14, [51.5074, 359.8722])
    const form = await screen.findByRole('form', { name: 'Start a cleaning group' })
    await user.type(within(form).getByLabelText('Group name'), 'Round The World Crew')
    await user.click(within(form).getByRole('button', { name: 'Start the group' }))
    const panel = screen.getByRole('region', { name: 'Cleaning groups' })
    expect(await within(panel).findByText('Round The World Crew')).toBeInTheDocument()
  })

  it('tells a founder whose group has members that those members can see it too', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    data.seedGroup(
      { id: 'mine', name: 'Waiting Group', lat: 51.507, lng: -0.128, status: 'pending' },
      { founderId: ALICE.id, members: [ALICE.id, 'dan'] },
    )
    data.seedGroup(
      { id: 'alone', name: 'Brand New Group', lat: 51.507, lng: -0.128, status: 'pending' },
      { founderId: ALICE.id, members: [ALICE.id] },
    )
    render(<App data={data} />)
    const panel = await openGroups(user)
    const shared = (await within(panel).findByText('Waiting Group')).closest('li') as HTMLElement
    const alone = within(panel).getByText('Brand New Group').closest('li') as HTMLElement
    expect(within(shared).getByText(/Only the people in it can see it/)).toBeInTheDocument()
    expect(within(alone).getByText(/Only you can see it/)).toBeInTheDocument()
  })

  it('lets the founder delete their own group, and nobody else', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    data.seedGroup({ id: 'mine', name: 'My Own Group', lat: 51.507, lng: -0.128 }, { founderId: ALICE.id, members: [ALICE.id] })
    render(<App data={data} />)
    const panel = await openGroups(user)
    const mine = (await within(panel).findByText('My Own Group')).closest('li') as HTMLElement
    const theirs = within(panel).getByText('Park Friends').closest('li') as HTMLElement
    expect(within(theirs).queryByRole('button', { name: 'Delete group' })).not.toBeInTheDocument()
    await user.click(within(mine).getByRole('button', { name: 'Delete group' }))
    // Asked first: it takes everybody out of the group, for good.
    const ask = within(mine).getByRole('alertdialog', { name: 'Delete My Own Group?' })
    expect(within(panel).getByText('My Own Group')).toBeInTheDocument()
    await user.click(within(ask).getByRole('button', { name: 'Yes, delete it' }))
    await waitFor(() => expect(within(panel).queryByText('My Own Group')).not.toBeInTheDocument())
  })

  it('keeps the group when the founder thinks better of deleting it', async () => {
    const user = userEvent.setup()
    const data = withGroups()
    const remove = vi.spyOn(data, 'deleteGroup')
    data.seedGroup({ id: 'mine', name: 'My Own Group', lat: 51.507, lng: -0.128 }, { founderId: ALICE.id })
    render(<App data={data} />)
    const panel = await openGroups(user)
    const mine = (await within(panel).findByText('My Own Group')).closest('li') as HTMLElement
    await user.click(within(mine).getByRole('button', { name: 'Delete group' }))
    await user.click(within(mine).getByRole('button', { name: 'Keep it' }))
    expect(remove).not.toHaveBeenCalled()
    expect(within(mine).queryByRole('alertdialog')).not.toBeInTheDocument()
    // Faded out, not snatched away: still drawn, hidden, on its way out...
    const leaving = within(mine).getByText(/cannot be undone/).closest('[data-reveal]')
    expect(leaving).toHaveAttribute('data-reveal', 'out')
    expect(leaving).toHaveAttribute('aria-hidden', 'true')
    // ...and then gone.
    await waitFor(() => expect(within(mine).queryByText(/cannot be undone/)).not.toBeInTheDocument())
  })

  it('lets an admin delete any group, including one whose founder has gone', async () => {
    const user = userEvent.setup()
    const data = new FakeDataSource({ id: 'admin', email: 'admin@example.com', isAdmin: true }, { displayName: 'Admin' })
    data.seedGroup({ id: 'orphan', name: 'Orphaned Group', lat: 51.507, lng: -0.128 }, { founderId: null, members: 3 })
    render(<App data={data} />)
    const panel = await openGroups(user)
    const card = (await within(panel).findByText('Orphaned Group')).closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Delete group' }))
    await user.click(within(card).getByRole('button', { name: 'Yes, delete it' }))
    await waitFor(() => expect(within(panel).queryByText('Orphaned Group')).not.toBeInTheDocument())
  })
})
