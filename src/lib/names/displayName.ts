/** The same limits set_display_name enforces, checked before anything is sent. */
export const MIN_NAME_LENGTH = 2
export const MAX_NAME_LENGTH = 30

/**
 * Length the way Postgres's char_length counts it: characters, not UTF-16
 * units. `.length` counts an emoji as two, so a name the database would take
 * was refused here.
 */
export function nameLength(text: string): number {
  return [...text].length
}

/**
 * Characters that take up no visible space, as inclusive code point ranges:
 * Unicode's default-ignorable characters and its extra spaces, plus the
 * letters that only LOOK blank, such as the Hangul fillers and the braille
 * blank. A name made only of these displays as nothing.
 *
 * Numbers rather than a regex class, so no escape can be mangled into the raw
 * character. mo.visible_length in 0001 holds the same ranges, and a test keeps
 * the two identical.
 */
export const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [32, 32], // space
  [160, 160], // no-break space
  [173, 173], // soft hyphen
  [847, 847], // combining grapheme joiner
  [1564, 1564], // Arabic letter mark
  [4447, 4448], // Hangul choseong and jungseong fillers
  [5760, 5760], // Ogham space
  [6068, 6069], // Khmer inherent vowels
  [6155, 6158], // Mongolian selectors and vowel separator
  [8192, 8207], // the space block, zero-width space and joiners, direction marks
  [8232, 8239], // line and paragraph separators, bidi embeddings, narrow no-break space
  [8287, 8303], // medium space, word joiner, invisible operators, bidi isolates
  [10240, 10240], // braille blank
  [12288, 12288], // ideographic space
  [12644, 12644], // Hangul filler
  [65024, 65039], // variation selectors
  [65279, 65279], // byte-order mark
  [65440, 65440], // halfwidth Hangul filler
  [119155, 119162], // musical format controls
  [917505, 917505], // language tag
  [917536, 917631], // tag characters
]

export const INVISIBLE_CODE_POINTS: ReadonlySet<number> = new Set(
  INVISIBLE_RANGES.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)),
)

/** How many characters of a name actually show up. */
export function visibleLength(text: string): number {
  let count = 0
  for (const character of text) {
    if (!INVISIBLE_CODE_POINTS.has(character.codePointAt(0)!)) count += 1
  }
  return count
}

/**
 * Tabs, line breaks and the like: the table's CHECK refuses them, and so does
 * set_display_name. Written as a character-code test rather than a regex
 * class, because a control-character class is exactly the kind of escape that
 * gets mangled into the raw bytes it describes.
 */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}
