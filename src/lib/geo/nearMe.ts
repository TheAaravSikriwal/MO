import type { Point } from './distance'

export type NearMeResult =
  | { ok: true; point: Point }
  | { ok: false; message: string }

/**
 * Ask the browser where you are.
 *
 * Every failure comes back as a plain sentence rather than an exception or a
 * numeric error code. Refusing permission is the most common outcome by far and
 * is not an error at all — it is a choice, so the wording does not scold.
 */
export function getCurrentPosition(
  geolocation: Geolocation | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.geolocation,
): Promise<NearMeResult> {
  if (!geolocation) {
    return Promise.resolve({
      ok: false,
      message: 'This device cannot share its location.',
    })
  }

  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          point: { lat: position.coords.latitude, lng: position.coords.longitude },
        }),
      (error) => {
        resolve({ ok: false, message: messageFor(error) })
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    )
  })
}

function messageFor(error: GeolocationPositionError | undefined): string {
  switch (error?.code) {
    case 1: // PERMISSION_DENIED
      return 'You have not shared your location, so the map is not centred on you.'
    case 2: // POSITION_UNAVAILABLE
      return 'Your location is not available right now.'
    case 3: // TIMEOUT
      return 'Finding your location took too long.'
    default:
      return 'Could not find your location.'
  }
}
