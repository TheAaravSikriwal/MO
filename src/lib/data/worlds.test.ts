import { describe, it, expect } from 'vitest'
import { worldFromSearch, searchWithWorld } from './worlds'

describe('worldFromSearch', () => {
  it('opens on the side the address names', () => {
    expect(worldFromSearch('?world=idea', true)).toBe('idea')
    expect(worldFromSearch('?world=real', false)).toBe('real')
  })

  it('reads the older ?demo=large as the idea', () => {
    expect(worldFromSearch('?demo=large', true)).toBe('idea')
  })

  it('otherwise opens on the real map when there is one, and the idea when there is not', () => {
    expect(worldFromSearch('', true)).toBe('real')
    expect(worldFromSearch('', false)).toBe('idea')
    expect(worldFromSearch('?world=elsewhere', false)).toBe('idea')
  })
})

describe('searchWithWorld', () => {
  it('names the side, keeps everything else, and drops the older switch', () => {
    const params = new URLSearchParams(searchWithWorld('?demo=large&count=300', 'real'))
    expect(params.get('world')).toBe('real')
    expect(params.get('count')).toBe('300')
    expect(params.has('demo')).toBe(false)
  })
})
