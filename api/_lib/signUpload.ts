import {
  MAX_PHOTO_BYTES,
  isAllowedPhotoType,
  type AllowedPhotoType,
} from '../../src/lib/upload/photoLimits'
import { MO_SCHEMA } from '../../src/lib/data/schema'
import {
  UPLOAD_URL_TTL_SECONDS,
  isUuid,
  photoObjectKey,
  presignPhotoPut,
  type R2Config,
} from './r2'

/**
 * Hand out a URL that accepts exactly one photo, to exactly one signed-in
 * person, for a very short time.
 *
 * This endpoint exists because photo bytes live in Cloudflare R2 and the R2
 * credentials must never reach a browser. It is the smallest thing that can
 * hold them: it checks who is asking, decides the object key itself, and signs
 * a single PUT. It never touches the bytes.
 *
 * What stops this being an open upload relay, in order:
 *
 *   1. A valid Supabase access token, checked with Supabase rather than
 *      trusted from the request.
 *   2. Every grant is RECORDED in `upload_grants`, and a trigger on that
 *      table refuses the thirty-first in an hour. This is the bound on volume,
 *      and it has to be a recorded insert rather than a check, because an
 *      earlier version counted the photos already on the report instead: a
 *      caller who asks for a URL and never inserts the photo row leaves that
 *      count at zero forever, so sign / PUT 8 MB / repeat was unbounded. About
 *      1,250 iterations fill R2's free tier, from one account and one report.
 *   3. The key is derived here from the verified user id, so a signed URL can
 *      only write inside the caller's own prefix.
 *   4. The type and the exact byte length are part of the signature, so the
 *      URL fits one photo and refuses anything bigger or different, and
 *      `if-none-match: *` makes the write conditional on the object not
 *      existing -- so the URL is good for one write, not for every write of
 *      that shape until it expires.
 *   5. It expires in two minutes.
 *
 * Every question it asks the database, it asks with the CALLER'S token, never
 * a service role key. So the answers are the ones row level security would
 * give that person anyway, and this endpoint holds no database privilege at
 * all beyond what the person already has.
 */

export interface SignUploadEnv {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  /**
   * Accepted as a fallback so one set of variables can serve both the built
   * bundle and this function. A function pointed at a different project than
   * the app would reject every real token, and the symptom would be a sign-in
   * that works everywhere except uploads.
   */
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_ANON_KEY?: string
  R2_ACCOUNT_ID?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_BUCKET?: string
  /**
   * Where approved photos are served from, behind Cloudflare.
   *
   * Required even though this endpoint never uses it. Photos are meant to live
   * behind a Cloudflare-proxied hostname because that is what puts them in
   * scope for the free CSAM scanning tool, which is a legal obligation rather
   * than a preference. Accepting bytes with nowhere to serve them from means an
   * unscanned bucket, a map with no pictures, and admins asked to judge images
   * they cannot see. Refusing the upload is the honest answer.
   *
   * Only the `VITE_` name, deliberately -- see `readConfig`. It is the one
   * value here that belongs to the bundle rather than to this endpoint, so
   * checking any other spelling of it checks the wrong thing.
   */
  VITE_PHOTO_BASE_URL?: string
}

export interface SignUploadDeps {
  /** Injected so tests never reach the network. */
  fetch: typeof globalThis.fetch
  now: () => Date
  randomUUID: () => string
}

export interface SignedUpload {
  /** Presigned PUT. Send the file as the raw body, with these headers. */
  url: string
  /** The object key to store in `report_photos.storage_path`. */
  key: string
  /**
   * Headers the upload must carry, exactly as given.
   *
   * `content-length` is signed too but is not listed here: a browser sets it
   * from the body and refuses to let script set it, so listing it would only
   * invite a caller to try. `if-none-match` IS listed, because script has to
   * send that one and the upload is refused without it.
   */
  headers: Record<string, string>
  expiresInSeconds: number
}

