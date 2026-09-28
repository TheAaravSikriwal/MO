import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** How long a panel takes to come in or go out. Tailwind's duration-200, plus a frame. */
export const REVEAL_MS = 220

export interface RevealProps {
  show: boolean
  children: ReactNode
  /** Which way it moves as it comes in: up from below, or down from above. */
  from?: 'below' | 'above'
  /**
   * Space above it, as a class (`pt-2`). Given here rather than by the parent,
   * because it has to shrink away with the panel: a gap left behind by a panel
   * that has gone closes with a jump.
   */
  gap?: string
  /**
   * Keep it on the page, hidden, once it has gone, instead of removing it. For
   * a half-filled form: removed, it would forget everything typed into it.
   */
  keepMounted?: boolean
}

/**
 * Keeps something around for the length of its exit, then lets it go.
 *
 * `mounted` is whether to draw it at all; `visible` whether it should be in
 * its "on" state. Entering, both turn true together; leaving, `visible` goes
 * at once and `mounted` follows `ms` later.
 */
export function useLinger(show: boolean, ms: number = REVEAL_MS) {
  const [mounted, setMounted] = useState(show)
  useEffect(() => {
    if (show) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), ms)
    return () => clearTimeout(timer)
  }, [show, ms])
  return { mounted: mounted || show, visible: show }
}

export interface Lingering<T> {
  item: T
  key: string
  /** True while it fades out, after the list it came from dropped it. */
  leaving: boolean
}

/**
 * A list, with anything just removed from it kept in its old place for the
 * length of its exit, marked `leaving`.
 *
 * For lists rather than single panels: a group card when the map pans away, a
 * review item once it is decided, a pin a filter hides. Without it each of
 * those is simply gone in one frame.
 *
 * Worked out while rendering, not in an effect afterwards. Done afterwards, the
 * removed item missed one render, so React unmounted it and then mounted a new
 * one already hidden, which has nothing to fade from: the exit never ran. Each
 * removal gets its own timer, so a second change arriving mid-fade does not
 * strand the first one on screen.
 */
export function useLingeringList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  ms: number = REVEAL_MS,
): Array<Lingering<T>> {
  const lastShown = useRef<Array<Lingering<T>>>([])
  const leaving = useRef(new Map<string, { item: T; index: number; timed: boolean }>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [, rerender] = useState(0)

  const present = new Set(items.map(keyOf))
  // Newly dropped since the last render: keep them where they were. Only what
  // was really there last time -- one that had already finished leaving would
  // otherwise be picked up again and leave for ever.
  lastShown.current.forEach((entry, index) => {
    if (!entry.leaving && !present.has(entry.key) && !leaving.current.has(entry.key)) {
      leaving.current.set(entry.key, { item: entry.item, index, timed: false })
    }
  })
  // Anything that came back is no longer leaving.
  for (const key of [...leaving.current.keys()]) {
    if (present.has(key)) leaving.current.delete(key)
  }

  const shown: Array<Lingering<T>> = items.map((item) => ({ item, key: keyOf(item), leaving: false }))
  const going = [...leaving.current.entries()].sort((a, b) => a[1].index - b[1].index)
  for (const [key, { item, index }] of going) {
    shown.splice(Math.min(index, shown.length), 0, { item, key, leaving: true })
  }
  lastShown.current = shown

  useEffect(() => {
    for (const [key, entry] of leaving.current) {
      if (entry.timed) continue
      entry.timed = true
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        // Only if it is still leaving: it may have come back meanwhile.
        if (leaving.current.get(key) === entry) {
          leaving.current.delete(key)
          rerender((n) => n + 1)
        }
      }, ms)
      timers.current.add(timer)
    }
  })

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
    }
  }, [])

  return shown
}

