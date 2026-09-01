import { useEffect, type ReactNode } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { OPEN_STREET_MAP } from './tileProvider'
import 'leaflet/dist/leaflet.css'

export interface MapPosition {
  center: [number, number]
  zoom: number
}

export interface MapBounds {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

export interface MapView2 {
  center: [number, number]
  zoom: number
  bounds: MapBounds
}

/** A fly target that repeats. See Recenter below for why the nonce is needed. */
export interface FlyTarget extends MapPosition {
  nonce: number
}

export interface MapViewProps {
  /** Where the map opens. Leaflet treats this as initial state only. */
  initialCenter: [number, number]
  initialZoom: number
  /**
   * Set this to move an already-mounted map, e.g. after a place search.
   * Changing initialCenter alone does nothing once Leaflet has mounted, which is
   * the trap this prop exists to close.
   */
  flyTo?: FlyTarget | null
  onViewChange: (view: MapView2) => void
  children?: ReactNode
}

function ViewWatcher({ onViewChange }: Pick<MapViewProps, 'onViewChange'>) {
  useMapEvents({
    moveend(event) {
      const map = event.target
      const { lat, lng } = map.getCenter()
      const bounds = map.getBounds()
      onViewChange({
        center: [lat, lng],
        zoom: map.getZoom(),
        // The viewport, so what is fetched and aggregated matches what is on
        // screen rather than being an arbitrary slice of the whole planet.
        bounds: {
          minLat: bounds.getSouth(),
          minLng: bounds.getWest(),
          maxLat: bounds.getNorth(),
          maxLng: bounds.getEast(),
        },
      })
    },
  })
  return null
}

function Recenter({ flyTo }: { flyTo: FlyTarget | null | undefined }) {
  const map = useMap()
  const nonce = flyTo?.nonce

  useEffect(() => {
    if (!flyTo) return
    map.flyTo(flyTo.center, flyTo.zoom)
    // Keyed on the nonce, NOT on the coordinates.
    //
    // Depending on lat/lng/zoom meant asking to go somewhere you were already
    // pointed at did nothing: "Update my location" after panning away returns
    // the same cached fix, and picking the same search result twice produces
    // identical numbers. Both are exactly when a person expects to be moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, nonce])

  return null
}

/**
 * The map surface.
 *
 * Deliberately thin: it owns the Leaflet instance and the tile source, and
 * nothing else. Everything drawn on it arrives as children, so the cell layer
 * and the pin layer can each be tested without a map at all.
 */
export function MapView({
  initialCenter,
  initialZoom,
  flyTo,
  onViewChange,
  children,
}: MapViewProps) {
  return (
    <MapContainer
      center={initialCenter}
      zoom={initialZoom}
      className="h-full w-full"
      scrollWheelZoom
    >
      <TileLayer
        url={OPEN_STREET_MAP.url}
        attribution={OPEN_STREET_MAP.attribution}
        maxZoom={OPEN_STREET_MAP.maxZoom}
      />
      <ViewWatcher onViewChange={onViewChange} />
      <Recenter flyTo={flyTo} />
      {children}
    </MapContainer>
  )
}
