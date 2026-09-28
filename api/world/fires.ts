import { FIRES_UPSTREAM } from '../../src/lib/worlddata/sources'
import { slimFires } from '../../src/lib/worlddata/csv'

/**
 * GET /api/world/fires -- NASA's open file of fires seen in the last 24 hours,
 * for the "Fires today" layer.
 *
 * NASA publishes it freely but does not let a browser fetch it from another
 * site, so this passes it through. In development the Vite dev server does the
 * same (vite.config.ts); this is the one that runs once deployed. wearechintu
 * has its own route for it, src/app/api/map/fires, so this file is not synced.
 *
 * Cached for an hour at the edge: the file changes a few times a day, and one
 * fetch from NASA can serve everyone in that time.
 */
export const config = { runtime: 'edge' }

export async function passFiresThrough(get: typeof fetch = globalThis.fetch): Promise<Response> {
  try {
    const upstream = await get(FIRES_UPSTREAM)
    if (!upstream.ok) return new Response('NASA did not answer', { status: 502 })
    // Only what the map draws, about a fifth of the size (see slimFires).
    const slim = slimFires(await upstream.text())
    if (!slim) return new Response('NASA’s file could not be read', { status: 502 })
    return new Response(slim, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'public, max-age=900, s-maxage=3600',
      },
    })
  } catch {
    return new Response('NASA could not be reached', { status: 502 })
  }
}

export default function handler(): Promise<Response> {
  return passFiresThrough()
}
