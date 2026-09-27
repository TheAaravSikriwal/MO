import { useState, type FormEvent } from 'react'
import { checkText } from '../../lib/moderation/clientGate'
import { ALLOWED_PHOTO_TYPES, MAX_PHOTOS } from '../../lib/upload/photoLimits'
import { NAME_NEEDED, plainError } from '../../lib/moderation/plainWords'
import { screenPhotoWithModel, type PhotoScreener } from '../../lib/moderation/screenPhoto'
import { PIN_ZOOM_THRESHOLD } from '../../lib/grid/zoomResolution'
import type { DataSource } from '../../lib/data/types'
import { NameField, nameProblem, useDisplayName } from './NameField'

export const MAX_NOTE_LENGTH = 500

export interface ReportFormProps {
  data: DataSource
  /** Where the pin currently sits. */
  lat: number
  lng: number
  /** Reporting only unlocks close to the ground, so the location is precise. */
  zoom: number
  signedIn: boolean
  onSubmitted: (reportId: string) => void
  onCancel: () => void
  /**
   * Injected in tests so nothing has to load TensorFlow. In the browser this
   * lazy-loads the NSFW model the first time somebody actually picks a photo,
   * which keeps several megabytes off the initial page load for the majority
   * who only ever look at the map.
   */
  screenPhoto?: PhotoScreener
}

