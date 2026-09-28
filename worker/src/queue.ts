import { createClient } from '@supabase/supabase-js'
import type { Config } from './config.js'
import { MO_SCHEMA } from './schema.js'
import type { Decision, ModerationJob, Subject } from './types.js'

/**
 * The client, built in one place so its type follows from its options.
 *
 * `SupabaseClient` is generic over the schema name, so a bare annotation means
 * the `public`-schema type and the assignment below stops compiling. Deriving
 * the type from this function keeps the generics out of the code entirely —
 * and out of step-keeping when supabase-js changes how many there are.
 */
function createMoClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Everything this worker touches is in `mo`, not `public`. See schema.ts:
    // without this, `.from('reports')` finds the marketplace's abuse-report
    // table instead of MO's, and every RPC 404s.
    db: { schema: MO_SCHEMA },
  })
}

/** The shape the constructor accepts, so tests can inject a fake. */
export type MoClient = ReturnType<typeof createMoClient>

/**
 * Where each kind of text lives.
 *
 * A table, not a ternary. The ternary this replaced sent everything that was
 * not a comment to `reports.note`, so a name job would have looked up a
 * person's id among report ids, found nothing, and been discarded as deleted
 * -- leaving the name pending forever with nothing in any queue to say so.
 * A name is keyed by `user_id`, which is why `key` is here too.
 */
const TEXT_SOURCES: Record<
  Exclude<ModerationJob['subject_type'], 'photo'>,
  { table: string; key: string; column: string }
> = {
  comment: { table: 'comments', key: 'id', column: 'body' },
  note: { table: 'reports', key: 'id', column: 'note' },
  name: { table: 'display_names', key: 'user_id', column: 'name' },
  // Name and description together, so neither is approved without the other.
  group: { table: 'cleaning_groups', key: 'id', column: 'review_text' },
}

/**
 * The worker's whole relationship with the database.
 *
 * It talks to Supabase over ordinary outbound HTTPS. No inbound port, no
 * tunnel, no static IP, nothing to expose to the internet — which is what makes
 * "copy the folder, and `shared/` beside it, onto whichever machine has the GPU
 * and run it" true.
 */
export class Queue {
  private readonly client: MoClient
  private readonly workerId: string
  private readonly photoBaseUrl: string

  /**
   * `client` is injectable so the guards below can be tested without a
   * database. They are the only thing stopping a retried job from reversing a
   * decision a person already made, and they were previously untested.
   */
  constructor(config: Config, photoBaseUrl = '', client?: MoClient) {
    // The service role key bypasses row-level security entirely. It lives here,
    // in a process on a machine you control, and must never reach a browser.
    this.client =
      client ?? createMoClient(config.supabaseUrl, config.supabaseServiceRoleKey)
    this.workerId = config.workerId
    this.photoBaseUrl = photoBaseUrl.replace(/\/$/, '')
  }

  /** Claim a batch. Safe to run several workers at once; the RPC skips locked rows. */
  async claim(batchSize: number): Promise<ModerationJob[]> {
    const { data, error } = await this.client.rpc('claim_moderation_jobs', {
      worker_id: this.workerId,
      batch_size: batchSize,
    })
    if (error) throw new Error(`could not claim jobs: ${error.message}`)
    return (data ?? []) as ModerationJob[]
  }

  /** Fetch the content a job refers to. Returns null if it has since been deleted. */
  async fetchSubject(job: ModerationJob): Promise<Subject | null> {
    if (job.subject_type === 'photo') {
      const { data, error } = await this.client
        .from('report_photos')
        .select('storage_path')
        .eq('id', job.subject_id)
        .maybeSingle()
      if (error) throw new Error(`could not load photo: ${error.message}`)
      if (!data) return null
      return { kind: 'image', url: `${this.photoBaseUrl}/${String(data.storage_path).replace(/^\//, '')}` }
    }

    const { table, key, column } = TEXT_SOURCES[job.subject_type]

    const { data, error } = await this.client
      .from(table)
      .select(column)
      .eq(key, job.subject_id)
      .maybeSingle()
    if (error) throw new Error(`could not load ${job.subject_type}: ${error.message}`)
    if (!data) return null

    const text = (data as unknown as Record<string, unknown>)[column]
    if (typeof text !== 'string') return null
    const purpose = job.subject_type === 'name' || job.subject_type === 'group' ? job.subject_type : 'report'
    return { kind: 'text', text, purpose }
  }