interface SignRequestBody {
  reportId: string
  contentType: AllowedPhotoType
  contentLength: number
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** Kept identical across the failure paths, so no reply is a probing oracle. */
const GENERIC_FAILURE = 'Something went wrong preparing the upload.'

/**
 * Said for a missing variable and for a missing `upload_grants` table alike.
 *
 * Both mean the same thing to the person in front of it -- this site cannot
 * take photos yet -- and both are the operator's to fix.
 */
const NOT_SET_UP = 'Photo upload is not set up on this site yet.'

const SIGN_IN = 'Please sign in to add a photo.'

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), { status, headers: JSON_HEADERS })
}

/**
 * The characters an R2 account id and bucket name are allowed to contain.
 *
 * An allow-list, not a list of things to reject. `@`, `#` and `?` all parse as
 * URL syntax: `https://a@evil.example.r2.cloudflarestorage.com/...` has host
 * `evil.example.r2.cloudflarestorage.com`, and a `?` truncates the path. Each
 * would be signed happily and come back from R2 as an unexplained signature
 * mismatch, which is the failure this check exists to turn into a clear one.
 */
const R2_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Is this somewhere photos could actually be served from?
 *
 * Non-empty was not enough. `img.example.com`, with no scheme, passed -- and
 * the app concatenates that into `img.example.com/<key>`, which a browser
 * resolves against the app's own origin. The result is a broken image the UI
 * treats as a real photo and an admin asked to judge something they cannot
 * see, which is the exact failure `toPhoto` in `supabaseSource.ts` says it
 * exists to prevent. https, because this is the hostname CSAM scanning applies
 * to and it is not going to be plain http.
 */
function isServableBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    // A path is fine -- the bucket may be served under one, and the app appends
    // the key after it. A query or a fragment is not: `${base}/${key}` puts
    // them in the middle of the URL, so `https://img.example?x=1` becomes
    // `https://img.example?x=1/<key>` and every photo is a broken image the UI
    // treats as real. Checking the scheme alone let that through.
    return url.protocol === 'https:' && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}

/**
 * A URL this endpoint can call. http is allowed; https is not required.
 *
 * Separate from `isServableBaseUrl` on purpose. The photo hostname must be
 * https, because it is the public, Cloudflare-proxied one. The Supabase URL is
 * a server-to-server call that may legitimately be
 * `http://127.0.0.1:54321` -- which is how you run the migrations and answer
 * the row-level security questions in `supabase/README.md`. Requiring https
 * there silently closed local development off: every request answered "not set
 * up", with nothing pointing at the scheme.
 */
function isCallableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * First value that is actually set, treating blank as unset.
 *
 * `??` was wrong here. `.env.example` ships every variable as `NAME=` for
 * somebody to fill in, and dotenv reads that as `''` -- present, not absent. So
 * the documented path of filling in only the `VITE_` values left
 * `SUPABASE_URL` as an empty string, `??` kept it, and the fallback the docs
 * promise never fired: every upload answered "not set up" with nothing to say
 * which variable was at fault.
 */
