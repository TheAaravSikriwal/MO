import { useRef, type KeyboardEvent } from 'react'

export type Tab = 'map' | 'groups' | 'findings'

export interface MapTabsProps {
  value: Tab
  onChange: (tab: Tab) => void
}

const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: 'map', label: 'Reports' },
  { tab: 'groups', label: 'Cleaning groups' },
  { tab: 'findings', label: 'Findings' },
]

/**
 * What the panel beside the map is about: litter reports, the groups
 * cleaning it up, or the findings across the world's figures.
 *
 * The full tab pattern, because a screen reader announces "tab" and people
 * then expect it to behave like one: the chosen tab names the panel it
 * controls (`panel-map`, `panel-groups` or `panel-findings`, drawn in App.tsx; the others are
 * not on the page), only the chosen tab is in the Tab order, and the arrow
 * keys, Home and End move between them.
 */
export function MapTabs({ value, onChange }: MapTabsProps) {
  const buttons = useRef<Record<Tab, HTMLButtonElement | null>>({ map: null, groups: null, findings: null })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(({ tab }) => tab === value)
    const next =
      event.key === 'ArrowRight'
        ? (at + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    const tab = TABS[next].tab
    onChange(tab)
    buttons.current[tab]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="What to show"
      onKeyDown={onKeyDown}
      className="mo-glass flex rounded-2xl p-1"
    >
      {TABS.map(({ tab, label }) => {
        const on = value === tab
        return (
          <button
            key={tab}
            ref={(element) => {
              buttons.current[tab] = element
            }}
            type="button"
            role="tab"
            id={`tab-${tab}`}
            aria-selected={on}
            // Only the chosen tab: the other panel is taken off the page once it
            // has faded, and pointing at an id that is not there is worse than
            // pointing at nothing.
            aria-controls={on ? `panel-${tab}` : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab)}
            className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors duration-200 ${
              on ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
