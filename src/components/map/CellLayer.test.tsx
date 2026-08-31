import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CellLayer } from './CellLayer'
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
    const [cold, warm] = screen.getAllByTestId('cell')
    expect(cold).toHaveAttribute('data-fill', colorForT(0))
    expect(warm).toHaveAttribute('data-fill', colorForT(1))
    expect(cold.getAttribute('data-fill')).not.toBe(warm.getAttribute('data-fill'))
  })

  it('gives every cell a real boundary polygon', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 0)]} />)
    expect(Number(screen.getByTestId('cell').getAttribute('data-points'))).toBeGreaterThanOrEqual(
      6,
    )
  })

  it('keeps the basemap readable by not filling opaquely', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 1)]} />)
    expect(Number(screen.getByTestId('cell').getAttribute('data-opacity'))).toBeLessThan(1)
  })

  it('honours an explicit fill opacity', () => {
    render(<CellLayer cells={[cell(london.cell_r7, 1)]} fillOpacity={0.2} />)
    expect(screen.getByTestId('cell')).toHaveAttribute('data-opacity', '0.2')
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