function firstSet(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = (value ?? '').trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

function readConfig(env: SignUploadEnv): {
  r2: R2Config
  supabaseUrl: string
  supabaseAnonKey: string
} | null {
  const supabaseUrl = firstSet(env.SUPABASE_URL, env.VITE_SUPABASE_URL).replace(/\/$/, '')
  const supabaseAnonKey = firstSet(env.SUPABASE_ANON_KEY, env.VITE_SUPABASE_ANON_KEY)
  const r2: R2Config = {
    accountId: (env.R2_ACCOUNT_ID ?? '').trim(),
    accessKeyId: (env.R2_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (env.R2_SECRET_ACCESS_KEY ?? '').trim(),
    bucket: (env.R2_BUCKET ?? '').trim(),
  }

  // `VITE_PHOTO_BASE_URL` only, with no fallback, unlike every other value
  // here. This is the one variable the endpoint does not use itself: it checks
  // it on the BUNDLE's behalf, and the bundle reads exactly this name
  // (`createDataSource.ts`). Accepting `PHOTO_BASE_URL` as an alias made the
  // gate pass on a value the app would never see, so uploads succeeded while
  // every photo URL came back null -- "Photo is being checked" forever, and an
  // admin queue with nothing to judge. Which is the state this refuses.
  const photoBaseUrl = firstSet(env.VITE_PHOTO_BASE_URL)

  const values = [supabaseUrl, supabaseAnonKey, photoBaseUrl, ...Object.values(r2)]
  if (values.some((value) => value === '')) return null
  if (!isServableBaseUrl(photoBaseUrl)) return null
  if (!isCallableUrl(supabaseUrl)) return null
  // Not lowercased first. The bucket is a path segment and is used exactly as
  // written, so `My-Photos` would pass a case-insensitive check and then sign a
  // path R2 cannot resolve -- which is the opaque failure this check exists to
  // replace with a clear one.
  if (!R2_NAME.test(r2.accountId)) return null
  if (!R2_NAME.test(r2.bucket)) return null
  return { r2, supabaseUrl, supabaseAnonKey }
}

function parseBody(raw: unknown): SignRequestBody | string {
  if (typeof raw !== 'object' || raw === null) return GENERIC_FAILURE
  const body = raw as Record<string, unknown>

  if (typeof body.reportId !== 'string' || !isUuid(body.reportId)) return GENERIC_FAILURE
  if (typeof body.contentType !== 'string' || !isAllowedPhotoType(body.contentType)) {
    return 'Please choose a JPEG, PNG or WebP photo.'
  }
  // Ordered so each answer is true of the input that produced it. Folding all
  // of these into one check meant `NaN`, `Infinity` and a fractional length all
  // came back as "that file seems to be empty" -- which is the one message that
  // is definitely wrong, and it sends somebody off to pick a different photo
  // when the photo was never the problem.
  if (typeof body.contentLength !== 'number' || !Number.isFinite(body.contentLength)) {
    return GENERIC_FAILURE
  }
  if (body.contentLength > MAX_PHOTO_BYTES) {
    // The number comes from the cap, not from a sentence somebody typed.
    // Written out, the two drifted apart the moment the cap changed: the
    // endpoint refused at the new size while still saying "under 8 MB".
    return `That photo is too large. Please choose one under ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`
  }
  if (body.contentLength <= 0) {
    return 'That file seems to be empty. Please choose another photo.'
  }
  // A length with a fraction in it did not come from a file.
  if (!Number.isSafeInteger(body.contentLength)) return GENERIC_FAILURE

  return {
    // Lowercased, because the key is built from this and the grant policy
    // compares it against `report_id::text`, which Postgres renders lowercase.
    // An uppercase id would build a key the `like` clause does not match, and
    // the refusal would tell somebody their own report could not be found.
    reportId: body.reportId.toLowerCase(),
    contentType: body.contentType,
    contentLength: body.contentLength,
  }
}

/**
 * Ask Supabase who this token belongs to.
 *
 * Verifying the JWT here would need the project's signing secret and would
 * have to keep up with which algorithm the project signs with. Asking Supabase
 * costs one round-trip on a request that is about to upload a photo anyway, it
 * cannot drift out of step with key rotation, and it fails closed.
 */
/**
 * `'unreachable'` when the check could not be made at all, distinct from a
 * token that was checked and rejected.
 *
 * Collapsing the two told somebody with a perfectly good session to sign in
 * again, which is the one thing that cannot help, and left the operator -- whose
 * `SUPABASE_URL` is wrong, or whose project is down -- with no signal at all.
 * Both still fail closed; they just say different things.
 */
type Verified = { userId: string } | 'rejected' | 'unreachable'

async function verifyUser(
  deps: SignUploadDeps,
  supabaseUrl: string,
  anonKey: string,
  token: string,
): Promise<Verified> {
  let response: Response
  try {
    response = await deps.fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    })
  } catch {
    return 'unreachable'
  }
  // 401 and 403 are a verdict on the token. Anything else is the service
  // having a bad day, which is not this person's fault.
  if (!response.ok) {
    return response.status === 401 || response.status === 403 ? 'rejected' : 'unreachable'
  }

  let user: unknown
  try {
    user = await response.json()
  } catch {
    // A 200 that is not JSON is a proxy or an error page, not a verdict.
    return 'unreachable'
  }
  const id = (user as { id?: unknown } | null)?.id
  return typeof id === 'string' && isUuid(id) ? { userId: id } : 'rejected'
}

