import { describe, it, expect } from 'vitest'
import { MAX_PHOTOS, MAX_PHOTO_BYTES } from '../upload/photoLimits'
import {
  plainReason,
  plainError,
  summariseScores,
  DEFAULT_REASON,
  DEFAULT_ERROR,
} from './plainWords'

/** Words that must never reach a person, wherever the string came from. */
const JARGON = [
  'tier',
  'nsfw',
  'escalate',
  'verdict',
  'moderation',
  'classifier',
  'judge',
  'rpc',
  'null',
  'jwt',
  'econnrefused',
]

const hasNoJargon = (text: string) => {
  for (const word of JARGON) {
    expect(text.toLowerCase()).not.toContain(word)
  }
}

describe('plainReason', () => {
  it('replaces the exact strings the worker produces', () => {
    // These are copied verbatim from worker/src/pipeline.ts.
    const fromWorker = [
      'no judge configured and tier 2 could not decide',
      'judge was unreachable',
      'the content this job referred to no longer exists',
      'text classifier scored 0.42',
      'image classifier scored 0.61',
    ]
    for (const reason of fromWorker) {
      const plain = plainReason(reason)
      expect(plain).not.toBe(reason)
      hasNoJargon(plain)
    }
  })

  it('never passes through raw model prose', () => {
    // Tier 3's reason is whatever a language model wrote, so it cannot be
    // trusted to be either plain or safe.
    const modelProse =
      'The image appears to depict a NSFW scene; tier escalation recommended per policy 4.2'
    hasNoJargon(plainReason(modelProse))
  })

  it('falls back to a plain sentence for anything unrecognised', () => {
    expect(plainReason('kernel panic 0x8004')).toBe(DEFAULT_REASON)
    expect(plainReason('')).toBe(DEFAULT_REASON)
    expect(plainReason(null)).toBe(DEFAULT_REASON)
    expect(plainReason(undefined)).toBe(DEFAULT_REASON)
  })

  it('always returns a readable sentence', () => {
    for (const input of ['', 'anything at all', 'judge was unreachable']) {
      const plain = plainReason(input)
      expect(plain.length).toBeGreaterThan(10)
      expect(plain.endsWith('.')).toBe(true)
      hasNoJargon(plain)
    }
  })
})

describe('plainError', () => {
  it('replaces database and permission errors', () => {
    const fromServer = [
      'only an admin may read the moderation queue',
      'permission denied for function admin_moderation_queue',
      'this item has already been decided',
      'no such moderation job: abc-123',
      'TypeError: Failed to fetch',
    ]
    for (const message of fromServer) {
      hasNoJargon(plainError(message))
    }
  })

  it('says something useful about a permission problem', () => {
    expect(plainError('only an admin may read the moderation queue')).toMatch(/permission/i)
  })

  it('says so when someone else got there first', () => {
    expect(plainError('this item has already been decided')).toMatch(/already/i)
  })

  it('falls back for anything unrecognised', () => {
    expect(plainError('ERR_8004: segmentation fault')).toBe(DEFAULT_ERROR)
    expect(plainError(null)).toBe(DEFAULT_ERROR)
  })
})

describe('summariseScores', () => {
  it('turns known scores into readable labels and percentages', () => {
    expect(summariseScores({ nsfw: 0.42 })).toEqual([{ label: 'Adult content', value: '42%' }])
  })

  it('reads scores nested inside the worker’s shape', () => {
    const fromWorker = { imageScores: { nsfw: 0.9 }, textScores: { insult: 0.1 } }
    const summary = summariseScores(fromWorker)
    expect(summary).toContainEqual({ label: 'Adult content', value: '90%' })
    expect(summary).toContainEqual({ label: 'Insulting', value: '10%' })
  })

  it('drops keys it has no plain label for, rather than showing them raw', () => {
    expect(summariseScores({ some_internal_metric: 0.5 })).toEqual([])
  })

  it('never emits jargon in a label', () => {
    const summary = summariseScores({
      nsfw: 0.5,
      toxicity: 0.5,
      identity_hate: 0.5,
      some_internal_metric: 0.5,
    })
    for (const score of summary) hasNoJargon(score.label)
  })

  it('ignores values that are not scores', () => {
    expect(summariseScores({ nsfw: 1.5, toxicity: -1, insult: 'high' })).toEqual([])
  })

  it('does not repeat a label when several keys map to it', () => {
    const summary = summariseScores({ porn: 0.8, hentai: 0.7, nsfw: 0.9 })
    expect(summary.filter((s) => s.label === 'Adult content')).toHaveLength(1)
  })

  it('handles an empty or junk input', () => {
    expect(summariseScores({})).toEqual([])
    expect(summariseScores({ wordlist: { matched: false, terms: [] } })).toEqual([])
  })
})

