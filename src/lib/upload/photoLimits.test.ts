import { describe, it, expect } from 'vitest'
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  extensionForPhotoType,
  isAllowedPhotoType,
} from './photoLimits'
import { MAX_PHOTO_BYTES as gateMax, checkPhotoFile } from '../moderation/clientGate'

describe('isAllowedPhotoType', () => {
  it('accepts the three image types the form offers', () => {
    expect(ALLOWED_PHOTO_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp'])
    for (const type of ALLOWED_PHOTO_TYPES) expect(isAllowedPhotoType(type)).toBe(true)
  })

  it('rejects anything else, including things that merely look like images', () => {
    for (const type of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', '']) {
      expect(isAllowedPhotoType(type)).toBe(false)
    }
  })
})

describe('extensionForPhotoType', () => {
  it('maps each allowed type to a stored extension', () => {
    expect(extensionForPhotoType('image/jpeg')).toBe('jpg')
    expect(extensionForPhotoType('image/png')).toBe('png')
    expect(extensionForPhotoType('image/webp')).toBe('webp')
  })

  it('covers every allowed type, so adding one cannot silently store no extension', () => {
    for (const type of ALLOWED_PHOTO_TYPES) {
      expect(extensionForPhotoType(type)).toMatch(/^[a-z]+$/)
    }
  })
})

describe('one definition of the limits', () => {
  // The browser gate and the signing endpoint both enforce these, and the
  // symptom of them disagreeing is an upload the form accepted and the server
  // refused -- a bug that looks like it is in neither half.
  //
  // There is no assertion that `clientGate`'s cap equals this one, because
  // `clientGate` re-exports this binding: comparing them is comparing a value
  // to itself and cannot fail. What is worth checking is the behaviour built on
  // top of it, which is what the cases below do.
  it('applies the cap the gate exports, at the boundary and past it', () => {
    expect(checkPhotoFile({ type: 'image/jpeg', size: gateMax }).blocked).toBe(false)
    expect(checkPhotoFile({ type: 'image/jpeg', size: gateMax + 1 }).blocked).toBe(true)
  })

  it('names the cap in a message a person can act on', () => {
    // 8 MB is written out in the wording, so the number and the sentence can
    // drift apart. This is the only thing that would notice.
    const message = checkPhotoFile({ type: 'image/jpeg', size: MAX_PHOTO_BYTES + 1 }).message ?? ''
    expect(message).toContain(`${MAX_PHOTO_BYTES / 1024 / 1024} MB`)
  })

  it('agrees with the browser gate about which types pass', () => {
    for (const type of ALLOWED_PHOTO_TYPES) {
      expect(checkPhotoFile({ type, size: 1024 }).blocked).toBe(false)
    }
    expect(checkPhotoFile({ type: 'image/gif', size: 1024 }).blocked).toBe(true)
  })
})
