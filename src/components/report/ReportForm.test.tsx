import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportForm } from './ReportForm'
import { FakeDataSource } from '../../lib/data/fakeSource'

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
    expect(screen.getByText('litter.jpg')).toBeInTheDocument()
  })

  it('lets a photo be removed again', async () => {
    const { user } = setup()
    await user.upload(screen.getByLabelText(/^photo$/i), photo())
    await user.click(screen.getByRole('button', { name: /remove litter\.jpg/i }))
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

  it('stops at three photos', async () => {
    const { user } = setup()
    const input = screen.getByLabelText(/^photo$/i)
    await user.upload(input, [photo('a.jpg'), photo('b.jpg'), photo('c.jpg'), photo('d.jpg')])
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
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
    const { user } = setup()
    const failing = { createReport: vi.fn().mockRejectedValue(new Error('network is down')) }
    render(
      <ReportForm
        data={failing as never}
        lat={0}
        lng={0}
        zoom={16}
        signedIn
        onSubmitted={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const forms = screen.getAllByLabelText(/add a report/i)
    const input = forms[1].querySelector('input[type=file]')!
    await user.upload(input as HTMLElement, photo())
    await user.click(within(forms[1]).getByRole('button', { name: /add report/i }))
    expect(await within(forms[1]).findByRole('alert')).toHaveTextContent(/network is down/i)
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
