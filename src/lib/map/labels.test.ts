import { describe, it, expect } from 'vitest'
import { namesInEnglish } from './labels'

// The label fields the OpenFreeMap "liberty" style actually uses (checked
// 2026-09-28): place names in two forms, and road shields.
const PLACE_NAME = [
  'case',
  ['has', 'name:nonlatin'],
  ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']],
  ['coalesce', ['get', 'name_en'], ['get', 'name']],
]
const ROAD_SHIELD = ['to-string', ['get', 'ref']]

const ENGLISH = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']]

describe('namesInEnglish', () => {
  it('shows a place’s English name, which the style otherwise shows in two scripts at once', () => {
    expect(namesInEnglish(PLACE_NAME)).toEqual(ENGLISH)
    expect(namesInEnglish('{name:latin}')).toEqual(ENGLISH)
  })

  it('leaves a road shield alone, which shows the road’s number, not a name', () => {
    expect(namesInEnglish(ROAD_SHIELD)).toBeNull()
  })

  it('leaves a house number alone', () => {
    expect(namesInEnglish(['get', 'housenumber'])).toBeNull()
    expect(namesInEnglish('{housenumber}')).toBeNull()
  })

  it('leaves a layer with no label alone', () => {
    expect(namesInEnglish(undefined)).toBeNull()
  })
})
