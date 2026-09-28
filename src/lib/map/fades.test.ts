import { describe, it, expect } from 'vitest'
import { FadeBook } from './fades'

const book = () => new FadeBook<string>((s) => s, 200)
const opacities = (b: FadeBook<string>) => Object.fromEntries(b.shown().map((e) => [e.key, e.opacity]))

/** Fade points all the way in, then pause, so a test starts from them fully shown. */
const shownFully = (b: FadeBook<string>, items: string[]) => {
  b.set(items)
  b.step(-100_000)
  b.step(-90_000)
  b.pause()
}

describe('FadeBook', () => {
  it('fades a new point in over the fade, rather than showing it at once', () => {
    const b = book()
    b.set(['a'])
    b.step(0)
    expect(opacities(b).a).toBe(0)
    b.step(100)
    expect(opacities(b).a).toBeCloseTo(0.5)
    expect(b.step(200)).toBe(false)
    expect(opacities(b).a).toBe(1)
  })

  it('keeps a removed point, marked leaving, while it fades out, then drops it', () => {
    const b = book()
    shownFully(b, ['a', 'b'])
    b.set(['a'])
    b.step(0)
    expect(b.shown().find((e) => e.key === 'b')?.leaving).toBe(true)
    b.step(100)
    expect(opacities(b).b).toBeCloseTo(0.5)
    b.step(250)
    expect(Object.keys(opacities(b))).toEqual(['a'])
  })

  it('turns round a point that comes back part-way through leaving', () => {
    const b = book()
    shownFully(b, ['a'])
    b.set([])
    b.step(0)
    b.step(100)
    b.set(['a'])
    b.step(150)
    expect(opacities(b).a).toBeCloseTo(0.75)
    expect(b.shown()[0].leaving).toBe(false)
  })

  it('says when it has stopped moving, so no frames are spent on nothing', () => {
    const b = book()
    b.set(['a'])
    b.step(0)
    expect(b.step(50)).toBe(true)
    expect(b.step(500)).toBe(false)
  })

  it('does not count time spent idle after a pause', () => {
    const b = book()
    shownFully(b, ['a'])
    b.step(0)
    b.pause()
    b.set([])
    b.step(10_000)
    expect(opacities(b).a).toBe(1)
    b.step(10_100)
    expect(opacities(b).a).toBeCloseTo(0.5)
  })
})
