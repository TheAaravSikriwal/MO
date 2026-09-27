import {
  extensionForPhotoType,
  type AllowedPhotoType,
} from '../../src/lib/upload/photoLimits'
import { presignUrl } from './sigv4'

/**
 * Cloudflare R2, reached over its S3-compatible API.
 *
 * R2 does not support presigned POST policies, so a presigned PUT is the only
 * way a browser can hand bytes straight to the bucket. That matters: routing
 * photo bytes through a serverless function instead would run every upload
 * into the function's request size and duration limits, on a free tier.
 */

/** R2 signs against a single pseudo-region rather than a real one. */
const R2_REGION = 'auto'
const S3_SERVICE = 's3'

/**
 * How long a signed upload URL stays usable.
 *
 * Long enough for a slow phone connection to finish one photo, short enough
 * that a URL captured from a log or a shared screen is dead by the time
 * anybody tries it. The URL grants a write to one exact key at one exact
 * size, so this is the last of the three limits, not the only one.
 */
export const UPLOAD_URL_TTL_SECONDS = 120

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/**
 * Where one photo lives in the bucket.
 *
 * Every part is either a UUID or a fixed extension, so nothing
 * attacker-controlled reaches the key: no traversal, no overlong names, no
 * second extension smuggled in through a filename.
 *
 * The owner's id comes first so that a signed URL can only ever write inside
 * the prefix belonging to the person who asked for it, and so an abusive
 * upload is attributable without a database lookup.
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
  }
  return `${input.userId}/${input.reportId}/${input.photoId}.${extensionForPhotoType(input.contentType)}`
}

export interface PhotoPutRequest {
  key: string
  contentType: AllowedPhotoType
  /** Exact byte length. Signed, so an upload of any other size is refused. */
  contentLength: number
  signedAt: Date
}

/**
 * A URL that accepts exactly one photo, once.
 *
 * Three signed headers, each closing a different hole. The store recomputes the
 * signature from the headers it actually receives, so a request that does not
 * match all three is rejected before any body is stored.
 *
 * `content-type` and `content-length` stop a URL issued for a 2 MB JPEG being
 * used to push half a gigabyte of anything into a 10 GB bucket.
 *
 * `if-none-match: *` is what makes it ONE photo rather than one shape of
 * photo. Without it a presigned PUT stays usable for its whole lifetime: any
 * number of writes to that key would be accepted as long as each body had the
 * same length and type, and padding a file to an exact length is trivial. That
 * matters because the worker judges the OBJECT -- it fetches the bytes and
 * writes the verdict to the row. So sign, upload something harmless, let the
 * worker approve it, then overwrite the object inside the same two minutes, and
 * the row says approved over content nothing ever reviewed. A conditional PUT
 * refuses the second write, because by then the object exists.
 */
export async function presignPhotoPut(
  config: R2Config,
  request: PhotoPutRequest,
): Promise<string> {
  return presignUrl({
    method: 'PUT',
    url: `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${request.key}`,
    region: R2_REGION,
    service: S3_SERVICE,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    signedHeaders: {
      'content-type': request.contentType,
      'content-length': String(request.contentLength),
      // Only if the object is not already there. See above: this is the
      // difference between one photo and one photo-shaped write per request.
      'if-none-match': '*',
    },
    signedAt: request.signedAt,
  })
}