  /**
   * Write back what was decided.
   *
   * Approve and reject go through record_moderation_verdict, which updates the
   * job and the content it judged in one transaction — a job can never be
   * marked done while the thing it judged stays pending.
   */
  async record(job: ModerationJob, decision: Decision): Promise<boolean> {
    if (decision.action === 'escalate') {
      const { data, error } = await this.client.rpc('escalate_moderation_job', {
        job_id: job.id,
        tier_results: decision.tierResults,
        reason: decision.reason,
      })
      if (error) throw new Error(`could not escalate job ${job.id}: ${error.message}`)
      // Same guard as the verdict path: an admin may have decided it while the
      // pipeline was running, in which case nothing was written.
      return data === true
    }

    const { data, error } = await this.client.rpc('record_moderation_verdict', {
      job_id: job.id,
      new_verdict: decision.action === 'approve' ? 'approved' : 'rejected',
      decided_by: decision.decidedBy,
      tier_results: decision.tierResults,
      reason: decision.reason,
    })
    if (error) throw new Error(`could not record verdict for job ${job.id}: ${error.message}`)

    // The RPC refuses to publish anything carrying an unresolved complaint, and
    // says so rather than raising. Returning that stops the caller logging a
    // verdict which was never recorded.
    return data === true
  }

  /**
   * Record that this job could not be processed.
   *
   * Leaving it 'in_progress' would rely on the 15-minute lock expiry to retry
   * it, with no record that anything went wrong -- and once its retries are
   * exhausted it would sit claimed forever, invisible to the admin queue, with
   * its content withheld and nobody able to release it.
   */
  async fail(job: ModerationJob, reason: string): Promise<void> {
    // Guarded, like every other write to this table. Unconditionally stamping
    // 'failed' could overwrite a job that someone flagged mid-processing, or one
    // an admin had already ruled on -- and since a failed job is re-claimable,
    // the retry would then let the machine silently reverse a human's decision.
    const { error } = await this.client
      .from('moderation_jobs')
      .update({ status: 'failed', reason, locked_at: null, locked_by: null })
      .eq('id', job.id)
      .eq('status', 'in_progress')
      .is('verdict', null)
    if (error) throw new Error(`could not mark job ${job.id} failed: ${error.message}`)
  }

  /** A batch of R2 objects to delete. See claim_objects_to_delete in 0006. */
  async claimObjectsToDelete(batchSize = 50): Promise<Array<{ storage_path: string; reason: string }>> {
    const { data, error } = await this.client.rpc('claim_objects_to_delete', { batch_size: batchSize })
    if (error) throw new Error(`could not claim objects to delete: ${error.message}`)
    return (data ?? []) as Array<{ storage_path: string; reason: string }>
  }

  /** Record that R2 has removed an object. */
  async recordObjectDeleted(path: string): Promise<void> {
    const { error } = await this.client.rpc('record_object_deleted', { path })
    if (error) throw new Error(`could not record ${path} as deleted: ${error.message}`)
  }

  /** A job whose content vanished has nothing left to judge. */
  async discard(job: ModerationJob, reason: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('escalate_moderation_job', {
      job_id: job.id,
      tier_results: { discarded: true },
      reason,
    })
    if (error) throw new Error(`could not discard job ${job.id}: ${error.message}`)
    return data === true
  }
}