describe('plainError — actionable causes stay distinct', () => {
  /** Verbatim from the migrations and the data sources. */
  const cases: Array<[string, RegExp]> = [
    ['too many reports in the last hour; please slow down', /wait a while/i],
    ['too many comments in the last minute; please slow down', /wait a moment/i],
    ['a report may have at most 3 photos', /at most 3 photos/i],
    ['Please sign in to add a report.', /sign in/i],
    ['a report needs at least one photo', /add a photo/i],
    ['Photo upload is not set up on this site yet.', /not set up yet/i],
    ['Please choose a JPEG, PNG or WebP photo.', /jpeg, png or webp/i],
    ['That photo is too large. Please choose one under 8 MB.', /under 8 MB/i],
    ['That file seems to be empty. Please choose another photo.', /empty/i],
    ['Your photo could not be uploaded. Please try again.', /photo could not be uploaded/i],
    ['That report could not be found.', /report could not be found/i],
    // Verbatim from PostgREST when `mo` is not an exposed schema. The single
    // likeliest first-deploy failure, reachable from every screen.
    [
      'The schema must be one of the following: public, graphql_public',
      /not set up yet/i,
    ],
    // Verbatim from Postgres, which is what the real backend sends. These used
    // to fall through to "something went wrong, please try again" for actions
    // that can never succeed.
    [
      'duplicate key value violates unique constraint "flags_subject_type_subject_id_flagger_id_key"',
      /already reported this/i,
    ],
    ['duplicate key value violates unique constraint "votes_pkey"', /already confirmed/i],
    [
      'new row violates row-level security policy for table "votes"',
      /cannot confirm this one/i,
    ],
    [
      'duplicate key value violates unique constraint "upload_grants_storage_path_key"',
      /already done that/i,
    ],
    ['that photo could not be added; please choose it again', /choose it again/i],
    [
      'You have added several photos recently. Please wait a while before adding more.',
      /several photos recently/i,
    ],
    ['too many photo uploads in the last hour; please slow down', /several photos recently/i],
    ['Something went wrong preparing the upload.', /photo could not be uploaded/i],
    ['you have already reported this', /already reported/i],
    ['you cannot confirm your own report', /own report/i],
    ['report not found, already cleaned, or not yet approved', /already been marked cleaned/i],
  ]

  it.each(cases)('explains %s specifically', (raw, expected) => {
    // Collapsing these into the generic fallback told someone to "try again"
    // when retrying is the one thing guaranteed to keep failing.
    const plain = plainError(raw)
    expect(plain).toMatch(expected)
    expect(plain).not.toBe(DEFAULT_ERROR)
  })

  it('still hides the machine wording behind every one of them', () => {
    for (const [raw] of cases) {
      const plain = plainError(raw).toLowerCase()
      for (const word in { constraint: 1, postgres: 1, rls: 1, trigger: 1, rpc: 1 }) {
        expect(plain).not.toContain(word)
      }
    }
  })

  it('names the caps from the constants, not from a number typed in here', () => {
    // These sentences REPLACE whatever the server said, so a literal here
    // silently overrides the endpoint's own derived wording. Raising the cap
    // had the server refuse at 12 MB while the person read "under 8 MB".
    expect(plainError('that photo is too large')).toContain(
      `under ${MAX_PHOTO_BYTES / 1024 / 1024} MB`,
    )
    expect(plainError('a report may have at most 3 photos')).toContain(
      `at most ${MAX_PHOTOS} photos`,
    )
  })

  it('still recognises the wording whatever the numbers become', () => {
    // The patterns match a digit, not an 8 and a 3, so the database's own
    // message still routes here after either cap moves.
    expect(plainError('please choose one under 12 MB')).not.toBe(DEFAULT_ERROR)
    expect(plainError('a report may have at most 4 photos')).not.toBe(DEFAULT_ERROR)
  })

  it('still falls back for anything genuinely unrecognised', () => {
    expect(plainError('ERR_8004: segmentation fault')).toBe(DEFAULT_ERROR)
  })
})
