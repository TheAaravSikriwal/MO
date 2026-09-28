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
})
