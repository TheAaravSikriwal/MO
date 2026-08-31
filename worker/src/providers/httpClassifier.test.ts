import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normaliseScores,
  createHttpTextClassifier,
  createHttpImageClassifier,
} from './httpClassifier.js'

const ok = (payload: unknown) => ({ ok: true, json: async () => payload })

describe('normaliseScores', () => {
  it('reads a flat score map', () => {
    expect(normaliseScores({ toxicity: 0.9, insult: 0.2 })).toEqual({
      toxicity: 0.9,
      insult: 0.2,
    })
  })

  it('unwraps a scores envelope', () => {
    expect(normaliseScores({ scores: { nsfw: 0.4 } })).toEqual({ nsfw: 0.4 })
  })

  it('drops values outside 0..1 rather than trusting them', () => {
    expect(normaliseScores({ a: 1.5, b: -0.2, c: 0.5 })).toEqual({ c: 0.5 })
  })

  it('drops non-numeric values, so a string cannot pose as a score', () => {
    expect(normaliseScores({ a: 'safe', b: null, c: 0.3 })).toEqual({ c: 0.3 })
  })

  it('drops NaN and Infinity', () => {
    expect(normaliseScores({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toEqual({})
  })

  it('returns nothing for junk, so the caller fails closed', () => {
    expect(normaliseScores(null)).toEqual({})
    expect(normaliseScores('nope')).toEqual({})
    expect(normaliseScores(undefined)).toEqual({})
    expect(normaliseScores(42)).toEqual({})
  })

  it('accepts the exact bounds', () => {
    expect(normaliseScores({ a: 0, b: 1 })).toEqual({ a: 0, b: 1 })
  })
})

describe('http classifiers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the text and returns its scores', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ toxicity: 0.7 })))
    const classifier = createHttpTextClassifier('http://localhost:8001/toxicity')

    expect(await classifier.score('some text')).toEqual({ toxicity: 0.7 })
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({
      text: 'some text',
    })
  })

  it('posts the image url and returns its scores', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ nsfw: 0.1 })))
    const classifier = createHttpImageClassifier('http://localhost:8002/nsfw')

    expect(await classifier.score('https://img/a.jpg')).toEqual({ nsfw: 0.1 })
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({
      url: 'https://img/a.jpg',
    })
  })

  it('names itself by endpoint, so the audit trail says which classifier ruled', () => {
    expect(createHttpTextClassifier('http://x/y').name).toContain('http://x/y')
    expect(createHttpImageClassifier('http://x/z').name).toContain('http://x/z')
  })

  it('throws on an error status, so the pipeline escalates instead of approving', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(createHttpTextClassifier('http://x/y').score('t')).rejects.toThrow('500')
  })

  it('throws when the classifier is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(createHttpImageClassifier('http://x/y').score('u')).rejects.toThrow(
      'ECONNREFUSED',
    )
  })

  it('never returns a usable score on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('garbage')))
    expect(await createHttpImageClassifier('http://x/y').score('u')).toEqual({})
  })
})
