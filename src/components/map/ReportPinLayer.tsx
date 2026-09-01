import { CircleMarker } from 'react-leaflet'
import { colorForT } from '../../lib/color/ramp'
import { normaliseWeights } from '../../lib/severity/percentile'
import type { ReportView } from '../../lib/data/types'

/** A cleaned spot is not "low severity" — it is a different thing entirely. */
export const CLEANED_COLOR = '#2f9e6e'

export const MIN_PIN_RADIUS = 7
export const MAX_PIN_RADIUS = 16

export interface ReportPinLayerProps {
  reports: readonly ReportView[]
  onSelect: (report: ReportView) => void
  selectedId?: string | null
}

/**
 * Individual reports, drawn once you are close enough to tell them apart.
 *
 * Circles rather than image markers on purpose: Leaflet's default icon loads
 * from a bundled asset path that breaks under a bundler, and a coloured circle
 * carries the one thing that matters here — how many people have confirmed this
 * spot — without an image at all.
 */
export function ReportPinLayer({ reports, onSelect, selectedId }: ReportPinLayerProps) {
  const open = reports.filter((report) => report.status === 'open')

  // Ranked against the other pins on screen, the same way cells are, so a
  // street with one report does not look identical to one with twenty.
  const ranked = normaliseWeights(
    open.map((report) => ({
      cell: report.id,
      weight: 1 + Math.max(0, report.voteCount),
      reportCount: 1,
    })),
  )
  const tById = new Map(ranked.map((entry) => [entry.cell, entry.t]))

  return (
    <>
      {reports.map((report) => {
        const cleaned = report.status === 'cleaned'
        const t = tById.get(report.id) ?? 0
        const selected = report.id === selectedId

        return (
          <CircleMarker
            key={report.id}
            center={[report.lat, report.lng]}
            radius={
              cleaned
                ? MIN_PIN_RADIUS
                : MIN_PIN_RADIUS + (MAX_PIN_RADIUS - MIN_PIN_RADIUS) * t
            }
            pathOptions={{
              fillColor: cleaned ? CLEANED_COLOR : colorForT(t),
              fillOpacity: cleaned ? 0.55 : 0.85,
              // Pins get an outline, unlike cells: at this zoom they sit on top
              // of streets and buildings and need to stay distinguishable from
              // the map underneath.
              color: selected ? '#0f172a' : '#ffffff',
              weight: selected ? 3 : 1.5,
            }}
            eventHandlers={{ click: () => onSelect(report) }}
          />
        )
      })}
    </>
  )
}
