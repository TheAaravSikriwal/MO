import { describe, it, expect } from 'vitest'
import { loadConfig, describeCapabilities, ConfigError } from './config.js'

const minimal = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
}

describe('loadConfig', () => {
  it('reads the minimum viable configuration', () => {
    const config = loadConfig(minimal)
    expect(config.supabaseUrl).toBe('https://example.supabase.co')
    expect(config.supabaseServiceRoleKey).toBe('service-role-key')
  })

  it('refuses to start without supabase credentials', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({ SUPABASE_URL: 'x' })).toThrow(/SERVICE_ROLE_KEY/)
  })

  it('treats blank and whitespace-only values as missing', () => {
    expect(() => loadConfig({ ...minimal, SUPABASE_URL: '   ' })).toThrow(/SUPABASE_URL/)
  })

  it('defaults the thresholds to the documented bands', () => {
    const { thresholds } = loadConfig(minimal)
    expect(thresholds.nsfw).toEqual({ rejectAbove: 0.85, approveBelow: 0.15 })
    expect(thresholds.toxicity).toEqual({ rejectAbove: 0.8, approveBelow: 0.2 })
  })

  it('lets the bands be widened without touching code', () => {
    const { thresholds } = loadConfig({
      ...minimal,
      NSFW_AUTO_REJECT_ABOVE: '0.6',
      NSFW_AUTO_APPROVE_BELOW: '0.4',
    })
    expect(thresholds.nsfw).toEqual({ rejectAbove: 0.6, approveBelow: 0.4 })
  })

  it('refuses to start on an inverted band rather than silently mis-deciding', () => {
    expect(() =>
      loadConfig({
        ...minimal,
        NSFW_AUTO_REJECT_ABOVE: '0.1',
        NSFW_AUTO_APPROVE_BELOW: '0.9',
      }),
    ).toThrow(ConfigError)
  })

  it('refuses a band with no uncertain middle', () => {
    expect(() =>
      loadConfig({
        ...minimal,
        TOXICITY_AUTO_REJECT_ABOVE: '0.5',
        TOXICITY_AUTO_APPROVE_BELOW: '0.5',
      }),
    ).toThrow(ConfigError)
  })

  it('refuses a threshold that is not a number', () => {
    expect(() => loadConfig({ ...minimal, NSFW_AUTO_REJECT_ABOVE: 'high' })).toThrow(/number/)
  })

  it('carries model names through so switching model is one env change', () => {
    const config = loadConfig({
      ...minimal,
      MODERATION_TEXT_MODEL: 'llama-guard3:8b',
      MODERATION_VISION_MODEL: 'shieldgemma2:4b',
    })
    expect(config.textModel).toBe('llama-guard3:8b')
    expect(config.visionModel).toBe('shieldgemma2:4b')
  })

  it('carries the endpoint through so switching machine is one env change', () => {
    expect(
      loadConfig({ ...minimal, MODERATION_ENDPOINT: 'http://192.168.1.40:11434/v1' })
        .moderationEndpoint,
    ).toBe('http://192.168.1.40:11434/v1')
  })

  it('refuses a poll interval that would hammer the database', () => {
    expect(() => loadConfig({ ...minimal, WORKER_POLL_INTERVAL_MS: '10' })).toThrow(ConfigError)
  })

  it('refuses a batch size below one', () => {
    expect(() => loadConfig({ ...minimal, WORKER_BATCH_SIZE: '0' })).toThrow(ConfigError)
  })
})

describe('describeCapabilities', () => {
  it('warns loudly when nothing can decide anything', () => {
    const warnings = describeCapabilities(loadConfig(minimal))
    // Three tiers missing, and no R2 credential to clean up with.
    expect(warnings).toHaveLength(4)
    expect(warnings.join(' ')).toContain('human')
    expect(warnings.join(' ')).toContain('stay in the bucket')
  })

  it('stays quiet when every tier is configured', () => {
    const warnings = describeCapabilities(
      loadConfig({
        ...minimal,
        MODERATION_ENDPOINT: 'http://localhost:11434/v1',
        TEXT_CLASSIFIER_URL: 'http://localhost:8001/toxicity',
        IMAGE_CLASSIFIER_URL: 'http://localhost:8002/nsfw',
        R2_ACCOUNT_ID: 'account',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_BUCKET: 'chintubucket',
      }),
    )
    expect(warnings).toEqual([])
  })
})

describe('loadConfig — R2 cleanup', () => {
  const r2 = {
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'chintubucket',
  }

  it('leaves cleanup off when no R2 variable is set', () => {
    expect(loadConfig(minimal).r2).toBeUndefined()
  })

  it('reads all four when they are set', () => {
    expect(loadConfig({ ...minimal, ...r2 }).r2).toEqual({
      accountId: 'account',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'chintubucket',
    })
  })

  it('refuses to start with some but not all, naming what is missing', () => {
    const { R2_BUCKET: _bucket, ...partial } = r2
    void _bucket
    expect(() => loadConfig({ ...minimal, ...partial })).toThrow(/R2_BUCKET missing/)
  })

  it('refuses a cleanup interval under a minute', () => {
    expect(() => loadConfig({ ...minimal, CLEANUP_INTERVAL_MS: '1000' })).toThrow(/CLEANUP_INTERVAL_MS/)
  })
})
