import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { highlights, type Highlight } from '../../lib/worlddata/highlights'
import type { FindingsState } from '../../lib/worlddata/useFindings'

/**
 * The introduction to tidy: a short reel of where the planet stands, one big
 * figure at a time, with what is behind it. A welcome first, the figures,
 * then what anyone can do about the litter near them.
 *
 * Every slide arrives and leaves: its leaves grow in from the edges and drift
 * off again, and its words rise in and fade away, before the next one comes.
 * One button moves on; the arrow keys and Enter do too. "Skip intro", large
 * at the top, or Escape, goes straight to the map at any point.
 */

type Slide =
  | { kind: 'welcome' }
  | { kind: 'loading' }
  | { kind: 'fact'; fact: Highlight }
  | { kind: 'finale' }

/** How long a slide takes to leave before the next arrives. Matches .mo-reel-leave. */
export const SLIDE_EXIT_MS = 440

/** One leaf: a curved blade with a vein down the middle. */
function Blade({ colour }: { colour: string }) {
  return (
    <>
      <path d="M0 0 C 18 -26 58 -30 84 0 C 58 30 18 26 0 0 Z" fill={colour} />
      <path d="M2 0 C 30 -2 56 -1 80 0" stroke="rgba(8, 28, 18, 0.35)" strokeWidth="1.6" fill="none" />
    </>
  )
}

interface LeafSpot {
  x: number
  y: number
  size: number
  rotate: number
  colour: string
}

const GREENS = ['#2d6a4f', '#40916c', '#52b788', '#74c69d', '#95d5b2']

/**
 * Where the leaves sit on a slide. A different arrangement for each slide,
 * worked out from its number, so moving on visibly changes the scene rather
 * than replaying the same one. Always round the edges, never over the words.
 */
export function leafSpots(slide: number): LeafSpot[] {
  // A small, steady shuffle: the same slide always gets the same leaves.
  let seed = 7 + slide * 131
  const next = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  const corners = [
    { x: -20, y: 60, rotate: 20 },
    { x: 30, y: 10, rotate: 50 },
    { x: 0, y: 170, rotate: -15 },
    { x: 1040, y: 30, rotate: 150 },
    { x: 990, y: 130, rotate: 200 },
    { x: 1070, y: 600, rotate: 210 },
    { x: -30, y: 630, rotate: -30 },
    { x: 1000, y: 690, rotate: 190 },
  ]
  return corners
    .filter((_, i) => (i + slide) % 4 !== 3)
    .map((c) => ({
      x: c.x + (next() - 0.5) * 60,
      y: c.y + (next() - 0.5) * 60,
      size: 0.9 + next() * 0.9,
      rotate: c.rotate + (next() - 0.5) * 40,
      colour: GREENS[Math.floor(next() * GREENS.length)],
    }))
}

/** Branches and leaves round the edges, and a vine along the bottom; each leaf arrives and leaves with the slide. */
function Foliage({ slide, leaving }: { slide: number; leaving: boolean }) {
  const spots = useMemo(() => leafSpots(slide), [slide])
  const vine = 'M -20 690 C 160 640 260 700 420 660 S 700 610 860 660 S 1060 700 1120 640'
  const sprigs = [
    { x: 170, y: 655, rotate: -60, colour: '#52b788' },
    { x: 390, y: 662, rotate: -110, colour: '#74c69d' },
    { x: 620, y: 632, rotate: -70, colour: '#95d5b2' },
    { x: 870, y: 660, rotate: -115, colour: '#52b788' },
  ]
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1100 720"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      data-testid="foliage"
      data-leaving={leaving ? 'yes' : 'no'}
    >
      {spots.map((s, i) => {
        // Each comes in from beyond its own edge.
        const fromLeft = s.x < 550
        const motion = {
          '--dx': `${fromLeft ? -140 : 140}px`,
          '--dy': `${s.y < 360 ? -90 : 90}px`,
          '--spin': `${fromLeft ? -70 : 70}deg`,
          '--delay': `${i * 90}ms`,
        } as CSSProperties
        return (
          <g key={`${slide}-${i}`} transform={`translate(${s.x} ${s.y}) rotate(${s.rotate}) scale(${s.size})`}>
            <g className={leaving ? 'mo-leaf-out' : 'mo-leaf-in'} style={motion} data-testid="leaf">
              <g className="mo-reel-leaf" style={{ animationDelay: `${i * 400}ms` } as CSSProperties}>
                <Blade colour={s.colour} />
              </g>
            </g>
          </g>
        )
      })}
      <g className={leaving ? 'mo-leaf-out' : undefined} style={{ '--dx': '0px', '--dy': '60px', '--spin': '0deg' } as CSSProperties}>
        <path
          key={`vine-${slide}`}
          className="mo-reel-vine"
          d={vine}
          stroke="#40916c"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
          style={{ '--length': 1300 } as CSSProperties}
        />
      </g>
      {sprigs.map((s, i) => (
        <g key={`${slide}-sprig-${i}`} transform={`translate(${s.x} ${s.y}) rotate(${s.rotate}) scale(0.55)`}>
          <g
            className={leaving ? 'mo-leaf-out' : 'mo-reel-sprout'}
            style={{ '--delay': `${700 + i * 280}ms`, '--dx': '0px', '--dy': '40px', '--spin': '30deg' } as CSSProperties}
          >
            <Blade colour={s.colour} />
          </g>
        </g>
      ))}
    </svg>
  )
}

