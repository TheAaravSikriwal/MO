import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { latLngToCell } from 'h3-js'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useWorldData, loadWorldLayer, forgetWorldData, FIRES_KEPT_MS, WORLD_RECHECK_MS } from './useWorldData'
import { AIR_POLLUTION_CSV, COUNTRIES_URL, FIRES_ENDPOINT, SAVED_COPIES, SAVED_ON } from './sources'
import { savedDay } from './worldData'

const COUNTRIES = JSON.stringify({
  type: 'FeatureCollection',
  features: ['IND', 'ISL'].map((iso) => ({
    type: 'Feature',
    properties: { iso, name: iso },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  })),
})
const AIR = ['entity,code,year,population_weighted_pm25', 'India,IND,2024,83.2', 'Iceland,ISL,2024,5.2'].join('\n')
const FIRES = ['latitude,longitude,frp', '-10,-60,5', '-10.01,-60.01,5', '40,20,1'].join('\n')

const files = (overrides: Record<string, string | Error> = {}) =>
  vi.fn(async (url: string) => {
    const table: Record<string, string | Error> = { [AIR_POLLUTION_CSV]: AIR, [COUNTRIES_URL]: COUNTRIES, [FIRES_ENDPOINT]: FIRES, ...overrides }
    const found = table[url]
    if (found instanceof Error) throw found
    if (found === undefined) throw new Error(`unexpected ${url}`)
    return found
  })

beforeEach(() => forgetWorldData())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useWorldData', () => {
  it('is off until a layer is chosen, and fetches nothing', () => {
    const get = files()
    const { result } = renderHook(() => useWorldData(null, 2, get))
    expect(result.current).toEqual({ status: 'off' })
    expect(get).not.toHaveBeenCalled()
  })

  it('loads air pollution onto the countries, with the figures for the legend', async () => {
    const get = files()
    const { result } = renderHook(() => useWorldData('air', 2, get))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.overlay.features.features).toHaveLength(2)
    expect(result.current.legend).toEqual({ range: { low: 5.2, middle: 83.2, high: 83.2 }, count: 2, year: 2024, savedOn: null })
    // The unit goes with each country, for the words shown on hover.
    expect(result.current.overlay.features.features[0].properties?.unit).toBe('micrograms per cubic metre')
  })

  it('loads fires as areas, counting every fire', async () => {
    const { result } = renderHook(() => useWorldData('fires', 2, files()))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.legend.count).toBe(3)
    expect(result.current.overlay.features.features).toHaveLength(2)
  })

  it('groups fires into the same hexagons as the litter, and again when that size changes', async () => {
    const cellsAt = (res: number) => new Set([[-10, -60], [-10.01, -60.01], [40, 20]].map(([lat, lng]) => latLngToCell(lat, lng, res))).size
    // The two close fires share an area at size 2 and not at size 7.
    expect(cellsAt(2)).toBe(2)
    expect(cellsAt(7)).toBe(3)
    const { result, rerender } = renderHook(({ res }) => useWorldData('fires', res, files()), { initialProps: { res: 2 } })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.overlay.features.features).toHaveLength(2)
    rerender({ res: 7 })
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.overlay.features.features).toHaveLength(3)
    expect(result.current.legend.count).toBe(3)
  })

  it('draws the saved copy when the live file cannot be reached, and says it is one', async () => {
    const get = files({ [AIR_POLLUTION_CSV]: new Error('offline'), [SAVED_COPIES.air]: AIR })
    const { result } = renderHook(() => useWorldData('air', 2, get))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.overlay.features.features).toHaveLength(2)
    expect(result.current.legend.savedOn).toBe(SAVED_ON)
  })

  it('draws saved fires too, still on the litter’s hexagons', async () => {
    const get = files({ [FIRES_ENDPOINT]: new Error('502'), [SAVED_COPIES.fires]: FIRES })
    const { result } = renderHook(() => useWorldData('fires', 7, get))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.overlay.features.features).toHaveLength(3)
    expect(result.current.legend.savedOn).toBe(SAVED_ON)
    // And the words on hover name the saved day, not today.
    for (const f of result.current.overlay.features.features) {
      expect(f.properties?.when).toBe(`in the 24 hours to ${savedDay(SAVED_ON)}`)
    }
  })

  it('treats a live file it cannot read as not reached', async () => {
    const get = files({ [AIR_POLLUTION_CSV]: '<html>busy</html>', [SAVED_COPIES.air]: AIR })
    const { result } = renderHook(() => useWorldData('air', 2, get))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.legend.savedOn).toBe(SAVED_ON)
  })

  it('says nothing about a saved copy when the live file came', async () => {
    const { result } = renderHook(() => useWorldData('air', 2, files({ [SAVED_COPIES.air]: AIR })))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('not ready')
    expect(result.current.legend.savedOn).toBeNull()
  })

  describe('while a layer stays on', () => {
    // The hook's own hourly timer is caught and run by hand, and the clock
    // moved on. Faking every timer would stall waitFor, which polls with one.
    let hourly: (() => void) | null = null
    const fakeClock = () => {
      hourly = null
      const real = window.setInterval.bind(window)
      vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
        if (ms === WORLD_RECHECK_MS) {
          hourly = fn
          return 0
        }
        return real(fn, ms)
      }) as typeof window.setInterval)
    }
    const anHourLater = () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + WORLD_RECHECK_MS)
      expect(hourly).not.toBeNull()
      act(() => hourly!())
    }

    it('fetches fires again once they are an hour old, without blanking the globe meanwhile', async () => {
      fakeClock()
      const get = files()
      const { result } = renderHook(() => useWorldData('fires', 2, get))
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(get).toHaveBeenCalledTimes(1)
      anHourLater()
      // The old fires stay up while the new file comes.
      expect(result.current.status).toBe('ready')
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
      expect(get).toHaveBeenLastCalledWith(FIRES_ENDPOINT)
    })

    it('tries the live file again an hour after falling back to the saved copy', async () => {
      fakeClock()
      let online = false
      const get = vi.fn(async (url: string) => {
        if (url === AIR_POLLUTION_CSV && !online) throw new Error('offline')
        return files({ [SAVED_COPIES.air]: AIR })(url)
      })
      const { result } = renderHook(() => useWorldData('air', 2, get))
      await waitFor(() => expect(result.current.status === 'ready' && result.current.legend.savedOn).toBe(SAVED_ON))
      online = true
      anHourLater()
      await waitFor(() => expect(result.current.status === 'ready' && result.current.legend.savedOn).toBeNull())
    })

    it('keeps a live country layer, asking nothing more of the source', async () => {
      fakeClock()
      const get = files()
      const { result } = renderHook(() => useWorldData('air', 2, get))
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const calls = get.mock.calls.length
      anHourLater()
      await Promise.resolve()
      expect(get.mock.calls.length).toBe(calls)
    })
  })

  it('asks again at once from "Try again" after a failure', async () => {
    let online = false
    const get = vi.fn(async (url: string) => {
      if (!online) throw new Error('offline')
      return files()(url)
    })
    const { result } = renderHook(() => useWorldData('air', 2, get))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    online = true
    if (result.current.status !== 'failed') throw new Error('not failed')
    act(() => (result.current as { retry: () => void }).retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('stops waiting on a source that never answers, and says so', async () => {
    // The timeout, already run out.
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      init?.signal?.aborted ? Promise.reject(new DOMException('timed out', 'TimeoutError')) : new Promise<Response>(() => {}),
    ))
    const { result } = renderHook(() => useWorldData('air', 2))
    await waitFor(() => expect(result.current.status).toBe('failed'))
  })

  it('says plainly when a source cannot be reached, rather than drawing a clean world', async () => {
    const { result } = renderHook(() => useWorldData('fires', 2, files({ [FIRES_ENDPOINT]: new Error('502') })))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    if (result.current.status !== 'failed') throw new Error('not failed')
    expect(result.current.message).toBe('Could not load today’s fires right now. Please try again.')
  })

  it('fetches a layer once, and tries again after a failure', async () => {
    const get = files()
    await loadWorldLayer('air', get)
    await loadWorldLayer('air', get)
    expect(get).toHaveBeenCalledTimes(2) // the figures and the countries, once each

    const failing = files({ [FIRES_ENDPOINT]: new Error('502') })
    await expect(loadWorldLayer('fires', failing)).rejects.toThrow()
    await expect(loadWorldLayer('fires', files())).resolves.toBeDefined()
  })
})

