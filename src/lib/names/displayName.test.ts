import { describe, it, expect } from 'vitest'
import { hasControlCharacter, nameLength, visibleLength } from './displayName'
import { nameProblem } from '../../components/report/NameField'

describe('display name rules', () => {
  it('counts characters the way Postgres does, not UTF-16 units', () => {
    expect('🌳'.length).toBe(2)
    expect(nameLength('🌳')).toBe(1)
  })

  it('accepts sixteen emoji, which the database would accept', () => {
    expect(nameProblem('🌳'.repeat(16))).toBeNull()
  })

  it('refuses thirty-one characters, however they are encoded', () => {
    expect(nameProblem('a'.repeat(31))).toMatch(/between 2 and 30/)
    expect(nameProblem('🌳'.repeat(31))).toMatch(/between 2 and 30/)
  })

  it('spots a tab or a line break, and nothing else', () => {
    expect(hasControlCharacter('Sam' + String.fromCharCode(9) + 'J')).toBe(true)
    expect(hasControlCharacter('Sam' + String.fromCharCode(10))).toBe(true)
    expect(hasControlCharacter('Sam J-O’Brien 🌳')).toBe(false)
  })
})

describe('display name rules — names that show up', () => {
  const zeroWidth = String.fromCodePoint(8203)
  const nbsp = String.fromCodePoint(160)

  it('refuses a name made of zero-width or non-breaking spaces', () => {
    expect(nameProblem(zeroWidth + zeroWidth)).toMatch(/characters that show up/)
    expect(nameProblem('S' + zeroWidth + zeroWidth)).toMatch(/characters that show up/)
    expect(nameProblem(nbsp + 'a' + nbsp)).toMatch(/between 2 and 30|show up/)
  })

  it('counts what shows', () => {
    expect(visibleLength('Sam')).toBe(3)
    expect(visibleLength('S' + zeroWidth + 'a')).toBe(2)
    expect(visibleLength('🌳🌳')).toBe(2)
  })
})

describe('display name rules — letters that only look blank', () => {
  it.each([
    ['Hangul filler', 0x3164],
    ['halfwidth Hangul filler', 0xffa0],
    ['braille blank', 0x2800],
    ['soft hyphen', 0x00ad],
    ['Mongolian vowel separator', 0x180e],
    ['a tag character', 0xe0041],
  ])('refuses a name made of the %s', (_label, codePoint) => {
    const blank = String.fromCodePoint(codePoint)
    expect(nameProblem(blank + blank + blank)).toMatch(/characters that show up/)
  })
})
