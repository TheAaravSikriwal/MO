import { extensionForPhotoType, type AllowedPhotoType } from './photoLimits'

/**
 * Where one photo lives in the bucket.
 *
 * The whole key is built here, server-side, from values that have already been
 * checked. Nothing a caller typed reaches it: every segment is either a UUID or
 * one of three fixed extensions, so there is no traversal, no overlong name and
 * no second extension smuggled in through a filename.
 */

/**
 * The bucket is shared with the marketplace, which already partitions it:
 * `covers/` is served publicly and `artifacts/` is meant to stay private.
 * Map photos get their own namespace rather than sitting loose at the root, so
 * a bucket-level rule scoped by prefix can name them as a group.
 *
 * `mo.is_photo_object_key` in migration 0006 holds the same shape as a regex and
 * both tables that store a key `check` against it. If this changes, that
 * changes, or every insert is refused by a constraint the endpoint cannot see.
 */
export const PHOTO_KEY_PREFIX = 'map/'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/**
 * The owner's id comes first so a signed URL can only ever write inside the
 * prefix belonging to the person who asked for it, and so an abusive object is
 * attributable without a database lookup. The row-level security policy on
 * `mo.upload_grants` compares the key against that same prefix.
 *
 * All three ids must arrive lowercase. Postgres renders `auth.uid()::text` and
 * `report_id::text` lowercase, and the policy's `like` clause and the shape
 * `check` both compare literal strings -- so an uppercase id would build a key
 * that signs fine and is then refused by the database, and the refusal reaching
 * the person would say their own report could not be found. Rejecting it here
 * is the difference between a clear failure and that one.
 */
export function photoObjectKey(input: {
  userId: string
  reportId: string
  contentType: AllowedPhotoType
  photoId: string
}): string {
  for (const [name, value] of Object.entries({
    userId: input.userId,
    reportId: input.reportId,
    photoId: input.photoId,
  })) {
    if (!isUuid(value)) throw new Error(`${name} must be a UUID`)
    if (value !== value.toLowerCase()) throw new Error(`${name} must be lowercase`)
  }
  const extension = extensionForPhotoType(input.contentType)
  return `${PHOTO_KEY_PREFIX}${input.userId}/${input.reportId}/${input.photoId}.${extension}`
}
