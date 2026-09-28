import { useState, type FormEvent } from 'react'
import { checkText } from '../../lib/moderation/clientGate'
import { NAME_NEEDED, plainError } from '../../lib/moderation/plainWords'
import { hasControlCharacter, visibleLength } from '../../lib/names/displayName'
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  GROUP_NAME_MIN,
  type DataSource,
} from '../../lib/data/types'
import { NameField, nameProblem, useDisplayName } from '../report/NameField'
import { Reveal } from '../Reveal'

/**
 * How close in the map has to be before a group's home is set. A town, not a
 * country: the home is where people will look to find a group near them.
 */
export const GROUP_ZOOM = 11

export interface GroupFormProps {
  data: DataSource
  lat: number
  lng: number
  zoom: number
  signedIn: boolean
  onCreated: (id: string) => void
  onCancel: () => void
  /** False on "The idea", where a new group is accepted at once. */
  checkedFirst?: boolean
}

/** A plain sentence if this group name would be refused, otherwise null. */
export function groupNameProblem(name: string): string | null {
  const chosen = name.trim()
  if (chosen.length < GROUP_NAME_MIN || visibleLength(chosen) < GROUP_NAME_MIN) {
    return `Please give the group a name of at least ${GROUP_NAME_MIN} letters.`
  }
  if (chosen.length > GROUP_NAME_MAX) {
    return `Please keep the group name to ${GROUP_NAME_MAX} characters or fewer.`
  }
  if (hasControlCharacter(chosen)) return 'Please give the group a name without tabs or line breaks.'
  return null
}

/** A plain sentence if this description would be refused, otherwise null. Line breaks are fine. */
export function groupDescriptionProblem(about: string): string | null {
  if (hasControlCharacter(about.split(String.fromCharCode(10)).join(''))) {
    return 'Please take the tabs out of the description. Line breaks are fine.'
  }
  return null
}

/** Start a cleaning group, with its home where the map is looking. */
export function GroupForm({
  data,
  lat,
  lng,
  zoom,
  signedIn,
  onCreated,
  onCancel,
  checkedFirst = true,
}: GroupFormProps) {
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const person = useDisplayName(data, signedIn)
  const tooFarOut = zoom < GROUP_ZOOM
  const notice = checkText(`${name}\n${about}`).message ?? null

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (tooFarOut) {
      setError('Zoom in to the area your group will clean up.')
      return
    }
    const problem =
      groupNameProblem(name) ??
      groupDescriptionProblem(about.trim()) ??
      (person.needed ? nameProblem(nameDraft) : null)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    try {
      if (person.needed) {
        const chosen = nameDraft.trim()
        await data.setDisplayName(chosen)
        person.saved(chosen)
      }
      const { id } = await data.createGroup({ name: name.trim(), description: about.trim(), lat, lng })
      onCreated(id)
    } catch (cause) {
      const message = plainError(cause instanceof Error ? cause.message : null)
      if (message === NAME_NEEDED) person.ask()
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  if (!signedIn) {
    return (
      <div className="mo-glass rounded-2xl p-4">
        <h2 className="text-lg font-semibold text-slate-900">Start a cleaning group</h2>
        <p className="mt-2 text-sm text-slate-600">Sign in to start a group.</p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-4 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} aria-label="Start a cleaning group" className="mo-glass rounded-2xl p-4">
      <h2 className="text-lg font-semibold text-slate-900">Start a cleaning group</h2>
      {tooFarOut ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Zoom in to the area your group will clean up.
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-600">
          Its home is where you are looking on the map.{' '}
          {checkedFirst
            ? 'It is checked before other people see it.'
            : 'On this made-up map it is accepted straight away. In the real world it is checked first.'}
        </p>
      )}

      <Reveal show={!!(person.needed)}>{(person.needed) && (
        <div className="mt-4">
          <NameField
            id="group-person-name"
            value={nameDraft}
            onChange={setNameDraft}
            rejected={person.mine?.status === 'rejected' ? person.mine.name : null}
          />
        </div>
      )}</Reveal>

      <label htmlFor="group-name" className="mt-4 block text-sm font-medium text-slate-800">
        Group name
      </label>
      <input
        id="group-name"
        type="text"
        value={name}
        maxLength={GROUP_NAME_MAX * 2}
        onChange={(event) => setName(event.target.value)}
        placeholder="Riverside Litter Pickers"
        className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
      />

      <label htmlFor="group-about" className="mt-3 block text-sm font-medium text-slate-800">
        What you do
      </label>
      <p className="text-xs text-slate-500">When and where you meet, and what people should bring.</p>
      <textarea
        id="group-about"
        value={about}
        rows={3}
        onChange={(event) => setAbout(event.target.value.slice(0, GROUP_DESCRIPTION_MAX))}
        className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
      />
      <p className="text-right text-xs text-slate-400">
        {about.length} / {GROUP_DESCRIPTION_MAX}
      </p>

      <Reveal show={!!(notice)}>{(notice) && <p className="mt-1 text-xs text-amber-800">{notice}</p>}</Reveal>
      <Reveal show={!!(error)}>{(error) && (
        <p role="alert" className="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-900">
          {error}
        </p>
      )}</Reveal>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Starting…' : 'Start the group'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
