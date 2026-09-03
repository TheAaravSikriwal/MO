import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CellLayer,
  MIN_FILL_OPACITY,
  MAX_FILL_OPACITY,
  CROSSFADE_MS,
  CELL_CLASS,
  MAX_LAYERS,
} from './CellLayer'
import { cellsForPoint } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'

vi.mock('react-leaflet', () => ({
  Polygon: ({ positions, pathOptions, className }: any) => (
    <div
      data-testid="cell"
      data-points={positions.length}
      data-fill={pathOptions.fillColor}
      data-stroke={String(pathOptions.stroke)}
      data-opacity={pathOptions.fillOpacity}
      data-class={className}
      data-nested-class={pathOptions.className}
    />
  ),
}))

const london = cellsForPoint(51.5007, -0.1246)
const sydney = cellsForPoint(-33.8568, 151.2153)

const cell = (id: string, t: number) => ({ cell: id, weight: 1, reportCount: 1, t })
const opacityOf = (el: HTMLElement) => Number(el.getAttribute('data-opacity'))

describe('CellLayer', () => {
  it('renders one polygon per cell', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 0), cell(sydney.cell_r7, 1)]} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(2)
  })

  it('draws fill only, with no stroke, so adjacent cells blend', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 0.5)]} />)
    expect(screen.getByTestId('cell')).toHaveAttribute('data-stroke', 'false')
  })

  it('colours each cell from its position on the ramp', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 0), cell(sydney.cell_r7, 1)]} />)
    const [clean, busy] = screen.getAllByTestId('cell')
    expect(clean).toHaveAttribute('data-fill', colorForT(0))
    expect(busy).toHaveAttribute('data-fill', colorForT(1))
  })

  it('keeps the quietest areas almost clear, so the map shows through', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 0)]} />)
    expect(opacityOf(screen.getByTestId('cell'))).toBe(MIN_FILL_OPACITY)
  })

  it('makes the busiest areas strongest, but never fully opaque', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 1)]} />)
    const opacity = opacityOf(screen.getByTestId('cell'))
    expect(opacity).toBe(MAX_FILL_OPACITY)
    expect(opacity).toBeLessThan(1)
  })

  it('raises opacity with severity', () => {
    render(
      <CellLayer
        cells={[cell(london.cell_r7, 0), cell(london.cell_r9, 0.5), cell(sydney.cell_r7, 1)]}
      />,
    )
    const [low, mid, high] = screen.getAllByTestId('cell').map(opacityOf)
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
  })

  it('honours explicit opacity bounds', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 1)]} minFillOpacity={0} maxFillOpacity={0.2} />)
    expect(opacityOf(screen.getByTestId('cell'))).toBe(0.2)
  })

  it('gives every cell a real boundary polygon', () => {
    render(<CellLayer crossfade={false} cells={[cell(london.cell_r7, 0)]} />)
    expect(Number(screen.getByTestId('cell').getAttribute('data-points'))).toBeGreaterThanOrEqual(
      6,
    )
  })

  it('renders nothing for an empty cell list', () => {
    render(<CellLayer crossfade={false} cells={[]} />)
    expect(screen.queryByTestId('cell')).not.toBeInTheDocument()
  })

  it('renders cells at any stored resolution', () => {
    render(
      <CellLayer
        cells={[cell(london.cell_r1, 0), cell(london.cell_r9, 0.5), cell(london.cell_r12, 1)]}
      />,
    )
    expect(screen.getAllByTestId('cell')).toHaveLength(3)
  })
})

