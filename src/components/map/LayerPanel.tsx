import type { ReactNode } from 'react'
import { GROUP_COLOR, T_FLOOR } from '../../lib/map/features'
import { WORLD_LAYERS, worldColor, type WorldLayerId, savedDay } from '../../lib/worlddata/worldData'
import type { WorldDataState } from '../../lib/worlddata/useWorldData'
import { colorForT } from '../../lib/color/ramp'
import { Reveal, Swap } from '../Reveal'

export interface LayerPanelProps {
  showReports: boolean
  onShowReports: (show: boolean) => void
  showGroups: boolean
  onShowGroups: (show: boolean) => void
  world: WorldLayerId | null
  onWorld: (layer: WorldLayerId | null) => void
  worldData: WorldDataState
}


/** A figure for the legend: whole numbers once they are big, one decimal below that. */
export function legendNumber(value: number): string {
  return value >= 100
    ? Math.round(value).toLocaleString('en-GB')
    : value.toLocaleString('en-GB', { maximumFractionDigits: 1 })
}

function Toggle({
  label,
  detail,
  on,
  onChange,
  swatch,
}: {
  label: string
  detail: string
  on: boolean
  onChange: (on: boolean) => void
  swatch: ReactNode
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-200 hover:bg-slate-900/5"
    >
      <span aria-hidden="true" className="shrink-0">
        {swatch}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        <span className="block text-xs text-slate-500">{detail}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-slate-900' : 'bg-slate-300'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200 ${on ? 'left-[1.1rem]' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

/** A bar of colour from one end of a scale to the other. */
function Ramp({ colors }: { colors: readonly string[] }) {
  return (
    <span
      className="block h-2 w-full rounded-full"
      style={{ background: `linear-gradient(to right, ${colors.join(', ')})` }}
    />
  )
}

const CHOICES: Array<{ id: WorldLayerId | null; label: string }> = [
  { id: null, label: 'None' },
  { id: 'air', label: 'Air' },
  { id: 'plastic', label: 'Plastic' },
  { id: 'fires', label: 'Fires' },
  { id: 'life', label: 'Quality of life' },
  { id: 'water', label: 'Water' },
]

/**
 * What is on the map, and what its colours mean.
 *
 * Litter reports and cleaning groups each switch on and off. World data is one
 * layer at a time: two country layers cannot both raise the same country, and
 * three sets of towers at once would say nothing.
 */
export function LayerPanel({
  showReports,
  onShowReports,
  showGroups,
  onShowGroups,
  world,
  onWorld,
  worldData,
}: LayerPanelProps) {
  const info = world ? WORLD_LAYERS[world] : null
  const litterColors = [0, 0.33, 0.66, 1].map((t) => colorForT(T_FLOOR + (1 - T_FLOOR) * t))
  return (
    <section aria-label="On the map" className="mo-glass rounded-2xl p-3">
      <h2 className="px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">On the map</h2>

      <div className="mt-1">
        <Toggle
          label="Litter reports"
          detail="Taller and redder where more people reported litter"
          on={showReports}
          onChange={onShowReports}
          swatch={<span className="block h-6 w-3 rounded-sm" style={{ background: `linear-gradient(to top, ${litterColors.join(', ')})` }} />}
        />
        <Reveal show={showReports}>
          <div className="px-2 pb-1">
            <Ramp colors={litterColors} />
            <div className="mt-1 flex justify-between text-[11px] text-slate-500">
              <span>A few reports</span>
              <span>Many</span>
            </div>
          </div>
        </Reveal>
        <Toggle
          label="Cleaning groups"
          detail="People who clean up an area together"
          on={showGroups}
          onChange={onShowGroups}
          swatch={<span className="block h-5 w-5 rounded-full border-[3px] bg-white" style={{ borderColor: GROUP_COLOR }} />}
        />
      </div>

      <h2 className="mt-3 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">World data</h2>
      <div role="radiogroup" aria-label="World data" className="mt-1.5 grid grid-cols-3 gap-1 rounded-xl bg-slate-900/5 p-1">
        {CHOICES.map(({ id, label }) => {
          const on = world === id
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={id ? WORLD_LAYERS[id].label : 'No world data'}
              onClick={() => onWorld(id)}
              className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors duration-200 ${
                on ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      <Reveal show={info !== null}>
        {info && (
          <div className="px-2 pt-2">
            <p className="text-sm font-medium text-slate-900">
              {info.id !== 'fires'
                ? info.label
                : worldData.status === 'ready' && worldData.legend.savedOn
                  ? `Fires in the 24 hours to ${savedDay(worldData.legend.savedOn)}`
                  : 'Fires today'}
            </p>
            <p className="text-xs text-slate-600">{info.measures}.</p>
            <Swap id={worldData.status}>
              {worldData.status === 'ready' && worldData.legend.range ? (
                <div className="mt-2">
                  <Ramp colors={[0, 0.33, 0.66, 1].map((t) => worldColor(info.id, t))} />
                  <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                    <span>{legendNumber(worldData.legend.range.low)}</span>
                    <span>
                      {legendNumber(worldData.legend.range.high)} {info.unit}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {info.id === 'fires'
                      ? `${worldData.legend.count.toLocaleString('en-GB')} hot spots seen in the ${
                          worldData.legend.savedOn ? `24 hours to ${savedDay(worldData.legend.savedOn)}` : 'last 24 hours'
                        }. `
                      : `${worldData.legend.count} ${worldData.legend.count === 1 ? 'country' : 'countries'}${worldData.legend.year ? `, ${worldData.legend.year}` : ''}. `}
                    Source: {info.source}.
                  </p>
                  {worldData.legend.savedOn && (
                    <p role="status" className="mt-1 text-[11px] text-amber-800">
                      The live file could not be reached, so this is a copy saved on {savedDay(worldData.legend.savedOn)}.
                    </p>
                  )}
                </div>
              ) : worldData.status === 'failed' ? (
                <div className="mt-2">
                  <p role="alert" className="text-xs text-rose-700">
                    {worldData.message}
                  </p>
                  <button
                    type="button"
                    onClick={worldData.retry}
                    className="mt-1.5 rounded-lg bg-slate-900/5 px-3 py-1 text-xs font-medium text-slate-800 hover:bg-slate-900/10"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <p role="status" className="mt-2 text-xs text-slate-500">
                  Loading…
                </p>
              )}
            </Swap>
          </div>
        )}
      </Reveal>
    </section>
  )
}
