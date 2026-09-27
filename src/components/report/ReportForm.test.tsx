import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportForm } from './ReportForm'
import { FakeDataSource } from '../../lib/data/fakeSource'
import { screenPhotoFileOnly } from '../../lib/moderation/screenPhoto'
import { ALLOWED_PHOTO_TYPES } from '../../lib/upload/photoLimits'

const photo = (name = 'litter.jpg', type = 'image/jpeg', size = 1024) => {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const setup = (overrides: Partial<Parameters<typeof ReportForm>[0]> = {}) => {
  const data = new FakeDataSource({ id: 'u1', email: 'a@b.com', isAdmin: false })
  const onSubmitted = vi.fn()
  const onCancel = vi.fn()
  render(
    <ReportForm
      data={data}
      lat={51.5007}
      lng={-0.1246}
      zoom={16}
      signedIn
      onSubmitted={onSubmitted}
      onCancel={onCancel}
      screenPhoto={screenPhotoFileOnly}
      {...overrides}
    />,
  )
  return { data, onSubmitted, onCancel, user: userEvent.setup() }
}

describe('ReportForm — signing in', () => {
  it('asks people to sign in rather than showing a form they cannot use', () => {
    setup({ signedIn: false })
    expect(screen.getByText(/sign in to add a report/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^photo$/i)).not.toBeInTheDocument()
  })
})

describe('ReportForm — the zoom gate', () => {
  it('will not accept a report from far out, so the pin stays precise', async () => {
    const { onSubmitted } = setup({ zoom: 9 })
    expect(screen.getByText(/zoom in closer/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add report/i })).toBeDisabled()
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('accepts a report once you are close enough', () => {
    setup({ zoom: 15 })
    expect(screen.queryByText(/zoom in closer/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add report/i })).toBeEnabled()
  })
})

describe('ReportForm — photos', () => {
  it('refuses to send without a photo, and says why plainly', async () => {
    const { user, onSubmitted } = setup()
    await user.click(screen.getByRole('button', { name: /add report/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/please add a photo/i)
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('accepts a photo and shows it in the list', async () => {
    const { user } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    expect(await screen.findByText('litter.jpg')).toBeInTheDocument()
  })

  it('lets a photo be removed again', async () => {
    const { user } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await user.click(await screen.findByRole('button', { name: /remove litter\.jpg/i }))
    expect(screen.queryByText('litter.jpg')).not.toBeInTheDocument()
  })

  it('blocks a file that is not a photo, in plain words', async () => {
    setup()
    // user.upload honours the input's accept attribute and silently drops a
    // PDF, exactly as a browser file picker does. The guard still matters for
    // drag-and-drop and for people who pick "All files", so simulate a file
    // that got past accept rather than one the picker would have filtered.
    fireEvent.change(screen.getByLabelText(/^photo$/i), {
      target: { files: [photo('notes.pdf', 'application/pdf')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/JPEG, PNG or WebP/i)
  })

  it('blocks an oversized photo', async () => {
    const { user } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo('huge.jpg', 'image/jpeg', 9e6))
    expect(await screen.findByRole('alert')).toHaveTextContent(/under 8 MB/i)
  })

  it('offers exactly the types the rest of the stack accepts', async () => {
    // The `accept` attribute was a third copy of the list. A fourth type added
    // to photoLimits would have been filtered out by the picker with nothing
    // on screen to say why.
    setup()
    expect(screen.getByLabelText(/^photo$/i)).toHaveAttribute(
      'accept',
      ALLOWED_PHOTO_TYPES.join(','),
    )
  })

  it('keeps the photos that pass when one of a batch is blocked', async () => {
    // Discarding the whole selection meant picking two good photos and one
    // oversized one added none of the three, with a message that did not say
    // which was at fault.
    const { user } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), [
      photo('good.jpg'),
      photo('huge.jpg', 'image/jpeg', 9e6),
    ])
    expect(await screen.findByText('good.jpg')).toBeInTheDocument()
    expect(screen.queryByText('huge.jpg')).not.toBeInTheDocument()
  })

  it('names the photo it could not use, and why', async () => {
    const { user } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), [
      photo('good.jpg'),
      photo('huge.jpg', 'image/jpeg', 9e6),
    ])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/huge\.jpg/)
    expect(alert).toHaveTextContent(/under 8 MB/i)
    expect(alert).not.toHaveTextContent(/good\.jpg/)
  })

  it('names every photo it could not use', async () => {
    // fireEvent, not user.upload: the input carries an `accept` list, and
    // user.upload honours it by dropping the files before they ever reach the
    // handler -- so the gate under test would never run.
    setup()
    fireEvent.change(screen.getByLabelText(/^photo$/i), {
      target: {
        files: [photo('one.pdf', 'application/pdf'), photo('two.pdf', 'application/pdf')],
      },
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/one\.pdf/)
    expect(alert).toHaveTextContent(/two\.pdf/)
  })

  it('keeps the unjudged files, but not the blocked one, when the screener throws', async () => {
    // Tier 1 fails open, so files it never reached are let through and the
    // server decides. But re-admitting the whole selection put back the ones
    // the gate had already positively BLOCKED, so a file it had just refused
    // was attached anyway and only stopped after the report row was written.
    let seen = 0
    const screenPhoto = async () => {
      seen += 1
      if (seen === 1) return { blocked: true, message: 'That photo cannot be used.' }
      throw new Error('model exploded')
    }

    const { user } = setup({ screenPhoto })
    await user.upload(screen.getByLabelText(/^photo$/i), [
      photo('blocked.jpg'),
      photo('unjudged.jpg'),
    ])

    expect(await screen.findByText('unjudged.jpg')).toBeInTheDocument()
    expect(screen.queryByText('blocked.jpg')).not.toBeInTheDocument()
  })

  it('still reports the blocked file when the screener throws afterwards', async () => {
    let seen = 0
    const screenPhoto = async () => {
      seen += 1
      if (seen === 1) return { blocked: true, message: 'That photo cannot be used.' }
      throw new Error('model exploded')
    }

    const { user } = setup({ screenPhoto })
    await user.upload(screen.getByLabelText(/^photo$/i), [
      photo('blocked.jpg'),
      photo('unjudged.jpg'),
    ])
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked\.jpg/)
  })

  it('stops at three photos', async () => {
    const { user } = setup()
    const input = screen.getByLabelText(/^photo$/i)
    await user.upload(input, [photo('a.jpg'), photo('b.jpg'), photo('c.jpg'), photo('d.jpg')])
    expect(await screen.findByText('a.jpg')).toBeInTheDocument()
    expect(screen.getByText('c.jpg')).toBeInTheDocument()
    expect(screen.queryByText('d.jpg')).not.toBeInTheDocument()
    expect(input).toBeDisabled()
  })
})

describe('ReportForm — the note', () => {
  it('is optional', async () => {
    const { user, onSubmitted } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await user.click(screen.getByRole('button', { name: /add report/i }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
  })

  it('warns about wording that will be held for review, without blocking it', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText(/note/i), 'this is fucking disgusting')
    expect(await screen.findByRole('status')).toHaveTextContent(/held for review/i)
    expect(screen.getByRole('button', { name: /add report/i })).toBeEnabled()
  })

  it('does not block a real place name that trips the wordlist', async () => {
    // "Penistone Road" matches the wordlist on `penis`. The server really will
    // hold it for review, so saying so is honest -- but it must never be
    // blocked, and the wording must not imply the person did anything wrong.
    const { user } = setup()
    await user.type(screen.getByLabelText(/note/i), 'Penistone Road')

    expect(screen.getByRole('button', { name: /add report/i })).toBeEnabled()
    const notice = screen.getByRole('status').textContent ?? ''
    expect(notice).toMatch(/held for review/i)
    for (const accusatory of ['you ', 'your ', 'offensive', 'inappropriate', 'banned']) {
      expect(notice.toLowerCase()).not.toContain(accusatory)
    }
  })

  it('still sends fine after a wordlist warning', async () => {
    const { user, onSubmitted } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await user.type(screen.getByLabelText(/note/i), 'Litter near Penistone Road')
    await user.click(screen.getByRole('button', { name: /add report/i }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
  })
})

describe('ReportForm — sending', () => {
  it('creates the report and hands back its id', async () => {
    const { user, data, onSubmitted } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await user.type(screen.getByLabelText(/note/i), 'Bags of rubbish by the bus stop')
    await user.click(screen.getByRole('button', { name: /add report/i }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))
    const created = await data.getReport(onSubmitted.mock.calls[0][0])
    expect(created).not.toBeNull()
    expect(created!.lat).toBe(51.5007)
    expect(created!.photos).toHaveLength(1)
  })

  it('arrives pending, never approved', async () => {
    const { user, data, onSubmitted } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await user.click(screen.getByRole('button', { name: /add report/i }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    const created = await data.getReport(onSubmitted.mock.calls[0][0])
    expect(created!.noteStatus).toBe('pending')
    expect(created!.photos[0].moderationStatus).toBe('pending')
    expect(created!.photos[0].url).toBeNull()
  })

  it('says clearly that things are checked before they appear', async () => {
    setup()
    expect(screen.getByText(/checked before they appear/i)).toBeInTheDocument()
  })

  it('shows a plain message if sending fails', async () => {
    const failing = {
      createReport: vi.fn().mockRejectedValue(new Error('network is down')),
    } as never
    const { user } = setup({ data: failing })

    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await screen.findByText('litter.jpg')
    await user.click(screen.getByRole('button', { name: /add report/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not reach the server/i)
    // The raw backend wording must not reach a member of the public.
    expect(alert.textContent).not.toContain('network is down')
  })
})

describe('ReportForm — language', () => {
  it('keeps internal concepts out of the interface', () => {
    setup()
    const text = document.body.textContent ?? ''
    expect(text.length).toBeGreaterThan(0)
    for (const jargon of ['hexagon', 'H3', 'cell', 'resolution', 'severity', 'moderation']) {
      expect(text.toLowerCase()).not.toContain(jargon.toLowerCase())
    }
  })

  it('never describes the place or its people, only the litter', () => {
    setup()
    const text = (document.body.textContent ?? '').toLowerCase()
    for (const word of ['dirty', 'filthy', 'slum', 'bad area', 'contaminated']) {
      expect(text).not.toContain(word)
    }
  })
})

describe('ReportForm — the photo model gate', () => {
  it('blocks a photo the model rejects, and says so about the photo', async () => {
    const { user } = setup({
      screenPhoto: async () => ({
        blocked: true,
        message: 'This photo does not look like litter or pollution. Please choose another.',
      }),
    })
    await user.upload(screen.getByLabelText(/^photo$/i), photo())

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like litter/i)
    expect(screen.queryByText('litter.jpg')).not.toBeInTheDocument()
  })

  it('accepts a photo the model allows', async () => {
    const { user } = setup({ screenPhoto: async () => ({ blocked: false }) })
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    expect(await screen.findByText('litter.jpg')).toBeInTheDocument()
  })

  it('lets the photo through when the screener itself rejects', async () => {
    // Tier 1 fails open: it is a convenience filter, and the server is what
    // actually protects the map.
    //
    // The screener genuinely rejects here. The previous version caught its own
    // exception and returned { blocked: false }, so the component never saw a
    // failure and the test was identical to the happy path -- it passed with
    // the fail-open handling deleted.
    const { user } = setup({
      screenPhoto: async () => {
        throw new Error('model failed to load')
      },
    })
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    expect(await screen.findByText('litter.jpg')).toBeInTheDocument()
  })

  it('shows no error when the screener rejects, since nothing is wrong for the person', async () => {
    const { user } = setup({
      screenPhoto: async () => {
        throw new Error('model failed to load')
      },
    })
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await screen.findByText('litter.jpg')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('actually calls the screener for every chosen photo', async () => {
    const screenPhoto = vi.fn().mockResolvedValue({ blocked: false })
    const { user } = setup({ screenPhoto })
    await user.upload(screen.getByLabelText(/^photo$/i), [photo('a.jpg'), photo('b.jpg')])
    await waitFor(() => expect(screenPhoto).toHaveBeenCalledTimes(2))
  })
})
