// @vitest-environment node
//
// Server code, so it is tested in the runtime it resembles. It ran green under
// the suite's jsdom default -- Node's WebCrypto and fetch classes survive that
// environment -- but relying on which globals jsdom happens not to replace is
// not something to depend on. Nothing here touches a DOM.
import { describe, it, expect } from 'vitest'
import { UPLOAD_URL_TTL_SECONDS, isUuid, photoObjectKey, presignPhotoPut } from './r2'

const USER = '11111111-1111-4111-8111-111111111111'
const REPORT = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'

describe('isUuid', () => {
  it('accepts a uuid in either case', () => {
    expect(isUuid(USER)).toBe(true)
    expect(isUuid(USER.toUpperCase())).toBe(true)
  })

  it('rejects anything else', () => {
    for (const value of [
      '',
      'not-a-uuid',
      '11111111-1111-4111-8111-11111111111',
      `${USER} `,
      `${USER}/../other`,
      '../../etc/passwd',
    ]) {
      expect(isUuid(value)).toBe(false)
    }
  })
})

describe('photoObjectKey', () => {
  it('nests the photo under its owner and its report', () => {
    expect(photoObjectKey({ userId: USER, reportId: REPORT, contentType: 'image/jpeg', photoId: PHOTO }))
      .toBe(`map/${USER}/${REPORT}/${PHOTO}.jpg`)
  })

  it('takes the extension from the content type, not from any filename', () => {
    expect(
      photoObjectKey({ userId: USER, reportId: REPORT, contentType: 'image/webp', photoId: PHOTO }),
    ).toMatch(/\.webp$/)
  })

  it('refuses a report id that is not a uuid, so nothing can be smuggled into the key', () => {
    for (const reportId of ['../../secrets', 'a/b', '', 'report.jpg']) {
      expect(() =>
        photoObjectKey({ userId: USER, reportId, contentType: 'image/jpeg', photoId: PHOTO }),
      ).toThrow(/reportId must be a UUID/)
    }
  })

  it('refuses a user id or photo id that is not a uuid', () => {
    expect(() =>
      photoObjectKey({ userId: 'x', reportId: REPORT, contentType: 'image/jpeg', photoId: PHOTO }),
    ).toThrow(/userId must be a UUID/)
    expect(() =>
      photoObjectKey({ userId: USER, reportId: REPORT, contentType: 'image/jpeg', photoId: 'x' }),
    ).toThrow(/photoId must be a UUID/)
  })

  it('never produces a key with a path segment that could escape the prefix', () => {
    const key = photoObjectKey({
      userId: USER,
      reportId: REPORT,
      contentType: 'image/png',
      photoId: PHOTO,
    })
    // The `map/` prefix, the owner, the report, the photo.
    expect(key.split('/')).toHaveLength(4)
    expect(key.startsWith('map/')).toBe(true)
    expect(key).not.toContain('..')
  })
})

describe('presignPhotoPut', () => {
  const config = {
    accountId: 'acc123',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-example',
    bucket: 'mo-photos',
  }
  const request = {
    key: `${USER}/${REPORT}/${PHOTO}.jpg`,
    contentType: 'image/jpeg' as const,
    contentLength: 2048,
    signedAt: new Date('2026-09-15T10:20:30Z'),
  }

  it('points at the bucket and key on the R2 S3 endpoint', async () => {
    const url = new URL(await presignPhotoPut(config, request))
    expect(url.host).toBe('acc123.r2.cloudflarestorage.com')
    expect(url.pathname).toBe(`/mo-photos/${request.key}`)
  })

  it('signs for R2, which uses one pseudo-region', async () => {
    const url = new URL(await presignPhotoPut(config, request))
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAEXAMPLE/20260915/auto/s3/aws4_request',
    )
  })

  it('expires quickly, so a leaked URL is already dead', async () => {
    const url = new URL(await presignPhotoPut(config, request))
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_TTL_SECONDS))
    expect(UPLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(300)
  })

  it('signs the size and the type, so the URL fits one photo and no other', async () => {
    const url = new URL(await presignPhotoPut(config, request))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    )
  })

  it('signs the write as conditional, so the URL is good for one upload', async () => {
    // Without this a presigned PUT stays usable for its whole life: any write
    // of the same length and type is accepted, and the worker judges the
    // OBJECT -- so bytes could be swapped after a verdict was recorded.
    const url = new URL(await presignPhotoPut(config, request))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('if-none-match')
  })

  it('will not verify if the upload is a different size than was declared', async () => {
    const declared = new URL(await presignPhotoPut(config, request))
    const larger = new URL(
      await presignPhotoPut(config, { ...request, contentLength: 500_000_000 }),
    )
    expect(declared.searchParams.get('X-Amz-Signature')).not.toBe(
      larger.searchParams.get('X-Amz-Signature'),
    )
  })

  it('never puts the secret key in the URL', async () => {
    const url = await presignPhotoPut(config, request)
    expect(url).not.toContain(config.secretAccessKey)
    expect(url).toContain(config.accessKeyId)
  })
})
