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
            // Counts as work, or a batch of nothing but deleted subjects makes
            // the worker sleep a full interval instead of draining the queue.
            handled += 1
            continue
          }

          const decision = await moderate(subject, tiers)
          const applied = await queue.record(job, decision)
          handled += 1

          if (applied) {
            console.log(
              `[mo-worker] ${job.subject_type} ${job.subject_id} -> ${decision.action} (${decision.decidedBy})`,
            )
          } else {
            // The write was refused: somebody flagged it, or another worker got
            // there first. Logging the verdict anyway would claim a decision
            // that was never recorded.
            console.log(
              `[mo-worker] ${job.subject_type} ${job.subject_id} -> not applied, left for a person`,
            )
          }
        } catch (error) {
          // One bad job must not stop the batch, but it must not vanish either.
          // Marking it failed records why and lets the retry cap eventually
          // push it to a human, instead of leaving it claimed and invisible.
          console.error(`[mo-worker] job ${job.id} failed:`, error)
          try {
            await queue.fail(job, error instanceof Error ? error.message : String(error))
          } catch (markError) {
            console.error(`[mo-worker] could not mark job ${job.id} failed:`, markError)
          }
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
