import { describe, it, expect, vi } from 'vitest'

/**
 * Cleaning groups against a fake Supabase client: the shape of each call, and
 * of what comes back. The SQL behind them is exercised in groups.run.test.ts.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

function make(result: { data: unknown; error: { message: string } | null } = { data: null, error: null }) {
  const calls: Array<{ name: string; args: unknown }> = []
  mocks.client = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name: string, args?: unknown) => {
      calls.push({ name, args })
      return result
    },
  }
  return { source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', ''), calls }
}

describe('SupabaseDataSource — cleaning groups', () => {
  it('asks for the groups in a viewport, and reads the rows it gets back', async () => {
    const { source, calls } = make({
      data: [
        {
          id: 'g1',
          name: 'Riverside Litter Pickers',
          description: null,
          home_lat: 51.5,
          home_lng: -0.12,
          moderation_status: 'approved',
          member_count: '12',
          viewer_is_member: true,
          viewer_is_founder: false,
        },
      ],
      error: null,
    })
    const groups = await source.listGroupsInView({ minLat: 51, minLng: -1, maxLat: 52, maxLng: 1 })
    expect(calls).toEqual([
      { name: 'cleaning_groups_in_view', args: { min_lat: 51, min_lng: -1, max_lat: 52, max_lng: 1 } },
    ])
    expect(groups).toEqual([
      {
        id: 'g1',
        name: 'Riverside Litter Pickers',
        description: '',
        lat: 51.5,
        lng: -0.12,
        status: 'approved',
        memberCount: 12,
        viewerIsMember: true,
        viewerIsFounder: false,
      },
    ])
  })

  it('starts a group through its function, with the names the function takes', async () => {
    const { source, calls } = make({ data: 'new-id', error: null })
    expect(await source.createGroup({ name: 'Park Tidy-Up', description: 'Sundays.', lat: 1, lng: 2 })).toEqual({
      id: 'new-id',
    })
    expect(calls).toEqual([
      { name: 'create_cleaning_group', args: { group_name: 'Park Tidy-Up', about: 'Sundays.', lat: 1, lng: 2 } },
    ])
  })

  it.each([
    ['joinGroup', 'join_cleaning_group'],
    ['leaveGroup', 'leave_cleaning_group'],
    ['deleteGroup', 'delete_cleaning_group'],
  ] as const)('%s calls %s with the group', async (method, rpc) => {
    const { source, calls } = make()
    await source[method]('g1')
    expect(calls).toEqual([{ name: rpc, args: { target: 'g1' } }])
  })

  it('passes a refusal on as an error, in the database’s words', async () => {
    const { source } = make({ data: null, error: { message: 'no such group' } })
    await expect(source.joinGroup('g1')).rejects.toThrow('no such group')
  })
})
