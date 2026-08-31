import { useEffect, type ReactNode } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { OPEN_STREET_MAP } from './tileProvider'
import 'leaflet/dist/leaflet.css'

export interface MapPosition {
  center: [number, number]
  zoom: number
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
  flyTo?: MapPosition | null
  onViewChange: (view: MapPosition) => void
  children?: ReactNode
}

function ViewWatcher({ onViewChange }: Pick<MapViewProps, 'onViewChange'>) {
  useMapEvents({
    moveend(event) {
      const map = event.target
      const { lat, lng } = map.getCenter()
      onViewChange({ center: [lat, lng], zoom: map.getZoom() })
    },
  })
  return null
}

function Recenter({ flyTo }: { flyTo: MapPosition | null | undefined }) {
  const map = useMap()
  const lat = flyTo?.center[0]
  const lng = flyTo?.center[1]
  const zoom = flyTo?.zoom

  useEffect(() => {
    if (lat === undefined || lng === undefined || zoom === undefined) return
    map.flyTo([lat, lng], zoom)
  }, [map, lat, lng, zoom])

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
