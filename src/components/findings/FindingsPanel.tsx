import { useMemo, useState, type ReactNode } from 'react'
import {
  allLinks,
  betterTogether,
  byLifeBand,
  ENVIRONMENT,
  LIFE_BANDS,
  link,
  METRICS,
  sayFinding,
  withinWealth,
  type Link,
  type LinkFigure,
  type MetricId,
  type WealthGroup,
} from '../../lib/worlddata/findings'
import type { Findings, FindingsState } from '../../lib/worlddata/useFindings'
import { savedDay, WORLD_LAYERS } from '../../lib/worlddata/worldData'
import { paperToMarkdown, researchPaper, tableToCsv, type Block } from '../../lib/worlddata/research'

/** A rank link as a signed figure, with a true minus sign. */
export const signed = (r: number) => (Number.isFinite(r) ? `${r < 0 ? '−' : r > 0 ? '+' : ''}${Math.abs(r).toFixed(2)}` : '–')

/** The chance a link is luck, in words. */
export function chance(p: number): string {
  if (!Number.isFinite(p)) return 'too few countries to say'
  if (p < 0.001) return 'under 1 in 1,000'
  if (p < 0.05) return `about 1 in ${Math.round(1 / p).toLocaleString('en-GB')}`
  return 'could easily be luck'
}

/** A figure in its measure's usual form. */
export function figure(id: MetricId, value: number): string {
  if (!Number.isFinite(value)) return '–'
  switch (id) {
    case 'life':
      return value.toFixed(2)
    case 'gdp':
      return `$${Math.round(value).toLocaleString('en-GB')}`
    case 'water':
      return `${Math.round(value)}%`
    case 'fires':
      return value.toFixed(2)
    default:
      return value.toFixed(1)
  }
}

const ORDER: MetricId[] = ['life', 'gdp', ...ENVIRONMENT]
/** The quality-of-life layer's own colours, one per band, as on the map. */
const BAND_COLORS = WORLD_LAYERS.life.colors
const WEALTH_NAMES = ['Poorest quarter', 'Lower middle', 'Upper middle', 'Richest quarter']

type View = 'explore' | 'paper'

/**
 * The findings: how quality of life, wealth and the environment go together,
 * across every country with the figures. Two ways in: Explore, to click
 * through it in plain words, and Research paper, the formal write-up with
 * every statistic, to cite and check.
 */
