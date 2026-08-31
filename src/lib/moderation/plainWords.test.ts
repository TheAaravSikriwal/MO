import { describe, it, expect } from 'vitest'
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
