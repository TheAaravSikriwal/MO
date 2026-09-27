/**
 * AWS Signature Version 4, the query-string ("presigned URL") flavour.
 *
 * Hand-rolled on Web Crypto rather than taken from the AWS SDK. The SDK is
 * megabytes of dependency for one signature in a free-tier serverless
 * function, and the algorithm is small enough to pin exactly: the tests check
 * this against AWS's own published example, so an encoding mistake fails in
 * `npm test` instead of arriving from R2 as an opaque SignatureDoesNotMatch.
 *
 * Every byte that goes into the signature has to match what the server
 * recomputes from the request it actually receives, which is why the encoding
 * helpers below are fussier than they look.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'

/** Presigned requests sign this literal instead of a body hash. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

const encoder = new TextEncoder()

function toHex(bytes: Bytes): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return toHex(new Uint8Array(digest))
}

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: the bare form is
// backed by `ArrayBufferLike`, which the signing-key loop below cannot
// reassign into its own variable.
type Bytes = Uint8Array<ArrayBuffer>

async function hmacSha256(key: Bytes, data: string): Promise<Bytes> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  return new Uint8Array(signature)
}

/**
 * Exported only so the tests can pin the primitive against the RFC 4231
 * vectors. If HMAC itself is wrong, every layer above it is wrong in a way
 * that is very hard to read off a failing end-to-end assertion.
 */
export async function hmacSha256Hex(key: Bytes, data: string): Promise<string> {
  return toHex(await hmacSha256(key, data))
}

/**
 * Percent-encode for RFC 3986, which is stricter than `encodeURIComponent`.
 *
 * `encodeURIComponent` leaves `!'()*` alone; AWS expects them escaped, and
 * leaves only `A-Z a-z 0-9 - _ . ~` bare. A single unescaped `(` in a key is
 * enough to make the signature mismatch.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * Encode a path, keeping the separators.
 *
 * Each segment is decoded first, because a path taken off a `URL` object is
 * already partly percent-encoded and encoding it again would turn `%20` into
 * `%2520`. S3 does not double-encode the path, unlike most other AWS services.
 */
function encodePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')
}

/** `20130524T000000Z` and `20130524`, both in UTC. */
function formatSigningDate(at: Date): { amzDate: string; dateStamp: string } {
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export interface PresignOptions {
  method: string
  /** Full URL of the object, including scheme and host. */
  url: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  /** How long the URL stays usable. Short is the point — see UPLOAD_URL_TTL_SECONDS. */
  expiresInSeconds: number
  /**
   * Headers the caller commits to sending, beyond `host`.
   *
   * Anything listed here becomes part of the signature, so the request is
   * rejected unless the header arrives with exactly this value. That is what
   * turns a declared size into an enforced one.
   */
  signedHeaders?: Record<string, string>
  /** Injected rather than read from the clock, so the tests are deterministic. */
  signedAt: Date
}

export async function presignUrl(options: PresignOptions): Promise<string> {
  const url = new URL(options.url)
  const { amzDate, dateStamp } = formatSigningDate(options.signedAt)
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`

  // `host` is always signed; a presigned URL that could be replayed against a
  // different host would be a different object.
  const headers = new Map<string, string>([['host', url.host]])
  for (const [name, value] of Object.entries(options.signedHeaders ?? {})) {
    headers.set(name.toLowerCase().trim(), value.trim().replace(/\s+/g, ' '))
  }
  const headerNames = [...headers.keys()].sort()
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers.get(name)}\n`).join('')
  const signedHeaderList = headerNames.join(';')

  const query = new Map<string, string>()
  for (const [name, value] of url.searchParams) query.set(name, value)
  query.set('X-Amz-Algorithm', ALGORITHM)
  query.set('X-Amz-Credential', `${options.accessKeyId}/${scope}`)
  query.set('X-Amz-Date', amzDate)
  query.set('X-Amz-Expires', String(options.expiresInSeconds))
  query.set('X-Amz-SignedHeaders', signedHeaderList)

  // Sorted by encoded name, then encoded value — byte order, not locale order,
  // which is why this compares strings by hand rather than calling sort().
  const canonicalQuery = [...query.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? compareBytes(a[1], b[1]) : compareBytes(a[0], b[0])))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

  const canonicalPath = encodePath(url.pathname)
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n')

  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')

  let key = encoder.encode(`AWS4${options.secretAccessKey}`)
  for (const part of [dateStamp, options.region, options.service, 'aws4_request']) {
    key = await hmacSha256(key, part)
  }
  const signature = toHex(await hmacSha256(key, stringToSign))

  return `${url.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