/**
 * Fades and slides something onto the screen, and off it again, and opens and
 * closes the space it takes so nothing around it jumps.
 *
 * The height is animated with a one-row grid going from `0fr` to `1fr`, which
 * needs no measuring. Coming in: it is first drawn in its "off" state, the
 * browser is made to lay that out, and only then is it switched "on", so the
 * change is a transition rather than a jump. Going out: the last thing it
 * showed is kept for the length of the exit and then removed. It is marked
 * hidden and made inert for that time, so nothing on its way out can be read
 * out, tabbed to or clicked.
 *
 * Clipped only while it moves: a shadow or a dropdown is cut off by the
 * overflow that the height animation needs, so once it has arrived the clip
 * is lifted.
 *
 * It moves for everyone, including machines set to reduce motion, as the rest
 * of the site does (its src/lib/motion.js): the movement is part of the app.
 */
export function Reveal({ show, children, from = 'below', gap = '', keepMounted = false }: RevealProps) {
  const { mounted } = useLinger(show)
  const [on, setOn] = useState(false)
  const [settled, setSettled] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // What to keep showing while it goes out, when whatever it showed has gone.
  const last = useRef<ReactNode>(children)
  if (show) last.current = children

  useLayoutEffect(() => {
    if (!show) return
    // Lay out the "off" state before switching on, or there is nothing to
    // transition from and it simply appears.
    void box.current?.offsetHeight
    setOn(true)
  }, [show])

  useEffect(() => {
    if (!show) {
      setOn(false)
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [show])

  // Set on the element directly: React 18, which the wearechintu copy runs,
  // does not know `inert` as a prop.
  useEffect(() => {
    const element = box.current
    if (!element) return
    if (show) element.removeAttribute('inert')
    else element.setAttribute('inert', '')
  }, [show, mounted])

  if (!mounted && !keepMounted) return null

  const arrived = on && show
  const off = from === 'below' ? 'translate-y-2' : '-translate-y-2'
  return (
    <div
      ref={box}
      // Gone but kept: the same elements, so what was typed survives.
      hidden={!mounted}
      aria-hidden={show ? undefined : true}
      data-reveal={arrived ? 'in' : 'out'}
      // `translate`, not `transform`: in Tailwind 4 the translate-y utilities set
      // the CSS translate property, so a transition on transform left the slide
      // snapping while only the fade and the height moved.
      className={`grid transition-[grid-template-rows,opacity,translate] duration-200 ease-out ${
        arrived ? 'grid-rows-[1fr] translate-y-0 opacity-100' : `grid-rows-[0fr] ${off} opacity-0`
      }`}
    >
      <div className={`min-h-0 ${arrived && settled ? '' : 'overflow-hidden'}`}>
        <div className={gap}>{show ? children : last.current}</div>
      </div>
    </div>
  )
}

export interface SwapProps {
  /** Which state is showing. A new value cross-fades to the new children. */
  id: string
  children: ReactNode
  /** Sit in a line of text or buttons rather than taking a whole row. */
  inline?: boolean
}

/**
 * Cross-fades between the states of one thing: a sign-in form and the note
 * that replaces it, "Join" and "Leave", "Report" and "Reported".
 *
 * `Reveal` is for something coming and going; this is for something that is
 * always there but changes what it is, which otherwise happens in one frame.
 * The old state and the new are stacked in one grid cell, the old fading out
 * (hidden and inert, so it cannot be read out or clicked) while the new fades
 * in, and the old is dropped once it has gone. With "reduce motion" switched
 * on the old state goes at once and nothing fades.
 */
export function Swap({ id, children, inline = false }: SwapProps) {
  const layers = useLingeringList([{ id, node: children }], (layer) => layer.id)
  return (
    <div className={inline ? 'inline-grid' : 'grid'} data-swap={id}>
      {layers.map(({ item, key, leaving }) => (
        <div
          key={key}
          style={{ gridArea: '1 / 1' }}
          aria-hidden={leaving ? true : undefined}
          ref={(element) => {
            if (!element) return
            if (leaving) element.setAttribute('inert', '')
            else element.removeAttribute('inert')
          }}
          className={`transition-opacity duration-200 ease-out ${
            leaving ? 'pointer-events-none opacity-0' : 'mo-swap-in opacity-100'
          }`}
        >
          {item.node}
        </div>
      ))}
    </div>
  )
}
