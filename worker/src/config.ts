import { isUsableBand } from './decide.js'
import type { Band, Thresholds } from './types.js'
import type { R2Config } from './r2.js'

export interface Config {
  supabaseUrl: string
  supabaseServiceRoleKey: string

  /** Any OpenAI-compatible /v1 endpoint. Empty disables tier 3. */
  moderationEndpoint: string
  moderationApiKey?: string
  textModel: string
  visionModel: string

  /** Optional tier 2 HTTP classifiers. Empty means that classifier is absent. */
  textClassifierUrl?: string
  imageClassifierUrl?: string

  thresholds: Thresholds

  workerId: string
  batchSize: number
  pollIntervalMs: number

  /**
   * An R2 credential that may delete objects, for removing rejected and unused
   * photos. All four or none: absent, the cleanup does not run.
   */
  r2?: R2Config
  /** How often the cleanup pass runs. */
  cleanupIntervalMs: number
}

export class ConfigError extends Error {}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim()
  if (!value) throw new ConfigError(`${key} is required`)
  return value
}

const optional = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim()
  return value ? value : undefined
}

const numberOr = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new ConfigError(`${key} must be a number, got "${raw}"`)
  return value
}

const band = (
  env: NodeJS.ProcessEnv,
  rejectKey: string,
  approveKey: string,
  defaults: Band,
): Band => {
  const parsed: Band = {
    rejectAbove: numberOr(env, rejectKey, defaults.rejectAbove),
    approveBelow: numberOr(env, approveKey, defaults.approveBelow),
  }
  if (!isUsableBand(parsed)) {
    throw new ConfigError(
      `${approveKey} (${parsed.approveBelow}) and ${rejectKey} (${parsed.rejectAbove}) ` +
        'must both sit in 0..1 with the approve bound strictly below the reject bound',
    )
  }
  return parsed
}

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const

/**
 * All four R2 variables, or none. Some but not all is a mistake worth refusing
 * to start over: it looks configured and would delete nothing.
 */
function r2Config(env: NodeJS.ProcessEnv): R2Config | undefined {
  const present = R2_KEYS.filter((key) => optional(env, key))
  if (present.length === 0) return undefined
  if (present.length < R2_KEYS.length) {
    const missing = R2_KEYS.filter((key) => !present.includes(key))
    throw new ConfigError(`${missing.join(', ')} missing: set all four R2 variables, or none`)
  }
  return {
    accountId: required(env, 'R2_ACCOUNT_ID'),
    accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
    bucket: required(env, 'R2_BUCKET'),
  }
}

/**
 * Read configuration from the environment.
 *
 * Validation is strict and happens at startup, on purpose. A worker that boots
 * with an inverted threshold band would silently approve content it should have
 * escalated, and nobody would notice until something bad was already public.
 * Failing to start is the safe failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    supabaseUrl: required(env, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),

    moderationEndpoint: optional(env, 'MODERATION_ENDPOINT') ?? '',
    moderationApiKey: optional(env, 'MODERATION_API_KEY'),
    textModel: optional(env, 'MODERATION_TEXT_MODEL') ?? 'qwen3:8b',
    visionModel: optional(env, 'MODERATION_VISION_MODEL') ?? 'qwen2.5vl:7b',

    textClassifierUrl: optional(env, 'TEXT_CLASSIFIER_URL'),
    imageClassifierUrl: optional(env, 'IMAGE_CLASSIFIER_URL'),

    thresholds: {
      nsfw: band(env, 'NSFW_AUTO_REJECT_ABOVE', 'NSFW_AUTO_APPROVE_BELOW', {
        rejectAbove: 0.85,
        approveBelow: 0.15,
      }),
      toxicity: band(env, 'TOXICITY_AUTO_REJECT_ABOVE', 'TOXICITY_AUTO_APPROVE_BELOW', {
        rejectAbove: 0.8,
        approveBelow: 0.2,
      }),
    },

    workerId: optional(env, 'WORKER_ID') ?? 'worker',
    batchSize: numberOr(env, 'WORKER_BATCH_SIZE', 10),
    pollIntervalMs: numberOr(env, 'WORKER_POLL_INTERVAL_MS', 15_000),

    r2: r2Config(env),
    cleanupIntervalMs: numberOr(env, 'CLEANUP_INTERVAL_MS', 10 * 60_000),
  }

  if (config.batchSize < 1) throw new ConfigError('WORKER_BATCH_SIZE must be at least 1')
  if (config.cleanupIntervalMs < 60_000) {
    throw new ConfigError('CLEANUP_INTERVAL_MS must be at least 60000')
  }
  if (config.pollIntervalMs < 1000) {
    throw new ConfigError('WORKER_POLL_INTERVAL_MS must be at least 1000')
  }

  return config
}

/**
 * A worker with no tier 2 and no tier 3 cannot decide anything; it would push
 * every single item to the human queue. That is safe but useless, so say so
 * loudly at startup rather than letting someone discover it via a full queue.
 */
export function describeCapabilities(config: Config): string[] {
  const warnings: string[] = []
  if (!config.imageClassifierUrl) {
    warnings.push('No IMAGE_CLASSIFIER_URL: every photo falls through to tier 3 or a human.')
  }
  if (!config.textClassifierUrl) {
    warnings.push('No TEXT_CLASSIFIER_URL: text relies on the wordlist, then tier 3 or a human.')
  }
  if (!config.moderationEndpoint) {
    warnings.push('No MODERATION_ENDPOINT: tier 3 is disabled, so anything uncertain goes to a human.')
  }
  if (!config.r2) {
    warnings.push(
      'No R2 credentials: rejected and unused photos stay in the bucket, and a rejected photo stays reachable by whoever holds its key.',
    )
  }
  return warnings
}
