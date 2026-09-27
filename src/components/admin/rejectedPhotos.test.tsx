import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminQueue } from './AdminQueue'
import { ReportDetail } from '../report/ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'

/**
 * The thirty-day hold on rejected photos exists so an admin can undo a wrong
 * rejection before the bytes are deleted. This is where that happens.
 */

const admin = () => {
  const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
  data.seed({ id: 'r1', lat: 51.5, lng: -0.12, photos: [] })
  return data
}

describe('AdminQueue — photos removed in the last 30 days', () => {
  it('lists them, and says when a machine removed one that nobody has seen', async () => {
    const data = admin()
    data.seedRejectedPhoto('r1', 'p1', { automatic: true })
    data.seedRejectedPhoto('r1', 'p2')
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)

    expect(await screen.findByText(/^removed photos$/i)).toBeInTheDocument()
    expect(screen.getByText(/removed automatically\. nobody has looked at it/i)).toBeInTheDocument()
    expect(screen.getByText(/removed by a person/i)).toBeInTheDocument()
  })

  it('shows a photo only when asked, like everything else here', async () => {
    const data = admin()
    data.seedRejectedPhoto('r1', 'p1', { automatic: true })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    await screen.findByText(/^removed photos$/i)
    expect(screen.queryByAltText(/removed photo/i)).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /show photo/i }))
    expect(screen.getByAltText(/removed photo/i)).toBeInTheDocument()
  })

  it('allows one after all, which puts it back on the report', async () => {
    const data = admin()
    data.seedRejectedPhoto('r1', 'p1', { automatic: true })
    const onDecided = vi.fn()
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} onDecided={onDecided} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /allow after all/i }))

    await waitFor(async () =>
      expect((await data.getReport('r1'))!.photos[0].moderationStatus).toBe('approved'),
    )
    expect(onDecided).toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByText(/^removed photos$/i)).not.toBeInTheDocument(),
    )
  })

  it('keeps the queue working when this list cannot be loaded', async () => {
    const data = admin()
    data.seedQueueItem({ jobId: 'j1', subjectType: 'comment', text: 'something a person wrote' })
    vi.spyOn(data, 'listRecentlyRejectedPhotos').mockRejectedValue(new Error('network is down'))
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    expect(await screen.findByText('something a person wrote')).toBeInTheDocument()
    expect(await screen.findByText(/could not load the photos removed recently/i)).toBeInTheDocument()
  })
})

describe('ReportDetail — no "Report this" on your own posts', () => {
  it('offers nothing to report on your own report’s note and photos', () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = data.seed({
      id: 'r1',
      lat: 51.5,
      lng: -0.12,
      viewerIsReporter: true,
      note: 'my note',
      photos: [{ id: 'p1', url: 'https://img/a.jpg', moderationStatus: 'approved' }],
    })
    render(<ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /report this note/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /report this photo/i })).not.toBeInTheDocument()
  })

  it('offers nothing to report on your own comment', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.addComment('r1', 'mine')
    ;(await data.listComments('r1'))[0].moderationStatus = 'approved'
    render(<ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('mine')
    expect(screen.queryByRole('button', { name: /report this comment/i })).not.toBeInTheDocument()
  })

  it('refuses it in the fake as well, in the database’s words', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12, viewerIsReporter: true })
    await expect(data.flag('note', 'r1', 'x')).rejects.toThrow('your own post')
  })
})

describe('AdminQueue — when each removed photo will go', () => {
  it('says when a photo is due to be deleted, and when it is overdue', async () => {
    const data = admin()
    data.seedRejectedPhoto('r1', 'p1', { automatic: true })
    vi.spyOn(data, 'listRecentlyRejectedPhotos').mockResolvedValue({
      photos: [
        { photoId: 'p1', reportId: 'r1', url: null, rejectedAt: new Date().toISOString(), automatic: true },
        {
          photoId: 'p2',
          reportId: 'r1',
          url: null,
          rejectedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
          automatic: false,
        },
      ],
      more: true,
    })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    expect(await screen.findByText(/to be deleted on/i)).toBeInTheDocument()
    expect(screen.getByText(/due to be deleted now/i)).toBeInTheDocument()
    // And says the list is cut short, rather than passing it off as complete.
    expect(screen.getByText(/showing the 2 due to be deleted soonest/i)).toBeInTheDocument()
  })
})

describe('AdminQueue — allowing a photo once', () => {
  it('sends one allow for a double click, and shows no error after it worked', async () => {
    const data = admin()
    data.seedRejectedPhoto('r1', 'p1', { automatic: true })
    // Slow, as a real request is, so the second click lands while the first
    // is still in flight.
    const original = data.allowRejectedPhoto.bind(data)
    const allow = vi.spyOn(data, 'allowRejectedPhoto').mockImplementation(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return original(id)
    })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    await userEvent.setup().dblClick(await screen.findByRole('button', { name: /allow after all/i }))
    await waitFor(() => expect(screen.queryByText(/^removed photos$/i)).not.toBeInTheDocument())
    expect(allow).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
