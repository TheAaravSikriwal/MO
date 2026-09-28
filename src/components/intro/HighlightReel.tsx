import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { highlights, type Highlight } from '../../lib/worlddata/highlights'
import type { FindingsState } from '../../lib/worlddata/useFindings'

/**
 * The introduction to tidy: a short reel of where the planet stands, one big
 * figure at a time, with what is behind it. A welcome first, the figures,
 * then what anyone can do about the litter near them. One button moves on;
 * the arrow keys and Enter do too, and Escape, or "Skip", goes straight to
 * the map.
 */

type Slide =
  | { kind: 'welcome' }
  | { kind: 'loading' }
  | { kind: 'fact'; fact: Highlight }
  | { kind: 'finale' }

/** One leaf: a curved blade with a vein down the middle. */
function Leaf({ x, y, size, rotate, colour, delay }: { x: number; y: number; size: number; rotate: number; colour: string; delay: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${size})`}>
      <g className="mo-reel-leaf" style={{ animationDelay: `${delay}ms` } as CSSProperties}>
        <path d="M0 0 C 18 -26 58 -30 84 0 C 58 30 18 26 0 0 Z" fill={colour} />
        <path d="M2 0 C 30 -2 56 -1 80 0" stroke="rgba(8, 28, 18, 0.35)" strokeWidth="1.6" fill="none" />
      </g>
    </g>
  )
}

/** Branches and leaves round the edges of the screen, and a vine that grows along the bottom. */
function Foliage() {
  const leaves = [
    { x: -20, y: 70, size: 1.6, rotate: 18, colour: '#2d6a4f', delay: 0 },
    { x: 40, y: 20, size: 1.1, rotate: 48, colour: '#40916c', delay: 600 },
    { x: 10, y: 150, size: 1.2, rotate: -12, colour: '#52b788', delay: 1200 },
    { x: 1030, y: 40, size: 1.5, rotate: 150, colour: '#2d6a4f', delay: 300 },
    { x: 990, y: 120, size: 1, rotate: 200, colour: '#74c69d', delay: 900 },
    { x: 1060, y: 610, size: 1.7, rotate: 210, colour: '#40916c', delay: 450 },
    { x: -30, y: 640, size: 1.4, rotate: -30, colour: '#2d6a4f', delay: 750 },
  ]
  const vine = 'M -20 690 C 160 640 260 700 420 660 S 700 610 860 660 S 1060 700 1120 640'
  const sprigs = [
    { x: 170, y: 655, rotate: -60, colour: '#52b788', delay: 900 },
    { x: 390, y: 662, rotate: -110, colour: '#74c69d', delay: 1300 },
    { x: 620, y: 632, rotate: -70, colour: '#95d5b2', delay: 1700 },
    { x: 870, y: 660, rotate: -115, colour: '#52b788', delay: 2100 },
  ]
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1100 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {leaves.map((leaf, i) => (
        <Leaf key={i} {...leaf} />
      ))}
      <path className="mo-reel-vine" d={vine} stroke="#40916c" strokeWidth="5" strokeLinecap="round" fill="none" style={{ '--length': 1300 } as CSSProperties} />
      {sprigs.map((s, i) => (
        <g key={i} transform={`translate(${s.x} ${s.y}) rotate(${s.rotate}) scale(0.55)`}>
          <g className="mo-reel-sprout" style={{ '--delay': `${s.delay}ms` } as CSSProperties}>
            <Leaf x={0} y={0} size={1} rotate={0} colour={s.colour} delay={s.delay} />
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
      ...(state.status === 'ready' ? facts.map((fact): Slide => ({ kind: 'fact', fact })) : state.status === 'failed' ? [] : [{ kind: 'loading' } as Slide]),
      { kind: 'finale' },
    ],
    [state, facts],
  )
  const [at, setAt] = useState(0)
  const slide = slides[Math.min(at, slides.length - 1)]
  const last = at >= slides.length - 1
  const next = () => (last ? onDone() : setAt((i) => i + 1))
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    button.current?.focus()
  }, [at])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone()
      else if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') setAt((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div role="dialog" aria-modal="true" aria-label="Introduction to tidy" className="mo-reel fixed inset-0 z-[3000] flex flex-col overflow-hidden">
      <Foliage />
      <div className="relative flex items-center justify-between px-6 py-5">
        <span className="text-lg font-bold tracking-tight text-[#b7e4c7]">tidy</span>
        <button type="button" onClick={onDone} className="rounded-full px-3 py-1 text-sm text-[#d8f3dc]/80 hover:bg-white/10 hover:text-white">
          Skip introduction
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-6">
        <div key={`${at}-${slide.kind}`} className="max-w-4xl text-center" aria-live="polite">
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

      <div className="relative flex flex-col items-center gap-4 px-6 pb-10">
        <button
          ref={button}
          type="button"
          onClick={next}
          className="rounded-full bg-[#b5e48c] px-10 py-3.5 text-lg font-bold text-[#081c12] shadow-lg shadow-black/30 transition-transform duration-200 hover:scale-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#d8f3dc]/60"
        >
          {slide.kind === 'welcome' ? 'Begin' : last ? 'Start exploring' : 'Next'}
        </button>
        <ol className="flex gap-2" aria-label={`Slide ${at + 1} of ${slides.length}`}>
          {slides.map((_, i) => (
            <li key={i} aria-hidden="true">
              <svg viewBox="0 0 20 12" className={`h-3 w-5 transition-opacity duration-300 ${i === at ? 'opacity-100' : 'opacity-35'}`}>
                <path d="M1 6 C 5 0 15 0 19 6 C 15 12 5 12 1 6 Z" fill={i <= at ? '#b5e48c' : '#d8f3dc'} />
              </svg>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
