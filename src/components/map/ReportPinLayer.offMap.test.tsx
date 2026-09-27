import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReportPinLayer, OFF_MAP_COLOR, MIN_PIN_RADIUS } from './ReportPinLayer'
import type { ReportView } from '../../lib/data/types'

/**
 * A pin off the map is sent only to its reporter and to admins. It must not
 * look like litter anybody else can see, and must not change how the live pins
 * around it are ranked.
 */

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ radius, pathOptions }: { radius: number; pathOptions: Record<string, unknown> }) => (
    <button
      type="button"
      data-testid="pin"
      data-radius={radius}
      data-fill={String(pathOptions.fillColor)}
      data-dash={String(pathOptions.dashArray ?? '')}
    />
  ),
}))

const report = (over: Partial<ReportView> & { id: string }): ReportView => ({
  reporterName: null,
  removalReason: null,
  lat: 51.5,
  lng: -0.12,
  note: null,
  noteStatus: 'approved',
  moderationStatus: 'approved',
  status: 'open',
  voteCount: 0,
  createdAt: new Date().toISOString(),
  cells: {},
  photos: [],
  viewerHasVoted: false,
  viewerIsReporter: false,
  ...over,
})

const pins = () => screen.getAllByTestId('pin')

describe('ReportPinLayer — a pin off the map', () => {
  it('is drawn grey, dashed and small, whatever its confirmations', () => {
    render(
      <ReportPinLayer
        reports={[report({ id: 'off', moderationStatus: 'rejected', voteCount: 50 })]}
        onSelect={vi.fn()}
      />,
    )
    const [pin] = pins()
    expect(pin.getAttribute('data-fill')).toBe(OFF_MAP_COLOR)
    expect(pin.getAttribute('data-dash')).not.toBe('')
    expect(Number(pin.getAttribute('data-radius'))).toBe(MIN_PIN_RADIUS)
  })

  it('does not change how the live pins around it look', () => {
    const live = [report({ id: 'a', voteCount: 1 }), report({ id: 'b', voteCount: 4 })]
    const { unmount } = render(<ReportPinLayer reports={live} onSelect={vi.fn()} />)
    const without = pins().map((pin) => [pin.getAttribute('data-fill'), pin.getAttribute('data-radius')])
    unmount()

    render(
      <ReportPinLayer
        reports={[...live, report({ id: 'off', moderationStatus: 'rejected', voteCount: 99 })]}
        onSelect={vi.fn()}
      />,
    )
    const withIt = pins()
      .slice(0, 2)
      .map((pin) => [pin.getAttribute('data-fill'), pin.getAttribute('data-radius')])
    expect(withIt).toEqual(without)
  })
})