export function FindingsPanel({ state }: { state: FindingsState }) {
  const [view, setView] = useState<View>('explore')
  return (
    <section
      role="tabpanel"
      id="panel-findings"
      aria-labelledby="tab-findings"
      aria-label="Findings"
      className="mo-glass flex h-full flex-col overflow-hidden rounded-2xl"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-900/10 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900">Does quality of life go with a healthier environment?</h2>
          <p className="mt-1 text-sm text-slate-600">
            Every country with the figures, compared on quality of life, wealth, air, plastic, water and fires.
          </p>
        </div>
        <div role="group" aria-label="How to read the findings" className="flex shrink-0 rounded-xl bg-slate-900/5 p-1">
          {(
            [
              ['explore', 'Explore'],
              ['paper', 'Research paper'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-200 ${
                view === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {state.status === 'ready' ? (
          <>
            {state.findings.fromSaved.length > 0 && (
              <p role="status" className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Some live files could not be reached, so saved copies from {savedDay(state.findings.savedOn)} are used for:{' '}
                {state.findings.fromSaved.map((id) => METRICS[id].label.toLowerCase()).join(', ')}.
              </p>
            )}
            <div key={view} className="mo-swap-in">
              {view === 'explore' ? <Explore findings={state.findings} /> : <Paper findings={state.findings} />}
            </div>
          </>
        ) : state.status === 'failed' ? (
          <div>
            <p role="alert" className="text-sm text-rose-700">
              {state.message}
            </p>
            <button
              type="button"
              onClick={state.retry}
              className="mt-2 rounded-lg bg-slate-900/5 px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-900/10"
            >
              Try again
            </button>
          </div>
        ) : (
          <p role="status" className="text-sm text-slate-500">
            Loading the figures…
          </p>
        )}
      </div>
    </section>
  )
}

// --- Explore --------------------------------------------------------------------

/** What a link means for the environment, as a colour. */
const tone = (l: LinkFigure, metric: MetricId) =>
  l.strength === 'no clear' ? 'slate' : betterTogether(l, metric) ? 'emerald' : 'rose'

/**
 * A link drawn on a line from −1 to +1: the dot is the link, the band round it
 * the range it most likely lies in. Easier to see than to read as a number.
 */
export function StrengthBar({ label, figure: l, metric }: { label: string; figure: LinkFigure; metric: MetricId }) {
  const at = (r: number) => `${((Math.max(-1, Math.min(1, r)) + 1) / 2) * 100}%`
  const colour = { slate: '#64748b', emerald: '#059669', rose: '#e11d48' }[tone(l, metric)]
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-slate-800">{label}</span>
        <span className="tabular-nums text-slate-600">
          {signed(l.r)} · {l.strength === 'no clear' ? 'no clear link' : `${l.strength} link`} · {l.n} countries
        </span>
      </div>
      <div
        className="relative mt-1 h-3 rounded-full bg-slate-900/10"
        role="img"
        aria-label={`${label}: ${signed(l.r)}, likely between ${signed(l.ci[0])} and ${signed(l.ci[1])}`}
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-900/30" />
        {Number.isFinite(l.ci[0]) && (
          <div
            className="absolute inset-y-0 rounded-full opacity-30"
            style={{ left: at(l.ci[0]), width: `calc(${at(l.ci[1])} - ${at(l.ci[0])})`, background: colour }}
          />
        )}
        {Number.isFinite(l.r) && (
          <div
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow transition-[left] duration-300"
            style={{ left: at(l.r), background: colour }}
          />
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
        <span>one falls as the other rises</span>
        <span>no link</span>
        <span>rise together</span>
      </div>
    </div>
  )
}

function Explore({ findings }: { findings: Findings }) {
  const links = useMemo(() => new Map(ENVIRONMENT.map((id) => [id, link(findings.table, 'life', id)])), [findings])
  const pairs = useMemo(() => allLinks(findings.table, ORDER), [findings])
  const lifeAndWealth = useMemo(() => link(findings.table, 'life', 'gdp'), [findings])
  const [metric, setMetric] = useState<MetricId>('air')
  const [group, setGroup] = useState<number | null>(null)
  const [hold, setHold] = useState(false)
  const chosen = links.get(metric)!
  const groups = useMemo(() => withinWealth(findings.table, 'life', metric), [findings, metric])

  return (
    <div className="space-y-6 text-sm text-slate-700">
      <section aria-labelledby="explore-pick">
        <h3 id="explore-pick" className="text-sm font-semibold text-slate-900">
          1. Pick part of the environment
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {ENVIRONMENT.map((id) => {
            const l = links.get(id)!
            const on = id === metric
            const t = tone(l, id)
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setMetric(id)
                  setGroup(null)
                }}
                className={`rounded-xl border p-3 text-left transition-colors duration-200 ${
                  on ? 'border-slate-900 bg-white' : 'border-slate-900/10 bg-white/60 hover:bg-white'
                }`}
              >
                <span className="block text-sm font-medium text-slate-900">{METRICS[id].label}</span>
                <span
                  className={`mt-1 block text-xs ${t === 'emerald' ? 'text-emerald-700' : t === 'rose' ? 'text-rose-700' : 'text-slate-500'}`}
                >
                  {l.strength === 'no clear'
                    ? 'No clear link'
                    : `${l.strength[0].toUpperCase()}${l.strength.slice(1)} link: ${betterTogether(l, id) ? METRICS[id].good : METRICS[id].bad}`}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="explore-answer" className="rounded-xl border border-slate-900/10 bg-white/60 p-4">
        <h3 id="explore-answer" className="text-sm font-semibold text-slate-900">
          2. The answer for {METRICS[metric].label.toLowerCase()}
        </h3>
        <p className="mt-1 text-[15px] leading-relaxed text-slate-900">{sayFinding(chosen)}</p>
        <div className="mt-3 space-y-3">
          <StrengthBar label="All countries" figure={chosen} metric={metric} />
          {chosen.heldLevel && <StrengthBar label="Countries compared only with others as rich" figure={chosen.heldLevel} metric={metric} />}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">{METRICS[metric].about}</p>
      </section>

      <section aria-labelledby="explore-wealth">
        <h3 id="explore-wealth" className="text-sm font-semibold text-slate-900">
          3. Compare countries of similar wealth
        </h3>
        <p className="mt-1 text-xs text-slate-600">
          Richer countries tend to have both a better quality of life and more money for a cleaner environment. Pick a group of
          countries about as rich as each other to see what quality of life goes with inside it.
        </p>
        <div role="group" aria-label="Countries by wealth" className="mt-2 flex flex-wrap gap-1">
          <Chip on={group === null} onClick={() => setGroup(null)}>
            All countries
          </Chip>
          {groups.map((_, i) => (
            <Chip key={i} on={group === i} onClick={() => setGroup(i)}>
              {WEALTH_NAMES[i]}
            </Chip>
          ))}
        </div>
        {group !== null && <GroupSentence group={groups[group]} name={WEALTH_NAMES[group]} metric={metric} />}
        <div className="mt-3">
          <Scatter findings={findings} metric={metric} group={group === null ? null : groups[group]} />
        </div>
      </section>

      <section aria-labelledby="explore-bands">
        <h3 id="explore-bands" className="text-sm font-semibold text-slate-900">
          4. The middle country at each level of quality of life
        </h3>
        <BandBars findings={findings} metric={metric} />
      </section>

      <section aria-labelledby="explore-pairs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="explore-pairs" className="text-sm font-semibold text-slate-900">
            5. Every measure against every other
          </h3>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
            Hold wealth level
          </label>
        </div>
        <Matrix pairs={pairs} hold={hold} />
      </section>

      <section aria-labelledby="explore-how" className="rounded-xl bg-slate-900/5 p-3 text-xs text-slate-700">
        <h3 id="explore-how" className="text-sm font-semibold text-slate-900">
          How to read this
        </h3>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            Each link runs from −1 to +1. The countries are put in order on each measure, and the link says how closely the two
            orders agree: +1 always rise together, −1 one always falls as the other rises, 0 no pattern.
          </li>
          <li>Green means the environment is better where quality of life is higher; red means worse; grey, no clear link.</li>
          <li>
            “Could easily be luck” means a link that size turns up by chance too often to count. The shaded band on each bar is the
            range the true link most likely lies in.
          </li>
          <li>
            A link is not a cause. It cannot say whether a better life leads to a cleaner environment, the other way round, or
            something else leads to both. Comparing countries of similar wealth rules out the biggest other explanation, not all
            of them.
          </li>
          <li>
            Quality of life and wealth go together very closely here ({signed(lifeAndWealth.r)} across {lifeAndWealth.n} countries),
            partly because the UN’s measure counts income. So a link that survives holding wealth level is worth noticing.
          </li>
          <li>The Research paper view has every figure, how each was worked out, and the sources to cite.</li>
        </ul>
      </section>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200 ${
        on ? 'bg-slate-900 text-white' : 'bg-slate-900/5 text-slate-700 hover:bg-slate-900/10'
      }`}
    >
      {children}
    </button>
  )
}

function GroupSentence({ group: g, name, metric }: { group: WealthGroup; name: string; metric: MetricId }) {
  const m = METRICS[metric]
  return (
    <p role="status" className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-sm text-slate-800">
      Among the {name.toLowerCase()} of countries ({figure('gdp', g.from)} to {figure('gdp', g.to)} a person):{' '}
      {g.strength === 'no clear'
        ? `no clear link between quality of life and ${m.label.toLowerCase()}`
        : `a better quality of life goes with ${betterTogether(g, metric) ? m.good : m.bad} (a ${g.strength} link)`}
      , {g.n} countries.
    </p>
  )
}

/** Quality of life against one measure, a dot per country; hover or search to see one. */
function Scatter({ findings, metric, group }: { findings: Findings; metric: MetricId; group: WealthGroup | null }) {
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const rows = [...findings.table.entries()]
    .filter(([, r]) => Number.isFinite(r.life) && Number.isFinite(r[metric]))
    .map(([code, r]) => ({ code, ...r }))
  const inGroup = (r: (typeof rows)[number]) => !group || (Number.isFinite(r.gdp) && r.gdp! >= group.from && r.gdp! <= group.to)
  const q = query.trim().toLowerCase()
  const found = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : []
  const W = 600
  const H = 300
  const pad = { left: 56, right: 16, top: 12, bottom: 40 }
  const xs = rows.map((r) => r.life!)
  const ys = rows.map((r) => r[metric]!)
  const [x0, x1] = [Math.min(0.3, ...xs), 1]
  // The top of the chart at the 95th in every 100, so a handful of extreme
  // countries do not squash the rest into a line along the bottom.
  const sorted = [...ys].sort((a, b) => a - b)
  const top = Math.max(sorted[Math.floor(sorted.length * 0.95)] ?? 1, 1e-9)
  const above = ys.filter((y) => y > top).length
  const px = (x: number) => pad.left + ((x - x0) / (x1 - x0)) * (W - pad.left - pad.right)
  const py = (y: number) => H - pad.bottom - (Math.min(y, top) / top) * (H - pad.top - pad.bottom)
  const bandOf = (life: number) => Math.max(0, LIFE_BANDS.findIndex((b) => life >= b.from && life < b.below))
  const shown = rows.find((r) => r.code === hover) ?? (found.length === 1 ? found[0] : undefined)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top)
  return (
    <figure>
      <label className="flex items-center gap-2 text-xs text-slate-700">
        Find a country
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a name"
          className="w-48 rounded-lg border border-slate-900/15 bg-white/80 px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-slate-900/15"
        />
        {q && (
          <span className="text-slate-500">
            {found.length === 0 ? 'none found' : found.length === 1 ? found[0].name : `${found.length} found`}
          </span>
        )}
      </label>
      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`Quality of life against ${METRICS[metric].label.toLowerCase()}, one dot per country`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={py(t)} y2={py(t)} stroke="#e2e8f0" />
              <text x={pad.left - 6} y={py(t) + 4} textAnchor="end" fontSize="11" fill="#64748b">
                {figure(metric, t)}
              </text>
            </g>
          ))}
          {[0.4, 0.55, 0.7, 0.8, 0.9, 1]
            .filter((t) => t >= x0)
            .map((t) => (
              <text key={t} x={px(t)} y={H - pad.bottom + 16} textAnchor="middle" fontSize="11" fill="#64748b">
                {t.toFixed(2)}
              </text>
            ))}
          <text x={(pad.left + W - pad.right) / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="#334155">
            Quality of life (0 to 1) →
          </text>
          {rows.map((r) => {
            const lit = inGroup(r)
            const picked = r.code === shown?.code || found.some((f) => f.code === r.code)
            return (
              <circle
                key={r.code}
                data-testid="country-dot"
                data-in-group={lit ? 'yes' : 'no'}
                data-picked={picked ? 'yes' : 'no'}
                cx={px(r.life!)}
                cy={py(r[metric]!)}
                r={picked ? 6 : 3.4}
                fill={BAND_COLORS[bandOf(r.life!)]}
                fillOpacity={lit ? 1 : 0.12}
                stroke="#0f172a"
                strokeOpacity={picked ? 1 : lit ? 0.35 : 0.1}
                strokeWidth={picked ? 2 : 0.6}
                onMouseEnter={() => setHover(r.code)}
                style={{ transition: 'fill-opacity 250ms, r 200ms', cursor: 'pointer' }}
              >
                <title>{`${r.name}: quality of life ${figure('life', r.life!)}, ${figure(metric, r[metric]!)} ${METRICS[metric].unit}`}</title>
              </circle>
            )
          })}
        </svg>
        {shown && (
          <div role="status" aria-label="Country" className="pointer-events-none absolute right-2 top-2 rounded-lg bg-white/95 px-3 py-2 text-xs shadow">
            <span className="block font-medium text-slate-900">{shown.name}</span>
            <span className="block text-slate-600">Quality of life: {figure('life', shown.life!)}</span>
            <span className="block text-slate-600">
              {METRICS[metric].label}: {figure(metric, shown[metric]!)} {METRICS[metric].unit}
            </span>
            {Number.isFinite(shown.gdp) && <span className="block text-slate-600">Wealth: {figure('gdp', shown.gdp!)} a person</span>}
          </div>
        )}
      </div>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>
          {rows.length} countries.{group ? ` Bright: the ${rows.filter(inGroup).length} in this wealth group.` : ''} Up the chart:{' '}
          {METRICS[metric].label.toLowerCase()}, {METRICS[metric].unit}.
          {above > 0 ? ` ${above} sit above the top and are drawn along it.` : ''}
        </span>
        {LIFE_BANDS.map((b, i) => (
          <span key={b.label} className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-slate-900/30" style={{ background: BAND_COLORS[i] }} />
            {b.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

function BandBars({ findings, metric }: { findings: Findings; metric: MetricId }) {
  const bands = byLifeBand(findings.table, metric)
  const most = Math.max(...bands.map((b) => (Number.isFinite(b.median) ? b.median : 0)), 1e-9)
  return (
    <ul className="mt-2 space-y-1.5" aria-label={`Middle ${METRICS[metric].label.toLowerCase()} figure in each quality-of-life band`}>
      {bands.map((b, i) => (
        <li key={b.band} className="grid grid-cols-[6.5rem_1fr_5rem] items-center gap-2 text-xs">
          <span className="text-slate-700">
            {b.band}
            <span className="block text-[10px] text-slate-500">{b.n} countries</span>
          </span>
          <span className="h-3 rounded-full bg-slate-900/5">
            <span
              className="block h-3 rounded-full transition-[width] duration-500"
              style={{ width: `${Number.isFinite(b.median) ? (b.median / most) * 100 : 0}%`, background: BAND_COLORS[i] }}
            />
          </span>
          <span className="tabular-nums text-slate-800">{figure(metric, b.median)}</span>
        </li>
      ))}
    </ul>
  )
}

function Matrix({ pairs, hold }: { pairs: Link[]; hold: boolean }) {
  const pairOf = (a: MetricId, b: MetricId) => pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))
  return (
    <>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-center text-xs tabular-nums">
          <thead className="text-slate-500">
            <tr>
              <td />
              {ORDER.map((id) => (
                <th key={id} scope="col" className="px-1 py-1 font-medium">
                  {METRICS[id].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORDER.map((row) => (
              <tr key={row}>
                <th scope="row" className="px-2 py-1 text-left font-medium text-slate-900">
                  {METRICS[row].label}
                </th>
                {ORDER.map((col) => {
                  if (row === col) return <td key={col} className="px-1 py-1 text-slate-300">·</td>
                  const pair = pairOf(row, col)
                  const shown = hold ? pair?.heldLevel ?? null : pair ?? null
                  if (!shown) return <td key={col} className="px-1 py-1 text-slate-300">–</td>
                  const size = Math.min(1, Math.abs(shown.r))
                  const faint = shown.strength === 'no clear'
                  return (
                    <td
                      key={col}
                      className="px-1 py-1 transition-colors duration-300"
                      style={{
                        background: faint ? 'transparent' : shown.r > 0 ? `rgba(37, 99, 235, ${size * 0.35})` : `rgba(225, 29, 72, ${size * 0.35})`,
                      }}
                      title={`${shown.n} countries · luck: ${chance(shown.p)}`}
                    >
                      <span className={faint ? 'text-slate-400' : 'text-slate-900'}>{signed(shown.r)}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Blue: the two rise together. Red: one rises as the other falls. Grey: no clear link.{' '}
        {hold ? 'Wealth itself is left out while it is held level.' : ''}
      </p>
    </>
  )
}

// --- Research paper -----------------------------------------------------------------

/** Hand a file to the person's browser to save. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function Paper({ findings }: { findings: Findings }) {
  const paper = useMemo(() => researchPaper(findings), [findings])
  return (
    <article aria-label="Research paper" className="text-sm leading-relaxed text-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => download(`tidy-findings-${findings.readOn}.md`, paperToMarkdown(paper), 'text/markdown')}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
        >
          Download the paper
        </button>
        <button
          type="button"
          onClick={() => download(`tidy-findings-data-${findings.readOn}.csv`, tableToCsv(findings), 'text/csv')}
          className="rounded-lg bg-slate-900/5 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-900/10"
        >
          Download the data
        </button>
        <span className="text-[11px] text-slate-500">The paper as a Markdown document; every country’s figures as a spreadsheet file.</span>
      </div>

      <h1 className="mt-4 text-xl font-semibold text-slate-900">{paper.title}</h1>
      <p className="text-sm italic text-slate-600">{paper.subtitle}</p>

      <nav aria-label="Contents" className="mt-3 rounded-lg bg-slate-900/5 px-3 py-2 text-xs">
        <span className="font-medium text-slate-900">Contents: </span>
        {paper.sections.map((s, i) => (
          <span key={s.id}>
            {i > 0 && ' · '}
            <a href={`#paper-${s.id}`} className="text-slate-700 underline decoration-slate-400 underline-offset-2 hover:text-slate-900">
              {s.heading}
            </a>
          </span>
        ))}
      </nav>

      {paper.sections.map((section) => (
        <section key={section.id} id={`paper-${section.id}`} aria-labelledby={`paper-${section.id}-h`} className="mt-5">
          <h2 id={`paper-${section.id}-h`} className="text-base font-semibold text-slate-900">
            {section.heading}
          </h2>
          {section.blocks.map((block, i) => (
            <PaperBlock key={i} block={block} />
          ))}
        </section>
      ))}
    </article>
  )
}

function PaperBlock({ block }: { block: Block }) {
  if (block.kind === 'p') return <p className="mt-2">{block.text}</p>
  if (block.kind === 'list')
    return (
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    )
  return (
    <figure className="mt-3">
      <figcaption id={block.id} className="text-xs font-semibold text-slate-900">
        {block.caption}
      </figcaption>
      <div className="mt-1 overflow-x-auto">
        <table aria-labelledby={block.id} className="w-full min-w-[36rem] border-collapse text-left text-xs tabular-nums">
          <thead>
            <tr className="border-y border-slate-900/30">
              {block.head.map((h, i) => (
                <th key={i} scope="col" className="px-2 py-1 font-semibold text-slate-900">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-900/10">
                {row.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-2 py-1 font-medium text-slate-900">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className="px-2 py-1">
                      {c}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.note && <p className="mt-1 text-[11px] italic text-slate-500">{block.note}</p>}
    </figure>
  )
}
