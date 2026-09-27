/**
 * What counts as an acceptable photo.
 *
 * This is a leaf module on purpose: it has no imports at all, so both the
 * browser gate and the upload-signing endpoint can share one definition of the
 * limits. Two copies would drift, and the drift would only show up as an
 * upload the browser accepted and the server refused.
 */

/** 8 MB. Phone photos land well under this; anything over is not a litter photo. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024

/**
 * How many photos one report may carry.
 *
 * Two places, not three. The form stops you picking a fourth, and the
 * `enforce_photo_limit` trigger in `0002_functions_triggers.sql` is the control
 * that actually holds, because it counts behind a per-report advisory lock: a
 * count without one cannot see a concurrent statement's rows. (This comment
 * used to add that a row-level trigger cannot see the rest of its own
 * statement. It can; see the note above enforce_report_rate_limit in 0002.)
 *
 * The signing endpoint does NOT check it. It bounds volume by recording every
 * signed URL in `upload_grants` and letting a trigger rate-limit that instead,
 * because counting the photos already attached to a report bounds nothing: the
 * count only rises when the client inserts a photo row, and a caller who never
 * inserts can keep asking. The cost of leaving it out is that someone can mint
 * more keys for one report than the trigger will ever let them link, and the
 * extra objects are orphaned -- which is recorded in `api/README.md`, not
 * prevented here.
 */
export const MAX_PHOTOS = 3

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type AllowedPhotoType = (typeof ALLOWED_PHOTO_TYPES)[number]

export function isAllowedPhotoType(type: string): type is AllowedPhotoType {
  return (ALLOWED_PHOTO_TYPES as readonly string[]).includes(type)
}

const EXTENSIONS: Record<AllowedPhotoType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * The extension to store the object under.
 *
 * Taken from the declared content type, never from the uploaded filename: a
 * filename is attacker-controlled and can carry a path, a second extension or
 * a few hundred characters of junk into the object key.
 */
export function extensionForPhotoType(type: AllowedPhotoType): string {
  return EXTENSIONS[type]
}
