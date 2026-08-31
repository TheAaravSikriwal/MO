import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchPlaces, createDebouncedSearch, MIN_REQUEST_INTERVAL_MS } from './nominatim'

const nominatimResponse = [
  { display_name: 'Hyde Park, London', lat: '51.5073', lon: '-0.1657' },
]

const mockFetchOk = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => nominatimResponse }),
  )

describe('searchPlaces', () => {
  beforeEach(mockFetchOk)
  afterEach(() => vi.unstubAllGlobals())

  it('returns parsed places with numeric coordinates', async () => {
    expect(await searchPlaces('hyde park')).toEqual([
      { name: 'Hyde Park, London', lat: 51.5073, lng: -0.1657 },
    ])
  })

  it('returns nothing for a blank query without calling the network', async () => {
    expect(await searchPlaces('   ')).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for json and a small result limit', async () => {
    await searchPlaces('hyde park')
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('format=json')
    expect(url).toContain('limit=5')
  })

  it('url-encodes the query', async () => {
    await searchPlaces('rue de l’église')
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).not.toContain(' ')
    expect(url).toContain('rue+de')
  })

  it('returns an empty list when the service errors, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    expect(await searchPlaces('anywhere')).toEqual([])
  })

  it('returns an empty list when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await searchPlaces('anywhere')).toEqual([])
  })

  it('returns an empty list when the response is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: 'nope' }) }),
    )
    expect(await searchPlaces('anywhere')).toEqual([])
  })

  it('drops results with unparseable coordinates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { display_name: 'Good', lat: '1', lon: '2' },
          { display_name: 'Bad', lat: 'not-a-number', lon: '2' },
        ],
      }),
    )
    expect(await searchPlaces('x')).toEqual([{ name: 'Good', lat: 1, lng: 2 }])
  })
})

describe('createDebouncedSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetchOk()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('defaults to the rate limit nominatim asks for', () => {
    expect(MIN_REQUEST_INTERVAL_MS).toBe(1000)
  })

  it('issues one request for a burst of keystrokes', async () => {
    const search = createDebouncedSearch(1000)
    search('h', () => {})
    search('hy', () => {})
    search('hyd', () => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('makes no request at all before the delay elapses', async () => {
    const search = createDebouncedSearch(1000)
    search('hyde', () => {})
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('delivers results for the final query only', async () => {
    const search = createDebouncedSearch(1000)
    const onResults = vi.fn()
    search('h', onResults)
    search('hyde park', onResults)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onResults).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('hyde+park')
  })

  it('still searches again after a completed search', async () => {
    const search = createDebouncedSearch(1000)
    search('first', () => {})
    await vi.advanceTimersByTimeAsync(1000)
    search('second', () => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
