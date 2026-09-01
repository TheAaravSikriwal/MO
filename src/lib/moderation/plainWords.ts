/**
 * Turns machine strings into plain sentences.
 *
 * The worker and the database both produce text meant for engineers: "no judge
 * configured and tier 2 could not decide", "permission denied for function
 * admin_moderation_queue". The escalation reason can also be raw prose from a
 * language model, which is unpredictable by definition.
 *
 * None of that may reach a person. Rather than trying to filter those strings,
 * nothing here passes one through — every input maps to a sentence written in
 * advance, and anything unrecognised falls back to a generic one.
 */

const REASON_RULES: Array<[RegExp, string]> = [
  // Written by the flag triggers. It must not fall through to the default,
  // which would tell an admin the automatic checks were unsure about something
  // no automatic check ever looked at.
  [/people reported this|reported by/i, 'People reported this.'],
  [/no judge configured/i, 'The automatic checks could not decide this one.'],
  [/unreachable|econnrefused|timed out|timeout/i, 'The automatic checks could not run.'],
  [/no longer exists|discarded/i, 'This has since been deleted.'],
  [/classifier|score/i, 'The automatic checks were not sure about this one.'],
  [/not sure|uncertain|cannot tell|could not tell/i, 'The automatic checks were not sure about this one.'],
]

export const DEFAULT_REASON = 'The automatic checks were not sure about this one.'

export function plainReason(reason: string | null | undefined): string {
  if (!reason || reason.trim() === '') return DEFAULT_REASON
  for (const [pattern, sentence] of REASON_RULES) {
    if (pattern.test(reason)) return sentence
  }
  return DEFAULT_REASON
}

const ERROR_RULES: Array<[RegExp, string]> = [
  [/only an admin/i, 'You do not have permission to review items.'],
  [/permission denied|not authorized|unauthorized|jwt/i, 'You do not have permission to do that.'],
  [/already been decided|decided by someone else/i, 'Someone already dealt with this one.'],
  [/no such/i, 'That item could not be found.'],
  [/network|fetch|offline|econnrefused|timeout/i, 'Could not reach the server. Please try again.'],
]

export const DEFAULT_ERROR = 'Something went wrong. Please try again.'

export function plainError(message: string | null | undefined): string {
  if (!message || message.trim() === '') return DEFAULT_ERROR
  for (const [pattern, sentence] of ERROR_RULES) {
    if (pattern.test(message)) return sentence
  }
  return DEFAULT_ERROR
}

export interface PlainScore {
  label: string
  /** Already formatted for reading, e.g. "42%". */
  value: string
}

const SCORE_LABELS: Array<[RegExp, string]> = [
  [/^nsfw$/i, 'Adult content'],
  [/^porn$/i, 'Adult content'],
  [/^hentai$/i, 'Adult content'],
  [/^sexy$/i, 'Revealing'],
  [/^toxicity$/i, 'Rudeness'],
  [/^severe_toxicity$/i, 'Strong rudeness'],
  [/^insult$/i, 'Insulting'],
  [/^threat$/i, 'Threatening'],
  [/^identity_hate$/i, 'Hateful'],
  [/^obscene$/i, 'Obscene'],
]

const labelFor = (key: string): string | null => {
  for (const [pattern, label] of SCORE_LABELS) {
    if (pattern.test(key)) return label
  }
  return null
}

/**
 * Pull readable scores out of the worker's raw results.
 *
 * Only keys with a known plain label survive, so an unrecognised internal name
 * can never be rendered. Values arrive as 0..1 and are shown as percentages,
 * because "42%" is readable and "0.42" invites misreading.
 */
export function summariseScores(tierResults: Record<string, unknown>): PlainScore[] {
  const out: PlainScore[] = []
  const seen = new Set<string>()

  const walk = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (typeof inner === 'number' && Number.isFinite(inner) && inner >= 0 && inner <= 1) {
        const label = labelFor(key)
        if (label && !seen.has(label)) {
          seen.add(label)
          out.push({ label, value: `${Math.round(inner * 100)}%` })
        }
      } else {
        walk(inner)
      }
    }
  }

  walk(tierResults)
  return out
}
