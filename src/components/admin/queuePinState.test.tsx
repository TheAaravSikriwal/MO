import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminQueue } from './AdminQueue'
import { FakeDataSource } from '../../lib/data/fakeSource'
import { OFF_MAP_PAGE } from '../../lib/data/types'

/**
 * Each queue item carries its pin's state from the database, so the queue
 * never has to guess from what it has loaded or done itself.
 */

const admin = () => {
  const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
  data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
  data.seedQueueItem({ jobId: 'j1', subjectType: 'note', subjectId: 'r1', reportId: 'r1', text: 'spam' })
  return data
}

describe('AdminQueue — an item’s pin, as it really is', () => {
  it('stops saying "taken off" when the pin is put back from the report screen', async () => {
    const data = admin()
    const { rerender } = render(<AdminQueue data={data} isAdmin onClose={vi.fn()} pinsVersion={0} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /take the pin off the map/i }))
    expect(await screen.findByText(/pin taken off the map/i)).toBeInTheDocument()

    // Put back from the report's own screen, which bumps the version.
    await data.setReportOnMap('r1', true)
    rerender(<AdminQueue data={data} isAdmin onClose={vi.fn()} pinsVersion={1} />)
    expect(await screen.findByRole('button', { name: /take the pin off the map/i })).toBeInTheDocument()
    expect(screen.queryByText(/pin taken off the map/i)).not.toBeInTheDocument()
  })

  it('knows a pin is off even when it is beyond the first page of the off-map list', async () => {
    // A clock that moves, so the removals have an order to sort by.
    let clock = 1000
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { now: () => clock })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    data.seedQueueItem({ jobId: 'j1', subjectType: 'note', subjectId: 'r1', reportId: 'r1', text: 'spam' })
    // r1 taken off first, so fifty later removals push it off the first page.
    await data.setReportOnMap('r1', false)
    for (let i = 0; i < OFF_MAP_PAGE; i += 1) {
      clock += 1
      data.seed({ id: `x${i}`, lat: 51.5, lng: -0.12 })
      await data.setReportOnMap(`x${i}`, false)
    }
    const { reports } = await data.listReportsOffMap()
    expect(reports.map((report) => report.id)).not.toContain('r1')

    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    expect(await screen.findByText(/this pin is off the map/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /take the pin off the map/i })).not.toBeInTheDocument()
  })

  it('offers nothing for an item whose report is gone', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seedQueueItem({ jobId: 'j1', subjectType: 'note', subjectId: 'gone', reportId: 'gone', text: 'x' })
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    await screen.findByText('x')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /take the pin off the map/i })).not.toBeInTheDocument(),
    )
    // Nor a claim about a pin that no longer exists.
    expect(screen.queryByText(/this pin is off the map/i)).not.toBeInTheDocument()
  })
})
