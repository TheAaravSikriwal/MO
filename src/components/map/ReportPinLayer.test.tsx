import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ReportPinLayer,
  CLEANED_COLOR,
  MIN_PIN_RADIUS,
  MAX_PIN_RADIUS,
  PIN_T_FLOOR,
} from './ReportPinLayer'
import { oklch } from 'culori'
import { colorForT } from '../../lib/color/ramp'
import type { ReportView } from '../../lib/data/types'

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ center, radius, pathOptions, eventHandlers }: any) => (
    <button
      type="button"
      data-testid="pin"
      data-center={JSON.stringify(center)}
      data-radius={radius}
      data-fill={pathOptions.fillColor}
      data-stroke={pathOptions.color}
      data-weight={pathOptions.weight}
      onClick={eventHandlers?.click}
    />
  ),
}))

const report = (over: Partial<ReportView> & { id: string }): ReportView => ({
  reporterName: null,
  removalReason: null,
  lat: 51.5,
  lng: -0.12,
  note: 'Bags of rubbish by the bus stop',
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
const radiusOf = (el: HTMLElement) => Number(el.getAttribute('data-radius'))

describe('ReportPinLayer', () => {
  it('draws one pin per report', () => {
    render(
      <ReportPinLayer reports={[report({ id: 'a' }), report({ id: 'b' })]} onSelect={vi.fn()} />,
    )
    expect(pins()).toHaveLength(2)
  })

  it('puts each pin where the report is', () => {
    render(<ReportPinLayer reports={[report({ id: 'a', lat: 1.5, lng: -2.5 })]} onSelect={vi.fn()} />)
    expect(pins()[0]).toHaveAttribute('data-center', '[1.5,-2.5]')
  })

  it('renders nothing when there is nothing to show', () => {
    render(<ReportPinLayer reports={[]} onSelect={vi.fn()} />)
    expect(screen.queryByTestId('pin')).not.toBeInTheDocument()
  })

  it('opens the report when a pin is tapped', async () => {
    const onSelect = vi.fn()
    const target = report({ id: 'a' })
    render(<ReportPinLayer reports={[target]} onSelect={onSelect} />)

    await userEvent.setup().click(pins()[0])
    expect(onSelect).toHaveBeenCalledWith(target)
  })
})

describe('ReportPinLayer — how much attention a spot has', () => {
  it('makes a more-confirmed report bigger than a less-confirmed one', () => {
    render(
      <ReportPinLayer
        reports={[report({ id: 'quiet', voteCount: 0 }), report({ id: 'busy', voteCount: 20 })]}
        onSelect={vi.fn()}
      />,
    )
    const [quiet, busy] = pins()
    expect(radiusOf(busy)).toBeGreaterThan(radiusOf(quiet))
  })

  it('keeps every pin within a tappable size range', () => {
    render(
      <ReportPinLayer
        reports={[
          report({ id: 'a', voteCount: 0 }),
          report({ id: 'b', voteCount: 5 }),
          report({ id: 'c', voteCount: 9999 }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    for (const pin of pins()) {
      expect(radiusOf(pin)).toBeGreaterThanOrEqual(MIN_PIN_RADIUS)
      expect(radiusOf(pin)).toBeLessThanOrEqual(MAX_PIN_RADIUS)
    }
  })

  it('colours a report from its place on the same ramp the map uses', () => {
    render(
      <ReportPinLayer
        reports={[report({ id: 'quiet', voteCount: 0 }), report({ id: 'busy', voteCount: 20 })]}
        onSelect={vi.fn()}
      />,
    )
    const [quiet, busy] = pins()
    expect(quiet).toHaveAttribute('data-fill', colorForT(PIN_T_FLOOR))
    expect(busy).toHaveAttribute('data-fill', colorForT(1))
  })

  it('never draws the quietest pin white, which would be invisible', () => {
    // colorForT(0) is #ffffff, and a white circle on a pale basemap with a
    // white outline cannot be seen at all.
    render(<ReportPinLayer reports={[report({ id: 'quiet', voteCount: 0 })]} onSelect={vi.fn()} />)
    const pin = pins()[0]
    expect(pin.getAttribute('data-fill')).not.toBe('#ffffff')
    expect(oklch(pin.getAttribute('data-fill')!)!.c).toBeGreaterThan(0.02)
  })

  it('outlines every pin in something darker than the fill', () => {
    render(
      <ReportPinLayer
        reports={[report({ id: 'quiet', voteCount: 0 }), report({ id: 'busy', voteCount: 9 })]}
        onSelect={vi.fn()}
      />,
    )
    for (const pin of pins()) {
      const stroke = oklch(pin.getAttribute('data-stroke')!)!
      const fill = oklch(pin.getAttribute('data-fill')!)!
      expect(stroke.l).toBeLessThan(fill.l)
    }
  })

  it('ranks against the other pins on screen, not against a fixed scale', () => {
    // A street with one report must not look identical to one with twenty.
    render(
      <ReportPinLayer
        reports={[
          report({ id: 'a', voteCount: 1 }),
          report({ id: 'b', voteCount: 2 }),
          report({ id: 'c', voteCount: 3 }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    const fills = pins().map((pin) => pin.getAttribute('data-fill'))
    expect(new Set(fills).size).toBe(3)
  })
})

describe('ReportPinLayer — cleaned spots', () => {
  it('shows a cleaned report in its own colour, not as a quiet one', () => {
    render(<ReportPinLayer reports={[report({ id: 'a', status: 'cleaned' })]} onSelect={vi.fn()} />)
    expect(pins()[0]).toHaveAttribute('data-fill', CLEANED_COLOR)
  })

  it('does not let a cleaned report affect how the open ones are ranked', () => {
    // Cleaned reports drop out of the weighting everywhere else; if they counted
    // here the map would cool down more slowly than the cells do.
    const withCleaned = render(
      <ReportPinLayer
        reports={[
          report({ id: 'a', voteCount: 1 }),
          report({ id: 'b', voteCount: 5 }),
          report({ id: 'gone', voteCount: 99, status: 'cleaned' }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    const withCleanedFills = pins()
      .slice(0, 2)
      .map((pin) => pin.getAttribute('data-fill'))
    withCleaned.unmount()

    render(
      <ReportPinLayer
        reports={[report({ id: 'a', voteCount: 1 }), report({ id: 'b', voteCount: 5 })]}
        onSelect={vi.fn()}
      />,
    )
    const withoutFills = pins().map((pin) => pin.getAttribute('data-fill'))
    expect(withCleanedFills).toEqual(withoutFills)
  })

  it('still lets a cleaned report be opened', async () => {
    const onSelect = vi.fn()
    render(<ReportPinLayer reports={[report({ id: 'a', status: 'cleaned' })]} onSelect={onSelect} />)
    await userEvent.setup().click(pins()[0])
    expect(onSelect).toHaveBeenCalled()
  })
})

describe('ReportPinLayer — the selected pin', () => {
  it('marks the open report distinctly', () => {
    render(
      <ReportPinLayer
        reports={[report({ id: 'a' }), report({ id: 'b' })]}
        onSelect={vi.fn()}
        selectedId="b"
      />,
    )
    const [a, b] = pins()
    expect(b.getAttribute('data-stroke')).not.toBe(a.getAttribute('data-stroke'))
    expect(Number(b.getAttribute('data-weight'))).toBeGreaterThan(
      Number(a.getAttribute('data-weight')),
    )
  })

  it('marks nothing when nothing is open', () => {
    render(
      <ReportPinLayer
        reports={[report({ id: 'a' }), report({ id: 'b' })]}
        onSelect={vi.fn()}
        selectedId={null}
      />,
    )
    const [a, b] = pins()
    expect(a.getAttribute('data-stroke')).toBe(b.getAttribute('data-stroke'))
    expect(a.getAttribute('data-weight')).toBe(b.getAttribute('data-weight'))
  })
})
