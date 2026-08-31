import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminQueue } from './AdminQueue'
import { FakeDataSource } from '../../lib/data/fakeSource'
import type { QueueItem } from '../../lib/data/types'

const setup = (
  seeds: Array<Partial<QueueItem> & { jobId: string }> = [],
  { isAdmin = true }: { isAdmin?: boolean } = {},
) => {
  const data = new FakeDataSource({ id: 'admin-1', email: 'a@b.com', isAdmin })
  for (const seed of seeds) data.seedQueueItem(seed)
  const onDecided = vi.fn()
  const onClose = vi.fn()
  render(<AdminQueue data={data} isAdmin={isAdmin} onClose={onClose} onDecided={onDecided} />)
  return { data, onDecided, onClose, user: userEvent.setup() }
}

describe('AdminQueue — who can see it', () => {
  it('renders nothing at all for a non-admin', () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false })
    const { container } = render(
      <AdminQueue data={data} isAdmin={false} onClose={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('does not even ask the server for the queue when not an admin', () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false })
    const spy = vi.spyOn(data, 'listModerationQueue')
    render(<AdminQueue data={data} isAdmin={false} onClose={vi.fn()} />)
    expect(spy).not.toHaveBeenCalled()
  })

  it('shows the error rather than an empty queue if the server refuses', async () => {
    // A non-admin getting "nothing to review" would read as "all clear", which
    // is the opposite of the truth.
    const data = new FakeDataSource({ id: 'u1', isAdmin: false })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/permission/i)
    // The raw server wording must not reach the screen.
    expect(alert.textContent?.toLowerCase()).not.toContain('moderation')
  })
})

describe('AdminQueue — what it shows', () => {
  it('says plainly when there is nothing waiting', async () => {
    setup([])
    expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument()
  })

  it('counts what is waiting', async () => {
    setup([{ jobId: 'j1' }, { jobId: 'j2' }])
    expect(await screen.findByText(/2 waiting/i)).toBeInTheDocument()
  })

  it('says when more are waiting than it is showing', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seedQueueItem({ jobId: 'j1' })
    vi.spyOn(data, 'getModerationQueueSize').mockResolvedValue(200)
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    // Printing the page length as the total would tell an admin the queue is
    // nearly clear when it is not.
    expect(await screen.findByText(/200 waiting, showing the first 1/i)).toBeInTheDocument()
  })

  it('shows comment text so it can be judged', async () => {
    setup([{ jobId: 'j1', subjectType: 'comment', text: 'something a person wrote' }])
    expect(await screen.findByText('something a person wrote')).toBeInTheDocument()
  })

  it('explains why it needs a person, in plain words', async () => {
    // Verbatim from worker/src/pipeline.ts. It must never render as-is.
    setup([{ jobId: 'j1', reason: 'no judge configured and tier 2 could not decide' }])
    expect(await screen.findByText(/automatic checks could not decide/i)).toBeInTheDocument()
    expect(screen.queryByText(/tier 2/i)).not.toBeInTheDocument()
  })

  it('never renders raw model prose from the escalation reason', async () => {
    setup([
      {
        jobId: 'j1',
        reason: 'The image depicts a NSFW scene; tier escalation advised per policy 4.2',
      },
    ])
    await screen.findByRole('listitem')
    const text = (document.body.textContent ?? '').toLowerCase()
    for (const jargon of ['nsfw', 'tier', 'escalation', 'policy 4.2']) {
      expect(text).not.toContain(jargon)
    }
  })

  it('shows the check scores as readable labels and percentages', async () => {
    setup([{ jobId: 'j1', tierResults: { imageScores: { nsfw: 0.42 } } }])
    expect(await screen.findByText('Adult content')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('shows nothing rather than raw keys when no score has a plain label', async () => {
    setup([{ jobId: 'j1', tierResults: { some_internal_metric: 0.5 } }])
    await screen.findByRole('listitem')
    expect(screen.queryByText(/some_internal_metric/i)).not.toBeInTheDocument()
  })

  it('marks items other people complained about', async () => {
    setup([{ jobId: 'j1', flagCount: 3 }])
    expect(await screen.findByText(/3 people reported this/i)).toBeInTheDocument()
  })

  it('uses singular wording for a single complaint', async () => {
    setup([{ jobId: 'j1', flagCount: 1 }])
    expect(await screen.findByText(/1 person reported this/i)).toBeInTheDocument()
  })

  it('puts complained-about items first', async () => {
    setup([
      { jobId: 'quiet', text: 'quiet one', flagCount: 0, createdAt: '2020-01-01T00:00:00Z' },
      { jobId: 'loud', text: 'loud one', flagCount: 5, createdAt: '2024-01-01T00:00:00Z' },
    ])
    await screen.findByText('loud one')
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('loud one')
  })
})

describe('AdminQueue — photos', () => {
  it('does not show a waiting photo until it is asked for', async () => {
    setup([{ jobId: 'j1', subjectType: 'photo', photoUrl: 'https://img/x.jpg' }])
    expect(await screen.findByRole('button', { name: /show photo/i })).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows it once asked', async () => {
    const { user } = setup([
      { jobId: 'j1', subjectType: 'photo', photoUrl: 'https://img/x.jpg' },
    ])
    await user.click(await screen.findByRole('button', { name: /show photo/i }))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://img/x.jpg')
  })

  it('copes with a photo that has since been deleted', async () => {
    setup([{ jobId: 'j1', subjectType: 'photo', photoUrl: null }])
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show photo/i })).not.toBeInTheDocument()
  })

  it('copes with text that has since been deleted', async () => {
    setup([{ jobId: 'j1', subjectType: 'comment', text: null }])
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
  })
})

