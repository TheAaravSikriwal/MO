import { useMemo, useState } from 'react'
import { MapView, type MapPosition } from './components/map/MapView'
import { CellLayer } from './components/map/CellLayer'
import { resolutionForZoom } from './lib/grid/zoomResolution'
import { weighCells } from './lib/severity/weight'
import { normaliseWeights } from './lib/severity/percentile'
import { createDebouncedSearch, type Place } from './lib/geo/nominatim'
import type { WeighableReport } from './types/report'

/** Milestone B replaces this with live data from Supabase. */
const reports: WeighableReport[] = []

const WORLD_VIEW: MapPosition = { center: [20, 0], zoom: 3 }

/** Close enough to the ground that a report pin means something. */
const PLACE_ZOOM = 16

export default function App() {
  const [view, setView] = useState<MapPosition>(WORLD_VIEW)
  const [flyTo, setFlyTo] = useState<MapPosition | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])

  const search = useMemo(() => createDebouncedSearch(), [])

  const cells = useMemo(() => {
    const resolution = resolutionForZoom(view.zoom)
    if (resolution === null) return []
    return normaliseWeights(weighCells(reports, resolution))
  }, [view.zoom])

  const onQueryChange = (value: string) => {
    setQuery(value)
    if (value.trim() === '') {
      setResults([])
      return
    }
    search(value, setResults)
  }

  const goToPlace = (place: Place) => {
    setFlyTo({ center: [place.lat, place.lng], zoom: PLACE_ZOOM })
    setResults([])
    setQuery(place.name)
  }

  return (
    <main className="relative h-full w-full">
      <div className="absolute top-4 left-4 z-[1000] w-[min(22rem,calc(100vw-2rem))]">
        <input
          type="search"
          aria-label="Search for a place"
          placeholder="Search for a place"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-md outline-none focus:border-slate-500"
        />
        {results.length > 0 && (
          <ul className="mt-1 max-h-64 overflow-auto rounded-lg bg-white shadow-md">
            {results.map((place) => (
              <li key={`${place.name}:${place.lat},${place.lng}`}>
                <button
                  type="button"
                  onClick={() => goToPlace(place)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                >
                  {place.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <MapView
        initialCenter={WORLD_VIEW.center}
        initialZoom={WORLD_VIEW.zoom}
        flyTo={flyTo}
        onViewChange={setView}
      >
        <CellLayer cells={cells} />
      </MapView>
    </main>
  )
}
