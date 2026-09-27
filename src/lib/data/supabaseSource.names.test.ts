import { describe, it, expect, vi } from 'vitest'

/**
 * Names, against a fake Supabase client.
 *
 * What these pin is the shape of the calls, not the SQL: that comments take
 * their author's name from `public_comments` and never go looking for it by
 * id. The lookup that used to be here resolved ids through chintu's
 * `public.profiles`, where a magic-link signup's name is their email prefix.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

interface Recorded {
  rpc: Array<{ name: string; args: unknown }>
  selects: Array<{ table: string; columns: string }>
}

function fakeClient(options: {
  rows?: Array<Record<string, unknown>>
  rpcResult?: { data: unknown; error: { message: string } | null }
}) {
  const recorded: Recorded = { rpc: [], selects: [] }
  const client = {
    recorded,
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name: string, args?: unknown) => {
      recorded.rpc.push({ name, args })
      return options.rpcResult ?? { data: null, error: null }
    },
    from: (table: string) => ({
      select: (columns: string) => {
        recorded.selects.push({ table, columns })
        const chain = {
          eq: () => chain,
          order: async () => ({ data: options.rows ?? [], error: null }),
        }
        return chain
      },
    }),
  }
  return client
}

const make = (options: Parameters<typeof fakeClient>[0] = {}) => {
  const client = fakeClient(options)
  mocks.client = client
  return {
    source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', ''),
    recorded: client.recorded,
  }
}

describe('SupabaseDataSource — comment authors', () => {
  it('reads the name from the comments view, and makes no second lookup', async () => {
    const { source, recorded } = make({
      rows: [
        { id: 'c1', body: 'Still here', author_name: 'Sam', created_at: '2026-09-01', moderation_status: 'approved' },
      ],
    })
    const comments = await source.listComments('r1')

    expect(comments[0].authorName).toBe('Sam')
    expect(recorded.selects).toEqual([
      {
        table: 'public_comments',
        columns: 'id, body, author_name, viewer_is_author, created_at, moderation_status',
      },
    ])
    expect(recorded.rpc).toEqual([])
  })

  it('never asks for author_id, which leads straight to an email prefix', async () => {
    const { source, recorded } = make({ rows: [] })
    await source.listComments('r1')
    expect(recorded.selects[0].columns).not.toContain('author_id')
  })

  it('says "someone" while a name is still being checked', async () => {
    const { source } = make({
      rows: [
        { id: 'c1', body: 'Still here', author_name: null, created_at: '2026-09-01', moderation_status: 'approved' },
      ],
    })
    expect((await source.listComments('r1'))[0].authorName).toBe('someone')
  })
})

describe('SupabaseDataSource — complaining about a name', () => {
  it('names the comment, never an author id, and goes through the RPC', async () => {
    const { source, recorded } = make()
    await source.flagCommentAuthorName('c1', 'reported by a reader')
    expect(recorded.rpc).toEqual([
      { name: 'flag_comment_author', args: { target_comment: 'c1', reason: 'reported by a reader' } },
    ])
    expect(recorded.selects).toEqual([])
  })

  it('reads whether you wrote a comment from the view, not from an id', async () => {
    const { source } = make({
      rows: [
        { id: 'c1', body: 'a', author_name: 'Sam', viewer_is_author: true, created_at: 'x', moderation_status: 'approved' },
        { id: 'c2', body: 'b', author_name: null, viewer_is_author: false, created_at: 'x', moderation_status: 'approved' },
      ],
    })
    const [mine, theirs] = await source.listComments('r1')
    expect(mine).toMatchObject({ viewerIsAuthor: true, authorNamed: true })
    expect(theirs).toMatchObject({ viewerIsAuthor: false, authorNamed: false, authorName: 'someone' })
  })
})

describe('SupabaseDataSource — your own name', () => {
  it('reads it through my_display_name', async () => {
    const { source, recorded } = make({
      rpcResult: { data: [{ name: 'Sam', moderation_status: 'pending' }], error: null },
    })
    expect(await source.getMyDisplayName()).toEqual({ name: 'Sam', status: 'pending' })
    expect(recorded.rpc.map((call) => call.name)).toEqual(['my_display_name'])
  })

  it('returns null when none has been chosen', async () => {
    const { source } = make({ rpcResult: { data: [], error: null } })
    expect(await source.getMyDisplayName()).toBeNull()
  })

  it('throws, rather than claiming there is no name, when the lookup fails', async () => {
    // Null means "ask for one". Reading a failure that way would ask somebody
    // who already has a name to choose again, and the new one would be refused
    // as too soon.
    const { source } = make({ rpcResult: { data: null, error: { message: 'network is down' } } })
    await expect(source.getMyDisplayName()).rejects.toThrow('network is down')
  })

  it('saves it through set_display_name', async () => {
    const { source, recorded } = make()
    await source.setDisplayName('Sam')
    expect(recorded.rpc).toEqual([{ name: 'set_display_name', args: { new_name: 'Sam' } }])
  })

  it('passes a refusal on, so the form can say why', async () => {
    const { source } = make({
      rpcResult: { data: null, error: { message: 'a name can be changed once a day' } },
    })
    await expect(source.setDisplayName('Sam')).rejects.toThrow('once a day')
  })
})
