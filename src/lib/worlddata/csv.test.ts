import { describe, it, expect } from 'vitest'
import { slimFires, parseFires } from './csv'

const HEADER =
  'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight'
const row = (i: number) =>
  `${(-26 + i / 1000).toFixed(5)},${(-55 + i / 1000).toFixed(5)},318.5,1.1,1.0,2026-09-28,0105,T,55,6.1NRT,293.4,${(i % 90) + 0.37},N`
const nasa = (n: number) => [HEADER, ...Array.from({ length: n }, (_, i) => row(i))].join('\n')

describe('slimFires', () => {
  it('keeps every hot spot, where it is and how strong, and nothing else', () => {
    const slim = slimFires(nasa(3))
    expect(slim.split('\n')[0]).toBe('latitude,longitude,frp')
    expect(parseFires(slim)).toEqual(parseFires(nasa(3)).map((f) => ({
      lat: Number(f.lat.toFixed(3)),
      lng: Number(f.lng.toFixed(3)),
      power: Number(f.power.toFixed(1)),
    })))
  })

  it('is a small fraction of NASA’s file, so a server’s cache will hold it', () => {
    const full = nasa(20_000)
    const slim = slimFires(full)
    expect(slim.length).toBeLessThan(full.length / 3)
    // Next's data cache refuses over 2 MB; well under, even for a big day.
    expect(slim.length).toBeLessThan(2 * 1024 * 1024)
  })

  it('skips a row with a blank position, rather than putting a fire at 0, 0', () => {
    const csv = ['latitude,longitude,frp', ',,5', ' , ,5', '-26.1,,5', ',-55.4,5', '0,0,5', '-26.1,-55.4,5'].join('\n')
    // Only the two real positions: 0, 0 written out is a real place.
    expect(parseFires(csv)).toEqual([
      { lat: 0, lng: 0, power: 5 },
      { lat: -26.1, lng: -55.4, power: 5 },
    ])
  })

  it('is empty for a file with no fires in it, so the caller can say so', () => {
    expect(slimFires('<html>maintenance</html>')).toBe('')
    expect(slimFires(HEADER)).toBe('')
  })
})
