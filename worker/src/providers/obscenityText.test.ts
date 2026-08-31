import { describe, it, expect } from 'vitest'
import { checkWordlist } from './obscenityText.js'

describe('checkWordlist', () => {
  it('passes ordinary report text', () => {
    expect(checkWordlist('Bags of rubbish dumped by the bus stop').matched).toBe(false)
    expect(checkWordlist('Broken glass along the canal path').matched).toBe(false)
  })

  it('passes empty and whitespace text', () => {
    expect(checkWordlist('').matched).toBe(false)
    expect(checkWordlist('   ').matched).toBe(false)
  })

  it('catches plain profanity', () => {
    expect(checkWordlist('this is fucking disgusting').matched).toBe(true)
  })

  it('catches symbol and leetspeak substitution', () => {
    expect(checkWordlist('f*ck this').matched).toBe(true)
    expect(checkWordlist('sh1t everywhere').matched).toBe(true)
  })

  it('names what it matched, for the audit trail', () => {
    expect(checkWordlist('this is fucking disgusting').terms).toContain('fuck')
  })

  it('leaves the whitelisted place-name traps alone', () => {
    expect(checkWordlist('Scunthorpe town centre').matched).toBe(false)
    expect(checkWordlist('Clitheroe high street').matched).toBe(false)
    expect(checkWordlist('rubbish by the assembly hall').matched).toBe(false)
  })

  // --- Documented limitations -----------------------------------------------
  // These tests pin behaviour that is WRONG but real. They exist so the
  // limitation stays visible and so a library upgrade that changes it is
  // noticed rather than silently altering how content is treated.

  it('KNOWN GAP: misses letters separated by spaces', () => {
    expect(checkWordlist('what the f u c k').matched).toBe(false)
  })

  it('KNOWN FALSE POSITIVE: flags real place names containing a bad substring', () => {
    // Penistone is a real town in South Yorkshire. This is exactly why a
    // wordlist match escalates instead of rejecting -- auto-rejecting would
    // censor a legitimate report about a real road.
    const result = checkWordlist('Litter near Penistone Road')
    expect(result.matched).toBe(true)
    expect(result.terms).toContain('penis')
  })

  it('does not judge tone, only words', () => {
    // Both of these break MO's rule about never disparaging a place or the
    // people in it, and both pass the wordlist clean. Only tier 3 catches them.
    expect(checkWordlist('this whole neighbourhood is a slum').matched).toBe(false)
    expect(checkWordlist('the people here are animals').matched).toBe(false)
  })
})
