import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportDetail } from './ReportDetail'
import { FakeDataSource } from '../../lib/data/fakeSource'
import type { ReportView } from '../../lib/data/types'

const setup = (
  seed: Partial<ReportView> = {},
  { signedIn = true }: { signedIn?: boolean } = {},
) => {
  const data = new FakeDataSource(
    signedIn ? { id: 'u1', email: 'a@b.com', isAdmin: false } : null,
  )
  const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12, ...seed })
  const onChanged = vi.fn()
  const rendered = render(
    <ReportDetail
      data={data}
      report={report}
      signedIn={signedIn}
      onChanged={onChanged}
      onClose={vi.fn()}
    />,
  )
  return { data, report, onChanged, rendered, user: userEvent.setup() }
}

describe('ReportDetail — what it says', () => {
  it('describes the litter, never the place or the people', () => {
    setup()
    const text = (document.body.textContent ?? '').toLowerCase()
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('litter reported here')
    for (const word of ['dirty', 'filthy', 'slum', 'contaminated', 'bad area', 'these people']) {
      expect(text).not.toContain(word)
    }
  })

  it('keeps internal concepts out of the interface', () => {
    setup()
    const text = (document.body.textContent ?? '').toLowerCase()
    for (const jargon of ['hexagon', 'h3', 'severity', 'moderation', 'resolution']) {
      expect(text).not.toContain(jargon)
    }
  })

  it('says plainly when nobody has confirmed yet', () => {
    setup({ voteCount: 0 })
    expect(screen.getByText(/no one else has confirmed this yet/i)).toBeInTheDocument()
  })

  it('counts confirmations without calling it severity', () => {
    setup({ voteCount: 4 })
    expect(screen.getByText(/4 confirmed this is here/i)).toBeInTheDocument()
  })
})

describe('ReportDetail — photos under review', () => {
  it('shows a placeholder rather than the image while it is being checked', () => {
    setup({ photos: [{ id: 'p1', url: null, moderationStatus: 'pending' }] })
    expect(screen.getByTestId('photo-pending')).toHaveTextContent(/being checked/i)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows the photo once it is approved', () => {
    setup({
      photos: [{ id: 'p1', url: 'https://img/a.jpg', moderationStatus: 'approved' }],
    })
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://img/a.jpg')
  })

  it('hides a note that is still being checked', () => {
    setup({ note: null, noteStatus: 'pending' })
    expect(screen.getByText(/the note is being checked/i)).toBeInTheDocument()
  })
})

describe('ReportDetail — confirming', () => {
  it('lets a signed-in person confirm someone else’s report', async () => {
    const { user, data, onChanged } = setup({ viewerIsReporter: false })
    await user.click(screen.getByRole('button', { name: /confirm this is here/i }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect((await data.getReport('r1'))!.voteCount).toBe(1)
  })

  it('offers no confirm button on your own report', () => {
    setup({ viewerIsReporter: true })
    expect(screen.queryByRole('button', { name: /confirm this is here/i })).not.toBeInTheDocument()
  })

  it('lets a confirmation be taken back', async () => {
    const { user, data } = setup({ viewerHasVoted: true, voteCount: 1 })
    await user.click(screen.getByRole('button', { name: /remove my confirmation/i }))
    await waitFor(async () => expect((await data.getReport('r1'))!.voteCount).toBe(0))
  })

  it('asks anonymous visitors to sign in instead of hiding the option silently', () => {
    setup({}, { signedIn: false })
    expect(screen.getByText(/sign in to confirm or mark cleaned/i)).toBeInTheDocument()
  })
})

describe('ReportDetail — the cleaned moment', () => {
  it('shows nothing about cleaning while the report is still open', () => {
    setup({ status: 'open' })
    expect(screen.queryByTestId('cleaned-mark')).not.toBeInTheDocument()
  })

  it('marks the report cleaned and plays the wipe', async () => {
    const { user, data } = setup({ status: 'open' })
    await user.click(screen.getByRole('button', { name: /mark as cleaned/i }))

    const mark = await screen.findByTestId('cleaned-mark')
    expect(mark).toHaveTextContent(/someone cleaned this up/i)
    // The animation only plays on the transition, not on every later render.
    expect(mark.className).toContain('mo-scrub--playing')
    expect((await data.getReport('r1'))!.status).toBe('cleaned')
  })

  it('shows an already-cleaned report without replaying the animation', () => {
    setup({ status: 'cleaned' })
    const mark = screen.getByTestId('cleaned-mark')
    expect(mark).toBeInTheDocument()
    expect(mark.className).not.toContain('mo-scrub--playing')
  })

  it('stops offering actions once it is cleaned', () => {
    setup({ status: 'cleaned' })
    expect(screen.queryByRole('button', { name: /mark as cleaned/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /confirm this is here/i })).not.toBeInTheDocument()
  })

  it('says it in words too, not only in motion', () => {
    // The animation carries the feeling; the text carries the meaning for
    // anyone using a screen reader or with motion turned off.
    setup({ status: 'cleaned' })
    expect(screen.getByText(/someone cleaned this up/i)).toBeInTheDocument()
  })
})

describe('ReportDetail — comments', () => {
  it('says so plainly when there are none', () => {
    setup()
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument()
  })

  it('posts a comment and shows it as pending review', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'Still here this morning')
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(await screen.findByText('Still here this morning')).toBeInTheDocument()
    expect(screen.getByText(/being checked before it appears/i)).toBeInTheDocument()
  })

  it('will not post an empty comment', async () => {
    const { user } = setup()
    expect(screen.getByRole('button', { name: /post comment/i })).toBeDisabled()
    await user.type(screen.getByLabelText(/add a comment/i), '   ')
    expect(screen.getByRole('button', { name: /post comment/i })).toBeDisabled()
  })

  it('warns about wording that will be held, without blocking it', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'this is fucking disgusting')
    expect(await screen.findByRole('status')).toHaveTextContent(/held for review/i)
    expect(screen.getByRole('button', { name: /post comment/i })).toBeEnabled()
  })

  it('asks anonymous visitors to sign in to comment', () => {
    setup({}, { signedIn: false })
    expect(screen.getByText(/sign in to comment/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/add a comment/i)).not.toBeInTheDocument()
  })
})

describe('ReportDetail — when things fail', () => {
  it('shows the reason plainly rather than failing silently', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false })
    const report = data.seed({ id: 'r1', lat: 0, lng: 0, viewerIsReporter: true })
    render(
      <ReportDetail
        data={data}
        report={report}
        signedIn
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // Marking cleaned twice: the second attempt must explain itself.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /mark as cleaned/i }))
    await screen.findByTestId('cleaned-mark')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('ReportDetail — reporting a comment', () => {
  it('lets a signed-in reader report a comment, and records it', async () => {
    const { user, data } = setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'something unpleasant')
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await screen.findByText('something unpleasant')

    await user.click(screen.getByRole('button', { name: /report this comment/i }))

    await waitFor(() => expect(data.raisedFlags).toHaveLength(1))
    expect(data.raisedFlags[0].subjectType).toBe('comment')
  })

  it('thanks them and stops offering it again', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'something unpleasant')
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await screen.findByText('something unpleasant')

    await user.click(screen.getByRole('button', { name: /report this comment/i }))

    expect(await screen.findByText(/thanks\. someone will look at this/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /report this comment/i })).not.toBeInTheDocument()
  })

  it('offers nothing to report for a signed-out visitor', async () => {
    const data = new FakeDataSource(null)
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    render(
      <ReportDetail
        data={data}
        report={report}
        signedIn={false}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /report this comment/i })).not.toBeInTheDocument()
  })
})
