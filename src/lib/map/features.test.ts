import { describe, it, expect } from 'vitest'
import { cellToBoundary, gridDisk } from 'h3-js'
import { cellsForPoint } from '../grid/cells'
import {
  cellRing,
  cellFeatures,
  pinFeatures,
  groupFeatures,
  groupRadius,
  CLEANED_COLOR,
  OFF_MAP_COLOR,
  MIN_PIN_RADIUS,
  withNight,
  TOWER_INSET,
} from './features'
import { subsolarPoint } from '../geo/daylight'
import type { CleaningGroup, ReportView } from '../data/types'

const span = (ring: Array<[number, number]>) => {
  const lngs = ring.map(([lng]) => lng)
  return Math.max(...lngs) - Math.min(...lngs)
}

describe('cellRing', () => {
  it('is the cell as h3 gives it, as [lng, lat], and closed', () => {
    const { cell_r3 } = cellsForPoint(51.5, -0.12)
    const ring = cellRing(cell_r3)
    expect(ring[0]).toEqual(ring[ring.length - 1])
    // h3's GeoJSON form is already closed, so it is used exactly as given.
    expect(ring).toEqual(cellToBoundary(cell_r3, true))
  })

  it('keeps a cell on the 180th meridian in one piece, not a band round the world', () => {
    const { cell_r1 } = cellsForPoint(-17.7, 179.9)
    expect(span(cellToBoundary(cell_r1, true) as Array<[number, number]>)).toBeGreaterThan(180)
    const ring = cellRing(cell_r1)
    expect(span(ring)).toBeLessThan(180)
    for (const [lng] of ring) expect(lng).toBeGreaterThan(0)
  })
})

describe('cellFeatures', () => {
  it('carries each area’s rank, colour and count, for the tower it becomes', () => {
    const { cell_r3 } = cellsForPoint(51.5, -0.12)
    const [feature] = cellFeatures([{ cell: cell_r3, weight: 9, reportCount: 4, t: 1 }]).features
    expect(feature.properties).toMatchObject({ cell: cell_r3, t: 1, reportCount: 4 })
    expect(feature.properties.color).toMatch(/^#[0-9a-f]{6}$/)
  })

  describe('towers stand inside their hexagons, so no two walls are in one place', () => {
    const { cell_r3 } = cellsForPoint(51.5, -0.12)
    const ringOf = (cell: string) =>
      cellFeatures([{ cell, weight: 1, reportCount: 1, t: 0.5 }]).features[0].geometry.coordinates[0]
    const key = ([x, y]: [number, number] | number[]) => `${x.toFixed(9)},${y.toFixed(9)}`

    it('draws each tower a little inside its hexagon, around the same middle', () => {
      const tower = ringOf(cell_r3)
      const hexagon = cellRing(cell_r3)
      expect(tower).toHaveLength(hexagon.length)
      const middle = (ring: number[][]) => ring.slice(0, -1).reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0]).map((v) => v / (ring.length - 1))
      expect(middle(tower)[0]).toBeCloseTo(middle(hexagon)[0], 9)
      expect(middle(tower)[1]).toBeCloseTo(middle(hexagon)[1], 9)
      // Every corner pulled in by the same share.
      const reach = (ring: number[][], i: number) => Math.hypot(ring[i][0] - middle(ring)[0], ring[i][1] - middle(ring)[1])
      for (let i = 0; i < 6; i++) expect(reach(tower, i) / reach(hexagon, i)).toBeCloseTo(TOWER_INSET, 9)
    })

    it('leaves no corner shared with a neighbour, or with a fire on the same hexagon', () => {
      const [neighbour] = gridDisk(cell_r3, 1).filter((c) => c !== cell_r3)
      const mine = new Set(ringOf(cell_r3).map(key))
      for (const corner of ringOf(neighbour)) expect(mine.has(key(corner))).toBe(false)
      // A fire tower uses the whole hexagon.
      for (const corner of cellRing(cell_r3)) expect(mine.has(key(corner))).toBe(false)
    })

    it('keeps a tower on the date line in one piece', () => {
      const onTheLine = cellsForPoint(-16.5, 179.99).cell_r3
      const lngs = ringOf(onTheLine).map(([lng]) => lng)
      expect(Math.max(...lngs) - Math.min(...lngs)).toBeLessThan(10)
    })
  })

  it('never colours even the quietest area white, which would vanish on a light map', () => {
    const { cell_r3 } = cellsForPoint(51.5, -0.12)
    const [feature] = cellFeatures([{ cell: cell_r3, weight: 1, reportCount: 1, t: 0 }]).features
    expect(feature.properties.color).not.toBe('#ffffff')
  })
})

