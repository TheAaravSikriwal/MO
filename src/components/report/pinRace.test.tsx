import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportDetail } from './ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'

/**
 * Two admins at once, from the report screen. The second one's click changes
 * nothing on the server, and the screen has to say so rather than behave as
 * though it had worked.
 */

const setup = () => {
  const data = new FakeDataSource({ id: 'admin-1', isAdmin: true }, { displayName: 'Sam' })
  // A copy, as a real client holds: the fake changes its own objects in place.
  const report = { ...data.seed({ id: 'r1', lat: 51.5, lng: -0.12 }) }
  const onPinChanged = vi.fn()
  const onChanged = vi.fn()
  render(
    <ReportDetail
      data={data}
      report={report}
      signedIn
      isAdmin
      onChanged={onChanged}
      onPinChanged={onPinChanged}
      onClose={vi.fn()}
    />,
  )
  return { data, onPinChanged, onChanged, user: userEvent.setup() }
}

describe('ReportDetail — somebody else moved the pin first', () => {
  it('keeps the typed reason, says it was not saved, and reports no change', async () => {
    const { data, onPinChanged, user } = setup()
    await user.type(screen.getByLabelText(/why take it off/i), 'my own reason')
    // Another admin takes it off in the meantime.
    await data.setReportOnMap('r1', false, 'their reason')

    await user.click(screen.getByRole('button', { name: /take off the map/i }))
    expect(await screen.findByText(/somebody else already took this pin off the map/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/why take it off/i)).toHaveValue('my own reason')
    expect(onPinChanged).not.toHaveBeenCalled()
    expect(data.pinHistory).toHaveLength(1)
    expect(data.pinHistory[0].reason).toBe('their reason')
  })

  it('reports a real change, and clears the reason, when it did the moving', async () => {
    const { onPinChanged, user } = setup()
    await user.type(screen.getByLabelText(/why take it off/i), 'a pin in the sea')
    await user.click(screen.getByRole('button', { name: /take off the map/i }))
    await waitFor(() => expect(onPinChanged).toHaveBeenCalledTimes(1))
    // The panel holds a copy, so the field is still there to check.
    expect(screen.getByLabelText(/why take it off/i)).toHaveValue('')
  })
})

describe('ReportDetail — only a pin change reloads the review queue', () => {
  it('does not report a pin change for a vote or a comment', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = { ...data.seed({ id: 'r1', lat: 51.5, lng: -0.12 }) }
    const onPinChanged = vi.fn()
    const onChanged = vi.fn()
    render(
      <ReportDetail
        data={data}
        report={report}
        signedIn
        onChanged={onChanged}
        onPinChanged={onPinChanged}
        onClose={vi.fn()}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /confirm this is here/i }))
    await user.type(screen.getByLabelText(/add a comment/i), 'still here')
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2))
    expect(onPinChanged).not.toHaveBeenCalled()
  })
})
