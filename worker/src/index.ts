import 'dotenv/config'
import { loadConfig, describeCapabilities, ConfigError } from './config.js'
import { Queue } from './queue.js'
import { moderate } from './pipeline.js'
import { createHttpImageClassifier, createHttpTextClassifier } from './providers/httpClassifier.js'
import { createLlmJudge } from './providers/llmJudge.js'
import type { Tiers } from './pipeline.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const config = loadConfig()

  const tiers: Tiers = {
    thresholds: config.thresholds,
    textClassifier: config.textClassifierUrl
      ? createHttpTextClassifier(config.textClassifierUrl)
      : undefined,
    imageClassifier: config.imageClassifierUrl
      ? createHttpImageClassifier(config.imageClassifierUrl)
      : undefined,
    judge: config.moderationEndpoint
      ? createLlmJudge({
          endpoint: config.moderationEndpoint,
          apiKey: config.moderationApiKey,
          textModel: config.textModel,
          visionModel: config.visionModel,
        })
      : undefined,
  }

  const queue = new Queue(config, process.env.VITE_PHOTO_BASE_URL ?? process.env.PHOTO_BASE_URL ?? '')

  console.log(`[mo-worker] ${config.workerId} starting`)
  console.log(`[mo-worker] endpoint: ${config.moderationEndpoint || '(tier 3 disabled)'}`)
  console.log(`[mo-worker] models:   ${config.textModel} / ${config.visionModel}`)
  for (const warning of describeCapabilities(config)) {
    console.warn(`[mo-worker] WARNING  ${warning}`)
  }

  let running = true
  const stop = () => {
    if (!running) return
    running = false
    console.log('[mo-worker] finishing current batch, then stopping')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  while (running) {
    let handled = 0
    try {
      const jobs = await queue.claim(config.batchSize)

      for (const job of jobs) {
        try {
          const subject = await queue.fetchSubject(job)
          if (!subject) {
            await queue.discard(job, 'the content this job referred to no longer exists')
            continue
          }

          const decision = await moderate(subject, tiers)
          await queue.record(job, decision)
          handled += 1
          console.log(
            `[mo-worker] ${job.subject_type} ${job.subject_id} -> ${decision.action} (${decision.decidedBy})`,
          )
        } catch (error) {
          // One bad job must not stop the batch. Leaving it claimed means the
          // 15-minute lock expiry in claim_moderation_jobs will retry it.
          console.error(`[mo-worker] job ${job.id} failed:`, error)
        }
      }
    } catch (error) {
      console.error('[mo-worker] could not reach the queue:', error)
    }

    // Only idle when there was nothing to do. A full queue drains at full speed.
    if (running && handled === 0) await sleep(config.pollIntervalMs)
  }

  console.log('[mo-worker] stopped')
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`[mo-worker] configuration error: ${error.message}`)
    console.error('[mo-worker] refusing to start; see .env.example')
    process.exit(2)
  }
  console.error('[mo-worker] fatal:', error)
  process.exit(1)
})
