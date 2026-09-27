// @vitest-environment node
//
// Server code, so it is tested in the runtime it resembles. It ran green under
// the suite's jsdom default -- Node's WebCrypto and fetch classes survive that
// environment -- but relying on which globals jsdom happens not to replace is
// not something to depend on. Nothing here touches a DOM.
import { describe, it, expect, vi } from 'vitest'
import { createSignUploadHandler, type SignUploadEnv } from './signUpload'
import { MAX_PHOTO_BYTES } from '../../src/lib/upload/photoLimits'

const USER = '11111111-1111-4111-8111-111111111111'
const REPORT = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'

const fullEnv: SignUploadEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  R2_ACCOUNT_ID: 'acc123',
  R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secret-example',
  R2_BUCKET: 'mo-photos',
  VITE_PHOTO_BASE_URL: 'https://img.example',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

/**
 * A Supabase that says yes to everything: the token is real and the grant is
 * accepted.
 *
 * A fresh Response per call, not one shared instance: a Response body can only
 * be read once, so reusing one makes every call after the first look like a
 * rejected token. That silently turned two assertions below green.
 */
const supabaseOk = (grant: () => Promise<Response> = async () => new Response('', { status: 201 })) =>
  vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/auth/v1/user')) return json({ id: USER })
    if (url.includes('upload_grants')) return grant()
    throw new Error(`unexpected request: ${url}`)
  })

/** Kept under the old name so the auth cases below read the same. */
const userOk = supabaseOk

const deps = (fetchImpl = userOk()) => ({
  fetch: fetchImpl as unknown as typeof globalThis.fetch,
  now: () => new Date('2026-09-15T10:20:30Z'),
  randomUUID: () => PHOTO,
})

