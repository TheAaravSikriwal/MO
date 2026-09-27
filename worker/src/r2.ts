import { presignUrl } from '../../shared/sigv4.js'

/**
 * Deleting one object from Cloudflare R2, over its S3-compatible API.
 *
 * Signed with MO's own SigV4 signer in `shared/` -- the one the upload endpoint
 * uses, pinned against AWS's published example -- rather than the AWS SDK, so
 * the worker gains no dependency for one kind of request.
 */

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/** Long enough to send the request, and no longer. */
const DELETE_URL_TTL_SECONDS = 60

export type FetchLike = (
  url: string,
  init: { method: string; signal?: AbortSignal },
) => Promise<{ status: number }>

/**
 * How long one delete may take. A hanging R2 must not hold the worker: the
 * cleanup runs in the same loop as moderation, and every second it waits is a
 * second no pending photo or comment is being judged.
 */
export const DELETE_TIMEOUT_MS = 15_000

/**
 * Delete one object. Resolves if it is gone -- including when it was never
 * there, since a missing object is exactly the state being asked for -- and
 * throws otherwise, so the caller leaves it to be retried.
 */
export async function deleteObject(
  config: R2Config,
  key: string,
  options: { fetch?: FetchLike; now?: () => Date } = {},
): Promise<void> {
  const url = await presignUrl({
    method: 'DELETE',
    url: `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`,
    region: 'auto',
    service: 's3',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresInSeconds: DELETE_URL_TTL_SECONDS,
    signedAt: (options.now ?? (() => new Date()))(),
  })
  const send = options.fetch ?? ((target, init) => fetch(target, init))
  const response = await send(url, { method: 'DELETE', signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) })
  // S3 answers a delete with 204 whether or not the key existed; R2 matches.
  // 404 is accepted too, so a store that does report it is not treated as a
  // failure to be retried forever.
  if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
    throw new Error(`R2 refused to delete ${key}: ${response.status}`)
  }
}