const report = (over: Partial<ReportView>): ReportView =>
  ({ id: 'r', lat: 51.5, lng: -0.12, status: 'open', moderationStatus: 'approved', voteCount: 0, ...over }) as ReportView

describe('pinFeatures', () => {
  it('draws a cleaned report green and small, and one off the map grey', () => {
    const { features } = pinFeatures(
      [report({ id: 'a', status: 'cleaned' }), report({ id: 'b', moderationStatus: 'rejected' })],
      null,
    )
    expect(features[0].properties).toMatchObject({ color: CLEANED_COLOR, radius: MIN_PIN_RADIUS })
    expect(features[1].properties).toMatchObject({ color: OFF_MAP_COLOR, radius: MIN_PIN_RADIUS })
  })

  it('draws the most confirmed report on screen biggest', () => {
    const { features } = pinFeatures([report({ id: 'a', voteCount: 0 }), report({ id: 'b', voteCount: 9 })], null)
    expect(features[1].properties.radius).toBeGreaterThan(features[0].properties.radius)
  })

  it('outlines the chosen report more strongly', () => {
    const { features } = pinFeatures([report({ id: 'a' }), report({ id: 'b' })], 'b')
    expect(features[1].properties.strokeWidth).toBeGreaterThan(features[0].properties.strokeWidth)
  })

  it('places each pin at its report, as [lng, lat]', () => {
    const [feature] = pinFeatures([report({ id: 'a', lat: 10, lng: 20 })], null).features
    expect(feature.geometry.coordinates).toEqual([20, 10])
  })
})

describe('groupFeatures', () => {
  const group = (over: Partial<CleaningGroup> = {}): CleaningGroup => ({
    id: 'g',
    name: 'Riverside Litter Pickers',
    description: '',
    lat: 1,
    lng: 2,
    status: 'approved',
    memberCount: 4,
    viewerIsMember: false,
    viewerIsFounder: false,
    ...over,
  })

  it('names each group and marks one still waiting to be checked', () => {
    const { features } = groupFeatures([group(), group({ id: 'h', status: 'pending' })], 'h')
    expect(features[0].properties).toMatchObject({ name: 'Riverside Litter Pickers', approved: true, selected: false })
    expect(features[1].properties).toMatchObject({ approved: false, selected: true })
    expect(features[0].geometry.coordinates).toEqual([2, 1])
  })

  it('grows with the group, but not without end', () => {
    expect(groupRadius(100)).toBeGreaterThan(groupRadius(1))
    expect(groupRadius(1_000_000)).toBe(16)
  })
})

describe('withNight', () => {
  const date = new Date('2026-09-28T12:00:00Z')
  const { lat, lng } = subsolarPoint(date)
  const square = (y: number, x: number) => ({
    type: 'Feature' as const,
    properties: { color: '#ff0000' },
    geometry: { type: 'Polygon' as const, coordinates: [[[x - 1, y - 1], [x + 1, y - 1], [x + 1, y + 1], [x - 1, y + 1], [x - 1, y - 1]]] },
  })
  const lightness = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)

  it('keeps day colours in the sun, and darkens shapes on the night side', () => {
    const [day, night] = withNight(
      { type: 'FeatureCollection', features: [square(lat, lng), square(-lat, lng > 0 ? lng - 180 : lng + 180)] },
      date,
    ).features
    expect(day.properties.nightColor).toBe('#ff0000')
    expect(lightness(night.properties.nightColor)).toBeLessThan(lightness('#ff0000') * 0.3)
    // Dusk, as the map flattens: darker than day, lighter than full night.
    expect(lightness(night.properties.duskColor)).toBeGreaterThan(lightness(night.properties.nightColor))
    expect(lightness(night.properties.duskColor)).toBeLessThan(lightness('#ff0000'))
  })

  it('keeps everything else about each shape', () => {
    const [out] = withNight({ type: 'FeatureCollection', features: [square(0, 0)] }, date).features
    expect(out.properties.color).toBe('#ff0000')
    expect(out.geometry.coordinates[0]).toHaveLength(5)
  })
})
