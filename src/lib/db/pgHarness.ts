import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A real Postgres, in process, with MO's migrations applied.
 *
 * PGlite is Postgres compiled to WebAssembly. It is the actual server, so
 * policies, grants, triggers, SECURITY DEFINER and `set role` behave exactly
 * as they do on Supabase. What it does not have is Supabase itself or PostGIS,
 * and the two stand-ins below replace exactly those and nothing else.
 *
 * Node only: it reads the migrations off disk.
 */

/**
 * What Supabase provides that the migrations assume: the three API roles, an
 * `auth.uid()` that reads the caller from the request, and the marketplace's
 * `public.profiles`, which MO references and never creates.
 *
 * auth.uid() here reads the same setting Supabase's does, so `asUser` below
 * sets it the way PostgREST would for a signed-in request.
 */
const SUPABASE_STANDIN = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- chintu's table, reduced to what matters here. display_name is what its
-- handle_new_user fills with the email's local part for a magic-link signup,
-- and it is readable by anon in that project -- mirrored, so a test can prove
-- MO never hands it out.
create table public.profiles (
  id uuid primary key,
  display_name text,
  username text
);
grant select on public.profiles to anon, authenticated;
`

/**
 * PostGIS, reduced to the three functions MO calls and a type to hold a point.
 *
 * A point is stored as 'lng lat' text, and st_dwithin is a real great-circle
 * distance, so the near-me filters are tested against honest geometry rather
 * than a stub that always says yes. btree_gist lets the one gist index on the
 * column build.
 */
const POSTGIS_STANDIN = `
create schema extensions;
create extension btree_gist with schema extensions;

create domain extensions.geography as text;

create function extensions.st_makepoint(x double precision, y double precision)
returns text language sql immutable
as $$ select x::text || ' ' || y::text $$;

create function extensions.st_setsrid(point text, srid integer)
returns text language sql immutable
as $$ select point $$;

create function extensions.st_dwithin(
  a extensions.geography, b extensions.geography, metres double precision
) returns boolean language sql immutable
as $$
  select 2 * 6371008.8 * asin(sqrt(
    power(sin(radians(split_part(b, ' ', 2)::float8 - split_part(a, ' ', 2)::float8) / 2), 2)
    + cos(radians(split_part(a, ' ', 2)::float8))
    * cos(radians(split_part(b, ' ', 2)::float8))
    * power(sin(radians(split_part(b, ' ', 1)::float8 - split_part(a, ' ', 1)::float8) / 2), 2)
  )) <= metres
$$;

grant usage on schema extensions to anon, authenticated, service_role;
`

/**
 * The only edits made to the migration text, each asserted to match exactly
 * the number of times expected. If a migration changes under one of these,
 * the harness fails loudly instead of quietly testing something else.
 */
const SUBSTITUTIONS: Array<{ file: string; find: string; replace: string; count: number }> = [
  {
    // Provided by POSTGIS_STANDIN instead.
    file: '0001_init_schema.sql',
    find: 'create extension if not exists "postgis"  with schema extensions;',
    replace: '',
    count: 1,
  },
  {
    // A domain cannot take a type modifier. Two: the column, and a comment
    // above it that names the same type.
    file: '0001_init_schema.sql',
    find: 'geography(Point, 4326)',
    replace: 'geography',
    count: 2,
  },
]

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
}

function migrationText(file: string): string {
  let text = readFileSync(join(MIGRATIONS, file), 'utf8')
  for (const edit of SUBSTITUTIONS.filter((s) => s.file === file)) {
    const found = text.split(edit.find).length - 1
    if (found !== edit.count) {
      throw new Error(
        `pgHarness: expected ${edit.count} of ${JSON.stringify(edit.find)} in ${file}, found ${found}`,
      )
    }
    text = text.split(edit.find).join(edit.replace)
  }
  return text
}

/** A fresh database with every migration applied, in order. */
export async function freshDatabase(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { btree_gist, pgcrypto } })
  await db.exec(SUPABASE_STANDIN)
  await db.exec(POSTGIS_STANDIN)
  for (const file of migrationFiles()) {
    try {
      await db.exec(migrationText(file))
    } catch (error) {
      throw new Error(`pgHarness: ${file} failed to apply: ${(error as Error).message}`)
    }
  }
  return db
}

/** A profile row, as chintu's handle_new_user would have made on sign-up. */
export async function addProfile(db: PGlite, id: string, emailPrefix: string): Promise<void> {
  await db.query('insert into public.profiles (id, display_name, username) values ($1, $2, $3)', [
    id,
    emailPrefix,
    emailPrefix + '1234',
  ])
}

type Role = 'anon' | 'authenticated' | 'service_role'

/**
 * Run `work` as a browser or worker request would: under that role, with
 * auth.uid() returning `userId`. Always puts the session back, including when
 * `work` throws, so one failing assertion cannot leak a role into the next.
 */
export async function asRole<T>(
  db: PGlite,
  role: Role,
  userId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
  await db.exec(`set role ${role}`)
  try {
    return await work()
  } finally {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
  }
}

/** The error message a statement fails with, or null if it succeeds. */
export async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return (error as Error).message
  }
}
