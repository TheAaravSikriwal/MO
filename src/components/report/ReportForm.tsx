import { useState, type FormEvent } from 'react'
import { checkPhotoFile, checkText } from '../../lib/moderation/clientGate'
import { PIN_ZOOM_THRESHOLD } from '../../lib/grid/zoomResolution'
import type { DataSource } from '../../lib/data/types'

export const MAX_PHOTOS = 3
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
}

export function ReportForm({
  data,
  lat,
  lng,
  zoom,
  signedIn,
  onSubmitted,
  onCancel,
}: ReportFormProps) {
  const [photos, setPhotos] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tooFarOut = zoom < PIN_ZOOM_THRESHOLD

  const onChoosePhotos = (files: FileList | null) => {
    setError(null)
    if (!files || files.length === 0) return

    const chosen = Array.from(files).slice(0, MAX_PHOTOS - photos.length)
    for (const file of chosen) {
      const result = checkPhotoFile(file)
      if (result.blocked) {
        setError(result.message ?? 'That photo cannot be used.')
        return
      }
    }
    setPhotos((current) => [...current, ...chosen].slice(0, MAX_PHOTOS))
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

    setBusy(true)
    try {
      const { id } = await data.createReport({ lat, lng, note: note.trim(), photos })
      onSubmitted(id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.')
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
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={photos.length >= MAX_PHOTOS}
          onChange={(event) => onChoosePhotos(event.target.files)}
          className="mt-2 block w-full text-sm"
        />
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
          disabled={busy || tooFarOut}
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