/**
 * Record the grant, which is what limits it.
 *
 * Inserted with the CALLER'S token, never a service role key, so this endpoint
 * holds no privilege the person does not already have -- and so it cannot
 * record a grant against somebody else or exempt itself from the trigger.
 *
 * The insert does three jobs at once, and none of them can be skipped by a
 * client that simply declines to make its next request:
 *
 *   - the rate-limit trigger refuses the thirty-first grant in an hour;
 *   - the row level security policy refuses a report that is not the caller's,
 *     which is why there is no separate ownership check here;
 *   - the row leaves a trace tying an object in the bucket to the request that
 *     asked for it.
 *
 * Returns a sentence to refuse with, or null to go ahead.
 */
async function recordUploadGrant(
  deps: SignUploadDeps,
  config: { supabaseUrl: string; supabaseAnonKey: string },
  token: string,
  grant: { userId: string; reportId: string; storagePath: string },
): Promise<string | null> {
  let response: Response
  try {
    response = await deps.fetch(`${config.supabaseUrl}/rest/v1/upload_grants`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Nothing here needs the row back, and asking for it would put the
        // key in a response body for no reason.
        Prefer: 'return=minimal',
        // The schema, as a header, because this talks to PostgREST directly
        // rather than through supabase-js -- so there is no `db.schema`
        // setting to inherit. `upload_grants` is in `mo`, and without this the
        // insert goes looking for `public.upload_grants`, which does not
        // exist: a 404 that the handler reports as "not set up yet".
        //
        // Content-Profile, not Accept-Profile: this is a write. Accept-Profile
        // governs reads and would be silently ignored here.
        'Content-Profile': MO_SCHEMA,
      },
      body: JSON.stringify({
        user_id: grant.userId,
        report_id: grant.reportId,
        storage_path: grant.storagePath,
      }),
    })
  } catch {
    // Fails closed. An unreachable database must not mean an unlimited URL.
    return GENERIC_FAILURE
  }

  if (response.ok) return null

  // Postgres explains itself in the body: the trigger raises a message, row
  // level security returns a code. Read the message before falling back, or a
  // person who is merely going too fast is told their report vanished.
  let detail = ''
  try {
    const body = (await response.json()) as { message?: unknown }
    if (typeof body.message === 'string') detail = body.message
  } catch {
    detail = ''
  }

  if (/too many photo uploads/i.test(detail)) {
    return 'You have added several photos recently. Please wait a while before adding more.'
  }
  // Two setup problems, one sentence, because to the person in front of it
  // they are the same fact and neither is theirs to fix.
  //
  // 404: the table is not there, so migration 0006 has not been applied.
  //
  // 406: PostgREST refusing the schema (`PGRST106`, "The schema must be one of
  // the following"). MO lives in the `mo` schema now, which has to be added to
  // the project's exposed-schemas list by hand — so this is the most likely
  // thing to be wrong the first time this runs, and it used to fall through to
  // the generic 503 and say nothing at all.
  if (response.status === 404 || response.status === 406) return NOT_SET_UP
  // 401, not 403: the token was accepted a moment ago and has expired since.
  // Telling this person their report could not be found would send them
  // looking for a report that is sitting right there.
  if (response.status === 401) return SIGN_IN
  if (response.status === 403) {
    // Covers both a report that does not exist and one belonging to somebody
    // else, on purpose: two different answers would let anyone test whether a
    // given id is a real report.
    return 'That report could not be found.'
  }
  return GENERIC_FAILURE
}

/** Which code a refusal should arrive under, kept in one place. */
function statusFor(refusal: string): number {
  if (refusal === GENERIC_FAILURE || refusal === NOT_SET_UP) return 503
  if (refusal === SIGN_IN) return 401
  if (refusal.includes('wait a while')) return 429
  return 403
}

