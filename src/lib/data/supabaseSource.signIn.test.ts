import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * Where the sign-in link goes, against a fake Supabase client.
 *
 * With no redirect named, Supabase sends the link to the project's Site URL.
 * In the wearechintu site that is the home page, not /map, so the person would
 * follow the link and land somewhere that never picks the sign-in up.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.client }))

const { SupabaseDataSource } = await import('./supabaseSource')

function make(result: { error: { message: string } | null } = { error: null }) {
  const calls: unknown[] = []
  mocks.client = {
    auth: {
      signInWithOtp: async (args: unknown) => {
        calls.push(args)
        return result
      },
    },
  }
  return { source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', ''), calls }
}

afterEach(() => window.history.replaceState(null, '', '/'))

describe('SupabaseDataSource — signing in by email', () => {
  it('sends the link back to the page it was asked for from', async () => {
    window.history.replaceState(null, '', '/map')
    const { source, calls } = make()
    await source.signInWithEmail('sam@example.com')
    expect(calls).toEqual([
      { email: 'sam@example.com', options: { emailRedirectTo: `${window.location.origin}/map` } },
    ])
  })

  it('leaves the query and hash off, so one Redirect URLs entry covers the page', async () => {
    window.history.replaceState(null, '', '/map?report=abc#photo')
    const { source, calls } = make()
    await source.signInWithEmail('sam@example.com')
    expect(calls).toEqual([
      { email: 'sam@example.com', options: { emailRedirectTo: `${window.location.origin}/map` } },
    ])
  })

  it('passes a refusal on as an error', async () => {
    const { source } = make({ error: { message: 'Email rate limit exceeded' } })
    await expect(source.signInWithEmail('sam@example.com')).rejects.toThrow('Email rate limit exceeded')
  })
})
