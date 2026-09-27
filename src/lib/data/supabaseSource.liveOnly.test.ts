import { describe, it, expect, vi } from 'vitest'

/**
 * The main map query carries live pins only, and off-map pins are asked for
 * separately and only when somebody is signed in.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

const bounds = { minLat: 51, minLng: -1, maxLat: 52, maxLng: 1 }
const filters = { status: 'all' as const, minConfirmations: 0, since: null, origin: null, withinMetres: null }

const make = (user: { id: string } | null) => {
  const calls: unknown[][] = []
  mocks.client = {
    auth: {
      getUser: async () => ({ data: { user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) => {
      calls.push(['from', table])
      const done = async () => ({ data: [], error: null })
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'gte', 'lte', 'or']) chain[method] = () => chain
      chain.eq = (column: string, value: unknown) => {
        calls.push(['eq', column, value])
        return chain
      }
      chain.neq = (column: string, value: unknown) => {
        calls.push(['neq', column, value])
        return chain
      }
      chain.order = () => chain
      chain.limit = done
      chain.in = done
      return chain
    },
  }
  return { source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', ''), calls }
}

describe('SupabaseDataSource — live pins and off-map pins stay apart', () => {
  it('never lets an off-map pin into the main page', async () => {
    const { source, calls } = make({ id: 'u1' })
    await source.listReportsInView(bounds, filters)
    expect(calls).toContainEqual(['neq', 'moderation_status', 'rejected'])
  })

  it('asks for off-map pins by status', async () => {
    const { source, calls } = make({ id: 'u1' })
    await source.listOffMapInView(bounds, { ...filters, status: 'cleaned', minConfirmations: 2 })
    expect(calls).toContainEqual(['eq', 'moderation_status', 'rejected'])
    // And the same filters as the live pins.
    expect(calls).toContainEqual(['eq', 'status', 'cleaned'])
  })

  it('does not ask at all when nobody is signed in', async () => {
    const { source, calls } = make(null)
    expect(await source.listOffMapInView(bounds, filters)).toEqual({ reports: [], more: false })
    expect(calls).toEqual([])
  })
})
