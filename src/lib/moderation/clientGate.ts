import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  isAllowedPhotoType,
} from '../upload/photoLimits'

/**
 * Tier 1 — the instant gate that runs in the browser.
 *
 * Its job is fast feedback and keeping obvious junk out of the review queue.
 * It is NOT a security control: anyone can skip it by calling the API directly,
 * which is exactly why tiers 2 to 4 exist on the server.
 *
 * Because it is a convenience filter rather than the authority, it FAILS OPEN.
 * If the image model will not load, the upload proceeds and the server decides.
 * This is the opposite of the worker, which fails closed — there, letting
 * something through unchecked is the actual risk; here, blocking every upload
 * because a model file 404'd would just break the app.
 */

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
})

export interface GateResult {
  blocked: boolean
  /** Shown to the person, so it must be plain and never accusatory. */
  message?: string
}

const ALLOWED = { blocked: false } as const

/**
 * Check text before it is sent.
 *
 * A wordlist hit here only warns; it does not hard-block, for the same reason
 * the worker escalates rather than rejecting. Place names collide with
 * profanity lists — "Penistone Road" matches on `penis` — and refusing to let
 * someone describe a real street would be worse than letting the server judge.
 */
export function checkText(text: string): GateResult {
  if (!text || text.trim() === '') return ALLOWED
  if (!matcher.hasMatch(text)) return ALLOWED
  return {
    blocked: false,
    message: 'This may contain wording that gets held for review before it appears.',
  }
}

// Re-exported, not redefined. The upload-signing endpoint enforces the same
// limits server-side and must read them from the same place; a second copy
// here would drift into a photo the browser accepts and the server refuses.
export { MAX_PHOTO_BYTES, ALLOWED_PHOTO_TYPES }

/** Cheap checks that need no model at all. */
export function checkPhotoFile(file: { type: string; size: number }): GateResult {
  if (!isAllowedPhotoType(file.type)) {
    return { blocked: true, message: 'Please choose a JPEG, PNG or WebP photo.' }
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { blocked: true, message: 'That photo is too large. Please choose one under 8 MB.' }
  }
  if (file.size === 0) {
    return { blocked: true, message: 'That file seems to be empty. Please choose another photo.' }
  }
  return ALLOWED
}

export interface NsfwScores {
  porn: number
  hentai: number
  sexy: number
  [key: string]: number
}

/** Injected so tests never need TensorFlow. */
export type NsfwScorer = (image: HTMLImageElement) => Promise<NsfwScores>

export const NSFW_BLOCK_THRESHOLD = 0.7

export function judgeNsfwScores(scores: NsfwScores | null): GateResult {
  if (!scores) return ALLOWED // model unavailable: fail open, server decides
  const explicit = Math.max(scores.porn ?? 0, scores.hentai ?? 0)
  if (explicit > NSFW_BLOCK_THRESHOLD) {
    return {
      blocked: true,
      message: 'This photo does not look like litter or pollution. Please choose another.',
    }
  }
  return ALLOWED
}

let scorerPromise: Promise<NsfwScorer | null> | null = null

/**
 * Where the NSFW model is loaded from at runtime.
 *
 * Deliberately NOT a bundled dependency. Installing nsfwjs and importing it
 * normally pulls TensorFlow *and the model weights* into the build: measured at
 * 39.6 MB of output, against 860 KB without it. Shipping that to every visitor
 * so the minority who upload a photo get instant feedback is a bad trade, and
 * the server tiers are the real protection either way.
 *
 * Loading it from a CDN on first use costs nothing to people who only look at
 * the map. Point this at your own copy if you would rather not depend on a CDN.
 */
const DEFAULT_NSFW_MODULE_URL = 'https://esm.sh/nsfwjs@4'

interface NsfwModule {
  load: () => Promise<{ classify: (image: HTMLImageElement) => Promise<Array<{ className: string; probability: number }>> }>
}

/**
 * Load the model lazily, the first time somebody actually picks a photo.
 *
 * Returns null on any failure, which the caller treats as "allow" — tier 1 is a
 * convenience filter, not the authority, so a CDN hiccup must not stop people
 * reporting litter.
 */
export async function loadNsfwScorer(
  moduleUrl: string = import.meta.env.VITE_NSFW_MODULE_URL || DEFAULT_NSFW_MODULE_URL,
): Promise<NsfwScorer | null> {
  if (scorerPromise) return scorerPromise

  scorerPromise = (async () => {
    try {
      // @vite-ignore keeps this a genuine runtime import, so neither the
      // library nor its weights are ever pulled into the bundle.
      const nsfwjs = (await import(/* @vite-ignore */ moduleUrl)) as NsfwModule
      const model = await nsfwjs.load()
      return async (image: HTMLImageElement) => {
        const predictions = await model.classify(image)
        const scores: NsfwScores = { porn: 0, hentai: 0, sexy: 0 }
        for (const p of predictions) scores[p.className.toLowerCase()] = p.probability
        return scores
      }
    } catch {
      return null
    }
  })()

  return scorerPromise
}

/** Test seam. */
export function __resetNsfwScorer(): void {
  scorerPromise = null
}
