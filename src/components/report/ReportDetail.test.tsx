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
    { displayName: 'Sam' },
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

  it('tells the author their own note is still being checked', () => {
    setup({ note: null, noteStatus: 'pending', viewerIsReporter: true })
    expect(screen.getByText(/your note is being checked/i)).toBeInTheDocument()
  })

  it('tells everyone else nothing about a note under review', () => {
    // note_status is public, so announcing the outcome told passers-by that a
    // note on this pin had been held or removed -- none of their business, and
    // an invitation to wonder what it said.
    setup({ note: null, noteStatus: 'pending', viewerIsReporter: false })
    expect(screen.queryByText(/being checked/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument()
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
  it('explains a failed action in plain words rather than failing silently', async () => {
    const { user, data } = setup({ status: 'open', viewerIsReporter: true })
    vi.spyOn(data, 'markCleaned').mockRejectedValue(
      new Error('permission denied for function mark_report_cleaned'),
    )

    await user.click(screen.getByRole('button', { name: /mark as cleaned/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/permission/i)
    // The raw Postgres wording must not reach a member of the public.
    expect(alert.textContent?.toLowerCase()).not.toContain('mark_report_cleaned')
  })

  it('does not claim the report was cleaned when the attempt failed', async () => {
    const { user, data } = setup({ status: 'open', viewerIsReporter: true })
    vi.spyOn(data, 'markCleaned').mockRejectedValue(new Error('network is down'))

    await user.click(screen.getByRole('button', { name: /mark as cleaned/i }))

    await screen.findByRole('alert')
    expect(screen.queryByTestId('cleaned-mark')).not.toBeInTheDocument()
  })

  it('explains a failed confirmation too', async () => {
    const { user, data } = setup({ viewerIsReporter: false })
    vi.spyOn(data, 'addVote').mockRejectedValue(new Error('duplicate key value violates unique constraint'))

    await user.click(screen.getByRole('button', { name: /confirm this is here/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.toLowerCase()).not.toContain('constraint')
  })

  it('stays quiet when nothing has gone wrong', async () => {
    const { user } = setup({ status: 'open', viewerIsReporter: true })
    await user.click(screen.getByRole('button', { name: /mark as cleaned/i }))
    await screen.findByTestId('cleaned-mark')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('ReportDetail — reporting a comment', () => {
  /** Seeds a comment at a given status BEFORE rendering, so the first load sees it. */
  const renderWithComment = async (
    body: string,
    moderationStatus: 'pending' | 'approved' | 'rejected',
  ) => {
    const data = new FakeDataSource(
      { id: 'u1', email: 'a@b.com', isAdmin: false },
      { displayName: 'Sam' },
    )
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.addComment('r1', body)
    ;(await data.listComments('r1'))[0].moderationStatus = moderationStatus

    render(
      <ReportDetail
        data={data}
        report={report}
        signedIn
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await screen.findByText(body)
    return { data, user: userEvent.setup() }
  }

  it('lets a signed-in reader report a published comment, and records it', async () => {
    const { data, user } = await renderWithComment('something unpleasant', 'approved')
    await user.click(screen.getByRole('button', { name: /report this comment/i }))

    await waitFor(() => expect(data.raisedFlags).toHaveLength(1))
    expect(data.raisedFlags[0].subjectType).toBe('comment')
  })

  it('thanks them and stops offering it again', async () => {
    const { user } = await renderWithComment('something unpleasant', 'approved')
    await user.click(screen.getByRole('button', { name: /report this comment/i }))

    expect(await screen.findByText(/thanks\. someone will look at this/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /report this comment/i })).not.toBeInTheDocument()
  })

  it('offers nothing to report on a comment still being checked', async () => {
    // Nobody else has seen it yet, so there is nothing to complain about.
    await renderWithComment('not yet published', 'pending')
    expect(screen.queryByRole('button', { name: /report this comment/i })).not.toBeInTheDocument()
    expect(screen.getByText(/being checked before it appears/i)).toBeInTheDocument()
  })

  it('says so when a comment has been removed', async () => {
    // Shown only to its author and to admins. Without it, a comment an admin
    // just removed reads exactly like a live one.
    await renderWithComment('removed by an admin', 'rejected')
    expect(screen.getByText(/removed and not shown to others/i)).toBeInTheDocument()
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

describe('ReportDetail — reporting a note', () => {
  it('lets a reader report the note, and records it against the report', async () => {
    const { user, data } = setup({ note: 'something unpleasant', noteStatus: 'approved' })
    await user.click(screen.getByRole('button', { name: /report this note/i }))
    await waitFor(() => expect(data.raisedFlags).toHaveLength(1))
    expect(data.raisedFlags[0].subjectType).toBe('note')
    expect(data.raisedFlags[0].subjectId).toBe('r1')
  })

  it('offers nothing to report when there is no note', () => {
    setup({ note: null, noteStatus: 'pending' })
    expect(screen.queryByRole('button', { name: /report this note/i })).not.toBeInTheDocument()
  })

  it('tells the author when their note was removed', () => {
    setup({ note: 'something unpleasant', noteStatus: 'rejected', viewerIsReporter: true })
    expect(screen.getByText(/your note was removed/i)).toBeInTheDocument()
    expect(screen.queryByText('something unpleasant')).not.toBeInTheDocument()
  })

  it('does not tell other people that a note was removed', () => {
    setup({ note: null, noteStatus: 'rejected', viewerIsReporter: false })
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument()
  })
})

describe('ReportDetail — the name next to a comment', () => {
  const setupNameless = () => {
    const data = new FakeDataSource({ id: 'u2', email: 'sam.jones@example.com', isAdmin: false })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    render(
      <ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />,
    )
    return { data, user: userEvent.setup() }
  }

  it('signs a comment with the chosen name, never the email address', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'Still here this morning')
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    await screen.findByText('Still here this morning')
    expect(screen.getByText('Sam')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('a@b.com')
  })

  it('asks for a name before a first comment, then posts under it', async () => {
    const { user, data } = setupNameless()
    await user.type(await screen.findByLabelText(/your name/i), 'Sam J')
    await user.type(screen.getByLabelText(/add a comment/i), 'Still here this morning')
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(await screen.findByText('Still here this morning')).toBeInTheDocument()
    expect(screen.getByText('Sam J')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('sam.jones')
    expect(await data.getMyDisplayName()).toEqual({ name: 'Sam J', status: 'pending' })
    // Asked once. The field goes away once a name is saved.
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
  })

  it('will not post a first comment without a name', async () => {
    const { user, data } = setupNameless()
    await screen.findByLabelText(/your name/i)
    await user.type(screen.getByLabelText(/add a comment/i), 'Still here this morning')
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/between 2 and 30 characters/i)
    expect(await data.listComments('r1')).toEqual([])
  })
})

describe('ReportDetail — reporting a name', () => {
  const setupOthers = () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    data.seedName('u7', 'Bad Handle', 'approved')
    data.seedName('u8', 'Still Checking', 'pending')
    data.seedComment('r1', { authorId: 'u7', body: 'first comment' })
    data.seedComment('r1', { authorId: 'u8', body: 'second comment' })
    render(
      <ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />,
    )
    return { data, user: userEvent.setup() }
  }

  it('offers it on a name somebody else chose, and files it against that person', async () => {
    const { data, user } = setupOthers()
    expect(await screen.findByText('Bad Handle')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: /report this name/i })
    // One: the pending name reads "someone", which is not a name to report.
    expect(buttons).toHaveLength(1)
    await user.click(buttons[0])

    expect(await screen.findByText(/someone will look at this name/i)).toBeInTheDocument()
    expect(data.raisedFlags).toContainEqual(
      expect.objectContaining({ subjectType: 'name', subjectId: 'u7', flaggerId: 'u1' }),
    )
  })

  it('does not offer it on your own comment', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.addComment('r1', 'mine')
    ;(await data.listComments('r1'))[0].moderationStatus = 'approved'
    data.decideName('u1', 'approved')
    render(
      <ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />,
    )
    expect(await screen.findByText('mine')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /report this name/i })).not.toBeInTheDocument()
  })
})

describe('ReportDetail — the name on a report', () => {
  it('shows the reporter’s approved name', () => {
    setup({ reporterName: 'Sam' })
    expect(screen.getByText(/^Added /).textContent).toMatch(/ by Sam/)
  })

  it('shows no name, and no email, while it is still being checked', () => {
    setup({ reporterName: null })
    // The header line alone: the seeded note says "by the bus stop".
    const header = screen.getByText(/^Added /)
    expect(header.textContent).not.toContain(' by ')
    expect(document.body.textContent).not.toContain('a@b.com')
  })
})

describe('ReportDetail — reporting the name on a report', () => {
  it('files a complaint against whoever filed the report', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12, reporterName: 'Bad Handle' })
    data.seedReporter('r1', 'u7')
    data.seedName('u7', 'Bad Handle', 'approved')
    render(
      <ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /report this name/i }))

    expect(await screen.findByText(/someone will look at this name/i)).toBeInTheDocument()
    expect(data.raisedFlags).toContainEqual(
      expect.objectContaining({ subjectType: 'name', subjectId: 'u7', flaggerId: 'u1' }),
    )
  })

  it('does not offer it on your own report, or when no name is shown', () => {
    setup({ reporterName: 'Sam', viewerIsReporter: true })
    expect(screen.queryByRole('button', { name: /report this name/i })).not.toBeInTheDocument()
  })

  it('does not offer it when the reporter has no approved name', () => {
    setup({ reporterName: null })
    expect(screen.queryByRole('button', { name: /report this name/i })).not.toBeInTheDocument()
  })
})

describe('ReportDetail — a name rejected after the page loaded', () => {
  it('asks again and says why, rather than leaving no field to type in', async () => {
    const data = new FakeDataSource({ id: 'u5', isAdmin: false }, { displayName: 'Rude Name' })
    const report = data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    render(
      <ReportDetail data={data} report={report} signedIn onChanged={vi.fn()} onClose={vi.fn()} />,
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/add a comment/i), 'Still here')
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
    // Rejected while the report was open.
    data.decideName('u5', 'rejected')
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/choose a name before posting/i)
    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
    expect(await screen.findByText(/"Rude Name" was not accepted/)).toBeInTheDocument()
    expect(await data.listComments('r1')).toEqual([])
  })
})
