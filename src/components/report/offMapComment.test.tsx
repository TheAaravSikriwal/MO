import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportDetail } from './ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'

/**
 * A pin taken off the map while somebody has it open. The panel still shows the
 * comment box; the refusal has to say what happened, not ask for a name.
 */

describe('ReportDetail — a pin taken off while it is open', () => {
  it('says the report was taken off, and does not ask for a name', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    // A copy, as a real client holds: the fake changes its own objects in
    // place, and handing the panel that same object would let it see the
    // removal the moment it re-rendered, which no stale panel ever does.
    const report = { ...data.seed({ id: 'r1', lat: 51.5, lng: -0.12 }) }
    render(<ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'still here')

    // An admin takes it off in the meantime.
    data.setUser({ id: 'admin-1', isAdmin: true })
    await data.setReportOnMap('r1', false)
    data.setUser({ id: 'u1', isAdmin: false })

    await user.click(screen.getByRole('button', { name: /post comment/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/taken off the map/i)
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
  })

  it('says so for "mark as cleaned" too, rather than claiming it was already cleaned', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    // A copy, as a real client holds: the fake changes its own objects in
    // place, and handing the panel that same object would let it see the
    // removal the moment it re-rendered, which no stale panel ever does.
    const report = { ...data.seed({ id: 'r1', lat: 51.5, lng: -0.12 }) }
    render(<ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />)
    data.setUser({ id: 'admin-1', isAdmin: true })
    await data.setReportOnMap('r1', false)
    data.setUser({ id: 'u1', isAdmin: false })

    await userEvent.setup().click(screen.getByRole('button', { name: /mark as cleaned/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/taken off the map/i)
    expect(alert).not.toHaveTextContent(/already/i)
  })
})
