import type { ImageClassifier, TextClassifier } from '../types.js'

/**
 * Tier 2 classifiers, reached over HTTP.
 *
 * Deliberately dumb: POST some JSON, read back a flat map of category scores.
 * Detoxify, a NSFW ViT classifier, NudeNet or anything else can sit behind this
 * shape, which is what makes tier 2 replaceable without touching the pipeline.
 *
 * Errors are thrown, not swallowed. The pipeline turns a thrown error into an
 * escalation, so a classifier that is down means content waits for a human
 * rather than sailing through unchecked.
 */

const TIMEOUT_MS = 30_000

async function postJson(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`classifier at ${url} returned ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Keep only numeric fields in 0..1, so a malformed payload cannot fake a score. */
export function normaliseScores(payload: unknown): Record<string, number> {
  if (payload === null || typeof payload !== 'object') return {}
  const source = 'scores' in payload ? (payload as { scores: unknown }).scores : payload
  if (source === null || typeof source !== 'object') return {}

  const scores: Record<string, number> = {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      scores[key] = value
    }
  }
  return scores
}

export function createHttpTextClassifier(url: string): TextClassifier {
  return {
    name: `http-text:${url}`,
    async score(text: string) {
      return normaliseScores(await postJson(url, { text }))
    },
  }
}

export function createHttpImageClassifier(url: string): ImageClassifier {
  return {
    name: `http-image:${url}`,
    async score(imageUrl: string) {
      return normaliseScores(await postJson(url, { url: imageUrl }))
    },
  }
}
