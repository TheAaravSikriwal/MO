import { describe, it, expect, vi } from 'vitest'

/** Recent rejections and allowing one after all, on the real source. */

const mocks = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

const make = (data: unknown) => {
  const rpc: Array<{ name: string; args: unknown }> = []
  mocks.client = {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    rpc: async (name: string, args?: unknown) => {
      rpc.push({ name, args })
      return { data, error: null }
    },
  }
  return { source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', 'https://img.example'), rpc }
}

describe('SupabaseDataSource — photos removed recently', () => {
  it('reads admin_recent_rejected_photos, and tells a machine’s decision from a person’s', async () => {
    const { source, rpc } = make([
      { photo_id: 'p1', report_id: 'r1', storage_path: 'u/r/a.jpg', rejected_at: 't', decided_by: 'tier2:nsfw' },
      { photo_id: 'p2', report_id: 'r1', storage_path: 'u/r/b.jpg', rejected_at: 't', decided_by: 'human:abc' },
    ])
    const { photos, more } = await source.listRecentlyRejectedPhotos()
    // One more than a page, so a list cut short can say so.
    expect(rpc).toEqual([{ name: 'admin_recent_rejected_photos', args: { max_results: 51 } }])
    expect(more).toBe(false)
    expect(photos.map((photo) => [photo.photoId, photo.automatic, photo.url])).toEqual([
      ['p1', true, 'https://img.example/u/r/a.jpg'],
      ['p2', false, 'https://img.example/u/r/b.jpg'],
    ])
  })

  it('allows one after all through admin_allow_rejected_photo', async () => {
    const { source, rpc } = make(null)
    await source.allowRejectedPhoto('p1')
    expect(rpc).toEqual([{ name: 'admin_allow_rejected_photo', args: { target_photo: 'p1' } }])
  })
})
