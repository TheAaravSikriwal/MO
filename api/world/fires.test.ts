// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { passFiresThrough } from './fires'
import { FIRES_UPSTREAM } from '../../src/lib/worlddata/sources'
import { FIRES_ENDPOINT } from '../../src/lib/worlddata/sources'

describe('GET /api/world/fires', () => {
  it('is where the app looks for fires', () => {
    // Vercel serves api/world/fires.ts at this path.
    expect(FIRES_ENDPOINT).toBe('/api/world/fires')
  })

  it('passes NASA’s file on, cut to what the map draws, as CSV, cached at the edge', async () => {
    const nasa = [
      'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight',
      '-26.03412,-55.49231,318.5,1.1,1.0,2026-09-28,0105,T,55,6.1NRT,293.4,13.11,N',
    ].join('\n')
    const get = vi.fn(async () => new Response(nasa, { status: 200 }))
    const response = await passFiresThrough(get as unknown as typeof fetch)
    expect(get).toHaveBeenCalledWith(FIRES_UPSTREAM)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('cache-control')).toContain('s-maxage=3600')
    expect(await response.text()).toBe('latitude,longitude,frp\n-26.034,-55.492,13.1\n')
  })

  it('says so when NASA answers with something that is not its fires', async () => {
    const get = vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 }))
    expect((await passFiresThrough(get as unknown as typeof fetch)).status).toBe(502)
  })

  it('says NASA did not answer, rather than passing an error page on as fires', async () => {
    const get = vi.fn(async () => new Response('<html>busy</html>', { status: 503 }))
    expect((await passFiresThrough(get as unknown as typeof fetch)).status).toBe(502)
  })

  it('says so when NASA cannot be reached at all', async () => {
    const get = vi.fn(async () => {
      throw new Error('offline')
    })
    expect((await passFiresThrough(get as unknown as typeof fetch)).status).toBe(502)
  })
})
