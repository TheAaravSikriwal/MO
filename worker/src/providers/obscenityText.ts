import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
})

export interface WordlistResult {
  matched: boolean
  /** Which entries fired, for the audit trail. Never the surrounding text. */
  terms: string[]
}

/**
 * Tier 2's wordlist pass: slurs and profanity, including obfuscated spellings.
 *
 * This runs in the worker even though the same library runs in the browser at
 * tier 1, because tier 1 is a UX filter, not a security control — anyone can
 * skip it by calling the API directly. This is the copy that counts.
 *
 * A MATCH HERE MUST ESCALATE, NOT REJECT.
 *
 * MO maps real places, and place names collide with the wordlist. Measured:
 * "Litter near Penistone Road" matches on `penis`. Penistone is a real town in
 * South Yorkshire. The library's dataset whitelists a few famous cases —
 * Scunthorpe and Clitheroe both pass — but no dataset can whitelist every place
 * name on Earth, and auto-rejecting would silently censor a legitimate report
 * about a real road.
 *
 * Known limits, measured rather than assumed:
 *   - catches "f*ck" and "sh1t" (symbol and leetspeak substitution)
 *   - MISSES "f u c k" (letters separated by spaces)
 *   - does not judge tone at all: "this neighbourhood is a slum" passes clean,
 *     even though it breaks MO's rule about disparaging a place. Only tier 3
 *     catches that.
 */
export function checkWordlist(text: string): WordlistResult {
  if (!text || text.trim() === '') return { matched: false, terms: [] }

  const matches = matcher.getAllMatches(text, true)
  const terms = [
    ...new Set(
      matches.map(
        (m) =>
          englishDataset.getPayloadWithPhraseMetadata(m).phraseMetadata?.originalWord ?? 'unknown',
      ),
    ),
  ]

  return { matched: matches.length > 0, terms }
}
