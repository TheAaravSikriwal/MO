import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The stylesheet, read off disk. Not imported: the test runner hands CSS
 * imports over as an empty string, so a check made that way passes whatever
 * the file says. Listed in tsconfig.node.json for that reason.
 */
const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')

describe('the stylesheet', () => {
  it('is the real file, not an empty stand-in', () => {
    expect(css).toContain('.mo-reel')
  })

  it('plays its animations for everyone, with no reduced-motion gate, as the rest of the site does', () => {
    expect(css).not.toMatch(/@media\s*\(\s*prefers-reduced-motion/)
  })

  it('defines "a phone" as App.tsx does, and "roomy" as exactly everything else', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
    const query = app.match(/const PHONE_QUERY = '([^']+)'/)?.[1]
    expect(query).toBe('(max-width: 767.98px), (max-height: 480px)')
    const variant = (name: string) =>
      css.match(new RegExp(String.raw`@custom-variant ${name} \{\s*@media ([^{]+?)\s*\{\s*@slot;`))?.[1]
    expect(variant('phone')).toBe(query)
    // Not narrow and not short: wide enough AND taller than the phone's limit.
    expect(variant('roomy')).toBe('(min-width: 768px) and (min-height: 480.02px)')
    // Within a phone: upright (narrow and tall) and short, which together are phone.
    expect(variant('upright')).toBe('(max-width: 767.98px) and (min-height: 480.02px)')
    expect(variant('short')).toBe('(max-height: 480px)')
  })

  it('keeps the compass clear of the panels, and the zoom buttons only where there is a mouse', () => {
    expect(css).toMatch(/\.mo-space \.maplibregl-ctrl-top-right \{\s*top: auto;\s*bottom: 9rem;\s*z-index: 1001;/)
    expect(css).toMatch(/\.mo-space\[data-layers-open\] \.maplibregl-ctrl-top-right \{\s*display: none;/)
    // Zoom buttons go on touch screens only, so a short desktop window keeps them.
    expect(css).toMatch(/@media \(max-width: 767\.98px\) and \(pointer: coarse\), \(max-height: 480px\) and \(pointer: coarse\) \{\s*\.mo-space \.maplibregl-ctrl-zoom-in,\s*\.mo-space \.maplibregl-ctrl-zoom-out \{\s*display: none;/)
    // The column in use puts the compass away on an upright phone only.
    expect(css).toMatch(/@media \(max-width: 767\.98px\) and \(min-height: 480\.02px\) \{\s*\.mo-space\[data-busy\] \.maplibregl-ctrl-top-right \{\s*display: none;/)
  })

  it('gives every field in the map 16px text on a phone, so iOS does not zoom into it', () => {
    const rule = css.match(/@media \(max-width: 767\.98px\), \(max-height: 480px\) \{\s*\.mo-space :is\(input, textarea, select\) \{\s*font-size: 16px;/)
    expect(rule).not.toBeNull()
  })
})
