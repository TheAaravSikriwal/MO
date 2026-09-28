import { useState, type FormEvent } from 'react'
import type { CurrentUser, DataSource } from '../../lib/data/types'
import { Reveal, Swap } from '../Reveal'

export interface SignInPanelProps {
  data: DataSource
  user: CurrentUser | null
}

export function SignInPanel({ data, user }: SignInPanelProps) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await data.signInWithEmail(email.trim())
      setSent(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the link. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Signed in, link sent, or the form: each fades into the next rather than
  // replacing it in one frame.
  return <Swap id={user ? 'signed-in' : sent ? 'sent' : 'form'}>{panel()}</Swap>

  function panel() {
  if (user) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="truncate text-slate-600">{user.email ?? 'Signed in'}</span>
        <button
          type="button"
          onClick={() => void data.signOut()}
          className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>
    )
  }

  if (sent) {
    return (
      <p role="status" className="text-sm text-slate-700">
        Check your email for a link to sign in.
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" aria-label="Sign in">
      <label htmlFor="signin-email" className="text-sm font-medium text-slate-800">
        Sign in
      </label>
      <div className="flex gap-2">
        <input
          id="signin-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
        >
          {busy ? 'Sending…' : 'Send link'}
        </button>
      </div>
      <p className="text-xs text-slate-500">We email you a link. No password needed.</p>
      <Reveal show={!!(error)}>{(error) && (
        <p role="alert" className="text-sm text-rose-900">
          {error}
        </p>
      )}</Reveal>
    </form>
  )
  }
}
