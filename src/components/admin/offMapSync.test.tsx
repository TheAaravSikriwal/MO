import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminQueue } from './AdminQueue'
import { ReportDetail } from '../report/ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'

/** The queue and the report screen agreeing about which pins are off the map. */

const admin = () => {
  const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
  data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
  return data
}

describe('AdminQueue — staying in step with the report screen', () => {
  it('reloads its off-map list when a pin changes elsewhere', async () => {
    const data = admin()
    const { rerender } = render(<AdminQueue data={data} isAdmin onClose={vi.fn()} pinsVersion={0} />)
    await waitFor(() => expect(screen.getByRole('region', { name: /review queue/i })).toBeInTheDocument())
    expect(screen.queryByText(/off the map/i)).not.toBeInTheDocument()

    // Taken off from the report's own screen, which bumps the version.
    await data.setReportOnMap('r1', false, 'spam')
    rerender(<AdminQueue data={data} isAdmin onClose={vi.fn()} pinsVersion={1} />)
    expect(await screen.findByText(/taken off because: spam/i)).toBeInTheDocument()
  })

  it('says an item’s pin is already off, instead of offering to take it off', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false)
    data.seedQueueItem({ jobId: 'j1', subjectType: 'note', subjectId: 'r1', reportId: 'r1', text: 'spam' })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    expect(await screen.findByText(/this pin is off the map/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /take the pin off the map/i })).not.toBeInTheDocument()
  })

  it('does not claim it just took off a pin that was already off', async () => {
    const data = admin()
    data.seedQueueItem({ jobId: 'j1', subjectType: 'note', subjectId: 'r1', reportId: 'r1', text: 'spam' })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /take the pin off the map/i })
    // Somebody else takes it off in the meantime, and the list has not caught up.
    await data.setReportOnMap('r1', false)
    await userEvent.setup().click(button)
    expect(await screen.findByText(/this pin is off the map/i)).toBeInTheDocument()
    expect(screen.queryByText(/pin taken off the map/i)).not.toBeInTheDocument()
  })
})

describe('ReportDetail — no name complaint on a pin off the map', () => {
  it('does not offer "Report this name" to an admin looking at an off-map pin', async () => {
    const data = admin()
    await data.setReportOnMap('r1', false)
    const report = { ...(await data.getReport('r1'))!, reporterName: 'Somebody' }
    render(<ReportDetail data={data} report={report} signedIn isAdmin onChanged={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/by Somebody/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /report this name/i })).not.toBeInTheDocument()
  })
})
