import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminQueue } from './AdminQueue'
import { ReportDetail } from '../report/ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'

/** Taking pins off the map and putting them back, from both places an admin can. */

const admin = () => {
  const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
  data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
  return data
}

describe('ReportDetail — an admin’s reason, and putting a pin back', () => {
  it('records the reason the admin typed', async () => {
    const data = admin()
    const report = (await data.getReport('r1'))!
    render(<ReportDetail data={data} report={report} signedIn isAdmin onChanged={vi.fn()} onClose={vi.fn()} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/why take it off/i), 'a pin in the sea')
    await user.click(screen.getByRole('button', { name: /take off the map/i }))
    await waitFor(() => expect(data.pinHistory).toHaveLength(1))
    expect(data.pinHistory[0]).toMatchObject({ action: 'off', actedBy: 'admin-1', reason: 'a pin in the sea' })
    expect((await data.getReport('r1'))!.removalReason).toBe('a pin in the sea')
  })

  it('records no reason, rather than a made-up one, when none is typed', async () => {
    const data = admin()
    const report = (await data.getReport('r1'))!
    render(<ReportDetail data={data} report={report} signedIn isAdmin onChanged={vi.fn()} onClose={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /take off the map/i }))
    await waitFor(() => expect(data.pinHistory).toHaveLength(1))
    expect(data.pinHistory[0].reason).toBeNull()
  })

  it('puts a pin back when asked', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false, 'spam')
    const report = (await data.getReport('r1'))!
    render(<ReportDetail data={data} report={report} signedIn isAdmin onChanged={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/taken off because: spam/i)).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /put back on the map/i }))
    await waitFor(async () => expect((await data.getReport('r1'))!.moderationStatus).toBe('approved'))
    expect(data.pinHistory.map((entry) => entry.action)).toEqual(['off', 'on'])
  })
})

describe('AdminQueue — pins off the map', () => {
  it('lists them, with the reason, and puts one back', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false, 'a joke pin')
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    const user = userEvent.setup()

    expect(await screen.findByText(/taken off because: a joke pin/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /put back on the map/i }))
    await waitFor(async () => expect((await data.getReport('r1'))!.moderationStatus).toBe('approved'))
    expect(screen.queryByText(/a joke pin/i)).not.toBeInTheDocument()
  })

  it('records one removal for a double click, with no made-up reason', async () => {
    const data = admin()
    data.seedQueueItem({ jobId: 'j1', subjectType: 'note', subjectId: 'r1', reportId: 'r1', text: 'spam' })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /take the pin off the map/i })
    await userEvent.setup().dblClick(button)
    await screen.findByText(/pin taken off the map/i)
    expect(data.pinHistory).toEqual([
      { reportId: 'r1', action: 'off', actedBy: 'admin-1', reason: null },
    ])
  })

  it('keeps the queue working when the off-map list cannot be loaded', async () => {
    const data = admin()
    data.seedQueueItem({ jobId: 'j1', subjectType: 'comment', text: 'something a person wrote' })
    vi.spyOn(data, 'listReportsOffMap').mockRejectedValue(new Error('network is down'))
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    expect(await screen.findByText('something a person wrote')).toBeInTheDocument()
    expect(await screen.findByText(/could not load the pins that are off the map/i)).toBeInTheDocument()
  })
})

describe('FakeDataSource — taking a pin off the map', () => {
  it('changes nothing when the pin is already where it was asked to be', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false, 'first')
    await data.setReportOnMap('r1', false, 'second')
    expect(data.pinHistory).toHaveLength(1)
    expect((await data.getReport('r1'))!.removalReason).toBe('first')
  })

  it('takes no new comments on a pin off the map', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false)
    await expect(data.addComment('r1', 'hello')).rejects.toThrow('this report is off the map')
  })

  it('refuses a vote or "cleaned" on a pin off the map, as the database does', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false)
    data.setUser({ id: 'u2', isAdmin: true })
    await expect(data.addVote('r1')).rejects.toThrow('this report is off the map')
    await expect(data.markCleaned('r1')).rejects.toThrow('this report is off the map')
  })

  it('gives the reason to admins only', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false, 'spam')
    data.setUser({ id: 'u1', isAdmin: false })
    data.seedReporter('r1', 'u1')
    expect((await data.getReport('r1'))!.removalReason).toBeNull()
  })
})
