import { FakeDataSource } from './fakeSource'
import { ideaCountFromSearch, largeDemoReports } from './largeDemo'
import { SupabaseDataSource } from './supabaseSource'
import type { DataSource } from './types'

export interface DataSourceChoice {
  source: DataSource
  /** True when no backend is configured and the app is running on sample data. */
  demo: boolean
}

/**
 * The real backend, if there is one.
 *
 * With Supabase configured, use it. Without, an empty in-memory source, with
 * `demo` set so the app can say so: the "Real world" side of the switch shows
 * that empty map and explains it isn't connected. Made-up reports are the
 * other side's alone ("The idea", createIdeaSource below) -- never mixed into
 * this one, where they could be taken for real.
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

  return { source: new FakeDataSource(null), demo: true }
}

/**
 * "The idea": thousands of made-up reports around the world, to show how the
 * map looks at scale (see largeDemo.ts). `?count=` in the address changes how
 * many.
 */
export function createIdeaSource(
  search: string = globalThis.location?.search ?? '',
): FakeDataSource {
  const source = new FakeDataSource(null)
  for (const report of largeDemoReports(ideaCountFromSearch(search))) {
    source.seed({ ...report, noteStatus: 'approved' })
  }
  return source
}
