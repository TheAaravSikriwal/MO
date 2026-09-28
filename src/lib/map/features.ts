import { cellToBoundary } from 'h3-js'
import { interpolate, formatHex } from 'culori'
import { darknessAt, NIGHT_COLOR } from '../geo/daylight'
import { colorForT } from '../color/ramp'
import { normaliseWeights, type NormalisedCell } from '../severity/percentile'
import type { CleaningGroup, ReportView } from '../data/types'

/**
 * What the map draws, as GeoJSON.
 *
 * The map itself (GlobeMap) only hands these to MapLibre. Every decision about
 * how a hexagon, a pin or a group looks is made here, where it can be tested
 * without a browser or a graphics card.
 */

/** A cleaned spot is not "low severity": it is a different thing entirely. */
export const CLEANED_COLOR = '#2f9e6e'
/** A pin an admin took off the map. Only its reporter and admins ever see one. */
export const OFF_MAP_COLOR = '#94a3b8'
/** Green, like cleaned spots, so a group never reads as litter. */
export const GROUP_COLOR = '#10b981'

export const MIN_PIN_RADIUS = 6
export const MAX_PIN_RADIUS = 13

/**
 * Towers and pins never use the white end of the ramp: a white shape on a
 * light map is invisible, and each one stands for something somebody reported.
 */
export const T_FLOOR = 0.25
const floored = (t: number) => T_FLOOR + (1 - T_FLOOR) * t

/**
 * A cell's outline as [lng, lat], closed, ready for a GeoJSON polygon.
 *
 * A cell straddling the 180th meridian comes from h3 with corners on both
 * sides, and drawn as given it wraps the long way round the world. Its western
 * corners are moved on by 360 degrees instead, which MapLibre draws in one
 * piece just east of the line, on the globe and the flat map alike.
 */
export function cellRing(cell: string): Array<[number, number]> {
  const ring = cellToBoundary(cell, true) as Array<[number, number]>
  const lngs = ring.map(([lng]) => lng)
  const crosses = Math.max(...lngs) - Math.min(...lngs) > 180
  const fixed = crosses ? ring.map(([lng, lat]) => [lng < 0 ? lng + 360 : lng, lat] as [number, number]) : ring
  const [first] = fixed
  const [last] = fixed.slice(-1)
  return first[0] === last[0] && first[1] === last[1] ? fixed : [...fixed, first]
}

/**
 * How much of its hexagon a litter tower fills, edge to edge. Not all of it:
 * towers side by side, or a fire tower on the same hexagon, would otherwise
 * put two walls in exactly the same place, and two 3D walls in one place
 * flicker against each other. Inset, every wall has a place of its own, the
 * towers stand apart, and a fire under a litter tower shows as a lower ring
 * round its foot.
 */
export const TOWER_INSET = 0.86

/** A ring drawn in towards its middle, keeping `share` of its size. */
export function insetRing(ring: Array<[number, number]>, share: number): Array<[number, number]> {
  // The closing point repeats the first; the middle is of the corners only.
  const corners = ring.slice(0, -1)
  const [cx, cy] = corners.reduce(([x, y], [px, py]) => [x + px, y + py], [0, 0]).map((v) => v / corners.length)
  return ring.map(([x, y]) => [cx + (x - cx) * share, cy + (y - cy) * share])
}

export interface CellProperties {
  cell: string
  t: number
  color: string
  reportCount: number
}

/** The aggregated areas, each with the colour and rank that set its tower. */
export function cellFeatures(cells: readonly NormalisedCell[]): GeoJSON.FeatureCollection<GeoJSON.Polygon, CellProperties> {
  return {
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature',
      properties: { cell: c.cell, t: c.t, color: colorForT(floored(c.t)), reportCount: c.reportCount },
      geometry: { type: 'Polygon', coordinates: [insetRing(cellRing(c.cell), TOWER_INSET)] },
    })),
  }
}

/**
 * How much of night's strength is left once the map is flat, and gone a few
 * zooms after. Shared with the night layer's own curve (NIGHT_OPACITY), so
 * what the app draws darkens exactly as much as the map under it.
 */
export const NIGHT_AT_FLAT = 0.35

const toNight = (color: string, darkness: number) => formatHex(interpolate([color, NIGHT_COLOR], 'rgb')(darkness))!