describe('AdminQueue — deciding', () => {
  it('allows an item and removes it from the list', async () => {
    const { user, data, onDecided } = setup([{ jobId: 'j1', text: 'fine' }])
    await user.click(await screen.findByRole('button', { name: /allow/i }))

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(screen.queryByText('fine')).not.toBeInTheDocument()
    expect(await data.listModerationQueue()).toHaveLength(0)
  })

  it('removes an item and takes it out of the list', async () => {
    const { user, data } = setup([{ jobId: 'j1', text: 'not fine' }])
    await user.click(await screen.findByRole('button', { name: /remove/i }))
    await waitFor(async () => expect(await data.listModerationQueue()).toHaveLength(0))
  })

  it('actually applies the decision to the photo it judged', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    const report = data.seed({
      id: 'r1',
      lat: 51.5,
      lng: -0.12,
      photos: [{ id: 'p1', url: null, moderationStatus: 'pending' }],
    })
    data.seedQueueItem({
      jobId: 'j1',
      subjectType: 'photo',
      subjectId: 'p1',
      reportId: report.id,
      photoUrl: 'https://img/p1.jpg',
    })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /allow/i }))

    await waitFor(async () => {
      const updated = await data.getReport('r1')
      expect(updated!.photos[0].moderationStatus).toBe('approved')
      expect(updated!.photos[0].url).not.toBeNull()
    })
  })

  it('withholds the photo again when it is removed', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seed({
      id: 'r1',
      lat: 51.5,
      lng: -0.12,
      photos: [{ id: 'p1', url: null, moderationStatus: 'pending' }],
    })
    data.seedQueueItem({
      jobId: 'j1',
      subjectType: 'photo',
      subjectId: 'p1',
      reportId: 'r1',
      photoUrl: 'https://img/p1.jpg',
    })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /remove/i }))

    await waitFor(async () => {
      const updated = await data.getReport('r1')
      expect(updated!.photos[0].moderationStatus).toBe('rejected')
      expect(updated!.photos[0].url).toBeNull()
    })
  })

  it('applies the decision to the comment it judged, not just the job', async () => {
    // Comments are the default subject type and were previously never applied.
    const data = new FakeDataSource({ id: 'admin-1', email: 'a@b.com', isAdmin: true })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.addComment('r1', 'a comment awaiting review')
    const posted = (await data.listComments('r1'))[0]
    data.seedQueueItem({
      jobId: 'j1',
      subjectType: 'comment',
      subjectId: posted.id,
      reportId: 'r1',
      text: posted.body,
    })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /allow/i }))

    await waitFor(async () => {
      const updated = (await data.listComments('r1'))[0]
      expect(updated.moderationStatus).toBe('approved')
    })
  })

  it('makes an approved note readable again', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12, note: null, noteStatus: 'pending' })
    data.seedQueueItem({
      jobId: 'j1',
      subjectType: 'note',
      subjectId: 'r1',
      reportId: 'r1',
      text: 'Bags of rubbish by the bus stop',
    })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /allow/i }))

    await waitFor(async () => {
      const updated = await data.getReport('r1')
      expect(updated!.noteStatus).toBe('approved')
      expect(updated!.note).toBe('Bags of rubbish by the bus stop')
    })
  })

  it('surfaces a failed decision instead of pretending it worked', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seedQueueItem({ jobId: 'j1', text: 'something' })
    vi.spyOn(data, 'decideModerationItem').mockRejectedValue(
      new Error('permission denied for function admin_decide_moderation'),
    )
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /allow/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/permission/i)
    expect(alert.textContent?.toLowerCase()).not.toContain('admin_decide_moderation')
    // The item must still be there: a failed decision must not look like a done one.
    expect(await screen.findByText('something')).toBeInTheDocument()
  })

  it('says when someone else decided it first', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seedQueueItem({ jobId: 'j1', text: 'something' })
    vi.spyOn(data, 'decideModerationItem').mockRejectedValue(
      new Error('this item was decided by someone else a moment ago'),
    )
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /allow/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already/i)
  })

  it('disables both buttons while a decision is in flight, so it cannot be sent twice', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seedQueueItem({ jobId: 'j1', text: 'once' })
    let release: (() => void) | undefined
    const decide = vi
      .spyOn(data, 'decideModerationItem')
      .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    const user = userEvent.setup()
    const allow = await screen.findByRole('button', { name: /allow/i })
    await user.click(allow)

    await waitFor(() => expect(allow).toBeDisabled())
    expect(screen.getByRole('button', { name: /remove/i })).toBeDisabled()

    // A second click while in flight must not produce a second call.
    await user.click(allow)
    expect(decide).toHaveBeenCalledTimes(1)

    release?.()
  })

  it('will not let the same item be decided twice', async () => {
    const { user, data } = setup([{ jobId: 'j1', text: 'once' }])
    await user.click(await screen.findByRole('button', { name: /allow/i }))
    await waitFor(async () => expect(await data.listModerationQueue()).toHaveLength(0))
    await expect(data.decideModerationItem('j1', 'approved')).rejects.toThrow(/already/i)
  })
})

