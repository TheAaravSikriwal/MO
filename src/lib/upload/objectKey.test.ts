import { describe, it, expect } from 'vitest'
import { PHOTO_KEY_PREFIX, photoObjectKey } from './objectKey'

const USER = '11111111-1111-4111-8111-111111111111'
const REPORT = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'

describe('photoObjectKey', () => {
  it('puts every photo under the map’s own prefix in the shared bucket', () => {
    expect(PHOTO_KEY_PREFIX).toBe('map/')
    expect(photoObjectKey({ userId: USER, reportId: REPORT, contentType: 'image/jpeg', photoId: PHOTO })).toBe(
      `map/${USER}/${REPORT}/${PHOTO}.jpg`,
    )
  })

  it('refuses an uppercase id, which the database would refuse after signing', () => {
    // Letters in it, so upper-casing actually changes something.
    const lettered = 'abcdef12-3456-4abc-8def-abcdefabcdef'
    expect(() =>
      photoObjectKey({ userId: lettered.toUpperCase(), reportId: REPORT, contentType: 'image/jpeg', photoId: PHOTO }),
    ).toThrow(/lowercase/)
    expect(photoObjectKey({ userId: lettered, reportId: REPORT, contentType: 'image/jpeg', photoId: PHOTO })).toBe(
      `map/${lettered}/${REPORT}/${PHOTO}.jpg`,
    )
  })
})
