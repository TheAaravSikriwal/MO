import { useCallback, useEffect, useState } from 'react'
import type { DataSource, MyDisplayName } from '../../lib/data/types'
import {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  hasControlCharacter,
  nameLength,
  visibleLength,
} from '../../lib/names/displayName'

const VISIBLE_NAME = 'Please choose a name with at least 2 characters that show up.'

/** A plain sentence if this name would be refused, otherwise null. */
export function nameProblem(name: string): string | null {
  const chosen = name.trim()
  if (nameLength(chosen) < MIN_NAME_LENGTH || nameLength(chosen) > MAX_NAME_LENGTH) {
    return `Please choose a name between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`
  }
  if (chosen.includes('@')) return 'Please choose a name rather than an email address.'
  if (hasControlCharacter(chosen)) return 'Please choose a name without tabs or line breaks.'
  if (visibleLength(chosen) < MIN_NAME_LENGTH) return VISIBLE_NAME
  return null
}

/**
 * Whether the signed-in person still has to choose a name before posting.
 *
 * `needed` is true only when the lookup positively said so -- no name yet, or
 * the last one was rejected. A failed lookup leaves it false and lets the
 * database be the judge: asking somebody who already has a name to choose one
 * would get the new one refused as too soon. If the database then refuses the
 * post for want of a name, `ask()` turns the field on.
 */
export function useDisplayName(data: DataSource, signedIn: boolean) {
  const [mine, setMine] = useState<MyDisplayName | null>(null)
  const [needed, setNeeded] = useState(false)

  useEffect(() => {
    if (!signedIn) {
      setMine(null)
      setNeeded(false)
      return
    }
    let live = true
    data
      .getMyDisplayName()
      .then((found) => {
        if (!live) return
        setMine(found)
        setNeeded(!found || found.status === 'rejected')
      })
      .catch(() => {
        if (live) setNeeded(false)
      })
    return () => {
      live = false
    }
  }, [data, signedIn])

  /** Call after setDisplayName succeeds. */
  const saved = useCallback((name: string) => {
    setMine({ name, status: 'pending' })
    setNeeded(false)
  }, [])

  /**
   * The database refused a post for want of a name. Show the field, and look
   * the name up again: the likeliest reason is that it was rejected since the
   * page loaded, and the person should be told that rather than asked for a
   * name as if they had never given one.
   */
  const ask = useCallback(() => {
    setNeeded(true)
    data
      .getMyDisplayName()
      .then(setMine)
      .catch(() => undefined)
  }, [data])

  return { mine, needed, saved, ask }
}

export interface NameFieldProps {
  id: string
  value: string
  onChange: (value: string) => void
  /** The name that was turned down, if that is why we are asking. */
  rejected: string | null
}

export function NameField({ id, value, onChange, rejected }: NameFieldProps) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        Your name
      </label>
      <p className="text-xs text-slate-500">
        {rejected
          ? `"${rejected}" was not accepted. Please choose a different name.`
          : 'Shown on your reports and comments. It is checked before other people see it.'}
      </p>
      <input
        id={id}
        type="text"
        value={value}
        // Twice the limit, because maxLength counts UTF-16 units and an emoji
        // is two of them. The real limit, in characters, is nameProblem's.
        maxLength={MAX_NAME_LENGTH * 2}
        autoComplete="nickname"
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-lg border border-slate-300 p-2 text-sm"
      />
    </div>
  )
}
