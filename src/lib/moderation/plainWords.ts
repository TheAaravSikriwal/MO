import { MAX_PHOTOS, MAX_PHOTO_BYTES } from '../upload/photoLimits'

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

/**
 * The caps, written once.
 *
 * These sentences replace whatever the server said, so a number typed in here
 * silently overrides a number computed from the constant. The endpoint derives
 * its own wording from `MAX_PHOTO_BYTES` -- and then this table overwrote it,
 * so raising the cap had the server refuse at 12 MB while the person read
 * "under 8 MB".
 */
const MAX_PHOTO_MB = MAX_PHOTO_BYTES / 1024 / 1024

/**
 * What a post refused for want of a name turns into. Exported because the
 * forms react to it by asking for a name, and matching a copy of the sentence
 * would break silently the day this wording changes.
 */
export const NAME_NEEDED = 'Please choose a name before posting.'

const ERROR_RULES: Array<[RegExp, string]> = [
  // Actionable causes come first. Collapsing these into "please try again"
  // told someone to retry the one thing guaranteed to keep failing, and left
  // every other cause with the same wording.
  [/last minute/i, 'You are posting quickly. Please wait a moment.'],
  [
    /added several photos recently|too many photo uploads/i,
    'You have added several photos recently. Please wait a while before adding more.',
  ],
  [/last hour|slow down/i, 'You have added several recently. Please wait a while before adding more.'],
  [/at most \d+ photos|at most \d+/i, `A report can have at most ${MAX_PHOTOS} photos.`],
  [/sign in|signed in/i, 'Please sign in first.'],
  [/add a photo|needs at least one photo/i, 'Please add a photo.'],
  // The upload endpoint's own replies. It refuses a photo before any byte is
  // sent, and each refusal is something the person can act on, so none of them
  // may collapse into "please try again" -- retrying a 12 MB photo fails
  // exactly the same way.
  // PostgREST's answer when `mo` is not in the project's exposed-schemas list.
  // That is one checkbox in the Supabase dashboard and nothing works without
  // it, so it is the likeliest thing to be wrong the first time this is
  // deployed -- and it reaches a person through every screen, not just the
  // upload. The endpoint has its own branch for it; everything else comes
  // through here, and used to arrive as "something went wrong, please try
  // again" about a configuration nobody using the site can fix.
  [/schema must be one of the following|PGRST106/i, 'This site is not set up yet.'],
  [/upload is not set up/i, 'Photo upload is not set up yet, so reports cannot be sent.'],
  [/jpeg, png or webp/i, 'Please choose a JPEG, PNG or WebP photo.'],
  [/too large|under \d+ ?mb/i, `That photo is too large. Please choose one under ${MAX_PHOTO_MB} MB.`],
  [/seems to be empty/i, 'That file seems to be empty. Please choose another photo.'],
  [/could not be uploaded|preparing the upload/i, 'Your photo could not be uploaded. Please try again.'],
  // What the endpoint says when a report is not there, or is not yours. It
  // must not fall through to the generic sentence: this is what someone sees
  // if their own report disappears part-way through submitting it.
  [/report could not be found/i, 'That report could not be found.'],
  // From enforce_photo_has_grant in 0006, which fires when a photo row names an
  // object with no unspent grant behind it. Choosing the photo again uploads it
  // afresh, which is genuinely the way out, so this must not collapse into the
  // generic "something went wrong".
  [/could not be added/i, 'That photo could not be added. Please choose it again.'],
  [/already reported this/i, 'You have already reported this.'],
  // The three below are what the REAL backend says, as opposed to the fake.
  //
  // Every "already done that" case reaches the browser as a Postgres
  // constraint or policy message, because the database is what enforces them:
  // the unique constraint on flags, the primary key on votes, and the
  // votes_insert_own policy. None of those strings matched any rule, so
  // re-flagging something, voting twice, or voting on your own report all came
  // back as "something went wrong, please try again" — advice to retry an
  // action that can never succeed.
  //
  // Matched on the table name, which appears in the constraint name Postgres
  // reports, so a duplicate flag and a duplicate vote stay distinguishable.
  [/duplicate key[\s\S]*flags/i, 'You have already reported this.'],
  [/duplicate key[\s\S]*votes/i, 'You have already confirmed this one.'],
  // Any of the three things votes_insert_own requires: it is your own row, it
  // is not your own report, and the report is open and approved. The wording
  // covers all three rather than guessing which failed.
  [/row-level security policy for table "votes"/i, 'You cannot confirm this one.'],
  // reports_insert_own and comments_insert_own both require a name that has
  // not been rejected. The app asks for one before posting, so reaching this
  // means the name lookup failed or the name was rejected in the meantime.
  [
    /row-level security policy for table "(reports|comments)"/i,
    NAME_NEEDED,
  ],
  // set_display_name in 0002. Each is something the person can fix.
  [/name must be between/i, 'Please choose a name between 2 and 30 characters.'],
  [/name cannot contain @/i, 'Please choose a name rather than an email address.'],
  [/name was not accepted/i, 'That name was not accepted. Please choose a different one.'],
  [/name can be changed once a day/i, 'You can change your name once a day.'],
  [/too many new names today/i, 'You have chosen several names today. Please try again tomorrow.'],
  [/cannot report your own name/i, 'You cannot report your own name.'],
  [/cannot report your own post/i, 'You cannot report your own post.'],
  [/name could not be saved/i, 'Your name could not be saved. Please try again.'],
  [/at least 2 visible characters/i, 'Please choose a name with at least 2 characters that show up.'],
  [/tabs or line breaks|display_names_name_check/i, 'Please choose a name without tabs or line breaks.'],
  [/already confirmed|already been decided/i, 'You have already done that.'],
  [/cannot confirm your own/i, 'You cannot confirm your own report.'],
  // Before the "cleaned" rule: a pin off the map can be refused for being
  // off the map, and that must not read as "already cleaned".
  [/report is off the map/i, 'This report has been taken off the map.'],
  [/already cleaned|not found, already cleaned|already marked cleaned/i, 'This report has already been marked cleaned.'],
  [/^report not found$/i, 'That report could not be found.'],
  [/comment cannot be empty/i, 'Please write something first.'],
  [/take a pin off the map/i, 'You do not have permission to do that.'],
  [/only an admin/i, 'You do not have permission to review items.'],
  [/permission denied|not authorized|unauthorized|jwt/i, 'You do not have permission to do that.'],
  [/already been decided|decided by someone else/i, 'Someone already dealt with this one.'],
  [/no such/i, 'That item could not be found.'],
  // Anything else the database refuses as a duplicate. Last, so the specific
  // cases above keep their own wording.
  [/duplicate key/i, 'You have already done that.'],
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