export function createSignUploadHandler(env: SignUploadEnv, deps: SignUploadDeps) {
  /**
   * Nothing escapes as an unhandled rejection.
   *
   * Every refusal below is a deliberate shape: a status and one sentence
   * `plainWords` knows how to say. A throw from anywhere -- the signer, a
   * Response that will not serialise -- would instead hand the browser whatever
   * the platform emits, which is neither, and the grant has already been
   * recorded and counted by then.
   */
  return async function handle(request: Request): Promise<Response> {
    try {
      return await handleOrThrow(env, deps, request)
    } catch (cause) {
      // Logged, because this is the only 503 nothing else explains. Three
      // separate causes answer with this same sentence -- an unreachable auth
      // check, a grant that could not be recorded, and this -- and the person
      // must not be told which. Whoever is on call has to be, and by the time
      // this runs the grant may already be recorded and counted.
      console.error('[mo] /api/sign-upload failed unexpectedly:', cause)
      return fail(503, GENERIC_FAILURE)
    }
  }
}

function handleOrThrow(
  env: SignUploadEnv,
  deps: SignUploadDeps,
  request: Request,
): Promise<Response> {
  return (async function handle(): Promise<Response> {
    if (request.method !== 'POST') return fail(405, GENERIC_FAILURE)

    const config = readConfig(env)
    if (!config) {
      // The same honest failure the old stub gave, moved to where it belongs.
      // A half-configured upload is worse than none: the report row is written
      // before the photo, so failing quietly here leaves a pin with no picture.
      return fail(503, NOT_SET_UP)
    }

    const authorization = request.headers.get('Authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    if (!token) return fail(401, SIGN_IN)

    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return fail(400, GENERIC_FAILURE)
    }

    const parsed = parseBody(raw)
    if (typeof parsed === 'string') return fail(400, parsed)

    const verified = await verifyUser(deps, config.supabaseUrl, config.supabaseAnonKey, token)
    if (verified === 'unreachable') return fail(503, GENERIC_FAILURE)
    if (verified === 'rejected') return fail(401, SIGN_IN)
    const { userId } = verified

    // The key is settled before the grant is recorded, because the grant
    // records it -- that is what ties a stray object back to one request.
    const key = photoObjectKey({
      // Lowercased for the same reason as reportId above: the grant policy
      // compares the key against `auth.uid()::text`, which Postgres renders
      // lowercase. Supabase returns lowercase today, so this is belt rather
      // than braces -- but an uppercase id would build a key the policy cannot
      // match, and the refusal would say the report could not be found.
      userId: userId.toLowerCase(),
      reportId: parsed.reportId,
      contentType: parsed.contentType,
      // Lowercased like the other two. `crypto.randomUUID()` is specified to
      // return lowercase, so this cannot fire today -- which is the same
      // argument the other two lines exist to reject. An uppercase id would
      // pass `isUuid` here and then be refused by the key-shape check at the
      // grant insert (`mo.is_photo_object_key`, called from a `check`
      // constraint), arriving as an unexplained 503.
      photoId: deps.randomUUID().toLowerCase(),
    })

    const refusal = await recordUploadGrant(deps, config, token, {
      userId,
      reportId: parsed.reportId,
      storagePath: key,
    })
    if (refusal) return fail(statusFor(refusal), refusal)

    const url = await presignPhotoPut(config.r2, {
      key,
      contentType: parsed.contentType,
      contentLength: parsed.contentLength,
      signedAt: deps.now(),
    })

    const signed: SignedUpload = {
      url,
      key,
      headers: {
        'Content-Type': parsed.contentType,
        // Makes the write conditional on the object not existing, which is
        // what stops the URL being reused inside its two-minute life to
        // replace bytes a human or the worker has already judged.
        'If-None-Match': '*',
      },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    }
    return new Response(JSON.stringify(signed), {
      status: 200,
      // A signed URL is a bearer credential for one write. Nothing should keep it.
      headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' },
    })
  })()
}
