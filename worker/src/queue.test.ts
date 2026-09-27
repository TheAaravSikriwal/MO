import { describe, it, expect, vi } from 'vitest'
import { Queue } from './queue.js'
import type { Config } from './config.js'
import type { Decision, ModerationJob } from './types.js'

/**
 * These cover the guards that stop the worker reversing a decision a person
 * already made. Nothing else in the suite touches them, so without this file
 * deleting `.eq('status', 'in_progress').is('verdict', null)` from `fail()`
 * would break nothing visible.
 */

const config: Config = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'service-role',
  moderationEndpoint: '',
  textModel: 'x',
  visionModel: 'y',
  thresholds: {
    nsfw: { rejectAbove: 0.85, approveBelow: 0.15 },
    toxicity: { rejectAbove: 0.8, approveBelow: 0.2 },
  },
  workerId: 'test-worker',
  batchSize: 10,
  pollIntervalMs: 15000,
  cleanupIntervalMs: 600000,
}

const job: ModerationJob = {
  id: 'job-1',
  subject_type: 'photo',
  subject_id: 'photo-1',
  attempts: 1,
}

type Filter = [string, unknown, unknown]

/** A stand-in for postgrest-js: records the filters applied, then resolves. */
const makeUpdateBuilder = () => {
  const filters: Filter[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['eq', 'is', 'in', 'neq']) {
    builder[method] = (column: unknown, value: unknown) => {
      filters.push([method, column, value])
      return builder
    }
  }
  builder.then = (resolve: (value: unknown) => void) => resolve({ error: null })
  return { builder, filters }
}

const makeClient = (rpcImpl?: ReturnType<typeof vi.fn>) => {
  const rpc = rpcImpl ?? vi.fn().mockResolvedValue({ data: true, error: null })
  const updates: Array<{ table: string; values: unknown; filters: Filter[] }> = []

  const client = {
    rpc,
    from: (table: string) => ({
      update: (values: unknown) => {
        const { builder, filters } = makeUpdateBuilder()
        updates.push({ table, values, filters })
        return builder
      },
    }),
  }
  return { client: client as never, rpc, updates }
}

const decision = (action: Decision['action']): Decision => ({
  action,
  decidedBy: 'tier2:test',
  reason: 'because',
  tierResults: {},
})

describe('Queue.record', () => {
  it('reports that a verdict was applied when the database says so', async () => {
    const { client, rpc } = makeClient()
    expect(await new Queue(config, '', client).record(job, decision('approve'))).toBe(true)
    expect(rpc.mock.calls[0][0]).toBe('record_moderation_verdict')
    expect(rpc.mock.calls[0][1]).toMatchObject({ job_id: 'job-1', new_verdict: 'approved' })
  })

  it('reports that it was NOT applied when the database refuses', async () => {
    // The RPC refuses rather than raising when a flag landed or an admin got
    // there first. Treating that as success makes the log claim a decision
    // that was never recorded.
    const { client } = makeClient(vi.fn().mockResolvedValue({ data: false, error: null }))
    expect(await new Queue(config, '', client).record(job, decision('approve'))).toBe(false)
  })

  it('maps reject to the rejected verdict', async () => {
    const { client, rpc } = makeClient()
    await new Queue(config, '', client).record(job, decision('reject'))
    expect(rpc.mock.calls[0][1]).toMatchObject({ new_verdict: 'rejected' })
  })

  it('escalates through the escalate RPC, not the verdict one', async () => {
    const { client, rpc } = makeClient()
    await new Queue(config, '', client).record(job, decision('escalate'))
    expect(rpc.mock.calls[0][0]).toBe('escalate_moderation_job')
  })

  it('reports a refused escalation as not applied', async () => {
    const { client } = makeClient(vi.fn().mockResolvedValue({ data: false, error: null }))
    expect(await new Queue(config, '', client).record(job, decision('escalate'))).toBe(false)
  })

  it('throws when the database errors, rather than reporting success', async () => {
    const { client } = makeClient(
      vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    )
    await expect(new Queue(config, '', client).record(job, decision('approve'))).rejects.toThrow(
      /boom/,
    )
  })
})

describe('Queue.fail', () => {
  it('only marks a job failed while it is still in progress and undecided', async () => {
    // Without both guards a job an admin already ruled on could be stamped
    // failed, re-claimed, and auto-decided over the top.
    const { client, updates } = makeClient()
    await new Queue(config, '', client).fail(job, 'model unavailable')

    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('moderation_jobs')
    expect(updates[0].filters).toContainEqual(['eq', 'id', 'job-1'])
    expect(updates[0].filters).toContainEqual(['eq', 'status', 'in_progress'])
    expect(updates[0].filters).toContainEqual(['is', 'verdict', null])
  })

  it('releases the lock so the job is not left claimed', async () => {
    const { client, updates } = makeClient()
    await new Queue(config, '', client).fail(job, 'model unavailable')
    expect(updates[0].values).toMatchObject({
      status: 'failed',
      locked_at: null,
      locked_by: null,
    })
  })

  it('records why it failed', async () => {
    const { client, updates } = makeClient()
    await new Queue(config, '', client).fail(job, 'model unavailable')
    expect(updates[0].values).toMatchObject({ reason: 'model unavailable' })
  })
})

