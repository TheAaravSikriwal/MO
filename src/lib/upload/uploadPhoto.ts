/**
 * The browser half of a photo upload.
 *
 * Two steps, and neither of them can be skipped. First ask our own endpoint
 * for permission to write one object — it checks who we are and decides the
 * key. Then send the bytes straight to Cloudflare R2 with the URL it returned.
 *
 * The bytes never pass through a serverless function. Relaying them would run
 * every photo into the function's request-size and duration limits, on a free
 * tier, for no benefit: the endpoint has already constrained what the URL can
 * be used for before any byte is sent.
 */

export const SIGN_UPLOAD_ENDPOINT = '/api/sign-upload'

/** Shown to a person when nothing more specific came back. */
const GENERIC_FAILURE = 'Your photo could not be uploaded. Please try again.'

/**
 * Said when our own endpoint is not there.
 *
 * A deployment without the serverless function answers 404 with an HTML error
 * page, so there is no `{message}` to read and the generic wording would take
 * over -- telling somebody to retry a route that does not exist. That is the
 * likeliest way this fails the first time it is deployed, so it gets the same
 * honest answer the endpoint itself gives when it is unconfigured.
 *
 * Deliberately the same sentence: to the person in front of it, "the function
 * did not deploy" and "somebody forgot R2_BUCKET" are one fact, and neither is
 * theirs to fix. Whoever IS setting it up needs to tell them apart, though, so
 * the console line below says which happened. Do not put that detail in the
 * message -- plain language is a hard constraint, and a route path in a
 * sentence aimed at a member of the public breaks it.
 */
const NOT_SET_UP = 'Photo upload is not set up on this site yet.'

export interface UploadPhotoDeps {
  fetch: typeof globalThis.fetch
  endpoint: string
}

const defaultDeps = (): UploadPhotoDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  endpoint: SIGN_UPLOAD_ENDPOINT,
})

interface SignedUploadResponse {
  url: string
  key: string
  headers: Record<string, string>
}

/**
 * The only host a photo is ever sent to.
 *
 * The endpoint is same-origin and always builds this host itself, so a URL
 * pointing anywhere else means the endpoint is not the one that answered. It
 * costs one line, and it is the only point at which somebody's photo could be
 * redirected off-site.
 */
const R2_HOST_SUFFIX = '.r2.cloudflarestorage.com'

function isObjectStoreUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.host.endsWith(R2_HOST_SUFFIX)
  } catch {
    return false
  }
}

function isSignedUpload(value: unknown): value is SignedUploadResponse {
  const candidate = value as SignedUploadResponse | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.url === 'string' &&
    candidate.url !== '' &&
    typeof candidate.key === 'string' &&
    candidate.key !== '' &&
    typeof candidate.headers === 'object' &&
    candidate.headers !== null
  )
}

/**
 * Read the endpoint's own wording if it sent any.
 *
 * The messages it returns are written for a person -- "Please sign in to add a
 * photo" -- so passing them through is better than replacing every failure
 * with one generic line.
 */
async function messageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === 'string' && body.message !== '' ? body.message : GENERIC_FAILURE
  } catch {
    return GENERIC_FAILURE
  }
}

export interface UploadPhotoRequest {
  reportId: string
  file: File
  /** The signed-in person's Supabase access token. */
  accessToken: string
}

/**
 * Upload one photo and return the object key to store against the report.
 *
 * Throws on any failure rather than returning a partial result. The caller
 * deletes the report it just created when this throws -- a pin with no photo
 * is worse than no pin, because the person is told their report failed while
 * it stays on the map for good.
 */
export async function uploadPhoto(
  request: UploadPhotoRequest,
  deps: UploadPhotoDeps = defaultDeps(),
): Promise<string> {
  const signResponse = await deps.fetch(deps.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.accessToken}`,
    },
    body: JSON.stringify({
      reportId: request.reportId,
      contentType: request.file.type,
      // Declared here and signed there, so the upload is refused if the bytes
      // that follow are not this many.
      contentLength: request.file.size,
    }),
  })

  // 404 and 405 come from the platform, not from the endpoint: the route is
  // missing, or something other than our function answered. Either way no
  // amount of retrying will help.
  if (signResponse.status === 404 || signResponse.status === 405) {
    // The one signal distinguishing this from a missing environment variable,
    // which returns the same sentence from the endpoint itself.
    console.error(
      `[mo] ${deps.endpoint} answered ${signResponse.status}. The upload endpoint is not ` +
        'deployed, or is not being routed to. This is not the same as a missing ' +
        'environment variable, which answers 503 with the same message.',
    )
    throw new Error(NOT_SET_UP)
  }
  if (!signResponse.ok) throw new Error(await messageFrom(signResponse))

  let signed: unknown
  try {
    signed = await signResponse.json()
  } catch {
    throw new Error(GENERIC_FAILURE)
  }
  if (!isSignedUpload(signed) || !isObjectStoreUrl(signed.url)) {
    throw new Error(GENERIC_FAILURE)
  }

  const putResponse = await deps.fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: request.file,
  })

  // R2 answers with XML, not our JSON, so there is no message worth reading
  // out of it -- and nothing in it would mean anything to a person.
  if (!putResponse.ok) throw new Error(GENERIC_FAILURE)

  return signed.key
}
