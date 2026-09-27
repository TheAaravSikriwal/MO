import { describe, it, expect, vi } from 'vitest'
import { OFF_MAP_IN_VIEW } from './types'

/**
 * "There are more" has to come from what the database returned, not from what
 * is left after the radius trims the box's corners. Otherwise a full page with
 * some rows trimmed reads as complete while matching pins lay beyond the limit.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

const origin = { lat: 51.5, lng: -0.12 }

const row = (i: number, near: boolean) => ({
  id: `r${i}`,
  reporter_id: null,
  // Near ones sit on the origin; far ones in the box's corner, about 3 km out.
  lat: near ? origin.lat : origin.lat + 0.02,
  lng: near ? origin.lng : origin.lng + 0.03,
  note: null,
  note_status: 'approved',
  moderation_status: 'rejected',
  status: 'open',
  vote_count: 0,
  created_at: '2026-09-01T00:00:00Z',
  reporter_name: null,
  removal_reason: null,
})

const withRows = (rows: unknown[]) => {
  mocks.client = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'admin-1' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'neq', 'gte', 'lte', 'or', 'order']) chain[method] = () => chain
      chain.limit = async () => ({ data: table === 'public_reports' ? rows : [], error: null })
      chain.in = async () => ({ data: [], error: null })
      return chain
    },
  }
  return new SupabaseDataSource('https://project.supabase.co', 'anon-key', '')
}

const filters = {
  status: 'all' as const,
  minConfirmations: 0,
  since: null,
  origin,
  withinMetres: 1000,
}
const bounds = { minLat: 51.4, minLng: -0.3, maxLat: 51.6, maxLng: 0.1 }

describe('SupabaseDataSource — off-map pins with a radius', () => {
  it('says there are more when the database filled its page, even after trimming', async () => {
    // A full page plus one, ten of them outside the radius.
    const rows = Array.from({ length: OFF_MAP_IN_VIEW + 1 }, (_, i) => row(i, i >= 10))
    const { reports, more } = await withRows(rows).listOffMapInView(bounds, filters)
    expect(reports.length).toBeLessThan(OFF_MAP_IN_VIEW)
    expect(more).toBe(true)
  })

  it('says nothing more when the database did not fill its page', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, i >= 5))
    const { reports, more } = await withRows(rows).listOffMapInView(bounds, filters)
    expect(reports).toHaveLength(15)
    expect(more).toBe(false)
  })
})
