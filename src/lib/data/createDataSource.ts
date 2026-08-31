import { FakeDataSource } from './fakeSource'
import { SupabaseDataSource } from './supabaseSource'
import type { DataSource } from './types'

export interface DataSourceChoice {
  source: DataSource
  /** True when no backend is configured and the app is running on sample data. */
  demo: boolean
}

/**
 * Pick a backend.
 *
 * With Supabase configured, use it. Without, fall back to an in-memory source
 * seeded with a few reports, so `npm run dev` gives you a working map instead
 * of a blank error screen. The UI cannot tell the difference — that is the
 * whole point of the DataSource interface.
 */
export function createDataSource(env: Record<string, string | undefined>): DataSourceChoice {
  const url = env.VITE_SUPABASE_URL?.trim()
  const key = env.VITE_SUPABASE_ANON_KEY?.trim()

  if (url && key) {
    return {
      source: new SupabaseDataSource(url, key, env.VITE_PHOTO_BASE_URL?.trim() ?? ''),
      demo: false,
    }
  }

  return { source: createDemoSource(), demo: true }
}

/** A handful of reports around central London, purely so the map is not empty. */
export function createDemoSource(): FakeDataSource {
  const source = new FakeDataSource(null)
  const seeds: Array<[string, number, number, string, number, 'open' | 'cleaned']> = [
    ['demo-1', 51.5074, -0.1278, 'Bags of rubbish by the bus stop', 4, 'open'],
    ['demo-2', 51.5081, -0.1265, 'Broken glass along the path', 1, 'open'],
    ['demo-3', 51.5069, -0.1291, 'Fly-tipping behind the shops', 9, 'open'],
    ['demo-4', 51.5055, -0.1301, 'Litter around the benches', 0, 'cleaned'],
    ['demo-5', 51.5102, -0.1249, 'Cans and bottles in the hedge', 2, 'open'],
  ]

  for (const [id, lat, lng, note, voteCount, status] of seeds) {
    source.seed({ id, lat, lng, note, voteCount, status, noteStatus: 'approved' })
  }
  return source
}
