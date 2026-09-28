import { useEffect } from 'react'
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { GlobeMapProps } from '../components/map/GlobeMap'
import { toLibreZoom, viewFromMap, type MapView2 } from '../lib/map/view'

/**
 * A stand-in for GlobeMap in tests.
 *
 * MapLibre draws with the graphics card, which the test environment does not
 * have. Everything the map decides about how things look is in lib/map and
 * tested there; what the app's tests need is the map's side of the
 * conversation: what it was asked to draw, where it was asked to fly, and a
 * way to move it the way a person would.
 *
 *   vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))
 */

export type { FlyTarget, MapView2 } from '../lib/map/view'
export const MAP_STYLE_URL = 'about:blank'
export const MAP_FADE_MS = 220

let reportView: ((view: MapView2) => void) | null = null

export const mapControl = {
  /** Called with (center, zoom) each time the app asks the map to fly, as the real one would move. */
  flyTo: vi.fn<(center: [number, number], zoom: number) => void>(),
  /**
   * Move the map, as the real one reports a pan or a zoom: through the same
   * viewFromMap, so the wrapping and the whole-world view on the globe are the
   * real ones. Zoom is in the app's numbers.
   */
  async moveTo(zoom: number, center: [number, number] = [51.5074, -0.1278], halfSpan = 0.05) {
    await act(async () => {
      reportView?.(
        viewFromMap({
          lat: center[0],
          lng: center[1],
          libreZoom: toLibreZoom(zoom),
          bounds: {
            minLat: center[0] - halfSpan,
            minLng: center[1] - halfSpan,
            maxLat: center[0] + halfSpan,
            maxLng: center[1] + halfSpan,
          },
        }),
      )
    })
  },
}

export function GlobeMap(props: GlobeMapProps) {
  reportView = props.onViewChange
  const nonce = props.flyTo?.nonce
  useEffect(() => {
    if (props.flyTo) mapControl.flyTo(props.flyTo.center, props.flyTo.zoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])
  return (
    <div data-testid="map" data-world={props.world?.layer ?? ''} data-cells-key={String(props.cellsKey)}>
      {props.cells.map((cell) => (
        <button
          key={cell.cell}
          type="button"
          data-testid="cell"
          data-cell={cell.cell}
          data-t={cell.t}
          data-selected={cell.cell === props.selectedCell ? 'yes' : 'no'}
          onClick={() => props.onCellSelect(cell.cell, cell.reportCount)}
        />
      ))}
      {props.pins.map((report) => (
        <button
          key={report.id}
          type="button"
          data-testid="pin"
          data-selected={report.id === props.selectedPinId ? 'yes' : 'no'}
          onClick={() => props.onPinSelect(report.id)}
        />
      ))}
      {props.groups.map((group) => (
        <button key={group.id} type="button" data-testid="group-marker" onClick={() => props.onGroupSelect(group.id)}>
          {group.name}
        </button>
      ))}
    </div>
  )
}
