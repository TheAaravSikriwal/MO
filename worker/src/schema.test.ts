import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MO_SCHEMA } from './schema.js'

/**
 * The worker's client has to point at the `mo` schema.
 *
 * MO shares the wearechintu project's database, and that database has a
 * `public.reports` holding abuse reports against marketplace projects. With
 * the schema unset every name the worker uses resolves against `public`:
 * `claim_moderation_jobs`, `moderation_jobs` and `report_photos` are simply
 * not there, and `.from('reports').select('note')` finds the marketplace's
 * table but not a `note` column, so PostgREST answers 400.
 *
 * So it fails loudly and then goes quiet. Nothing in the app breaks; every
 * photo and note just stays `pending` forever, which looks like nobody has
 * posted anything.
 *
 * The app and the upload endpoint both have this pinned. The worker is a
 * separate package with its own client, and it was missed the first time.
 */

const captured: Array<Record<string, unknown> | undefined> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options?: Record<string, unknown>) => {
    captured.push(options)
    return {} as unknown
  },
}))

const { Queue } = await import('./queue.js')

const config = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'service-role',
  moderationEndpoint: '',
  textModel: 'x',
  visionModel: 'y',
  thresholds: {
    nsfw: { rejectAbove: 0.85, approveBelow: 0.15 },
    toxicity: { rejectAbove: 0.8, approveBelow: 0.2 },
  },
  workerId: 'test-worker',
  batchSize: 10,
  pollIntervalMs: 15000,
  cleanupIntervalMs: 600000,
}

describe('the client the worker builds', () => {
  it('is pointed at the mo schema, not public', () => {
    captured.length = 0
    new Queue(config)

    expect(captured).toHaveLength(1)
    const db = captured[0]?.db as { schema?: string } | undefined
    expect(db?.schema).toBe(MO_SCHEMA)
  })

  it('still refuses to keep a session, which is what a service key must not do', () => {
    captured.length = 0
    new Queue(config)

    const auth = captured[0]?.auth as { persistSession?: boolean } | undefined
    expect(auth?.persistSession).toBe(false)
  })

  it('agrees with the app about the schema name', () => {
    // Actually compares the two files. Asserting `MO_SCHEMA === 'mo'` against
    // the worker's own copy could never detect app-side drift, which is the
    // failure mode schema.ts warns about — it just restated the worker's
    // constant back to itself.
    //
    // Read off disk rather than imported: `worker/` is its own package with its
    // own tsconfig and does not compile anything from `src/`. (It does compile
    // `../shared/`, the SigV4 signer the app's upload endpoint also uses.)
    // Resolved from THIS FILE, not from the working directory. Off cwd it
    // only worked when the suite was run from `worker/` — run from the repo
    // root it read a path above the repo, so the only guard against the two
    // constants drifting was one `cd` away from being unrunnable.
    const appSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'data', 'schema.ts'),
      'utf8',
    )
    const match = /export const MO_SCHEMA = '([^']+)'/.exec(appSource)
    expect(match, 'could not find MO_SCHEMA in the app').not.toBeNull()
    expect(MO_SCHEMA).toBe(match![1])
  })
})