describe('loadWorldLayer — keeping fires fresh', () => {
  it('fetches fires again once they are an hour old, and keeps the other layers', async () => {
    const get = files()
    const start = 1_000_000
    await loadWorldLayer('fires', get, start)
    await loadWorldLayer('fires', get, start + FIRES_KEPT_MS - 1)
    expect(get.mock.calls.filter(([url]) => url === FIRES_ENDPOINT)).toHaveLength(1)
    await loadWorldLayer('fires', get, start + FIRES_KEPT_MS + 1)
    expect(get.mock.calls.filter(([url]) => url === FIRES_ENDPOINT)).toHaveLength(2)

    await loadWorldLayer('air', get, start)
    await loadWorldLayer('air', get, start + 10 * FIRES_KEPT_MS)
    expect(get.mock.calls.filter(([url]) => url === AIR_POLLUTION_CSV)).toHaveLength(1)
  })
})

describe('useWorldData — a file it cannot read', () => {
  it('says it could not load, rather than loading for ever over an empty globe', async () => {
    const { result } = renderHook(() =>
      useWorldData('air', 2, files({ [AIR_POLLUTION_CSV]: 'entity,code,year,pm25,pm10\nIndia,IND,2024,83,90' })),
    )
    await waitFor(() => expect(result.current.status).toBe('failed'))
  })
})

describe('useWorldData — changing layer', () => {
  beforeEach(() => forgetWorldData())

  it('never shows one layer’s figures under another’s name, not even for a frame', async () => {
    const get = files()
    const seen: Array<{ asked: string | null; status: string; layer?: string }> = []
    const { result, rerender } = renderHook(({ layer }) => {
      const state = useWorldData(layer, 2, get)
      seen.push({ asked: layer, status: state.status, layer: 'layer' in state ? state.layer : undefined })
      return state
    }, { initialProps: { layer: 'air' as 'air' | 'fires' | null } })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ layer: 'fires' })
    await waitFor(() => expect(result.current.status === 'ready' && result.current.layer).toBe('fires'))
    rerender({ layer: null })
    expect(result.current.status).toBe('off')
    for (const s of seen) if (s.status === 'ready' || s.status === 'loading') expect(s.layer).toBe(s.asked)
  })
})