describe('Queue.discard', () => {
  it('goes through the guarded escalate RPC', async () => {
    const { client, rpc } = makeClient()
    await new Queue(config, '', client).discard(job, 'content is gone')
    expect(rpc.mock.calls[0][0]).toBe('escalate_moderation_job')
    expect(rpc.mock.calls[0][1]).toMatchObject({ job_id: 'job-1' })
  })
})

describe('Queue.claim', () => {
  it('identifies itself so a stuck lock can be traced back to a worker', async () => {
    const { client, rpc } = makeClient(vi.fn().mockResolvedValue({ data: [], error: null }))
    await new Queue(config, '', client).claim(5)
    expect(rpc.mock.calls[0][1]).toMatchObject({ worker_id: 'test-worker', batch_size: 5 })
  })

  it('throws rather than returning an empty batch when the queue is unreachable', async () => {
    // Returning [] would look exactly like "nothing to do", and the worker
    // would sleep through an outage reporting a clear queue.
    const { client } = makeClient(
      vi.fn().mockResolvedValue({ data: null, error: { message: 'offline' } }),
    )
    await expect(new Queue(config, '', client).claim(5)).rejects.toThrow(/offline/)
  })

  it('returns an empty list when there is genuinely nothing queued', async () => {
    const { client } = makeClient(vi.fn().mockResolvedValue({ data: null, error: null }))
    expect(await new Queue(config, '', client).claim(5)).toEqual([])
  })
})

describe('Queue.fetchSubject', () => {
  /** Records the table, column and filter a text lookup used. */
  const makeReadClient = (row: Record<string, unknown> | null) => {
    const calls: Array<{ table: string; column: string; key: string; value: unknown }> = []
    const client = {
      from: (table: string) => ({
        select: (column: string) => ({
          eq: (key: string, value: unknown) => ({
            maybeSingle: async () => {
              calls.push({ table, column, key, value })
              return { data: row, error: null }
            },
          }),
        }),
      }),
    }
    return { client: client as never, calls }
  }

  it.each([
    ['comment', 'comments', 'id', 'body'],
    ['note', 'reports', 'id', 'note'],
    // A name is keyed by the person's id. Looking it up by `id` in reports --
    // what the old ternary did for anything that was not a comment -- finds
    // nothing, and the job is discarded as deleted with the name left pending.
    ['name', 'display_names', 'user_id', 'name'],
  ] as const)('reads a %s from %s by %s', async (subjectType, table, key, column) => {
    const { client, calls } = makeReadClient({ [column]: 'some words' })
    const subject = await new Queue(config, '', client).fetchSubject({
      id: 'job-9',
      subject_type: subjectType,
      subject_id: 'subject-9',
      attempts: 1,
    })
    expect(calls).toEqual([{ table, column, key, value: 'subject-9' }])
    // Names are judged by different rules, so the judge has to be told which.
    expect(subject).toEqual({
      kind: 'text',
      text: 'some words',
      purpose: subjectType === 'name' ? 'name' : 'report',
    })
  })

  it('treats a vanished name as deleted', async () => {
    const { client } = makeReadClient(null)
    const subject = await new Queue(config, '', client).fetchSubject({
      id: 'job-9',
      subject_type: 'name',
      subject_id: 'user-9',
      attempts: 1,
    })
    expect(subject).toBeNull()
  })
})

describe('Queue — the R2 cleanup calls', () => {
  it('claims through claim_objects_to_delete, by batch_size', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ storage_path: 'a', reason: 'unused' }], error: null })
    const { client } = makeClient(rpc)
    const claimed = await new Queue(config, '', client).claimObjectsToDelete(25)
    expect(rpc).toHaveBeenCalledWith('claim_objects_to_delete', { batch_size: 25 })
    expect(claimed).toEqual([{ storage_path: 'a', reason: 'unused' }])
  })

  it('records through record_object_deleted, by path', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const { client } = makeClient(rpc)
    await new Queue(config, '', client).recordObjectDeleted('u/r/p.jpg')
    expect(rpc).toHaveBeenCalledWith('record_object_deleted', { path: 'u/r/p.jpg' })
  })

  it('says so when either fails, rather than carrying on silently', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const { client } = makeClient(rpc)
    await expect(new Queue(config, '', client).claimObjectsToDelete()).rejects.toThrow('boom')
    await expect(new Queue(config, '', client).recordObjectDeleted('x')).rejects.toThrow('boom')
  })
})
