import { useState } from 'react'

export interface AboutPanelProps {
  onClose: () => void
  /** Plays the introduction again. */
  onReplay: () => void
}

/**
 * What tidy is and why it exists, in the maker's own words. Plain and honest:
 * a small project, not yet promoted, and an ask to pass it on.
 */
export function AboutPanel({ onClose, onReplay }: AboutPanelProps) {
  const [shared, setShared] = useState<'idle' | 'copied' | 'failed'>('idle')

  const share = async () => {
    const url = window.location.origin + window.location.pathname
    const text = 'tidy: a community map of litter, and of the people cleaning it up.'
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'tidy', text, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setShared('copied')
    } catch (error) {
      // Closing the share sheet is a choice, not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return
      setShared('failed')
    }
  }

  return (
    <section aria-label="About tidy" className="mo-reel relative flex h-full flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/40">
      <svg className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 opacity-70" viewBox="0 0 120 120" aria-hidden="true">
        <g className="mo-reel-leaf">
          <path d="M20 100 C 30 50 70 20 110 12 C 100 56 70 92 20 100 Z" fill="#2d6a4f" />
          <path d="M22 98 C 50 70 80 40 108 14" stroke="rgba(8, 28, 18, 0.4)" strokeWidth="2" fill="none" />
        </g>
      </svg>
      <header className="relative flex items-start justify-between gap-3 px-6 pb-2 pt-6 md:px-10">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#95d5b2]">About</p>
          <h2 className="mt-1 text-4xl font-black tracking-tight md:text-5xl">tidy</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-[#d8f3dc] hover:bg-white/10">
          Close
        </button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-8 md:px-10">
        <div className="max-w-2xl space-y-4 text-[17px] leading-relaxed text-[#eef6ee]">
          <p className="text-2xl font-extrabold leading-snug text-white">
            I travel a lot. Almost everywhere I went, I saw the same two things.
          </p>
          <p>
            The first was litter. On beaches, along roadsides, caught in the reeds of rivers running through the middle of town.
            Some of it had clearly been there for years.
          </p>
          <p>
            The second was people cleaning it up. Good people, giving up their Saturdays with gloves and bin bags. But it was all
            so scattered. One group would clear a beach not knowing another had done the same stretch two days before, while a
            street a few blocks away went untouched for months. Nobody could see the whole picture, so nobody could tell where
            the effort was needed most, or whether any of it was working.
          </p>
          <p>
            tidy is my attempt to pull that together and make it a community effort. Anyone can report litter with a photo and
            a pin. Other people confirm it is there. The map shows where it is worst, and when a place gets cleaned the map gets
            better, so you can actually watch things improve. Groups can organise around the places that need them instead of
            guessing.
          </p>
          <p>
            I will be honest with you: this is a small project. I have not marketed it, and I do not plan to until I can give it
            the time and resources it deserves. One day I will. For now it is mostly me, and the world figures you see here come
            from free, public sources.
          </p>
          <p className="font-bold text-white">
            If you like the idea, the most helpful thing you can do is share it with someone who would care: a friend who runs
            clean-ups, a teacher, someone on their local council, anyone who picks up a stray wrapper on their walk. And if you
            would like to help build it, I would love that too.
          </p>
          <p className="text-[#b7e4c7]">Thank you for being here.</p>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void share()}
            className="rounded-full bg-[#b5e48c] px-6 py-2.5 text-base font-bold text-[#081c12] shadow-lg shadow-black/30 transition-transform duration-200 hover:scale-105"
          >
            Share tidy
          </button>
          <button type="button" onClick={onReplay} className="rounded-full border border-[#95d5b2]/50 px-5 py-2.5 text-sm font-semibold text-[#d8f3dc] hover:bg-white/10">
            Watch the introduction again
          </button>
          <span role="status" className="text-sm text-[#d8f3dc]">
            {shared === 'copied' ? 'Link copied. Thank you!' : shared === 'failed' ? 'Could not share from here. The address bar has the link.' : ''}
          </span>
        </div>
      </div>
    </section>
  )
}