export function ReportForm({
  data,
  lat,
  lng,
  zoom,
  signedIn,
  onSubmitted,
  onCancel,
  screenPhoto = screenPhotoWithModel,
}: ReportFormProps) {
  const [photos, setPhotos] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const name = useDisplayName(data, signedIn)

  const tooFarOut = zoom < PIN_ZOOM_THRESHOLD

  const onChoosePhotos = async (files: FileList | null) => {
    setError(null)
    if (!files || files.length === 0) return

    const chosen = Array.from(files).slice(0, MAX_PHOTOS - photos.length)
    setChecking(true)

    // Declared out here so the catch below can tell what was already judged
    // from what never got looked at.
    const accepted: File[] = []
    const rejected: string[] = []
    let firstMessage: string | null = null
    let judged = 0

    try {
      // Each file judged on its own, and the ones that pass are kept.
      //
      // Stopping at the first block used to discard the whole selection: pick
      // two good photos and one that is too large, and none of the three were
      // added, with a message that did not say which was at fault. Somebody
      // then has to guess which of their photos the form disliked.
      for (const file of chosen) {
        const result = await screenPhoto(file)
        judged += 1
        if (result.blocked) {
          rejected.push(file.name)
          firstMessage ??= result.message ?? 'That photo cannot be used.'
        } else {
          accepted.push(file)
        }
      }
    } catch {
      // Tier 1 fails OPEN. Without this a screener that rejects escapes as an
      // unhandled rejection: the photo is never added and no message is shown,
      // so picking a photo appears to do nothing at all. That is fail-closed,
      // the opposite of what this tier is for -- the server tiers are what
      // actually protect the map.
      //
      // Only the files it never reached, though. Re-admitting `chosen` whole
      // put back the ones the gate had positively BLOCKED a moment earlier, so
      // a file it had just refused would be attached anyway and only stopped
      // by the server after the report row had been written and rolled back.
      accepted.push(...chosen.slice(judged))
    } finally {
      setChecking(false)
    }

    if (rejected.length > 0) {
      // Name the files, so it is clear which ones did not make it. The reason
      // is the gate's own wording, which is written for a person.
      setError(`${rejected.join(', ')}: ${firstMessage}`)
    }
    if (accepted.length > 0) {
      setPhotos((current) => [...current, ...accepted].slice(0, MAX_PHOTOS))
    }
  }

  const onNoteChange = (value: string) => {
    setNote(value.slice(0, MAX_NOTE_LENGTH))
    setNotice(checkText(value).message ?? null)
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)

    if (tooFarOut) {
      setError('Zoom in closer so the pin lands in the right spot.')
      return
    }
    if (photos.length === 0) {
      setError('Please add a photo so people can see what is here.')
      return
    }
    if (name.needed) {
      const problem = nameProblem(nameDraft)
      if (problem) {
        setError(problem)
        return
      }
    }

    setBusy(true)
    try {
      // The name first, and only when one is needed. If the report then fails,
      // the name is kept -- it was accepted -- and the field goes away, so a
      // retry does not ask again.
      if (name.needed) {
        const chosen = nameDraft.trim()
        await data.setDisplayName(chosen)
        name.saved(chosen)
      }
      const { id } = await data.createReport({ lat, lng, note: note.trim(), photos })
      onSubmitted(id)
    } catch (cause) {
      // Never the raw message: createReport can fail with an RLS violation, a
      // check-constraint name, or the rate-limit trigger's wording, and this is
      // the app's primary write path.
      const message = plainError(cause instanceof Error ? cause.message : null)
      // The database refused for want of a name the lookup did not know was
      // missing -- it failed, or the name was rejected since. Ask for one.
      if (message === NAME_NEEDED) name.ask()
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  if (!signedIn) {
    return (
      <div className="rounded-xl bg-white p-4 shadow-lg">
        <h2 className="text-lg font-semibold text-slate-900">Add a report</h2>
        <p className="mt-2 text-sm text-slate-600">Sign in to add a report.</p>
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
    <form onSubmit={onSubmit} className="rounded-xl bg-white p-4 shadow-lg" aria-label="Add a report">
      <h2 className="text-lg font-semibold text-slate-900">Add a report</h2>

      {tooFarOut ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Zoom in closer so the pin lands in the right spot.
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-600">
          The pin is where you are looking on the map.
        </p>
      )}

      {name.needed && (
        <div className="mt-4">
          <NameField
            id="report-name"
            value={nameDraft}
            onChange={setNameDraft}
            rejected={name.mine?.status === 'rejected' ? name.mine.name : null}
          />
        </div>
      )}

      <div className="mt-4">
        <label htmlFor="report-photos" className="block text-sm font-medium text-slate-800">
          Photo
        </label>
        <p className="text-xs text-slate-500">
          At least one, up to {MAX_PHOTOS}. This is what people will see.
        </p>
        <input
          id="report-photos"
          type="file"
          // Built from the shared list, not written out again. A fourth type
          // added to photoLimits would otherwise still be filtered out by the
          // picker, with nothing to say why.
          accept={ALLOWED_PHOTO_TYPES.join(',')}
          multiple
          disabled={photos.length >= MAX_PHOTOS}
          onChange={(event) => void onChoosePhotos(event.target.files)}
          className="mt-2 block w-full text-sm"
        />
        {checking && (
          <p role="status" className="mt-2 text-xs text-slate-600">
            Checking the photo…
          </p>
        )}
        {photos.length > 0 && (
          <ul className="mt-2 space-y-1">
            {photos.map((photo, index) => (
              <li
                key={`${photo.name}-${index}`}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"
              >
                <span className="truncate">{photo.name}</span>
                <button
                  type="button"
                  onClick={() => setPhotos((current) => current.filter((_, i) => i !== index))}
                  className="ml-3 shrink-0 text-slate-500 hover:text-slate-900"
                  aria-label={`Remove ${photo.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4">
        <label htmlFor="report-note" className="block text-sm font-medium text-slate-800">
          Note <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id="report-note"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="What did you find here?"
          className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
        />
        <p className="text-right text-xs text-slate-400">
          {note.length} / {MAX_NOTE_LENGTH}
        </p>
      </div>

      {notice && (
        <p role="status" className="mt-2 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">
          {error}
        </p>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Photos and notes are checked before they appear.
      </p>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy || checking || tooFarOut}
          className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300"
        >
          {busy ? 'Sending…' : 'Add report'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