/** The middle of a shape, near enough to say whether it is in the dark. */
function middleOf(geometry: GeoJSON.Geometry): [number, number] | null {
  const rings =
    geometry.type === 'Polygon'
      ? [geometry.coordinates[0]]
      : geometry.type === 'MultiPolygon'
        ? // The largest part: an average over islands far apart would be at sea.
          [geometry.coordinates.map((p) => p[0]).sort((a, b) => b.length - a.length)[0]]
        : []
  const points = rings.flat()
  if (points.length === 0) return null
  const [lng, lat] = points.reduce(([x, y], [px, py]) => [x + px, y + py], [0, 0])
  return [lng / points.length, lat / points.length]
}

/**
 * Each shape with the colours it takes at night where it stands: `nightColor`
 * on the globe, `duskColor` as the map flattens. Blended towards the night's
 * own colour by as much as the night bands darken that spot, so a tower on
 * the dark side is dark too, rather than standing out in daylight colours.
 */
export function withNight<G extends GeoJSON.Geometry, P>(
  collection: GeoJSON.FeatureCollection<G, P>,
  date: Date,
): GeoJSON.FeatureCollection<G, P & { nightColor: string; duskColor: string }> {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const color = String((feature.properties as { color?: string } | null)?.color ?? '#ffffff')
      const middle = feature.geometry ? middleOf(feature.geometry) : null
      const darkness = middle ? darknessAt(middle[1], middle[0], date) : 0
      return {
        ...feature,
        properties: {
          ...feature.properties,
          nightColor: toNight(color, darkness),
          duskColor: toNight(color, darkness * NIGHT_AT_FLAT),
        },
      }
    }),
  }
}

export interface PinProperties {
  id: string
  color: string
  radius: number
  /** How solid the fill is, before any fade. */
  fill: number
  stroke: string
  strokeWidth: number
}

/**
 * Individual reports, drawn once you are close enough to tell them apart.
 *
 * Ranked against the other pins on screen, the same way cells are, so a street
 * with one report does not look identical to one with twenty. Off-map pins are
 * not ranked: they add nothing to the colours for anybody else.
 */
export function pinFeatures(
  reports: readonly ReportView[],
  selectedId: string | null,
): GeoJSON.FeatureCollection<GeoJSON.Point, PinProperties> {
  const open = reports.filter((r) => r.status === 'open' && r.moderationStatus !== 'rejected')
  const ranked = normaliseWeights(open.map((r) => ({ cell: r.id, weight: 1 + Math.max(0, r.voteCount), reportCount: 1 })))
  const tById = new Map(ranked.map((entry) => [entry.cell, entry.t]))
  return {
    type: 'FeatureCollection',
    features: reports.map((report) => {
      const cleaned = report.status === 'cleaned'
      const offMap = report.moderationStatus === 'rejected'
      const t = tById.get(report.id) ?? 0
      const selected = report.id === selectedId
      return {
        type: 'Feature',
        properties: {
          id: report.id,
          color: offMap ? OFF_MAP_COLOR : cleaned ? CLEANED_COLOR : colorForT(floored(t)),
          radius: cleaned || offMap ? MIN_PIN_RADIUS : MIN_PIN_RADIUS + (MAX_PIN_RADIUS - MIN_PIN_RADIUS) * t,
          fill: offMap ? 0.4 : cleaned ? 0.6 : 0.9,
          // Dark, not white: a white outline round a pale fill is no outline at all.
          stroke: selected ? '#0f172a' : '#334155',
          strokeWidth: selected ? 3 : 1.25,
        },
        geometry: { type: 'Point', coordinates: [report.lng, report.lat] },
      }
    }),
  }
}

export interface GroupProperties {
  id: string
  name: string
  radius: number
  selected: boolean
  approved: boolean
  memberCount: number
}

/** Grows a little with the group, and stops growing, so a big one does not cover a town. */
export function groupRadius(memberCount: number): number {
  return Math.min(16, 8 + Math.sqrt(Math.max(0, memberCount)))
}

/** Where each cleaning group in view is based. */
export function groupFeatures(
  groups: readonly CleaningGroup[],
  selectedId: string | null,
): GeoJSON.FeatureCollection<GeoJSON.Point, GroupProperties> {
  return {
    type: 'FeatureCollection',
    features: groups.map((g) => ({
      type: 'Feature',
      properties: {
        id: g.id,
        name: g.name,
        radius: groupRadius(g.memberCount),
        selected: g.id === selectedId,
        approved: g.status === 'approved',
        memberCount: g.memberCount,
      },
      geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
    })),
  }
}
