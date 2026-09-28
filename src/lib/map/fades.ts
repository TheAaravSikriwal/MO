/**
 * Fading points in and out on the map, one by one.
 *
 * MapLibre animates a paint setting that changes for a whole layer, but not
 * one feature arriving or leaving: a pin a filter hides would simply vanish.
 * So each point's opacity is tracked here, from 0 to 1, and stepped towards
 * where it should be on every animation frame. The map reads it through
 * feature state.
 *
 * Pure: the caller supplies the time, which is what makes it testable.
 */

export interface FadeEntry<T> {
  item: T
  /** 0 is invisible, 1 fully shown. */
  opacity: number
  /** Where it is heading: 1 while it is wanted, 0 once it has gone. */
  target: 0 | 1
}

export class FadeBook<T> {
  private entries = new Map<string, FadeEntry<T>>()
  private last: number | null = null

  constructor(
    private readonly keyOf: (item: T) => string,
    private readonly ms: number,
  ) {}

  /**
   * What should be shown now. New items start invisible and fade in; items no
   * longer listed fade out, and are kept until they have. `instant` skips the
   * fading altogether, for anyone who has asked for reduced motion.
   */
  set(items: readonly T[], instant = false): void {
    const wanted = new Set<string>()
    for (const item of items) {
      const key = this.keyOf(item)
      wanted.add(key)
      const existing = this.entries.get(key)
      if (existing) {
        existing.item = item
        existing.target = 1
        if (instant) existing.opacity = 1
      } else {
        this.entries.set(key, { item, opacity: instant ? 1 : 0, target: 1 })
      }
    }
    for (const [key, entry] of this.entries) {
      if (wanted.has(key)) continue
      entry.target = 0
      if (instant) this.entries.delete(key)
    }
  }

  /**
   * Move every entry towards its target by the time passed since the last
   * step, and drop the ones that have finished fading out. Returns true while
   * anything is still moving, so the caller knows to ask for another frame.
   */
  step(now: number): boolean {
    const dt = this.last === null ? 0 : Math.max(0, now - this.last)
    this.last = now
    const by = this.ms > 0 ? dt / this.ms : 1
    let moving = false
    for (const [key, entry] of this.entries) {
      if (entry.opacity < entry.target) entry.opacity = Math.min(1, entry.opacity + by)
      else if (entry.opacity > entry.target) entry.opacity = Math.max(0, entry.opacity - by)
      if (entry.target === 0 && entry.opacity === 0) {
        this.entries.delete(key)
        continue
      }
      if (entry.opacity !== entry.target) moving = true
    }
    return moving
  }

  /** Forget the clock, so the next step does not count time spent idle. */
  pause(): void {
    this.last = null
  }

  /** Everything to draw, the leaving ones included, with its opacity. */
  shown(): Array<{ key: string; item: T; opacity: number; leaving: boolean }> {
    return [...this.entries].map(([key, e]) => ({ key, item: e.item, opacity: e.opacity, leaving: e.target === 0 }))
  }
}
