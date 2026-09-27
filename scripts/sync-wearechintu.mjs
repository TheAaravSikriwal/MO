#!/usr/bin/env node
/**
 * Copy MO into the wearechintu Next app, the same way every time.
 *
 *   node scripts/sync-wearechintu.mjs <path-to-wearechintu-checkout>
 *
 * MO is where the code is written and tested -- including the migrations,
 * which run against a real Postgres here (PGlite) and nowhere else. The map at
 * wearechintu's `/map` is a copy of it with a handful of changes Next needs.
 * Making those changes by hand on every sync is how a copy quietly drifts, so
 * they live here as exact replacements, each checked to match the number of
 * times expected. If MO's code moves under one, this stops and names it
 * instead of writing something half-converted.
 *
 * What goes where:
 *   src/**                       -> src/mo/**   (App.tsx becomes MapApp.tsx)
 *   api/_lib/{signUpload,r2}.ts  -> src/mo/server/
 *   shared/sigv4.ts              -> src/mo/server/sigv4.ts
 *   supabase/migrations/000N_*   -> supabase/migrations/01(N-1)_mo_*
 *   supabase/README.md           -> supabase/README.md, renumbered
 *
 * Not copied: the Vite entry points, and src/lib/db -- the migration tests,
 * which need PGlite and read MO's own migration file names. They stay here,
 * where the SQL is tested before it is copied.
 *
 * It only ever writes the files named above, and removes files in src/mo that
 * MO no longer has -- except README.md and map.css, which are written there by
 * hand. A map migration MO no longer has stops it with an error instead, since
 * it may have been applied. Nothing is written until every file is ready and
 * every check has passed, so a failed run leaves the target as it was.
 * Everything else in the target repository is left alone.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Files under src/ that are the standalone Vite app, not the map. */
const SKIP = new Set(['main.tsx', 'index.css', 'vite-env.d.ts'])
const SKIP_DIRS = new Set(['lib/db'])

/** Files in the target's src/mo written there by hand, which a sync never touches. */
const HAND_WRITTEN = new Set(['src/mo/README.md', 'src/mo/map.css'])

/** Migration numbers and file names, MO's to wearechintu's. */
const MIGRATIONS = {
  '0001': ['010', '0001_init_schema.sql', '010_mo_init_schema.sql'],
  '0002': ['011', '0002_functions_triggers.sql', '011_mo_functions_triggers.sql'],
  '0003': ['012', '0003_views_and_rls.sql', '012_mo_views_and_rls.sql'],
  '0004': ['013', '0004_rollup_and_worker_rpc.sql', '013_mo_rollup_and_worker_rpc.sql'],
  '0005': ['014', '0005_admin_queue.sql', '014_mo_admin_queue.sql'],
  '0006': ['015', '0006_upload_grants.sql', '015_mo_upload_grants.sql'],
}

/** Replace `find` with `replace`, insisting it occurs exactly `count` times. */
function swap(text, file, find, replace, count = 1) {
  const found = text.split(find).length - 1
  if (found !== count) {
    throw new Error(
      `sync: expected ${count} of ${JSON.stringify(find.slice(0, 80))} in ${file}, found ${found}`,
    )
  }
  return text.split(find).join(replace)
}

/** The text from `start` up to (not including) `end`, each found exactly once. */
function between(text, file, start, end) {
  for (const anchor of [start, end]) {
    if (text.split(anchor).length !== 2) {
      throw new Error(`sync: expected one ${JSON.stringify(anchor)} in ${file}`)
    }
  }
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  if (to < from) throw new Error(`sync: ${JSON.stringify(end)} comes before its start in ${file}`)
  return text.slice(from, to)
}

// --- the changes Next needs -------------------------------------------------------

const APP_HEADER = `'use client'

/**
 * The litter map, as a client component.
 *
 * \`'use client'\` is not optional here and not a preference: Leaflet reaches for
 * \`window\` and \`document\` as soon as it is imported, so every component below
 * has to run in the browser. The route at \`src/app/map\` loads this through
 * \`next/dynamic\` with \`ssr: false\` for the same reason -- marking it a client
 * component stops React rendering it on the server, but Next would still
 * EVALUATE the module during prerender, and importing Leaflet is enough to
 * fail.
 *
 * Generated from MO's src/App.tsx by scripts/sync-wearechintu.mjs. What
 * changed: the directive above, and where the Supabase configuration comes
 * from. Edit MO, not this file.
 */

`

