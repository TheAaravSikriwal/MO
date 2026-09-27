import { describe, it, expect, vi } from 'vitest'

/** Listing pins off the map on the real source, against a fake client. */

const mocks = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

describe('SupabaseDataSource — pins off the map', () => {
  it('asks public_reports for rejected pins, most recently taken off first, and reads the reason', async () => {
    const calls: unknown[][] = []
    const row = {
      id: 'r1',
      reporter_id: null,
      lat: 51.5,
      lng: -0.12,
      note: null,
      note_status: 'approved',
      moderation_status: 'rejected',
      status: 'open',
      vote_count: 0,
      created_at: '2026-09-01T00:00:00Z',
      reporter_name: null,
      removal_reason: 'spam',
    }
    mocks.client = {
      auth: {
        getUser: async () => ({ data: { user: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        calls.push(['from', table])
        const chain = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            calls.push(['eq', column, value])
            return chain
          },
          order: (column: string, options: unknown) => {
            calls.push(['order', column, options])
            return chain
          },
          in: async () => ({ data: [], error: null }),
          limit: async (n: number) => {
            calls.push(['limit', n])
            return { data: table === 'public_reports' ? [row] : [], error: null }
          },
        }
        return chain
      },
    }
    const source = new SupabaseDataSource('https://project.supabase.co', 'anon-key', '')
    const { reports, more } = await source.listReportsOffMap()
    expect(calls).toContainEqual(['eq', 'moderation_status', 'rejected'])
    // When it was taken off, not when it was made: the pin an admin removed by
    // mistake a minute ago must be at the top however old the report is.
    expect(calls).toContainEqual(['order', 'removed_at', { ascending: false }])
    // One more than a page, so it can tell there are others.
    expect(calls).toContainEqual(['limit', 51])
    expect(reports[0].removalReason).toBe('spam')
    expect(more).toBe(false)
  })
})
