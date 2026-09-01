import { describe, it, expect, vi } from 'vitest'
import { getCurrentPosition } from './nearMe'

const geolocation = (
  behaviour:
    | { ok: true; lat: number; lng: number }
    | { ok: false; code: number },
): Geolocation =>
  ({
    getCurrentPosition: (success: PositionCallback, failure?: PositionErrorCallback) => {
      if (behaviour.ok) {
        success({
          coords: { latitude: behaviour.lat, longitude: behaviour.lng },
        } as GeolocationPosition)
      } else {
        failure?.({ code: behaviour.code } as GeolocationPositionError)
      }
    },
  }) as Geolocation

describe('getCurrentPosition', () => {
  it('returns the point when the browser shares it', async () => {
    const result = await getCurrentPosition(geolocation({ ok: true, lat: 51.5, lng: -0.12 }))
    expect(result).toEqual({ ok: true, point: { lat: 51.5, lng: -0.12 } })
  })

  it('treats a refusal as a choice, not an error to scold about', async () => {
    const result = await getCurrentPosition(geolocation({ ok: false, code: 1 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/not shared your location/i)
    for (const scolding of ['denied', 'error', 'failed', 'must']) {
      expect(result.message.toLowerCase()).not.toContain(scolding)
    }
  })

  it('explains an unavailable position plainly', async () => {
    const result = await getCurrentPosition(geolocation({ ok: false, code: 2 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/not available/i)
  })

  it('explains a timeout plainly', async () => {
    const result = await getCurrentPosition(geolocation({ ok: false, code: 3 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/too long/i)
  })

  it('copes with a device that cannot share a location at all', async () => {
    const result = await getCurrentPosition(undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/cannot share its location/i)
  })

  it('never rejects, so a refusal cannot crash the caller', async () => {
    const exploding = {
      getCurrentPosition: (_s: PositionCallback, failure?: PositionErrorCallback) =>
        failure?.({ code: 99 } as GeolocationPositionError),
    } as Geolocation
    await expect(getCurrentPosition(exploding)).resolves.toMatchObject({ ok: false })
  })

  it('never leaks a numeric error code into the message', async () => {
    for (const code of [1, 2, 3, 99]) {
      const result = await getCurrentPosition(geolocation({ ok: false, code }))
      if (!result.ok) expect(result.message).not.toMatch(/\d/)
    }
  })

  it('asks for a fresh, accurate fix rather than a stale one', () => {
    // Deliberately not awaited: this stand-in never calls back, which is the
    // point -- the options are passed synchronously when the request is made.
    const spy = vi.fn()
    void getCurrentPosition({ getCurrentPosition: spy } as unknown as Geolocation)

    expect(spy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, timeout: expect.any(Number) }),
    )
  })
})
