import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AdminQueue } from './AdminQueue'
import { ReportDetail } from '../report/ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'
import { OFF_MAP_PAGE } from '../../lib/data/types'

/** The off-map list's order, its limit, its independence, and closed comments. */

describe('ReportDetail — comments on a pin off the map', () => {
  it('closes them, rather than offering a box the database will refuse', () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12, moderationStatus: 'rejected', viewerIsReporter: true })
    render(<ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/comments are closed while this report is off the map/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/add a comment/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
  })
})

describe('AdminQueue — the off-map list', () => {
  it('puts the most recently taken off first, however old the report', async () => {
    let clock = 1000
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { now: () => clock })
    data.seed({ id: 'old', lat: 51.5, lng: -0.12, createdAt: '2020-01-01T00:00:00Z', reporterName: 'Old Pin' })
    data.seed({ id: 'new', lat: 51.5, lng: -0.12, createdAt: '2026-09-01T00:00:00Z', reporterName: 'New Pin' })
    await data.setReportOnMap('new', false)
    clock += 1000
    await data.setReportOnMap('old', false) // taken off most recently
    const { reports } = await data.listReportsOffMap()
    expect(reports.map((report) => report.id)).toEqual(['old', 'new'])
  })

  it('says when there are more than it shows', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    for (let i = 0; i <= OFF_MAP_PAGE; i += 1) {
      data.seed({ id: `r${i}`, lat: 51.5, lng: -0.12 })
      await data.setReportOnMap(`r${i}`, false)
    }
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    expect(
      await screen.findByText(new RegExp(`showing the ${OFF_MAP_PAGE} most recently taken off`, 'i')),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /put back on the map/i })).toHaveLength(OFF_MAP_PAGE)
  })

  it('moves the next pin up when one is put back from a list that was cut short', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    for (let i = 0; i <= OFF_MAP_PAGE; i += 1) {
      data.seed({ id: `r${i}`, lat: 51.5, lng: -0.12 })
      await data.setReportOnMap(`r${i}`, false)
    }
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    const buttons = await screen.findAllByRole('button', { name: /put back on the map/i })
    expect(buttons).toHaveLength(OFF_MAP_PAGE)

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.setup().click(buttons[0])
    // Fifty were shown out of fifty-one; one went back, so all fifty remaining
    // now fit, and the list no longer says it is cut short.
    await waitFor(() => expect(screen.queryByText(/most recently taken off/i)).not.toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: /put back on the map/i })).toHaveLength(OFF_MAP_PAGE)
  })

  it('still loads when the review queue itself cannot', async () => {
    const data = new FakeDataSource({ id: 'admin-1', isAdmin: true })
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.setReportOnMap('r1', false, 'spam')
    vi.spyOn(data, 'listModerationQueue').mockRejectedValue(new Error('network is down'))
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/taken off because: spam/i)).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(/could not reach the server/i)
  })
})