/** A seedling that pushes up out of the ground and opens two leaves. */
function Seedling() {
  return (
    <svg viewBox="0 0 120 120" className="mx-auto h-24 w-24" aria-hidden="true">
      <path d="M20 108 Q 60 100 100 108" stroke="#95d5b2" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.6" />
      <path
        className="mo-reel-vine"
        d="M60 106 C 60 88 58 72 60 52"
        stroke="#74c69d"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
        style={{ '--length': 60 } as CSSProperties}
      />
      <g className="mo-reel-sprout" style={{ '--delay': '700ms', transformOrigin: '60px 54px' } as CSSProperties}>
        <path d="M60 54 C 44 36 22 38 16 46 C 26 60 48 62 60 54 Z" fill="#52b788" />
        <path d="M60 54 C 76 32 100 32 106 42 C 96 58 72 62 60 54 Z" fill="#95d5b2" />
      </g>
    </svg>
  )
}

export interface HighlightReelProps {
  state: FindingsState
  onDone: () => void
}

export function HighlightReel({ state, onDone }: HighlightReelProps) {
  const facts = useMemo(() => (state.status === 'ready' ? highlights(state.findings) : []), [state])
  const slides: Slide[] = useMemo(
    () => [
      { kind: 'welcome' },
      ...(state.status === 'ready'
        ? facts.map((fact): Slide => ({ kind: 'fact', fact }))
        : state.status === 'failed'
          ? []
          : [{ kind: 'loading' } as Slide]),
      { kind: 'finale' },
    ],
    [state, facts],
  )
  const [at, setAt] = useState(0)
  // True while a slide is on its way out and the next is not yet in.
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const index = Math.min(at, slides.length - 1)
  const slide = slides[index]
  const last = index >= slides.length - 1
  const button = useRef<HTMLButtonElement>(null)

  /** Let the slide leave, then do what comes after. */
  const leaveThen = (then: () => void) => {
    if (leaving) return
    setLeaving(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setLeaving(false)
      then()
    }, SLIDE_EXIT_MS)
  }
  const next = () => leaveThen(() => (last ? onDone() : setAt((i) => i + 1)))
  const back = () => {
    if (index > 0) leaveThen(() => setAt((i) => Math.max(0, i - 1)))
  }
  // Skipping never waits for anything.
  const skip = () => {
    if (timer.current) clearTimeout(timer.current)
    onDone()
  }

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  useEffect(() => {
    button.current?.focus()
  }, [at])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') skip()
      else if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div role="dialog" aria-modal="true" aria-label="Introduction to tidy" className="mo-reel fixed inset-0 z-[3000] flex flex-col overflow-hidden">
      <Foliage slide={index} leaving={leaving} />
      <div className="relative flex items-center justify-between px-6 py-5">
        <span className="text-lg font-bold tracking-tight text-[#b7e4c7]">tidy</span>
        <button
          type="button"
          onClick={skip}
          className="flex items-center gap-2 rounded-full border-2 border-[#b5e48c] bg-[#081c12]/60 px-5 py-2.5 text-base font-bold text-[#f4f1e6] shadow-lg shadow-black/30 backdrop-blur transition-colors duration-200 hover:bg-[#b5e48c] hover:text-[#081c12] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#d8f3dc]/60"
        >
          Skip intro
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
            <path d="M4 4 L11 10 L4 16 M10 4 L17 10 L10 16" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-6">
        <div key={`${index}-${slide.kind}`} className={`max-w-4xl text-center ${leaving ? 'mo-reel-leave' : ''}`} aria-live="polite">
          {slide.kind === 'welcome' ? (
            <>
              <Seedling />
              <p className="mo-reel-rise mt-2 text-xl font-medium text-[#b7e4c7] md:text-2xl" style={{ '--delay': '200ms' } as CSSProperties}>
                Welcome to
              </p>
              <h1 className="mt-1 text-8xl font-black leading-none tracking-tight md:text-[10rem]" aria-label="tidy">
                {'tidy'.split('').map((letter, i) => (
                  <span key={i} className="mo-reel-rise inline-block" style={{ '--delay': `${450 + i * 120}ms` } as CSSProperties} aria-hidden="true">
                    {letter}
                  </span>
                ))}
              </h1>
              <p className="mo-reel-rise mx-auto mt-6 max-w-xl text-lg text-[#d8f3dc] md:text-xl" style={{ '--delay': '1100ms' } as CSSProperties}>
                A map of the litter around us, and of the people cleaning it up. First, a quick look at where the planet stands.
              </p>
            </>
          ) : slide.kind === 'loading' ? (
            <p role="status" className="mo-reel-rise text-2xl font-bold text-[#d8f3dc]">
              Gathering the latest figures…
            </p>
          ) : slide.kind === 'fact' ? (
            <>
              <p className="mo-reel-rise text-6xl font-black leading-none tracking-tight text-[#b5e48c] md:text-8xl">{slide.fact.big}</p>
              <p className="mo-reel-rise mx-auto mt-5 max-w-3xl text-3xl font-extrabold leading-tight md:text-5xl" style={{ '--delay': '150ms' } as CSSProperties}>
                {slide.fact.line}
              </p>
              <p className="mo-reel-rise mx-auto mt-6 max-w-2xl text-lg text-[#d8f3dc] md:text-xl" style={{ '--delay': '350ms' } as CSSProperties}>
                <span className="font-bold text-[#b7e4c7]">Why: </span>
                {slide.fact.cause}
              </p>
              <p className="mo-reel-rise mt-6 text-xs text-[#d8f3dc]/60" style={{ '--delay': '500ms' } as CSSProperties}>
                {slide.fact.source}
              </p>
            </>
          ) : (
            <>
              <p className="mo-reel-rise text-5xl font-black leading-tight tracking-tight md:text-7xl">
                Litter is local.
                <br />
                <span className="text-[#b5e48c]">So is cleaning it up.</span>
              </p>
              <p className="mo-reel-rise mx-auto mt-6 max-w-2xl text-lg text-[#d8f3dc] md:text-xl" style={{ '--delay': '250ms' } as CSSProperties}>
                Report litter you see, confirm what others have found, and join a group near you. Every clean-up shows on the map.
                {state.status === 'failed' ? ' (The world figures could not be loaded just now; the Findings tab can try again.)' : ''}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="relative flex flex-col items-center gap-3 px-6 pb-10">
        <button
          ref={button}
          type="button"
          onClick={next}
          className="rounded-full bg-[#b5e48c] px-10 py-3.5 text-lg font-bold text-[#081c12] shadow-lg shadow-black/30 transition-transform duration-200 hover:scale-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#d8f3dc]/60"
        >
          {slide.kind === 'welcome' ? 'Begin' : last ? 'Start exploring' : 'Next'}
        </button>
        {!last && (
          <button type="button" onClick={skip} className="text-sm font-semibold text-[#d8f3dc] underline decoration-[#b5e48c] decoration-2 underline-offset-4 hover:text-white">
            or skip straight to the map
          </button>
        )}
        <ol className="flex gap-2" aria-label={`Slide ${index + 1} of ${slides.length}`}>
          {slides.map((_, i) => (
            <li key={i} aria-hidden="true">
              <svg viewBox="0 0 20 12" className={`h-3 w-5 transition-opacity duration-300 ${i === index ? 'opacity-100' : 'opacity-35'}`}>
                <path d="M1 6 C 5 0 15 0 19 6 C 15 12 5 12 1 6 Z" fill={i <= index ? '#b5e48c' : '#d8f3dc'} />
              </svg>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
