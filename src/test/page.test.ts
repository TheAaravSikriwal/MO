import { describe, it, expect } from 'vitest'
import html from '../../index.html?raw'

/** The page around the app. */

describe('index.html', () => {
  it('lets people pinch to enlarge the page; the map handles its own gestures', () => {
    const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1]
    expect(viewport).toBeDefined()
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no/)
    expect(viewport).not.toMatch(/maximum-scale/)
  })
})
