import { describe, it, expect, vi } from 'vitest'
import { SIGN_UPLOAD_ENDPOINT, uploadPhoto } from './uploadPhoto'

const REPORT = '22222222-2222-4222-8222-222222222222'
const KEY = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/photo.jpg'
const SIGNED_URL = 'https://acc.r2.cloudflarestorage.com/mo-photos/key.jpg?X-Amz-Signature=abc'

const photo = (type = 'image/jpeg', size = 2048) => {
  const file = new File(['x'], 'litter.jpg', { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const signedBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    url: SIGNED_URL,
    key: KEY,
    headers: { 'Content-Type': 'image/jpeg', 'If-None-Match': '*' },
    expiresInSeconds: 120,
    ...overrides,
  })

/** Sign first, then PUT. Each call gets its own Response. */
const happyFetch = () =>
  vi.fn(async (input: unknown) =>
    String(input) === SIGN_UPLOAD_ENDPOINT
      ? new Response(signedBody(), { status: 200 })
      : new Response('', { status: 200 }),
  )

const run = (fetchImpl: ReturnType<typeof happyFetch>, file = photo()) =>
  uploadPhoto(
    { reportId: REPORT, file, accessToken: 'access-token' },
    { fetch: fetchImpl as unknown as typeof globalThis.fetch, endpoint: SIGN_UPLOAD_ENDPOINT },
  )

describe('uploadPhoto', () => {
  it('asks our own endpoint first, with the token and the declared size', async () => {
    const fetchImpl = happyFetch()
    await run(fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(SIGN_UPLOAD_ENDPOINT)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer access-token' })
    expect(JSON.parse(String(init.body))).toEqual({
      reportId: REPORT,
      contentType: 'image/jpeg',
      contentLength: 2048,
    })
  })

  it('sends the bytes to the signed URL, not through our own server', async () => {
    const fetchImpl = happyFetch()
    await run(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe(SIGNED_URL)
    expect(init.method).toBe('PUT')
    expect(init.body).toBeInstanceOf(File)
  })

  it('sends the headers the endpoint asked for, so the signature still matches', async () => {
    const fetchImpl = happyFetch()
    await run(fetchImpl)
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    // Passed through verbatim, whatever they are. If-None-Match is what makes
    // the write conditional, so dropping it would fail the signature check.
    expect(init.headers).toEqual({ 'Content-Type': 'image/jpeg', 'If-None-Match': '*' })
  })

  it('returns the key the endpoint chose, never one of its own', async () => {
    expect(await run(happyFetch())).toBe(KEY)
  })

  it('declares the real byte length of the file it is about to send', async () => {
    const fetchImpl = happyFetch()
    await run(fetchImpl, photo('image/webp', 7_654_321))
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      contentType: 'image/webp',
      contentLength: 7_654_321,
    })
  })
})

describe('uploadPhoto: when it fails', () => {
  const failingSign = (status: number, body: string) =>
    vi.fn(async (input: unknown) =>
      String(input) === SIGN_UPLOAD_ENDPOINT
        ? new Response(body, { status })
        : new Response('', { status: 200 }),
    )

  it('passes on the wording the endpoint chose, because it was written for a person', async () => {
    const fetchImpl = failingSign(401, JSON.stringify({ message: 'Please sign in to add a photo.' }))
    await expect(run(fetchImpl)).rejects.toThrow('Please sign in to add a photo.')
  })

  it('says uploads are not set up when the endpoint says so', async () => {
    const fetchImpl = failingSign(
      503,
      JSON.stringify({ message: 'Photo upload is not set up on this site yet.' }),
    )
    await expect(run(fetchImpl)).rejects.toThrow('Photo upload is not set up on this site yet.')
  })

  it.each([404, 405])(
    'tells whoever is setting the site up which of the two it was (%i)',
    async (status) => {
      // The person sees the same sentence as for a missing environment
      // variable, which is right -- neither is theirs to fix. The operator has
      // to tell them apart, and this is the only thing that says which.
      const logged: unknown[][] = []
      const spy = vi
        .spyOn(console, 'error')
        .mockImplementation((...args: unknown[]) => void logged.push(args))
      await expect(run(failingSign(status, '<html>404</html>'))).rejects.toThrow()
      spy.mockRestore()

      expect(logged).toHaveLength(1)
      expect(String(logged[0][0])).toContain(SIGN_UPLOAD_ENDPOINT)
      expect(String(logged[0][0])).toContain(String(status))
    },
  )

  it.each([404, 405])(
    'says uploads are not set up when the endpoint is not there (%i)',
    async (status) => {
      // A deployment with no serverless function answers with an HTML error
      // page, so there is no message to read. The generic wording would tell
      // somebody to retry a route that does not exist -- the likeliest way this
      // fails the first time it is deployed.
      const fetchImpl = failingSign(status, '<html>404 Not Found</html>')
      await expect(run(fetchImpl)).rejects.toThrow('Photo upload is not set up on this site yet.')
    },
  )

  it('never sends the bytes when signing failed', async () => {
    const fetchImpl = failingSign(401, '{}')
    await expect(run(fetchImpl)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('falls back to plain wording when the failure carries none', async () => {
    const fetchImpl = failingSign(500, '<html>oh no</html>')
    await expect(run(fetchImpl)).rejects.toThrow('Your photo could not be uploaded. Please try again.')
  })

  it.each([
    'https://evil.example/steal',
    'http://acc.r2.cloudflarestorage.com/mo/key.jpg',
    'https://acc.r2.cloudflarestorage.com.evil.example/mo/key.jpg',
    'not a url',
  ])('refuses to send the photo anywhere but the object store (%s)', async (url) => {
    // The endpoint is same-origin and always builds this host itself, so a URL
    // pointing elsewhere means the endpoint is not what answered. This is the
    // only point where somebody's photo could be redirected off-site.
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input) === SIGN_UPLOAD_ENDPOINT
        ? new Response(signedBody({ url }), { status: 200 })
        : new Response('', { status: 200 }),
    )
    await expect(run(fetchImpl)).rejects.toThrow(
      'Your photo could not be uploaded. Please try again.',
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('fails rather than returning a key when the endpoint answers with nonsense', async () => {
    for (const body of ['not json', '{}', signedBody({ url: '' }), signedBody({ key: undefined })]) {
      const fetchImpl = vi.fn(async (input: unknown) =>
        String(input) === SIGN_UPLOAD_ENDPOINT
          ? new Response(body, { status: 200 })
          : new Response('', { status: 200 }),
      )
      await expect(run(fetchImpl)).rejects.toThrow(
        'Your photo could not be uploaded. Please try again.',
      )
      // The PUT must not have been attempted against a URL we do not trust.
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  })

  it('fails when the store refuses the bytes, so no key is ever stored for them', async () => {
    // This is the path a size or type mismatch takes: R2 rejects the request
    // because the signature does not cover it.
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input) === SIGN_UPLOAD_ENDPOINT
        ? new Response(signedBody(), { status: 200 })
        : new Response('<Error>SignatureDoesNotMatch</Error>', { status: 403 }),
    )
    await expect(run(fetchImpl)).rejects.toThrow(
      'Your photo could not be uploaded. Please try again.',
    )
  })

  it('lets a network failure surface rather than swallowing it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(run(fetchImpl as unknown as ReturnType<typeof happyFetch>)).rejects.toThrow(
      'offline',
    )
  })
})
