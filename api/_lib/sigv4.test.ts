// @vitest-environment node
//
// Server code, so it is tested in the runtime it resembles. It ran green under
// the suite's jsdom default -- Node's WebCrypto and fetch classes survive that
// environment -- but relying on which globals jsdom happens not to replace is
// not something to depend on. Nothing here touches a DOM.
import { describe, it, expect } from 'vitest'
import { hmacSha256Hex, presignUrl } from './sigv4'

const repeat = (byte: number, count: number) => new Uint8Array(count).fill(byte)
const ascii = (text: string) => new TextEncoder().encode(text)

/**
 * RFC 4231 vectors for HMAC-SHA-256.
 *
 * The end-to-end signature below is a single 256-bit value: when it mismatches
 * it says nothing about which layer is wrong. These pin the primitive, so a
 * broken HMAC is distinguishable from a broken canonical request.
 */
describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 1', async () => {
    expect(await hmacSha256Hex(repeat(0x0b, 20), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })

  it('matches RFC 4231 test case 2', async () => {
    expect(await hmacSha256Hex(ascii('Jefe'), 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })

  // Cases 6 and 7: a key longer than SHA-256's block size, which has to be
  // hashed before use. The signing chain starts from `AWS4` + the secret, so a
  // long secret takes exactly this path.
  it('matches RFC 4231 test case 6', async () => {
    expect(
      await hmacSha256Hex(
        repeat(0xaa, 131),
        'Test Using Larger Than Block-Size Key - Hash Key First',
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  })

  it('matches RFC 4231 test case 7', async () => {
    expect(
      await hmacSha256Hex(
        repeat(0xaa, 131),
        'This is a test using a larger than block-size key and a larger ' +
          'than block-size data. The key needs to be hashed before being ' +
          'used by the HMAC algorithm.',
      ),
    ).toBe('9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2')
  })
})

/**
 * AWS's own published presigned-URL example, from the Signature Version 4
 * documentation. Reproducing this exact signature is the only check available
 * without a live bucket, and a 256-bit match cannot happen by accident.
 */
describe('presignUrl against the AWS worked example', () => {
  const awsExample = {
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresInSeconds: 86400,
    signedAt: new Date('2013-05-24T00:00:00Z'),
  }

  it('produces the documented signature', async () => {
    const url = new URL(await presignUrl(awsExample))
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
  })

  it('carries the documented credential scope, date, expiry and signed headers', async () => {
    const url = new URL(await presignUrl(awsExample))
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  it('keeps the object path intact', async () => {
    const url = new URL(await presignUrl(awsExample))
    expect(url.origin + url.pathname).toBe('https://examplebucket.s3.amazonaws.com/test.txt')
  })
})

describe('presignUrl', () => {
  const base = {
    method: 'PUT',
    url: 'https://account.r2.cloudflarestorage.com/bucket/a/b.jpg',
    region: 'auto',
    service: 's3',
    accessKeyId: 'key-id',
    secretAccessKey: 'secret',
    expiresInSeconds: 120,
    signedAt: new Date('2026-09-15T10:20:30Z'),
  }

  const signatureOf = async (options: Parameters<typeof presignUrl>[0]) =>
    new URL(await presignUrl(options)).searchParams.get('X-Amz-Signature')

  it('is deterministic for the same inputs', async () => {
    expect(await presignUrl(base)).toBe(await presignUrl(base))
  })

  it('lists every signed header, sorted, in the query', async () => {
    const url = new URL(
      await presignUrl({
        ...base,
        signedHeaders: { 'Content-Type': 'image/jpeg', 'content-length': '1024' },
      }),
    )
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
  })

  it('changes the signature when a signed header value changes', async () => {
    // This is the whole point of signing content-length: a client that asks for
    // one size and uploads another presents a request the signature does not
    // cover, so the store rejects it.
    const declared = await signatureOf({ ...base, signedHeaders: { 'content-length': '1024' } })
    const other = await signatureOf({ ...base, signedHeaders: { 'content-length': '1025' } })
    expect(declared).not.toBe(other)
  })

  it('changes the signature when the object key changes', async () => {
    const mine = await signatureOf(base)
    const theirs = await signatureOf({
      ...base,
      url: 'https://account.r2.cloudflarestorage.com/bucket/a/c.jpg',
    })
    expect(mine).not.toBe(theirs)
  })

  it('changes the signature when the expiry changes', async () => {
    expect(await signatureOf(base)).not.toBe(
      await signatureOf({ ...base, expiresInSeconds: 121 }),
    )
  })

  it('escapes the characters encodeURIComponent leaves bare', async () => {
    // encodeURIComponent leaves !'()* alone. AWS does not, and one stray
    // bracket is enough for a signature mismatch.
    const url = await presignUrl({
      ...base,
      url: "https://account.r2.cloudflarestorage.com/bucket/it's (a) photo!*.jpg",
    })
    expect(url).toContain("/bucket/it%27s%20%28a%29%20photo%21%2A.jpg?")
  })

  it('does not double-encode a path that already arrived percent-encoded', async () => {
    const url = await presignUrl({
      ...base,
      url: 'https://account.r2.cloudflarestorage.com/bucket/one%20two.jpg',
    })
    expect(url).toContain('/bucket/one%20two.jpg?')
    expect(url).not.toContain('%2520')
  })
})
