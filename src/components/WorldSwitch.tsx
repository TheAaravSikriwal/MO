import type { World } from '../lib/data/worlds'

export interface WorldSwitchProps {
  value: World
  onChange: (world: World) => void
  /** False when no database is connected; "Real world" still opens, and says so. */
  realConnected: boolean
}

const SIDES: Array<{ world: World; title: string; detail: string }> = [
  { world: 'idea', title: 'The idea', detail: 'Made-up reports, to show how it works' },
  { world: 'real', title: 'Real world', detail: 'Reports people have actually made' },
]

/**
 * The switch between made-up reports and real ones.
 *
 * Big and always on screen, because the two maps look alike and mistaking
 * one for the other is the whole risk: a made-up hotspot read as a real one.
 * Each side says in words what it holds, and each has its own colour, which
 * the frame round the map repeats (the world-frame in App.tsx).
 */
export function WorldSwitch({ value, onChange, realConnected }: WorldSwitchProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Which reports to show"
      className="mo-glass flex w-full rounded-2xl p-1.5"
    >
      {SIDES.map(({ world, title, detail }) => {
        const on = value === world
        const colour =
          world === 'idea'
            ? on
              ? 'bg-violet-600 text-white'
              : 'text-violet-700 hover:bg-violet-50'
            : on
              ? 'bg-emerald-600 text-white'
              : 'text-emerald-700 hover:bg-emerald-50'
        return (
          <button
            key={world}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(world)}
            className={`flex-1 rounded-xl px-3 py-1.5 text-left transition-colors roomy:px-4 roomy:py-2.5 ${colour}`}
          >
            <span className="block text-sm font-semibold roomy:text-base">{title}</span>
            <span className={`block text-xs phone:leading-tight ${on ? 'text-white/90' : 'text-slate-500'}`}>
              {world === 'real' && !realConnected ? 'Not connected yet' : detail}
            </span>
          </button>
        )
      })}
    </div>
  )
}