describe('CellLayer — crossing a zoom band', () => {
  const at = (id: string, t = 0.5) => [{ cell: id, weight: 1, reportCount: 1, t }]
  const opacities = () =>
    screen.getAllByTestId('cell').map((c) => Number(c.getAttribute('data-opacity')))

  it('holds the outgoing cells on screen while the new ones arrive', () => {
    // Unmounting one set and mounting the other in a single frame reads as a
    // flicker across the whole map.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(1)

    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(2)
  })

  it('does not fade on a pan, only on a change of zoom band', async () => {
    // cells is a fresh array after every pan and every filter change. Fading on
    // that made the whole map pulse darker each time it was dragged.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    rerender(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)

    expect(screen.getAllByTestId('cell')).toHaveLength(1)
    expect(opacities()[0]).toBeGreaterThan(0)
  })

  it('starts the incoming set at zero, so it rises rather than snapping in', () => {
    // A freshly created path has no previous value to transition from, so it
    // has to mount at nothing and rise on a later commit. The outgoing set
    // needs no such dance: it is already on screen, so setting its target to
    // zero is what starts its ramp down.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7, 1)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9, 1)} />)

    expect(opacities()[1]).toBe(0)
  })

  it('drives the outgoing set to zero rather than culling it part-way', async () => {
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7, 1)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9, 1)} />)

    // The next frame swaps them over.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const [leaving, arriving] = opacities()
    expect(leaving).toBe(0)
    expect(arriving).toBeGreaterThan(0)
  })

  it('drops the outgoing set once the fade is over', async () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
      rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
      expect(screen.getAllByTestId('cell')).toHaveLength(2)

      await act(async () => {
        vi.advanceTimersByTime(CROSSFADE_MS + 20)
      })
      expect(screen.getAllByTestId('cell')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires every layer even after the cap has trimmed one', async () => {
    // Once the cap drops a layer, its timer outlives it. If a timer removes
    // "the oldest survivor" rather than its own layers, that surplus timer
    // culls a layer that is still ramping down.
    vi.useFakeTimers()
    try {
      const { rerender } = render(<CellLayer fadeKey={1} cells={at(london.cell_r1)} />)
      const bands: Array<[number, string]> = [
        [3, london.cell_r3],
        [5, london.cell_r5],
        [7, london.cell_r7],
        [9, london.cell_r9],
        [12, london.cell_r12],
      ]
      for (const [key, cell] of bands) {
        rerender(<CellLayer fadeKey={key} cells={at(cell)} />)
        await act(async () => {
          vi.advanceTimersByTime(20)
        })
      }
      expect(screen.getAllByTestId("cell").length).toBeLessThanOrEqual(MAX_LAYERS)

      await act(async () => {
        vi.advanceTimersByTime(CROSSFADE_MS * 2)
      })
      // Exactly the live set: nothing stranded, nothing removed twice.
      expect(screen.getAllByTestId("cell")).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps how many layers can pile up on a long zoom', async () => {
    // Several bands can be crossed inside one fade. They must overlap rather
    // than cull each other, but not without bound.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
    rerender(<CellLayer fadeKey={12} cells={at(london.cell_r12)} />)
    rerender(<CellLayer fadeKey={1} cells={at(london.cell_r1)} />)
    rerender(<CellLayer fadeKey={3} cells={at(london.cell_r3)} />)
    rerender(<CellLayer fadeKey={5} cells={at(london.cell_r5)} />)

    expect(screen.getAllByTestId('cell').length).toBeLessThanOrEqual(MAX_LAYERS)
  })

  it('does not cull an earlier layer part-way through its fade', () => {
    // Culling it at roughly half opacity drops that much alpha across the whole
    // viewport in one frame -- the flash this feature exists to remove.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(2)

    rerender(<CellLayer fadeKey={12} cells={at(london.cell_r12)} />)
    // All three still present: the first is still ramping down.
    expect(screen.getAllByTestId('cell')).toHaveLength(3)
  })

  it('retires each layer on its own timer, not all at once', async () => {
    // Staged in time on purpose. With both crossings at t=0 their timers fire
    // together, so a shared "clear everything" and a per-layer retirement look
    // identical -- the test could not tell them apart.
    vi.useFakeTimers()
    try {
      const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
      rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)

      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      rerender(<CellLayer fadeKey={12} cells={at(london.cell_r12)} />)
      expect(screen.getAllByTestId('cell')).toHaveLength(3)

      // The first crossing's timer fires; only the oldest layer goes.
      await act(async () => {
        vi.advanceTimersByTime(140)
      })
      expect(screen.getAllByTestId('cell')).toHaveLength(2)

      // The second crossing's timer fires later, on its own schedule.
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.getAllByTestId('cell')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('swaps instantly when the fade is turned off', () => {
    const { rerender } = render(
      <CellLayer crossfade={false} fadeKey={7} cells={at(london.cell_r7)} />,
    )
    rerender(<CellLayer crossfade={false} fadeKey={9} cells={at(london.cell_r9)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(1)
  })

  it('swaps instantly for anyone who has asked for less motion', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({ matches: query.includes('reduce'), media: query })) as unknown as typeof window.matchMedia
    try {
      const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
      rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
      expect(screen.getAllByTestId('cell')).toHaveLength(1)
    } finally {
      window.matchMedia = original
    }
  })

  it('does not fade in from nothing on the very first render', () => {
    render(<CellLayer fadeKey={7} cells={at(london.cell_r7, 1)} />)
    expect(opacities()[0]).toBeGreaterThan(0)
  })

  it('keeps the stylesheet duration and CROSSFADE_MS in step', () => {
    // They are tuned to end together. A silent mismatch deletes the outgoing
    // layer part-way through its fade -- a visible step across the whole map.
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')
    const declared = css.match(/\.mo-cell\s*\{[^}]*transition:\s*fill-opacity\s+(\d+)ms/)
    expect(declared).not.toBeNull()
    expect(Number(declared![1])).toBe(CROSSFADE_MS)
  })
})

describe('CellLayer — a refetch must not strand the fade', () => {
  const at = (id: string, t = 0.5) => [{ cell: id, weight: 1, reportCount: 1, t }]

  it('still finishes the fade when new data arrives mid-fade', async () => {
    // A pan or a filter change refetches, producing a fresh cells array. If the
    // fade lifecycle is keyed on that array, the refetch cancels the timer that
    // ends the fade and the outgoing set never leaves the screen.
    vi.useFakeTimers()
    try {
      const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
      rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
      expect(screen.getAllByTestId('cell')).toHaveLength(2)

      // Same zoom band, new array — exactly what a pan produces.
      rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)

      await act(async () => {
        vi.advanceTimersByTime(CROSSFADE_MS + 20)
      })
      expect(screen.getAllByTestId('cell')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CellLayer — the fade cannot get stuck', () => {
  const at = (id: string, t = 0.5) => [{ cell: id, weight: 1, reportCount: 1, t }]

  it('never fades a set against itself', () => {
    // The key can change before the new cells arrive. Fading identical data
    // dips the combined alpha and pulses the whole map, which is the artefact
    // the fade exists to remove.
    const same = at(london.cell_r7)
    const { rerender } = render(<CellLayer fadeKey={7} cells={same} />)
    rerender(<CellLayer fadeKey={9} cells={same} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(1)
  })

  it('fades out rather than vanishing when the next band is empty', async () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
      rerender(<CellLayer fadeKey={9} cells={[]} />)
      // The old cells stay while they fade, rather than blinking out.
      expect(screen.getAllByTestId('cell')).toHaveLength(1)

      await act(async () => {
        vi.advanceTimersByTime(CROSSFADE_MS + 20)
      })
      expect(screen.queryAllByTestId('cell')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not strand cells when a fade starts from an empty band', async () => {
    // React runs the previous cleanup before re-running the effect, so an early
    // return used to leave the outgoing set with no timer to remove it --
    // invisible but still attached, and re-projected on every pan.
    vi.useFakeTimers()
    try {
      const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
      rerender(<CellLayer fadeKey={9} cells={[]} />)
      // Now the previous set IS empty, which is the early-return path.
      rerender(<CellLayer fadeKey={5} cells={at(london.cell_r5)} />)

      await act(async () => {
        vi.advanceTimersByTime(CROSSFADE_MS * 3)
      })
      expect(screen.getAllByTestId('cell')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a running fade when motion is switched off mid-fade', () => {
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(2)

    rerender(<CellLayer crossfade={false} fadeKey={12} cells={at(london.cell_r12)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(1)
  })

  it('draws exactly one set on the very first render', () => {
    // Asserting only that the opacity is above zero passed even when the first
    // render started a fade, because the outgoing copy is drawn first.
    render(<CellLayer fadeKey={7} cells={at(london.cell_r7, 1)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(1)
    expect(Number(screen.getByTestId('cell').getAttribute('data-opacity'))).toBeGreaterThan(0)
  })

  it('puts the animated class where Leaflet will actually read it', () => {
    // Not inside pathOptions. react-leaflet hands the constructor
    // { pathOptions, pane, ... }, so a nested className is undefined when
    // Leaflet creates the path -- and _initPath is the only place it is ever
    // applied. Nested, the stylesheet matched nothing in a production build and
    // every fade was a hard cut.
    render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    const cell = screen.getByTestId('cell')
    expect(cell).toHaveAttribute('data-class', CELL_CLASS)
    expect(cell).not.toHaveAttribute('data-nested-class')
  })
})

describe('CellLayer — fast zooming across bands', () => {
  const at = (id: string, t = 1) => [{ cell: id, weight: 1, reportCount: 1, t }]

  it('keeps the mid-fade set mounted when a second crossing arrives', () => {
    // On the second crossing the set that was rising becomes the outgoing one.
    // If it is given a different fragment key, React tears down its Leaflet
    // layers and rebuilds them at full opacity -- a bright flash mid-zoom.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)

    // [r7, r9] -- grab the r9 node.
    const rising = screen.getAllByTestId('cell')[1]

    rerender(<CellLayer fadeKey={12} cells={at(london.cell_r12)} />)

    // [r7, r9, r12] -- the r9 node must be the same element, not rebuilt.
    expect(screen.getAllByTestId('cell')[1]).toBe(rising)
  })
})

describe('CellLayer — turning motion off mid-fade', () => {
  const at = (id: string) => [{ cell: id, weight: 1, reportCount: 1, t: 0.5 }]

  it('clears a running fade even though the zoom band did not change', () => {
    // crossfade changes without fadeKey changing, which used to return before
    // the cancel logic and strand the outgoing set for good.
    const { rerender } = render(<CellLayer fadeKey={7} cells={at(london.cell_r7)} />)
    rerender(<CellLayer fadeKey={9} cells={at(london.cell_r9)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(2)

    rerender(<CellLayer crossfade={false} fadeKey={9} cells={at(london.cell_r9)} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(1)
  })
})