const TRANSFORMS = {
  'App.tsx': (text, file) => {
    text = APP_HEADER + text
    text = swap(
      text,
      file,
      '  const chosen = useMemo(() => createDataSource(import.meta.env), [])',
      `  // Read one name at a time, deliberately. Next inlines
  // \`process.env.NEXT_PUBLIC_*\` only at literal property accesses, so handing
  // the whole env object over -- which is what \`import.meta.env\` allowed under
  // Vite -- would arrive as undefined in the browser bundle.
  //
  // The first two are the SAME variables the marketplace uses, so the map and
  // the store share one Supabase project and so one set of accounts. They do
  // not share a session: the store signs people in through GitHub on the
  // server, and the map keeps its own magic-link session in the browser.
  const chosen = useMemo(
    () =>
      createDataSource({
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        photoBaseUrl: process.env.NEXT_PUBLIC_PHOTO_BASE_URL,
      }),
    [],
  )`,
    )
    return text
  },

  'lib/data/createDataSource.ts': (text, file) => {
    text = swap(
      text,
      file,
      `export function createDataSource(env: Record<string, string | undefined>): DataSourceChoice {
  const url = env.VITE_SUPABASE_URL?.trim()
  const key = env.VITE_SUPABASE_ANON_KEY?.trim()`,
      `/**
 * What the map needs from the outside world to reach a real backend.
 *
 * Three named fields rather than MO's \`Record<string, string | undefined>\`
 * keyed on \`VITE_*\`. Next inlines \`process.env.NEXT_PUBLIC_*\` only at literal
 * property accesses, so a caller here has to read each one by name anyway.
 */
export interface DataSourceConfig {
  supabaseUrl?: string
  supabaseAnonKey?: string
  /** Where approved photos are served from. Public, behind Cloudflare. */
  photoBaseUrl?: string
}

export function createDataSource(config: DataSourceConfig): DataSourceChoice {
  const url = config.supabaseUrl?.trim()
  const key = config.supabaseAnonKey?.trim()`,
    )
    return swap(
      text,
      file,
      "new SupabaseDataSource(url, key, env.VITE_PHOTO_BASE_URL?.trim() ?? '')",
      "new SupabaseDataSource(url, key, config.photoBaseUrl?.trim() ?? '')",
    )
  },

  'lib/moderation/clientGate.ts': (text, file) => {
    text = swap(
      text,
      file,
      'moduleUrl: string = import.meta.env.VITE_NSFW_MODULE_URL || DEFAULT_NSFW_MODULE_URL,',
      `// \`process.env.NEXT_PUBLIC_*\`, not \`import.meta.env.VITE_*\`: Next inlines
  // the NEXT_PUBLIC_ prefix at build time, and \`import.meta.env\` is undefined
  // in a Next client bundle.
  moduleUrl: string = process.env.NEXT_PUBLIC_NSFW_MODULE_URL || DEFAULT_NSFW_MODULE_URL,`,
    )
    return swap(
      text,
      file,
      'const nsfwjs = (await import(/* @vite-ignore */ moduleUrl)) as NsfwModule',
      `// \`webpackIgnore\` is the directive Next honours; without it webpack
      // resolves the dynamic import at build time and bundles the model.
      const nsfwjs = (await import(
        /* webpackIgnore: true */ /* @vite-ignore */ moduleUrl
      )) as NsfwModule`,
    )
  },

  'components/map/MapView.tsx': (text, file) => {
    text = swap(
      text,
      file,
      "import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'",
      "import { MapContainer, TileLayer, ZoomControl, useMap, useMapEvents } from 'react-leaflet'",
    )
    // Leaflet's zoom buttons default to top-left, where the site's layout puts
    // the place-search box. Moved to the top right.
    text = swap(
      text,
      file,
      '    <MapContainer\n',
      `    <MapContainer
      // Leaflet puts its zoom buttons top-left by default, which is where the
      // site's overlay starts -- they landed on the place-search box. Moved
      // rather than moving the overlay, which is sized to the viewport.
      zoomControl={false}\n`,
    )
    return swap(text, file, '    </MapContainer>', '      <ZoomControl position="topright" />\n    </MapContainer>')
  },

  'lib/upload/uploadPhoto.ts': (text, file) =>
    // The route lives under the map's own namespace in the Next app.
    swap(
      text,
      file,
      "export const SIGN_UPLOAD_ENDPOINT = '/api/sign-upload'",
      "export const SIGN_UPLOAD_ENDPOINT = '/api/map/sign-upload'",
    ),
}