describe('AdminQueue — language', () => {
  it('uses plain words for the actions', async () => {
    setup([{ jobId: 'j1' }])
    expect(await screen.findByRole('button', { name: /allow/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
    const text = (document.body.textContent ?? '').toLowerCase()
    for (const jargon of ['moderation', 'verdict', 'tier', 'nsfw', 'escalate']) {
      expect(text).not.toContain(jargon)
    }
  })
})

describe('AdminQueue — a complaint reaches a person', () => {
  it('puts flagged content into the queue even after it was already allowed', async () => {
    const data = new FakeDataSource({ id: 'admin-1', email: 'a@b.com', isAdmin: true })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.addComment('r1', 'a comment that was let through')
    const posted = (await data.listComments('r1'))[0]
    posted.moderationStatus = 'approved'

    // Nothing waiting to begin with.
    expect(await data.listModerationQueue()).toHaveLength(0)

    await data.flag('comment', posted.id, 'reported by a reader')

    const queue = await data.listModerationQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].subjectType).toBe('comment')
    expect(queue[0].flagCount).toBe(1)
  })

  it('withholds flagged content again while it waits', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seed({
      id: 'r1',
      lat: 51.5,
      lng: -0.12,
      photos: [{ id: 'p1', url: 'https://img/p1.jpg', moderationStatus: 'approved' }],
    })

    await data.flag('photo', 'p1', 'reported by a reader')

    const updated = await data.getReport('r1')
    expect(updated!.photos[0].moderationStatus).toBe('pending')
    expect(updated!.photos[0].url).toBeNull()
  })

  it('brings an already-decided item back for a second look', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.addComment('r1', 'borderline')
    const posted = (await data.listComments('r1'))[0]
    data.seedQueueItem({
      jobId: 'j1',
      subjectType: 'comment',
      subjectId: posted.id,
      reportId: 'r1',
      text: posted.body,
    })
    await data.decideModerationItem('j1', 'approved')
    expect(await data.listModerationQueue()).toHaveLength(0)

    await data.flag('comment', posted.id, 'reported by a reader')
    expect(await data.listModerationQueue()).toHaveLength(1)
  })

  it('keeps the waiting count honest after a decision', async () => {
    const { user } = setup([{ jobId: 'j1', text: 'one' }, { jobId: 'j2', text: 'two' }])
    expect(await screen.findByText(/2 waiting/i)).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /allow/i })[0])

    // Leaving the total at 2 would read "2 waiting, showing the first 1", which
    // contains neither of these.
    const panel = screen.getByRole('region', { name: /review queue/i })
    await waitFor(() => expect(panel).toHaveTextContent(/1 waiting/i))
    expect(panel).not.toHaveTextContent(/showing the first/i)
  })
})
