export interface Place {
  name: string
  lat: number
  lng: number
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/** Nominatim's usage policy asks for no more than one request per second. */
export const MIN_REQUEST_INTERVAL_MS = 1000

/** Keep the suggestion list short enough to scan on a phone. */
const RESULT_LIMIT = 5

interface NominatimResult {
  display_name: string
  lat: string
  lon: string
}

const isUsable = (place: Place) => Number.isFinite(place.lat) && Number.isFinite(place.lng)

/**
 * Look up a place by name.
 *
 * Returns an empty list rather than throwing on any failure — a search box that
 * explodes is worse than one that finds nothing, and the map behind it must keep
 * working regardless.
 *
 * Nominatim's policy asks callers to identify themselves. Browsers forbid setting
 * User-Agent from fetch, but they send Referer automatically, which satisfies it.
 */
export async function searchPlaces(query: string): Promise<Place[]> {
  const trimmed = query.trim()
  if (trimmed === '') return []

  const encoded = encodeURIComponent(trimmed).replace(/%20/g, '+')
  const url = `${ENDPOINT}?q=${encoded}&format=json&limit=${RESULT_LIMIT}`

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return []
    const results = (await response.json()) as NominatimResult[]
    if (!Array.isArray(results)) return []
    return results
      .map((r) => ({ name: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }))
      .filter(isUsable)
  } catch {
    return []
  }
}

/**
 * Wrap searchPlaces so a burst of keystrokes produces one request, honouring
 * Nominatim's rate limit.
 *
 * The generation counter means a slow response for an abandoned query can never
 * overwrite the results of a newer one.
 */
export function createDebouncedSearch(delayMs: number = MIN_REQUEST_INTERVAL_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0

  return function search(query: string, onResults: (places: Place[]) => void): void {
    if (timer !== undefined) clearTimeout(timer)
    const thisGeneration = ++generation

    timer = setTimeout(() => {
      void searchPlaces(query).then((places) => {
        if (thisGeneration === generation) onResults(places)
      })
    }, delayMs)
  }
}
