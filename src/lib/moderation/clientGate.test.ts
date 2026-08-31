import { describe, it, expect } from 'vitest'
import {
  checkText,
  checkPhotoFile,
  judgeNsfwScores,
  MAX_PHOTO_BYTES,
  NSFW_BLOCK_THRESHOLD,
} from './clientGate'

describe('checkText', () => {
  it('passes ordinary report text silently', () => {
    expect(checkText('Bags of rubbish by the bus stop')).toEqual({ blocked: false })
  })

  it('passes empty text', () => {
    expect(checkText('')).toEqual({ blocked: false })
    expect(checkText('   ')).toEqual({ blocked: false })
  })

  it('warns about profanity but does not block it', () => {
    const result = checkText('this is fucking disgusting')
    expect(result.blocked).toBe(false)
    expect(result.message).toBeTruthy()
  })

  it('does not block a real place name that trips the wordlist', () => {
    // "Penistone Road" matches on `penis`. Refusing to let someone describe a
    // real street would be worse than letting the server judge it.
    expect(checkText('Litter near Penistone Road').blocked).toBe(false)
  })

  it('never accuses the person in its wording', () => {
    const message = checkText('this is fucking disgusting').message ?? ''
    for (const word in { you: 1, your: 1, offensive: 1, banned: 1 }) {
      expect(message.toLowerCase()).not.toContain(word)
    }
  })
})

describe('checkPhotoFile', () => {
  it('accepts ordinary photo formats', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(checkPhotoFile({ type, size: 1024 })).toEqual({ blocked: false })
    }
  })

  it('blocks a file that is not a photo', () => {
    const result = checkPhotoFile({ type: 'application/pdf', size: 1024 })
    expect(result.blocked).toBe(true)
    expect(result.message).toContain('JPEG')
  })

  it('blocks an oversized photo', () => {
    const result = checkPhotoFile({ type: 'image/jpeg', size: MAX_PHOTO_BYTES + 1 })
    expect(result.blocked).toBe(true)
    expect(result.message).toContain('8 MB')
  })

  it('accepts a photo exactly at the limit', () => {
    expect(checkPhotoFile({ type: 'image/jpeg', size: MAX_PHOTO_BYTES }).blocked).toBe(false)
  })

  it('blocks an empty file', () => {
    expect(checkPhotoFile({ type: 'image/jpeg', size: 0 }).blocked).toBe(true)
  })

  it('uses plain language a non-technical person can act on', () => {
    const message = checkPhotoFile({ type: 'application/pdf', size: 10 }).message ?? ''
    expect(message.toLowerCase()).not.toContain('mime')
    expect(message.toLowerCase()).not.toContain('invalid')
    expect(message).toContain('Please choose')
  })
})

describe('judgeNsfwScores', () => {
  it('allows an ordinary photo of rubbish', () => {
    expect(judgeNsfwScores({ porn: 0.001, hentai: 0.0, sexy: 0.02, neutral: 0.97 })).toEqual({
      blocked: false,
    })
  })

  it('blocks explicit content', () => {
    expect(judgeNsfwScores({ porn: 0.99, hentai: 0.0, sexy: 0.4 }).blocked).toBe(true)
    expect(judgeNsfwScores({ porn: 0.0, hentai: 0.95, sexy: 0.1 }).blocked).toBe(true)
  })

  it('does not block on the "sexy" class alone', () => {
    // A person in shorts picking up litter is not a violation. Blocking on this
    // class would reject ordinary photos of people cleaning up.
    expect(judgeNsfwScores({ porn: 0.01, hentai: 0.0, sexy: 0.95 }).blocked).toBe(false)
  })

  it('treats the threshold itself as allowed, not blocked', () => {
    expect(judgeNsfwScores({ porn: NSFW_BLOCK_THRESHOLD, hentai: 0, sexy: 0 }).blocked).toBe(false)
  })

  it('FAILS OPEN when the model is unavailable', () => {
    // Tier 1 is a convenience filter, not the authority. Blocking every upload
    // because a model file failed to load would break the app; the server tiers
    // are what actually protect the map.
    expect(judgeNsfwScores(null)).toEqual({ blocked: false })
  })

  it('tolerates a scores object missing keys', () => {
    expect(judgeNsfwScores({ sexy: 0.1 } as never).blocked).toBe(false)
  })

  it('describes the photo, never the person who sent it', () => {
    const message = judgeNsfwScores({ porn: 0.99, hentai: 0, sexy: 0 }).message ?? ''
    expect(message).toContain('This photo')
    expect(message.toLowerCase()).not.toContain('you ')
  })
})
