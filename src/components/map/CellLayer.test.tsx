import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CellLayer, MIN_FILL_OPACITY, MAX_FILL_OPACITY } from './CellLayer'
import { cellsForPoint } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'

vi.mock('react-leaflet', () => ({
  Polygon: ({ positions, pathOptions }: any) => (
    <div
      data-testid="cell"
      data-points={positions.length}
      data-fill={pathOptions.fillColor}
      data-stroke={String(pathOptions.stroke)}
      data-opacity={pathOptions.fillOpacity}
    />
  ),
}))

const london = cellsForPoint(51.5007, -0.1246)
const sydney = cellsForPoint(-33.8568, 151.2153)

const cell = (id: string, t: number) => ({ cell: id, weight: 1, reportCount: 1, t })
const opacityOf = (el: HTMLElement) => Number(el.getAttribute('data-opacity'))

describe('CellLayer', () => {
  it('renders one polygon per cell', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 0), cell(sydney.cell_r7, 1)]} />)
    expect(screen.getAllByTestId('cell')).toHaveLength(2)
  })

  it('draws fill only, with no stroke, so adjacent cells blend', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 0.5)]} />)
    expect(screen.getByTestId('cell')).toHaveAttribute('data-stroke', 'false')
  })

  it('colours each cell from its position on the ramp', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 0), cell(sydney.cell_r7, 1)]} />)
    const [clean, busy] = screen.getAllByTestId('cell')
    expect(clean).toHaveAttribute('data-fill', colorForT(0))
    expect(busy).toHaveAttribute('data-fill', colorForT(1))
  })

  it('keeps the quietest areas almost clear, so the map shows through', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 0)]} />)
    expect(opacityOf(screen.getByTestId('cell'))).toBe(MIN_FILL_OPACITY)
  })

  it('makes the busiest areas strongest, but never fully opaque', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 1)]} />)
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
    render(<CellLayer cells={[cell(london.cell_r7, 1)]} minFillOpacity={0} maxFillOpacity={0.2} />)
    expect(opacityOf(screen.getByTestId('cell'))).toBe(0.2)
  })

  it('gives every cell a real boundary polygon', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 0)]} />)
    expect(Number(screen.getByTestId('cell').getAttribute('data-points'))).toBeGreaterThanOrEqual(
      6,
    )
  })

  it('renders nothing for an empty cell list', () => {
    render(<CellLayer cells={[]} />)
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
