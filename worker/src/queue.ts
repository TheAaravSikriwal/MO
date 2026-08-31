import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Config } from './config.js'
import type { Decision, ModerationJob, Subject } from './types.js'

/**
 * The worker's whole relationship with the database.
 *
 * It talks to Supabase over ordinary outbound HTTPS. No inbound port, no
 * tunnel, no static IP, nothing to expose to the internet — which is what makes
 * "copy the folder onto whichever machine has the GPU and run it" true.
 */
export class Queue {
  private readonly client: SupabaseClient
  private readonly workerId: string
  private readonly photoBaseUrl: string

  constructor(config: Config, photoBaseUrl = '') {
    // The service role key bypasses row-level security entirely. It lives here,
    // in a process on a machine you control, and must never reach a browser.
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
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

    const table = job.subject_type === 'comment' ? 'comments' : 'reports'
    const column = job.subject_type === 'comment' ? 'body' : 'note'

    const { data, error } = await this.client
      .from(table)
      .select(column)
      .eq('id', job.subject_id)
      .maybeSingle()
    if (error) throw new Error(`could not load ${job.subject_type}: ${error.message}`)
    if (!data) return null

    const text = (data as Record<string, unknown>)[column]
    if (typeof text !== 'string') return null
    return { kind: 'text', text }
  }

  /**
   * Write back what was decided.
   *
   * Approve and reject go through record_moderation_verdict, which updates the
   * job and the content it judged in one transaction — a job can never be
   * marked done while the thing it judged stays pending.
   */
  async record(job: ModerationJob, decision: Decision): Promise<void> {
    if (decision.action === 'escalate') {
      const { error } = await this.client.rpc('escalate_moderation_job', {
        job_id: job.id,
        tier_results: decision.tierResults,
        reason: decision.reason,
      })
      if (error) throw new Error(`could not escalate job ${job.id}: ${error.message}`)
      return
    }

    const { error } = await this.client.rpc('record_moderation_verdict', {
      job_id: job.id,
      new_verdict: decision.action === 'approve' ? 'approved' : 'rejected',
      decided_by: decision.decidedBy,
      tier_results: decision.tierResults,
      reason: decision.reason,
    })
    if (error) throw new Error(`could not record verdict for job ${job.id}: ${error.message}`)
  }

  /** A job whose content vanished has nothing left to judge. */
  async discard(job: ModerationJob, reason: string): Promise<void> {
    const { error } = await this.client.rpc('escalate_moderation_job', {
      job_id: job.id,
      tier_results: { discarded: true },
      reason,
    })
    if (error) throw new Error(`could not discard job ${job.id}: ${error.message}`)
  }
}
