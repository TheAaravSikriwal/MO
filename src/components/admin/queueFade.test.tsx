import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminQueue } from './AdminQueue'
import { FakeDataSource } from '../../lib/data/fakeSource'

/** A decided item leaves the review queue the way everything else leaves: by fading. */

describe('AdminQueue — a decided item', () => {
  it('fades out of the list rather than vanishing when the list reloads', async () => {
    const data = new FakeDataSource({ id: 'admin-1', email: 'a@b.com', isAdmin: true }, { displayName: 'Sam' })
    data.seedQueueItem({ jobId: 'j1', subjectType: 'comment', subjectId: 'c1', text: 'First thing to judge' })
    data.seedQueueItem({ jobId: 'j2', subjectType: 'comment', subjectId: 'c2', text: 'Second thing to judge' })
    const user = userEvent.setup()
    render(<AdminQueue data={data} isAdmin onClose={vi.fn()} onDecided={vi.fn()} />)

    const first = await screen.findByText('First thing to judge')
    const card = first.closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Allow' }))

    // Hidden and on its way out while the list is already the new one...
    await waitFor(() =>
      expect(screen.getByText('First thing to judge').closest('[data-reveal]')).toHaveAttribute('data-reveal', 'out'),
    )
    expect(screen.getByText('First thing to judge').closest('[data-reveal]')).toHaveAttribute('aria-hidden', 'true')
    // ...and then gone, with the other item untouched.
    await waitFor(() => expect(screen.queryByText('First thing to judge')).not.toBeInTheDocument())
    expect(screen.getByText('Second thing to judge').closest('[data-reveal]')).toHaveAttribute('data-reveal', 'in')
  })
})
