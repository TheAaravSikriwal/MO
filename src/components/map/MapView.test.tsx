import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MapView } from './MapView'
import { OPEN_STREET_MAP } from './tileProvider'

const flyToSpy = vi.fn()
// react-leaflet returns a stable map instance from context; the mock must too,
// otherwise effects keyed on map identity re-fire on every render.
const mapInstance = { flyTo: flyToSpy }

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, center, zoom }: any) => (
    <div data-testid="map" data-center={JSON.stringify(center)} data-zoom={zoom}>
      {children}
    </div>
  ),
  TileLayer: ({ url, attribution }: any) => (
    <div data-testid="tiles" data-url={url} data-attribution={attribution} />
  ),
  useMap: () => mapInstance,
  useMapEvents: () => null,
}))

describe('MapView', () => {
  const noop = () => {}

  it('opens at the requested centre and zoom', () => {
    render(<MapView initialCenter={[51.5, -0.12]} initialZoom={13} onViewChange={noop} />)
    const map = screen.getByTestId('map')
    expect(map).toHaveAttribute('data-center', '[51.5,-0.12]')
    expect(map).toHaveAttribute('data-zoom', '13')
  })

  it('renders tiles from the configured provider', () => {
    render(<MapView initialCenter={[0, 0]} initialZoom={2} onViewChange={noop} />)
    expect(screen.getByTestId('tiles')).toHaveAttribute('data-url', OPEN_STREET_MAP.url)
  })

  it('credits the tile source', () => {
    render(<MapView initialCenter={[0, 0]} initialZoom={2} onViewChange={noop} />)
    expect(screen.getByTestId('tiles').getAttribute('data-attribution')).toContain(
      'OpenStreetMap',
    )
  })

  it('renders its children as map layers', () => {
    render(
      <MapView initialCenter={[0, 0]} initialZoom={2} onViewChange={noop}>
        <div data-testid="layer" />
      </MapView>,
    )
    expect(screen.getByTestId('layer')).toBeInTheDocument()
  })

  it('does not move a freshly mounted map when given no fly target', () => {
    flyToSpy.mockClear()
    render(<MapView initialCenter={[0, 0]} initialZoom={2} onViewChange={noop} />)
    expect(flyToSpy).not.toHaveBeenCalled()
  })

  it('moves an already-mounted map when a fly target arrives', () => {
    flyToSpy.mockClear()
    const { rerender } = render(
      <MapView initialCenter={[0, 0]} initialZoom={2} onViewChange={noop} />,
    )
    rerender(
      <MapView
        initialCenter={[0, 0]}
        initialZoom={2}
        flyTo={{ center: [51.5073, -0.1657], zoom: 15, nonce: 1 }}
        onViewChange={noop}
      />,
    )
    expect(flyToSpy).toHaveBeenCalledWith([51.5073, -0.1657], 15)
  })

  it('does not re-fly on an unrelated re-render', () => {
    flyToSpy.mockClear()
    const target = { center: [1, 2] as [number, number], zoom: 10, nonce: 1 }
    const { rerender } = render(
      <MapView initialCenter={[0, 0]} initialZoom={2} flyTo={target} onViewChange={noop} />,
    )
    rerender(
      <MapView initialCenter={[0, 0]} initialZoom={2} flyTo={target} onViewChange={noop} />,
    )
    expect(flyToSpy).toHaveBeenCalledTimes(1)
  })

  it('flies again when asked to go somewhere it is already pointed at', () => {
    // "Update my location" after panning away returns the same cached fix, and
    // picking the same search result twice gives identical numbers. Keying on
    // the coordinates made both do nothing, which is precisely when a person
    // expects to be moved.
    flyToSpy.mockClear()
    const { rerender } = render(
      <MapView
        initialCenter={[0, 0]}
        initialZoom={2}
        flyTo={{ center: [1, 2], zoom: 10, nonce: 1 }}
        onViewChange={noop}
      />,
    )
    rerender(
      <MapView
        initialCenter={[0, 0]}
        initialZoom={2}
        flyTo={{ center: [1, 2], zoom: 10, nonce: 2 }}
        onViewChange={noop}
      />,
    )
    expect(flyToSpy).toHaveBeenCalledTimes(2)
    expect(flyToSpy).toHaveBeenLastCalledWith([1, 2], 10)
  })
})