/**
 * Every test that mocks react-leaflet has to know ZoomControl exists, because
 * the map's MapView uses it (see the MapView transform) and MO's does not.
 */
const LEAFLET_MOCK = "vi.mock('react-leaflet', () => ({\n"
function withZoomControlMock(text, file) {
  if (!text.includes(LEAFLET_MOCK)) return text
  return swap(
    text,
    file,
    LEAFLET_MOCK,
    LEAFLET_MOCK +
      '  ZoomControl: ({ position }: { position?: string }) => <div data-testid="zoom" data-position={position} />,\n',
  )
}

/** The port's own check that the zoom buttons were moved, kept with MapView's tests. */
const ZOOM_TEST = `
  it('places the zoom buttons away from the overlay', () => {
    // Top-left is where the place search and the filter panel live. Left
    // there, Leaflet's buttons sat on top of the search box.
    render(<MapView initialCenter={[51.5, -0.12]} initialZoom={13} onViewChange={noop} />)
    expect(screen.getByTestId('zoom')).toHaveAttribute('data-position', 'topright')
  })
`

/** The app's own tests of App, pointed at MapApp. */
function appTest(text, file) {
  return swap(text, file, "import App from './App'", "import App from './MapApp'")
}

// --- copying -----------------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/**
 * Every file this run will write, by path, held until all of them are ready.
 * A replacement that fails to match throws while this is still filling, so
 * the target is left exactly as it was rather than part old and part new.
 */
const pending = new Map()

function write(target, path, text) {
  pending.set(path, text.replace(/\r\n/g, '\n'))
  return path
}

