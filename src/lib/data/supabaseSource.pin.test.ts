import { describe, it, expect, vi } from 'vitest'

/** The one call that takes a pin off the map, against a fake client. */

const mocks = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

const make = (error: { message: string } | null = null) => {
  const rpc: Array<{ name: string; args: unknown }> = []
  mocks.client = {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    rpc: async (name: string, args?: unknown) => {
      rpc.push({ name, args })
      return { data: null, error }
    },
  }
  return { source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', ''), rpc }
}

describe('SupabaseDataSource — taking a pin off the map', () => {
  it('goes through admin_set_report_on_map', async () => {
    const { source, rpc } = make()
    await source.setReportOnMap('r1', false, 'spam')
    await source.setReportOnMap('r1', true)
    expect(rpc).toEqual([
      { name: 'admin_set_report_on_map', args: { target_report: 'r1', on_map: false, reason: 'spam' } },
      { name: 'admin_set_report_on_map', args: { target_report: 'r1', on_map: true, reason: null } },
    ])
  })

  it('says whether the pin moved, as the database answers', async () => {
    const answer = (data: unknown) => {
      mocks.client = {
        auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
        rpc: async () => ({ data, error: null }),
      }
      return new SupabaseDataSource('https://project.supabase.co', 'anon-key', '')
    }
    expect(await answer(true).setReportOnMap('r1', false)).toBe(true)
    expect(await answer(false).setReportOnMap('r1', false)).toBe(false)
  })

  it('passes a refusal on', async () => {
    const { source } = make({ message: 'only an admin may take a pin off the map' })
    await expect(source.setReportOnMap('r1', false)).rejects.toThrow('only an admin')
  })
})
