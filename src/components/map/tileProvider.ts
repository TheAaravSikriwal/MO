export interface TileProvider {
  url: string
  attribution: string
  maxZoom: number
}

/**
 * The only place the tile source is named.
 *
 * The spec requires the map stay behind a wrapper so the provider is swappable
 * later; this is the seam. Changing providers means editing this file and
 * nothing else.
 */
export const OPEN_STREET_MAP: TileProvider = {
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}