const signRequest = (
  body: unknown = { reportId: REPORT, contentType: 'image/jpeg', contentLength: 2048 },
  init: { token?: string | null; method?: string } = {},
) =>
  new Request('https://mo.example/api/sign-upload', {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? 'access-token'}` }),
    },
    // GET and HEAD cannot carry one, and the method check must come first anyway.
    ...(init.method === 'GET' || init.method === 'HEAD'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>

describe('sign-upload: a valid request', () => {
  it('returns a presigned PUT for a key under the verified user and the report', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const response = await handle(signRequest())
    expect(response.status).toBe(200)

    const body = await bodyOf(response)
    expect(body.key).toBe(`map/${USER}/${REPORT}/${PHOTO}.jpg`)
    const url = new URL(String(body.url))
    expect(url.host).toBe('acc123.r2.cloudflarestorage.com')
    expect(url.pathname).toBe(`/mo-photos/map/${USER}/${REPORT}/${PHOTO}.jpg`)
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('tells the caller which headers the upload must carry', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const body = await bodyOf(await handle(signRequest()))
    // If-None-Match is listed because script has to send it; Content-Length is
    // not, because a browser sets it from the body and refuses to let script.
    expect(body.headers).toEqual({ 'Content-Type': 'image/jpeg', 'If-None-Match': '*' })
    expect(body.expiresInSeconds).toBe(120)
  })

  it('never lets a signed URL be cached', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const response = await handle(signRequest())
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('never returns the R2 secret', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const text = await (await handle(signRequest())).text()
    expect(text).not.toContain('secret-example')
  })

  it('checks the token with Supabase rather than trusting it', async () => {
    const fetchImpl = userOk()
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    await handle(signRequest())

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://project.supabase.co/auth/v1/user')
    expect(init.headers).toMatchObject({
      apikey: 'anon-key',
      Authorization: 'Bearer access-token',
    })
  })

  it('records the grant with the token it was given, never a service role key', async () => {
    // The trigger counts by user_id, and row level security pins user_id to
    // auth.uid(). Using a service role key would bypass both.
    const fetchImpl = userOk()
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    const body = await bodyOf(await handle(signRequest()))

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls).toHaveLength(2)
    for (const [, init] of calls) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer access-token' })
      expect(JSON.stringify(init.headers)).not.toContain('service_role')
    }

    const [url, init] = calls[1]
    expect(url).toBe('https://project.supabase.co/rest/v1/upload_grants')
    expect(init.method).toBe('POST')
    // The schema, as a header. This talks to PostgREST directly rather than
    // through supabase-js, so nothing hands it `db.schema` -- and
    // `upload_grants` is in `mo`, alongside the rest of MO. Without it the
    // insert looks for `public.upload_grants`, which does not exist in the
    // wearechintu database, and the 404 reports as "not set up yet".
    //
    // Content-Profile because this is a write; Accept-Profile governs reads
    // and would be ignored here.
    expect(init.headers).toMatchObject({ 'Content-Profile': 'mo' })
    // The recorded key is the key it hands out, so a stray object in the
    // bucket traces back to the request that asked for it.
    expect(JSON.parse(String(init.body))).toEqual({
      user_id: USER,
      report_id: REPORT,
      storage_path: body.key,
    })
  })

  it('ignores any user id the caller supplies and uses the verified one', async () => {
    // Otherwise a caller could write into somebody else's prefix just by
    // asking, and an abusive object would be attributed to the wrong person.
    const handle = createSignUploadHandler(fullEnv, deps())
    const body = await bodyOf(
      await handle(
        signRequest({
          reportId: REPORT,
          contentType: 'image/jpeg',
          contentLength: 2048,
          userId: '99999999-9999-4999-8999-999999999999',
        }),
      ),
    )
    expect(String(body.key).startsWith(`map/${USER}/`)).toBe(true)
  })

  it('ignores any key the caller supplies', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const body = await bodyOf(
      await handle(
        signRequest({
          reportId: REPORT,
          contentType: 'image/jpeg',
          contentLength: 2048,
          key: '../../someone-else/secret.jpg',
        }),
      ),
    )
    expect(body.key).toBe(`map/${USER}/${REPORT}/${PHOTO}.jpg`)
  })

  it('lowercases the report id, because the grant policy compares against lowercase', async () => {
    // Postgres renders uuid::text lowercase, and the policy matches the key
    // against `<uid>/<report-id>/%`. An uppercase id would build a key the
    // clause does not match, and the refusal would tell somebody their own
    // report could not be found.
    const handle = createSignUploadHandler(fullEnv, deps())
    const body = await bodyOf(
      await handle(
        signRequest({
          reportId: REPORT.toUpperCase(),
          contentType: 'image/jpeg',
          contentLength: 2048,
        }),
      ),
    )
    expect(body.key).toBe(`map/${USER}/${REPORT}/${PHOTO}.jpg`)
  })

  it('gives each photo its own key, so two uploads cannot overwrite each other', async () => {
    let n = 0
    const ids = [PHOTO, '44444444-4444-4444-8444-444444444444']
    const handle = createSignUploadHandler(fullEnv, {
      ...deps(),
      randomUUID: () => ids[n++],
    })
    const first = await bodyOf(await handle(signRequest()))
    const second = await bodyOf(await handle(signRequest()))
    expect(first.key).not.toBe(second.key)
  })
})

describe('sign-upload: who is asking', () => {
  it('refuses a request with no Authorization header, without calling Supabase', async () => {
    const fetchImpl = supabaseOk()
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    const response = await handle(signRequest(undefined, { token: null }))
    expect(response.status).toBe(401)
    expect((await bodyOf(response)).message).toBe('Please sign in to add a photo.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a token Supabase rejects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    const response = await handle(signRequest())
    expect(response.status).toBe(401)
  })

  it('refuses when Supabase answers without a user id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    expect((await handle(signRequest())).status).toBe(401)
  })

  it('refuses when Supabase answers with an id that is not a user id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: '../../etc' }), { status: 200 }))
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    expect((await handle(signRequest())).status).toBe(401)
  })

  // Unreachable is not the same as rejected. Telling somebody with a good
  // session to sign in again points them at the one thing that cannot help,
  // and leaves whoever set the site up with no signal that their SUPABASE_URL
  // is wrong. Both still refuse; they just say different things.
  it.each([
    ['the check cannot be made at all', vi.fn().mockRejectedValue(new Error('network down'))],
    ['Supabase is down', vi.fn().mockResolvedValue(new Response('{}', { status: 500 }))],
    ['a gateway answers instead', vi.fn().mockResolvedValue(new Response('{}', { status: 502 }))],
    [
      'the answer is not JSON',
      vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 200 })),
    ],
  ])('fails closed, and does not blame the person, when %s', async (_case, fetchImpl) => {
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Something went wrong preparing the upload.')
  })

  it('never signs anything when the token could not be checked', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    expect(await (await handle(signRequest())).text()).not.toContain('X-Amz-Signature')
  })
})

describe('sign-upload: how much can be asked for', () => {
  // This is the only thing bounding how much can be written to the bucket, so
  // it has to be a recorded insert rather than a check. An earlier version
  // counted the photos already attached to the report; a caller who asks for a
  // URL and never inserts the photo row leaves that count at zero forever, so
  // sign / PUT 8 MB / repeat was unbounded.
  const grantRefused = (status: number, message: string) =>
    supabaseOk(async () => json({ message }, status))

  it('refuses once the hourly limit has been reached, and says to wait', async () => {
    const handle = createSignUploadHandler(
      fullEnv,
      deps(grantRefused(400, 'too many photo uploads in the last hour; please slow down')),
    )
    const response = await handle(signRequest())
    expect(response.status).toBe(429)
    expect((await bodyOf(response)).message).toBe(
      'You have added several photos recently. Please wait a while before adding more.',
    )
  })

  it('never signs anything once the limit is reached', async () => {
    const handle = createSignUploadHandler(
      fullEnv,
      deps(grantRefused(400, 'too many photo uploads in the last hour; please slow down')),
    )
    const text = await (await handle(signRequest())).text()
    expect(text).not.toContain('X-Amz-Signature')
  })

  it('refuses a report that is not the caller’s, which the policy rejects', async () => {
    const handle = createSignUploadHandler(
      fullEnv,
      deps(
        grantRefused(403, 'new row violates row-level security policy for table "upload_grants"'),
      ),
    )
    const response = await handle(signRequest())
    expect(response.status).toBe(403)
    expect((await bodyOf(response)).message).toBe('That report could not be found.')
  })

  it('tells someone going too fast to wait, rather than that their report vanished', async () => {
    // Both arrive as a non-2xx from the same endpoint. Reading the message is
    // what keeps them apart.
    const handle = createSignUploadHandler(
      fullEnv,
      deps(grantRefused(403, 'too many photo uploads in the last hour; please slow down')),
    )
    expect((await handle(signRequest())).status).toBe(429)
  })

  it('says uploads are not set up when the schema is not exposed', async () => {
    // PostGREST answers 406 / PGRST106 when `mo` is missing from the
    // project's exposed-schemas list. That is a hand-configured setting, so it
    // is the likeliest thing to be wrong the first time this runs -- and it
    // used to fall through to the generic 503 and name nothing.
    const handle = createSignUploadHandler(
      fullEnv,
      deps(
        supabaseOk(async () =>
          json({ code: 'PGRST106', message: 'The schema must be one of the following: public' }, 406),
        ),
      ),
    )
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Photo upload is not set up on this site yet.')
  })

  it('says uploads are not set up when the grants table is missing', async () => {
    // A 404 from PostgREST means migration 0006 was never applied, which is
    // the likeliest thing to be wrong the first time this runs. Telling
    // somebody to try again would be telling them to retry the one thing that
    // cannot start working.
    const handle = createSignUploadHandler(
      fullEnv,
      deps(supabaseOk(async () => json({ message: 'relation does not exist' }, 404))),
    )
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Photo upload is not set up on this site yet.')
  })

  it('asks an expired token to sign in again, not that the report has vanished', async () => {
    // The token was accepted a moment earlier, so 401 here means it expired in
    // between. Saying the report could not be found would send this person
    // looking for one that is sitting right there.
    const handle = createSignUploadHandler(
      fullEnv,
      deps(supabaseOk(async () => json({ message: 'JWT expired' }, 401))),
    )
    const response = await handle(signRequest())
    expect(response.status).toBe(401)
    expect((await bodyOf(response)).message).toBe('Please sign in to add a photo.')
  })

  it('names the cap from the cap, so the sentence cannot drift from the code', async () => {
    // Written out as "8 MB", the number and the limit drifted apart the moment
    // the cap changed: the endpoint refused at the new size while still telling
    // people the old one, with the suite green.
    const handle = createSignUploadHandler(fullEnv, deps())
    const response = await handle(
      signRequest({
        reportId: REPORT,
        contentType: 'image/jpeg',
        contentLength: MAX_PHOTO_BYTES + 1,
      }),
    )
    expect((await bodyOf(response)).message).toContain(
      `under ${MAX_PHOTO_BYTES / 1024 / 1024} MB`,
    )
  })

  it('leaves a log behind when it fails for a reason nothing else explains', async () => {
    // Three causes answer with this one sentence: an unreachable auth check, a
    // grant that could not be recorded, and an unexpected throw. The person
    // must not be told which; whoever is on call has to be.
    const logged: unknown[][] = []
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => void logged.push(args))

    const handle = createSignUploadHandler(fullEnv, {
      ...deps(),
      randomUUID: () => {
        throw new Error('no randomness available')
      },
    })
    const response = await handle(signRequest())
    spy.mockRestore()

    expect(response.status).toBe(503)
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain('/api/sign-upload')
    expect(String(logged[0][1])).toContain('no randomness available')
  })

  it('answers in the shape it always answers in, even if signing itself throws', async () => {
    // Every refusal here is a status plus one sentence plainWords can say. A
    // throw would hand the browser whatever the platform emits instead, after
    // the grant has already been recorded and counted.
    const handle = createSignUploadHandler(fullEnv, {
      ...deps(),
      randomUUID: () => {
        throw new Error('no randomness available')
      },
    })
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Something went wrong preparing the upload.')
  })

  it('never signs anything when the grant could not be recorded', async () => {
    // Fails closed. An unreachable database must not mean an unlimited URL.
    for (const grant of [
      async () => json({ message: 'boom' }, 500),
      async () => new Response('<html>502</html>', { status: 500 }),
      async () => {
        throw new Error('network down')
      },
    ]) {
      const handle = createSignUploadHandler(fullEnv, deps(supabaseOk(grant)))
      const response = await handle(signRequest())
      expect(response.status).toBe(503)
      expect((await bodyOf(response)).url).toBeUndefined()
    }
  })

  it('records the grant before it signs, so a refusal cannot leak a URL', async () => {
    const order: string[] = []
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/auth/v1/user')) {
        order.push('auth')
        return json({ id: USER })
      }
      order.push('grant')
      return new Response('', { status: 201 })
    })
    const handle = createSignUploadHandler(fullEnv, deps(fetchImpl))
    await handle(signRequest())
    expect(order).toEqual(['auth', 'grant'])
  })
})

describe('sign-upload: what is being asked for', () => {
  const rejects = async (body: unknown, message?: string) => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const response = await handle(signRequest(body))
    expect(response.status).toBe(400)
    if (message) expect((await bodyOf(response)).message).toBe(message)
  }

  it('refuses a report id that is not a uuid', async () => {
    await rejects({ reportId: '../../x', contentType: 'image/jpeg', contentLength: 10 })
    await rejects({ reportId: 1, contentType: 'image/jpeg', contentLength: 10 })
    await rejects({ contentType: 'image/jpeg', contentLength: 10 })
  })

  it('refuses a type that is not one of the three allowed', async () => {
    for (const contentType of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/html']) {
      await rejects(
        { reportId: REPORT, contentType, contentLength: 10 },
        'Please choose a JPEG, PNG or WebP photo.',
      )
    }
  })

  it('refuses a size over the cap the browser gate applies', async () => {
    await rejects(
      { reportId: REPORT, contentType: 'image/jpeg', contentLength: MAX_PHOTO_BYTES + 1 },
      'That photo is too large. Please choose one under 8 MB.',
    )
  })

  it('accepts a size exactly at the cap', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const response = await handle(
      signRequest({ reportId: REPORT, contentType: 'image/jpeg', contentLength: MAX_PHOTO_BYTES }),
    )
    expect(response.status).toBe(200)
  })

  // Each of these gets the answer that is true of it. Folding them together
  // meant NaN and a fractional length both came back as "that file seems to be
  // empty", sending somebody to choose a different photo over a request their
  // browser never made.
  it.each([
    [0, 'That file seems to be empty. Please choose another photo.'],
    [-1, 'That file seems to be empty. Please choose another photo.'],
    [MAX_PHOTO_BYTES + 1, 'That photo is too large. Please choose one under 8 MB.'],
    [Number.MAX_VALUE, 'That photo is too large. Please choose one under 8 MB.'],
    [1.5, 'Something went wrong preparing the upload.'],
    [Number.NaN, 'Something went wrong preparing the upload.'],
    [Number.POSITIVE_INFINITY, 'Something went wrong preparing the upload.'],
  ])('refuses the size %p, and says why', async (contentLength, message) => {
    await rejects({ reportId: REPORT, contentType: 'image/jpeg', contentLength }, message)
  })

  it('refuses a size that is not a number at all', async () => {
    await rejects(
      { reportId: REPORT, contentType: 'image/jpeg', contentLength: '2048' },
      'Something went wrong preparing the upload.',
    )
  })

  it('refuses a body that is not JSON, and one that is not an object', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    expect((await handle(signRequest('not json'))).status).toBe(400)
    expect((await handle(signRequest(null))).status).toBe(400)
    expect((await handle(signRequest([REPORT]))).status).toBe(400)
  })

  it('refuses any method other than POST', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await handle(signRequest(undefined, { method }))).status).toBe(405)
    }
  })

  it('signs the size that was asked for, so a different upload will not verify', async () => {
    const handle = createSignUploadHandler(fullEnv, deps())
    const small = await bodyOf(
      await handle(signRequest({ reportId: REPORT, contentType: 'image/jpeg', contentLength: 2048 })),
    )
    const large = await bodyOf(
      await handle(
        signRequest({ reportId: REPORT, contentType: 'image/jpeg', contentLength: 2_000_000 }),
      ),
    )
    const signatureOf = (body: Record<string, unknown>) =>
      new URL(String(body.url)).searchParams.get('X-Amz-Signature')
    expect(signatureOf(small)).not.toBe(signatureOf(large))
    expect(new URL(String(small.url)).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    )
  })
})

describe('sign-upload: when it is not configured', () => {
  const missing: Array<keyof SignUploadEnv> = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    // Required even though this endpoint never uses it: photos have to be
    // served from the Cloudflare-proxied hostname for the free CSAM scanning
    // to apply to them, and that is a legal obligation. Accepting bytes with
    // nowhere to serve them from means an unscanned bucket, a map with no
    // pictures, and admins asked to judge images they cannot see.
    'VITE_PHOTO_BASE_URL',
  ]

  it.each(missing)('says so plainly when %s is unset', async (key) => {
    const env = { ...fullEnv }
    delete env[key]
    const handle = createSignUploadHandler(env, deps())
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Photo upload is not set up on this site yet.')
  })

  it.each(missing)('says so plainly when %s is blank', async (key) => {
    const handle = createSignUploadHandler({ ...fullEnv, [key]: '   ' }, deps())
    expect((await handle(signRequest())).status).toBe(503)
  })

  it.each([
    'acc/123',
    'mo photos',
    // These parse as URL syntax rather than as a name. `a@host` moves the
    // host, `?` truncates the path, `#` drops the rest -- each signs something
    // other than the object it is meant to, and comes back from R2 as an
    // unexplained mismatch.
    'a@evil.example',
    'acc?x=1',
    'acc#frag',
    'acc:8080',
    '../other',
    '-leading-dash',
  ])('refuses %s as an account id or a bucket name', async (name) => {
    for (const env of [
      { ...fullEnv, R2_ACCOUNT_ID: name },
      { ...fullEnv, R2_BUCKET: name },
    ]) {
      const handle = createSignUploadHandler(env, deps())
      expect((await handle(signRequest())).status).toBe(503)
    }
  })

  it.each([
    'img.example.com',
    'http://img.example.com',
    '/photos',
    'x',
    'ftp://img.example.com',
    // A query or a fragment lands in the MIDDLE of the URL once the key is
    // appended: `https://img.example?x=1/<key>`. Checking only the scheme let
    // these through, and every photo came out a broken image.
    'https://img.example?x=1',
    'https://img.example#a',
  ])('refuses %s as a photo base URL, rather than signing into nowhere', async (url) => {
    // Non-empty was not enough. Without a scheme the app concatenates it into
    // `img.example.com/<key>`, which a browser resolves against its own
    // origin: a broken image the UI treats as real, and an admin asked to
    // judge something they cannot see.
    const handle = createSignUploadHandler({ ...fullEnv, VITE_PHOTO_BASE_URL: url }, deps())
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Photo upload is not set up on this site yet.')
  })

  it.each([
    'https://pub-0123456789abcdef.r2.dev',
    'https://PUB-0123456789ABCDEF.R2.DEV/photos',
    'https://pub-0123456789abcdef.r2.dev.',
    'https://r2.dev',
  ])('refuses %s, Cloudflare’s own bucket address, which CSAM scanning does not cover', async (url) => {
    // Scanning is switched on per zone, and r2.dev is not one of ours. It is
    // also the address a bucket comes with, so it is the likeliest thing to be
    // configured before a custom domain is attached.
    const handle = createSignUploadHandler({ ...fullEnv, VITE_PHOTO_BASE_URL: url }, deps())
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Photo upload is not set up on this site yet.')
  })

  it('accepts a custom domain whose name merely contains r2.dev', async () => {
    const handle = createSignUploadHandler(
      { ...fullEnv, VITE_PHOTO_BASE_URL: 'https://photos.myr2.dev.example' },
      deps(),
    )
    expect((await handle(signRequest())).status).toBe(200)
  })

  it('accepts a photo host served under a path, which the app appends to', async () => {
    const handle = createSignUploadHandler(
      { ...fullEnv, VITE_PHOTO_BASE_URL: 'https://img.example/photos' },
      deps(),
    )
    expect((await handle(signRequest())).status).toBe(200)
  })

  it('refuses a Supabase URL that is not a URL at all', async () => {
    for (const url of ['project.supabase.co', '/auth', 'x']) {
      const handle = createSignUploadHandler({ ...fullEnv, SUPABASE_URL: url }, deps())
      expect((await handle(signRequest())).status).toBe(503)
    }
  })

  it('accepts a local Supabase over http, which is how the migrations get run', async () => {
    // The photo hostname must be https -- it is the public, Cloudflare-proxied
    // one. This is a server-to-server call, and requiring https here closed
    // local development off with nothing pointing at the scheme.
    const fetchImpl = userOk()
    const handle = createSignUploadHandler(
      { ...fullEnv, SUPABASE_URL: 'http://127.0.0.1:54321' },
      deps(fetchImpl),
    )
    expect((await handle(signRequest())).status).toBe(200)
    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toBe(
      'http://127.0.0.1:54321/auth/v1/user',
    )
  })

  it('still requires https for the photo hostname, which is the scanned one', async () => {
    const handle = createSignUploadHandler(
      { ...fullEnv, VITE_PHOTO_BASE_URL: 'http://img.example' },
      deps(),
    )
    expect((await handle(signRequest())).status).toBe(503)
  })

  it('refuses a bucket name whose case would not resolve', async () => {
    // The bucket is a path segment, used exactly as written. A
    // case-insensitive check would pass this and then sign a path R2 cannot
    // resolve, which is the opaque failure the check exists to replace.
    const handle = createSignUploadHandler({ ...fullEnv, R2_BUCKET: 'My-Photos' }, deps())
    expect((await handle(signRequest())).status).toBe(503)
  })

  it('accepts the names R2 actually issues', async () => {
    for (const env of [
      { ...fullEnv, R2_ACCOUNT_ID: '0123abcdef4567890abcdef0123456789' },
      { ...fullEnv, R2_BUCKET: 'mo-photos-staging' },
    ]) {
      const handle = createSignUploadHandler(env, deps())
      expect((await handle(signRequest())).status).toBe(200)
    }
  })

  it('accepts the VITE_ variables as a fallback, so one set of values serves both halves', async () => {
    const handle = createSignUploadHandler(
      {
        VITE_SUPABASE_URL: 'https://project.supabase.co/',
        VITE_SUPABASE_ANON_KEY: 'anon-key',
        VITE_PHOTO_BASE_URL: 'https://img.example',
        R2_ACCOUNT_ID: 'acc123',
        R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        R2_SECRET_ACCESS_KEY: 'secret-example',
        R2_BUCKET: 'mo-photos',
      },
      deps(),
    )
    expect((await handle(signRequest())).status).toBe(200)
  })

  it('refuses a PHOTO_BASE_URL that is not the name the bundle reads', async () => {
    // The only value here with no fallback. The endpoint checks it on the
    // bundle's behalf, and the bundle reads `VITE_PHOTO_BASE_URL` -- so an
    // alias would let the gate pass on a value the app never sees: uploads
    // succeeding while every photo URL comes back null.
    const handle = createSignUploadHandler(
      { ...fullEnv, VITE_PHOTO_BASE_URL: '', PHOTO_BASE_URL: 'https://img.example' } as Record<
        string,
        string
      >,
      deps(),
    )
    const response = await handle(signRequest())
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).message).toBe('Photo upload is not set up on this site yet.')
  })

  it.each([
    ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'https://project.supabase.co'],
    ['SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'anon-key'],
  ] as const)(
    'falls back to %s even when %s is present but blank',
    async (blank, fallback, value) => {
      // `.env.example` ships every variable as `NAME=`, which dotenv reads as
      // an empty string -- present, not absent. With `??` the blank won and the
      // documented fallback never fired, so filling in only the VITE_ values
      // gave "not set up" with nothing to say which variable was at fault.
      const handle = createSignUploadHandler(
        { ...fullEnv, [blank]: '', [fallback]: value },
        deps(),
      )
      expect((await handle(signRequest())).status).toBe(200)
    },
  )

  it('does not double the slash when the Supabase URL has a trailing one', async () => {
    const fetchImpl = userOk()
    const handle = createSignUploadHandler(
      { ...fullEnv, SUPABASE_URL: 'https://project.supabase.co/' },
      deps(fetchImpl),
    )
    await handle(signRequest())
    expect((fetchImpl.mock.calls[0] as unknown as [string])?.[0]).toBe('https://project.supabase.co/auth/v1/user')
  })
})
