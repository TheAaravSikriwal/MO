import { describe, it, expect, vi } from 'vitest'

/**
 * The reporter's name on the real source, against a fake client.
 *
 * The UI tests for it all use FakeDataSource, and the migration test only
 * checks the SQL text. These pin the two seams between: the column key the
 * source reads, and the RPC and argument name it calls. A typo in either would
 * leave every other test green while real reports showed no name and every
 * "Report this name" click failed.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

function fakeClient(reportRow: Record<string, unknown> | null) {
  const rpc: Array<{ name: string; args: unknown }> = []
  const client = {
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name: string, args?: unknown) => {
      rpc.push({ name, args })
      return { data: null, error: null }
    },
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: () => chain,
          in: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: table === 'public_reports' ? reportRow : null, error: null }),
        }
        return chain
      },
    }),
  }
  return { client, rpc }
}

const row = (reporterName: string | null) => ({
  id: 'r1',
  reporter_id: null,
  lat: 51.5,
  lng: -0.12,
  note: null,
  note_status: 'approved',
  moderation_status: 'approved',
  status: 'open',
  vote_count: 0,
  created_at: '2026-09-01T00:00:00Z',
  reporter_name: reporterName,
})

const make = (reportRow: Record<string, unknown> | null = null) => {
  const { client, rpc } = fakeClient(reportRow)
  mocks.client = client
  return { source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', ''), rpc }
}

describe('SupabaseDataSource — the name on a report', () => {
  it('reads reporter_name from public_reports', async () => {
    const { source } = make(row('Sam'))
    expect((await source.getReport('r1'))!.reporterName).toBe('Sam')
  })

  it('leaves it null while the name is still being checked', async () => {
    const { source } = make(row(null))
    expect((await source.getReport('r1'))!.reporterName).toBeNull()
  })

  it('reports the name through flag_report_author, naming the report', async () => {
    const { source, rpc } = make()
    await source.flagReporterName('r1', 'reported by a reader')
    expect(rpc).toEqual([
      { name: 'flag_report_author', args: { target_report: 'r1', reason: 'reported by a reader' } },
    ])
  })
})