function flush(target) {
  for (const [path, text] of pending) {
    const full = join(target, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

function syncSource(target) {
  const written = []
  const src = join(MO, 'src')
  for (const path of walk(src)) {
    const rel = relative(src, path).split('\\').join('/')
    if (SKIP.has(rel)) continue
    if ([...SKIP_DIRS].some((dir) => rel.startsWith(dir + '/'))) continue
    let text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    let out = rel
    if (TRANSFORMS[rel]) text = TRANSFORMS[rel](text, rel)
    if (rel.endsWith('.test.tsx')) text = withZoomControlMock(text, rel)
    if (rel === 'components/map/MapView.test.tsx') {
      text = swap(text, rel, "describe('MapView', () => {\n  const noop = () => {}\n", "describe('MapView', () => {\n  const noop = () => {}\n" + ZOOM_TEST)
    }
    if (rel === 'components/map/CellLayer.test.tsx') {
      // The map's stylesheet is src/mo/map.css in the site, not index.css.
      text = swap(text, rel, "'..', '..', 'index.css'", "'..', '..', 'map.css'")
    }
    if (rel === 'App.tsx') out = 'MapApp.tsx'
    if (/^App(\.\w+)?\.test\.tsx$/.test(rel)) {
      text = appTest(text, rel)
      out = rel.replace(/^App/, 'MapApp')
    }
    written.push(write(target, `src/mo/${out}`, text))
  }
  return written
}

/** The upload endpoint's handler and its signer, rehomed under src/mo/server. */
function syncServer(target) {
  const files = [
    ['api/_lib/signUpload.ts', 'signUpload.ts'],
    ['api/_lib/signUpload.test.ts', 'signUpload.test.ts'],
    ['api/_lib/r2.ts', 'r2.ts'],
    ['api/_lib/r2.test.ts', 'r2.test.ts'],
    ['shared/sigv4.ts', 'sigv4.ts'],
    ['shared/sigv4.test.ts', 'sigv4.test.ts'],
  ]
  return files.map(([from, to]) => {
    let text = readFileSync(join(MO, from), 'utf8').replace(/\r\n/g, '\n')
    // Import paths: MO's api/_lib and shared/ reach into src/ from outside it;
    // under src/mo/server they are siblings of lib/.
    text = text.split("'../../src/lib/").join("'../lib/")
    text = text.split("'../../shared/sigv4'").join("'./sigv4'")
    // The one line on-call sees for a 503 names the route; name this app's.
    if (to === 'signUpload.ts') {
      text = swap(text, from, "'[mo] /api/sign-upload failed", "'[mo] /api/map/sign-upload failed")
    }
    if (to === 'signUpload.test.ts') {
      text = swap(text, from, ".toContain('/api/sign-upload')", ".toContain('/api/map/sign-upload')")
    }
    return write(target, `src/mo/server/${to}`, text)
  })
}

/** MO's migration numbers and file names, as wearechintu's. */
function renumber(text) {
  for (const [, newName, oldFile, newFile] of Object.entries(MIGRATIONS).map(([k, v]) => [k, ...v])) {
    text = text.split(oldFile).join(newFile)
  }
  for (const [old, [number]] of Object.entries(MIGRATIONS)) {
    // Whole numbers only: "0001" in prose or a heading, never inside another word.
    text = text.replace(new RegExp(`(?<![\\w.])${old}(?![\\w])`, 'g'), number)
  }
  return text.split('api/sign-upload').join('src/app/api/map/sign-upload')
}

function syncMigrations(target) {
  return Object.values(MIGRATIONS).map(([, from, to]) => {
    const text = readFileSync(join(MO, 'supabase', 'migrations', from), 'utf8').replace(/\r\n/g, '\n')
    return write(target, `supabase/migrations/${to}`, renumber(text))
  })
}

function syncDatabaseReadme(target) {
  let text = readFileSync(join(MO, 'supabase', 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  text = swap(
    text,
    'supabase/README.md',
    '# Database\n\nSchema, policies and RPCs for MO. Six migrations, applied in order.',
    `# The litter map's schema

Migrations \`010\` to \`015\` in this directory, applied in order. They are the map
at \`/map\`; \`001\` to \`009\` are the marketplace and have nothing to do with them.
The app-side notes are in \`src/mo/README.md\`.

Generated from MO's supabase/README.md by scripts/sync-wearechintu.mjs, where
these migrations are written and run against a real Postgres. Edit them there.`,
  )
  // MO's "how to apply" is about getting the files INTO this project; here they
  // already are. Renumbering it word for word would say `010` sorts before
  // `001`. Written without four-digit numbers, since renumber() runs after.
  text = swap(
    text,
    'supabase/README.md',
    between(
      text,
      'supabase/README.md',
      '**Apply the renumbered copies in the wearechintu project',
      'Then create the first admin',
    ),
    `**Apply them after \`009\`, in order.** MO numbers them with four digits, and
they are renumbered on the way in because the Supabase CLI compares migration
versions as text, where MO's numbers would sort before \`001\`. Paste each into
the Supabase SQL editor in order, or push them with this project's Supabase CLI
setup like any other migration.

`,
  )
  return write(target, 'supabase/README.md', renumber(text))
}

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/sync-wearechintu.mjs <path-to-wearechintu-checkout>')
  process.exit(2)
}
if (!statSync(join(target, 'src', 'mo'), { throwIfNoEntry: false })) {
  console.error(`sync: ${target} has no src/mo -- is it the wearechintu checkout?`)
  process.exit(2)
}

const written = [
  ...syncSource(target),
  ...syncServer(target),
  ...syncMigrations(target),
  syncDatabaseReadme(target),
]
const wrote = new Set(written)

// A migration may already have been applied, so one is never removed quietly.
// Checked before anything is written, so refusing leaves the target untouched.
const strays = readdirSync(join(target, 'supabase', 'migrations'))
  .map((name) => `supabase/migrations/${name}`)
  .filter((rel) => /^supabase\/migrations\/\d+_mo_/.test(rel) && !wrote.has(rel))
if (strays.length) {
  console.error(
    `sync: these map migrations are not MO's any more: ${strays.join(', ')}. Nothing was written.\n` +
      'If one has been applied, write a new migration that undoes it; otherwise delete it, then sync again.',
  )
  process.exit(1)
}

flush(target)
console.log(`sync: wrote ${written.length} files into ${target}`)

// A file deleted or renamed in MO would otherwise leave its old copy behind,
// still compiled and its tests still run -- the drift this script exists to
// stop. src/mo is MO's alone apart from the two files written there by hand,
// so anything else it holds that this run did not write is removed.
for (const path of walk(join(target, 'src', 'mo'))) {
  const rel = relative(target, path).split('\\').join('/')
  if (wrote.has(rel) || HAND_WRITTEN.has(rel)) continue
  unlinkSync(path)
  console.log(`sync: removed ${rel}, which MO no longer has`)
}
