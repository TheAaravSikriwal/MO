import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { MAX_PHOTOS } from '../upload/photoLimits'
import { join } from 'node:path'

/**
 * Static checks over the SQL migrations.
 *
 * These are NOT a substitute for running them — no Postgres is involved and
 * nothing here proves the schema works. They exist because the migrations
 * cannot be executed in this repo, so the invariants that are easy to break
 * silently while hand-editing SQL get pinned here instead.
 *
 * Every assertion below corresponds to a defect that was actually present at
 * some point, not a hypothetical one.
 *
 * Regexes are written as literals rather than built from template strings:
 * escaping a backslash through a template into `new RegExp` is exactly the kind
 * of quiet mistake that produces a test which passes on nothing.
 */

const DIR = join(process.cwd(), 'supabase', 'migrations')
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const sql: Record<string, string> = Object.fromEntries(
  files.map((f) => [f, readFileSync(join(DIR, f), 'utf8')]),
)

/** Strip `--` comments, so prose describing a rule cannot satisfy a check for it. */
const stripComments = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/--.*/, ''))
    .join('\n')

const allCode = stripComments(Object.values(sql).join('\n'))

// MO's own tables. `profiles` is deliberately absent: it belongs to the
// marketplace side of this database, and MO keeps its moderators in mo.admins
// rather than adding a role column to somebody else's table.
const TABLES = [
  'admins',
  'display_names',
  'reports',
  'report_photos',
  'votes',
  'comments',
  'flags',
  'moderation_jobs',
  'upload_grants',
]

/**
 * The whole schema with runs of whitespace collapsed to single spaces.
 *
 * Checks below match against this with plain string containment rather than
 * regexes assembled from templates. Escaping a backslash through a template
 * into `new RegExp` silently produces a pattern that matches nothing, which is
 * exactly how a test ends up guarding air.
 */
const flat = allCode.replace(/\s+/g, ' ')

/** The `create trigger` statement for a name, so its table can be checked. */
const triggerFor = (name: string) => {
  const at = flat.indexOf('create trigger ' + name + ' ')
  expect(at, 'trigger not found: ' + name).toBeGreaterThan(-1)
  const rest = flat.slice(at)
  const end = rest.indexOf(';')
  return end === -1 ? rest : rest.slice(0, end)
}

/** A view definition, bounded by the next statement rather than a fixed size. */
const viewOf = (name: string) => {
  const at = allCode.indexOf('create view mo.' + name)
  expect(at, 'view not found: ' + name).toBeGreaterThan(-1)
  const rest = allCode.slice(at)
  const end = rest.indexOf(';')
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * The body of one function, bounded by the start of the next one.
 *
 * A fixed-size window instead of this bound made three of the checks below
 * tautological: `bodyOf('admin_moderation_queue')` ran far enough to include
 * admin_decide_moderation's is_admin guard, so deleting the guard from the
 * function actually named still passed.
 */
const bodyOf = (name: string) => {
  const at = allCode.indexOf('function mo.' + name)
  expect(at, 'function not found: ' + name).toBeGreaterThan(-1)

  // Bounded at the function's OWN terminator, not at the next function.
  //
  // Stopping at the next `create or replace function` swallowed everything in
  // between -- for profile_names, the whole remainder of 0003 including its
  // GRANT statements -- so an assertion about one function's body was really
  // reading a whole migration file.
  const rest = allCode.slice(at)
  const end = rest.indexOf('$$;')
  return end === -1 ? rest : rest.slice(0, end + 3)
}

describe('migrations — everything MO owns lives in the mo schema', () => {
  // The load-bearing invariant of the whole wearechintu integration, and the
  // one a schema rename is most likely to half-finish.
  //
  // MO shares that project's database, which already has `public.reports` --
  // abuse reports against marketplace projects -- and `public.profiles`. One
  // MO table left behind in `public` does not fail loudly: `create table
  // reports` either collides with a table full of somebody else's rows, or
  // silently becomes the table MO reads while the marketplace reads the other
  // one. Neither is discoverable from the SQL by eye.
  //
  // So this asserts the schema of every object MO creates, rather than of the
  // ones somebody remembered to list.

  const created = [...allCode.matchAll(/create (?:or replace )?(table|view|type|function)\s+([\w.]+)/gi)]
    .map((match) => ({ kind: match[1].toLowerCase(), name: match[2] }))

  it('finds the created objects at all, so this is not checking an empty list', () => {
    expect(created.length).toBeGreaterThanOrEqual(30)
  })

  it.each(['table', 'view', 'type', 'function'])('creates every %s in mo', (kind) => {
    const strays = created.filter((o) => o.kind === kind && !o.name.startsWith('mo.'))
    expect(strays.map((o) => o.name)).toEqual([])
  })

  it('creates nothing in public, which belongs to the marketplace', () => {
    expect(created.filter((o) => o.name.startsWith('public.'))).toEqual([])
    // Unqualified is worse than wrong-qualified: it lands wherever the search
    // path points, which reads as if somebody had decided.
    expect(created.filter((o) => !o.name.includes('.'))).toEqual([])
  })

  it('attaches every index and trigger to a table in mo', () => {
    // Indexes and triggers were left out of the sweep above, and six indexes
    // on `reports` hid there -- written `on reports` while the two beneath
    // them said `on mo.reports`. An unqualified target resolves through the
    // search path, so they landed correctly by luck rather than by decision.
    const targets = [
      ...allCode.matchAll(/create (?:unique )?index [\w]+\s+on\s+([\w.]+)/gi),
      ...allCode.matchAll(/create trigger [\w]+\s+[\s\S]{0,80}?\son\s+([\w.]+)/gi),
      // Policies too. They were missing, which is the same hole the six
      // indexes hid in -- `create policy x on reports` would have resolved
      // through the search path and read as if somebody had chosen it.
      ...allCode.matchAll(/create policy [\w]+\s+on\s+([\w.]+)/gi),
    ].map((match) => match[1])

    expect(targets.length).toBeGreaterThanOrEqual(40)
    const strays = targets.filter((t) => !t.startsWith('mo.'))
    expect(strays).toEqual([])
  })

  /**
   * The FILE-level `set search_path`, not a function's own.
   *
   * Both of the checks below used to read the raw file, where every migration
   * except 0001 also contains a function-level `set search_path = mo, public`
   * with no semicolon. That satisfied a check about the statement at the top of
   * the file -- so deleting the real one left both tests green while the
   * migration stopped applying, because the bare enum names in
   * `record_moderation_verdict(new_verdict moderation_status, ...)` resolve at
   * parse time and have no function to inherit from.
   *
   * Comment-stripped, anchored to the start of a line, and terminated: that is
   * the top-level statement and nothing else.
   */
  const fileSearchPath = (name: string) => {
    // `[^;\n]+`, not `[^;]+`: a character class without the newline spans
    // lines, so it matched a FUNCTION-level `set search_path = mo, public`
    // (which has no semicolon) and ran on to the next statement's one. That is
    // exactly the thing this helper exists to tell apart.
    const match = /^set search_path = ([^;\n]+);[ \t]*$/m.exec(stripComments(sql[name]))
    expect(match, 'no file-level search_path in ' + name).not.toBeNull()
    return match![1]
  }

  it('pins a search path that can find PostGIS', () => {
    // `geography`, st_setsrid and st_makepoint are all written unqualified, and
    // PostGIS lives in `extensions` on a default Supabase project rather than
    // in public. 0001 declares a geography column and 0004's rollup calls the
    // functions, so both need it.
    for (const name of ['0001_init_schema.sql', '0004_rollup_and_worker_rpc.sql']) {
      expect(fileSearchPath(name), name).toContain('extensions')
    }
  })

  it('lets the worker into the schema, and not just the browser roles', () => {
    // The worker connects as service_role. A new schema grants it nothing --
    // Supabase's defaults are scoped to public -- and BYPASSRLS is not a
    // grant, so without this it fails on its first statement and nothing is
    // ever moderated.
    expect(flat).toContain('grant usage on schema mo to anon, authenticated, service_role')
    for (const rpc of [
      'claim_moderation_jobs',
      'record_moderation_verdict',
      'escalate_moderation_job',
    ]) {
      // Revoked from PUBLIC above, which takes service_role's implicit execute
      // with it, so it has to be granted back by name.
      expect(flat).toContain('grant execute on function mo.' + rpc)
    }
  })

  it('gives the worker a way to WRITE, not just to read', () => {
    // The previous version of this checked `grant usage` and `grant execute`
    // and passed while every write the worker makes was denied. A new schema
    // grants nothing, Supabase's defaults are scoped to public, and the three
    // worker RPCs ran as the caller -- so claim_moderation_jobs failed on its
    // first UPDATE and the pipeline never started. Green suite, dead pipeline.
    //
    // Two things make it work, and both are asserted: the RPCs run as definer,
    // and the one direct write the worker does outside an RPC is granted.
    for (const rpc of [
      'claim_moderation_jobs',
      'record_moderation_verdict',
      'escalate_moderation_job',
    ]) {
      const head = allCode.slice(
        allCode.indexOf('create or replace function mo.' + rpc),
        allCode.indexOf('as $$', allCode.indexOf('create or replace function mo.' + rpc)),
      )
      expect(head, rpc).toContain('security definer')
    }

    // Queue.fail() writes moderation_jobs directly.
    expect(flat).toContain('grant update (status, reason, locked_at, locked_by) on mo.moderation_jobs to service_role')
  })

  it('does not hand the worker the verdict column', () => {
    // `verdict` records what a machine or a person decided. The worker's own
    // guard refuses to touch a job that already has one; not granting the
    // column makes that guard unnecessary rather than merely correct.
    expect(flat).not.toMatch(/grant update [^;]*verdict[^;]*on mo\.moderation_jobs to service_role/i)
    expect(flat).not.toContain('grant update on mo.moderation_jobs to service_role')
    expect(flat).not.toContain('grant all on mo.moderation_jobs to service_role')
  })

  it('installs extensions into the extensions schema, not into public', () => {
    // CREATE EXTENSION with no SCHEMA clause lands in the first EXISTING
    // schema on the search path, which before `mo` is created is `public`.
    // That put PostGIS's types and functions in the marketplace's schema --
    // and the "creates nothing in public" sweep above cannot see it, because
    // an extension is not a table, view, type or function.
    const extensions = [...allCode.matchAll(/create extension[^;]*/gi)].map((m) => m[0])
    expect(extensions.length).toBeGreaterThanOrEqual(2)
    for (const statement of extensions) {
      expect(statement).toMatch(/with schema extensions/i)
    }
  })

  it('issues no grant on the marketplace schema either', () => {
    // Same class as the `alter default privileges in schema public` already
    // removed: a statement about somebody else's schema, from MO's migrations.
    // `grant \w+` matched only a single-word privilege list, so
    // `grant usage, create on schema public` walked straight through it -- and
    // so did every `revoke`. This is the stated mechanism for keeping MO out
    // of the marketplace's schema, so it has to cover both verbs and a list.
    expect(flat).not.toMatch(/(grant|revoke)[\s\S]{0,40}on schema public/i)
  })

  it('grants execute rather than relying on the implicit PUBLIC grant', () => {
    // Postgres grants EXECUTE on a new function to PUBLIC. These files revoke
    // exactly that from five other functions on the grounds that relying on it
    // is a trap -- so the two that DO depend on it have to say so by granting
    // explicitly. is_admin() is called by the public views (checked as the
    // invoking role, which for a signed-out map load is anon), and
    // is_photo_object_key() is called by two CHECK constraints (checked as the
    // inserting role).
    for (const fn of ['mo.is_admin()', 'mo.is_photo_object_key(text)']) {
      expect(flat).toContain('grant execute on function ' + fn + ' to anon, authenticated')
    }
  })

  it('reads nothing from the marketplace profiles table', () => {
    // profile_names used to, and for a magic-link signup the name it found
    // there was the local part of their email address -- readable by anyone,
    // on every comment. MO references public.profiles as a foreign-key target
    // and nothing else.
    expect(allCode).not.toMatch(/from\s+public\.profiles\b/i)
    expect(allCode).not.toMatch(/join\s+public\.profiles\b/i)
    expect(allCode).not.toContain('function mo.profile_names')
  })

  it('creates the schema before anything goes in it', () => {
    const schemaAt = allCode.indexOf('create schema if not exists mo')
    expect(schemaAt).toBeGreaterThan(-1)
    const firstObject = allCode.search(/create (?:or replace )?(?:table|view|type|function)\s+mo\./i)
    expect(firstObject).toBeGreaterThan(schemaAt)
  })

  it('lets both browser roles reach into the schema at all', () => {
    // Without this every policy and grant below is unreachable and the app
    // fails with "permission denied for schema mo" on the first query.
    expect(flat).toContain('grant usage on schema mo to anon, authenticated')
  })

  it('puts the session back at the end of every file', () => {
    // A plain `set search_path` is session-scoped and survives the commit.
    // These files are applied by the wearechintu project's CLI over one
    // connection, so without a reset the path stays `mo, public` for every
    // marketplace migration that runs after MO's -- and the next unqualified
    // `create table` over there lands in MO's schema.
    for (const [name, text] of Object.entries(sql)) {
      expect(stripComments(text), name).toMatch(/^reset search_path;/m)
    }
  })

  it('sets a search path that finds mo before public, in every file', () => {
    // The enum types are referenced bare, because `moderation_status` is the
    // name of both a type and a column. Without this, a bare type name
    // resolves against public and the migration fails on a database where
    // nothing of that name exists there.
    for (const name of Object.keys(sql)) {
      expect(fileSearchPath(name), name).toMatch(/^mo, public/)
    }
  })
})

describe('migrations — content status is only written through an RPC', () => {
  // There used to be `grant update (moderation_status, ...)` on the three
  // content tables plus *_update_admin policies, so an admin could PATCH a
  // status directly over PostgREST. Nothing used it: decideModerationItem
  // calls admin_decide_moderation and markCleaned calls mark_report_cleaned,
  // both SECURITY DEFINER.
  //
  // What it allowed was writing the content's status without writing
  // moderation_jobs.verdict or setting flags.resolved_at -- leaving the job
  // and the content disagreeing about what was decided, which is the state
  // 0004 and 0005 exist to prevent.
  it.each(['reports', 'report_photos', 'comments'])(
    'grants no update on %s to a browser role',
    (table) => {
      expect(flat).not.toMatch(
        new RegExp('grant update [^;]*on mo\.' + table + ' to (anon|authenticated)', 'i'),
      )
    },
  )

  it('has no admin update policy to go with a grant that is gone', () => {
    for (const name of [
      'reports_update_admin',
      'report_photos_update_admin',
      'comments_update_admin',
    ]) {
      expect(flat).not.toContain('create policy ' + name)
    }
  })

  it('still lets the worker write the one column set it needs', () => {
    // Removing the admin grants must not take the worker's with them.
    expect(flat).toContain(
      'grant update (status, reason, locked_at, locked_by) on mo.moderation_jobs to service_role',
    )
  })
})

describe('migrations — the count and the pins agree', () => {
  it('defaults both viewport functions to the same status filter', () => {
    // count_reports_in_view exists so the panel cannot say "60 reports" over
    // twelve pins. It defaulted to 'all' while reports_rollup defaulted to
    // 'open', so a caller omitting the filter got exactly that contradiction
    // back from the one function written to prevent it.
    const defaultOf = (fn: string) => {
      const head = allCode.slice(
        allCode.indexOf('create or replace function mo.' + fn),
        allCode.indexOf('as $$', allCode.indexOf('create or replace function mo.' + fn)),
      )
      const match = /status_filter\s+text\s+default '(\w+)'/.exec(head)
      expect(match, fn).not.toBeNull()
      return match![1]
    }
    expect(defaultOf('count_reports_in_view')).toBe(defaultOf('reports_rollup'))
    expect(defaultOf('reports_rollup')).toBe('open')
  })
})

describe('migrations — a flag cannot manufacture a queue item', () => {
  it('reopens an existing job rather than inserting one', () => {
    // This was `insert ... on conflict do update ... where status = 'done'`,
    // and the guard only applied to the update branch: with no existing job
    // the INSERT put a done/verdict-null row straight into the human queue.
    // Reachable via a whitespace note (which gets no job) plus a self-flag.
    const body = bodyOf('flag_reopens_review')
    expect(body).toMatch(/update mo\.moderation_jobs/i)
    expect(body).not.toMatch(/insert into mo\.moderation_jobs/i)
    expect(body).not.toMatch(/on conflict/i)
  })

  it('still only reopens something the machines have finished with', () => {
    const body = bodyOf('flag_reopens_review')
    expect(body).toMatch(/status\s*=\s*'done'/i)
  })
})

describe('migrations — a shared trigger function only touches shared columns', () => {
  // `enqueue_moderation` sits behind three triggers: mo.reports,
  // mo.report_photos and mo.comments. `note` exists only on the first.
  //
  // PL/pgSQL resolves a record field when it builds the expression's
  // parameters, and it does that for the whole condition before any AND can
  // short-circuit. So `if kind = 'note' and new.note is null` raised
  // `record "new" has no field "note"` on every photo and comment insert --
  // both core writes of the product -- and did it intermittently, because a
  // cached plan from an earlier reports insert in the same backend could let
  // one through.
  //
  // Nesting is the fix. No SQL runs in this suite, so a shape check is the only
  // thing that can notice.
  it('never guards a table-specific field with a flat AND', () => {
    const offenders = [...allCode.matchAll(/kind = '\w+'\s+and\s+[^;]*?\bnew\.\w+/gi)].map(
      (match) => match[0],
    )
    expect(offenders).toEqual([])
  })

  it('reaches new.note only after establishing which table fired', () => {
    const body = bodyOf('enqueue_moderation')
    const branchAt = body.search(/if kind = 'note' then/i)
    const noteAt = body.indexOf('new.note')
    expect(branchAt, 'no nested note branch').toBeGreaterThan(-1)
    expect(noteAt).toBeGreaterThan(-1)
    expect(noteAt).toBeGreaterThan(branchAt)
  })

  it('touches nothing but id and note on the row', () => {
    // Anything else would have to exist on all three tables to be safe.
    const body = bodyOf('enqueue_moderation')
    const fields = [...body.matchAll(/\bnew\.(\w+)/gi)].map((match) => match[1])
    expect([...new Set(fields)].sort()).toEqual(['id', 'note'])
  })
})

describe('migrations — structure', () => {
  it('has migrations, numbered and ordered', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const name of files) expect(name).toMatch(/^\d{4}_/)
  })

  it('strips comments before checking anything', () => {
    // Guards the guard: if this broke, every check below could be satisfied by
    // a comment describing the rule rather than the rule itself.
    expect(stripComments('foo -- revoke all on mo.reports from anon')).toBe('foo ')
  })
})

describe('migrations — unreviewed content stays unreachable', () => {
  it('revokes reports from browser roles rather than merely not granting it', () => {
    // Supabase ships default privileges granting SELECT on every new table to
    // anon and authenticated. Omitting a grant leaves the table world-readable,
    // which made the column masking in the views decorative.
    expect(allCode).toMatch(/revoke\s+all\s+on\s+mo\.reports\s+from\s+anon/i)
  })

  it('revokes report_photos from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+mo\.report_photos\s+from\s+anon/i)
  })

  it('revokes comments from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+mo\.comments\s+from\s+anon/i)
  })

  it('revokes moderation_jobs from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+mo\.moderation_jobs\s+from\s+anon/i)
  })

  it('does not rely on default privileges it no longer has to counter', () => {
    // Supabase's `alter default privileges in schema public grant all on tables
    // to anon, authenticated` is what MO used to revoke here. Default
    // privileges are per-schema and MO's objects are in `mo` now, so nothing
    // grants them by default and there is nothing to revoke -- while doing it
    // anyway reached into `public` and stripped the marketplace's future
    // tables. The explicit revokes below are the control.
    expect(allCode).not.toMatch(/alter\s+default\s+privileges/i)
  })

  it('never grants whole-table select on reports to a browser role', () => {
    expect(allCode).not.toMatch(/grant\s+select\s+on\s+mo\.reports\s+to\s+(anon|authenticated)/i)
  })

  it('never grants whole-table select on report_photos to a browser role', () => {
    expect(allCode).not.toMatch(
      /grant\s+select\s+on\s+mo\.report_photos\s+to\s+(anon|authenticated)/i,
    )
  })

  it('grants only the single column an insert needs to return', () => {
    // supabase-js turns .insert().select('id') into INSERT ... RETURNING id,
    // which needs SELECT on that column or every submission fails.
    expect(allCode).toMatch(/grant\s+select\s*\(\s*id\s*\)\s+on\s+mo\.reports\s+to\s+authenticated/i)
  })

  it('keeps the worker RPCs revoked from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+function\s+mo\.claim_moderation_jobs/i)
    expect(allCode).toMatch(/revoke\s+all\s+on\s+function\s+mo\.record_moderation_verdict/i)
    expect(allCode).toMatch(/revoke\s+all\s+on\s+function\s+mo\.escalate_moderation_job/i)
  })

  it('never hands a browser role blanket privileges on anything', () => {
    // `grant all` is how the worst leak got in: the views inherited it from
    // Supabase's default privileges, and every check here matched only the
    // literal `grant select ...` shape, so none of them noticed.
    expect(flat).not.toContain('grant all on public.')
    expect(flat).not.toContain('grant all on all tables');
  })

  it('never touches the default privileges of a schema it does not own', () => {
    // This used to assert the opposite: that MO revoked the default privileges
    // in `public` before creating its views. That made sense when MO's views
    // WERE in public and Supabase's default GRANT ALL applied to them.
    //
    // Now it would be a bug. Default privileges are per-schema, so the
    // statement did nothing for objects in `mo` -- and with no FOR ROLE clause
    // it applied to the role running the migration, which is the role chintu's
    // migrations run as too. Every table the marketplace created in `public`
    // afterwards would have lost its default anon and authenticated grants.
    expect(flat).not.toContain('alter default privileges in schema public')
  })

  it('still protects the views the way that actually works', () => {
    // The explicit revoke, immediately before the grant. This is what the
    // removed statement was belt-and-braces for, and it is the brace.
    for (const view of ['public_reports', 'public_report_photos', 'public_comments']) {
      const revokeAt = flat.indexOf('revoke all on mo.' + view + ' from anon')
      const grantAt = flat.indexOf('grant select on mo.' + view + ' to anon')
      expect(revokeAt, view).toBeGreaterThan(-1)
      expect(grantAt, view).toBeGreaterThan(-1)
      expect(revokeAt, view).toBeLessThan(grantAt)
    }
  })

  it.each([
    'public_reports',
    'public_report_photos',
    'public_comments',
  ])('revokes %s explicitly before granting select on it', (view) => {
    const revokeAt = flat.indexOf('revoke all on mo.' + view + ' from anon')
    const grantAt = flat.indexOf('grant select on mo.' + view + ' to anon')
    expect(revokeAt, view + ' is never revoked').toBeGreaterThan(-1)
    expect(grantAt).toBeGreaterThan(revokeAt)
  })

  it('masks the photo path in the public view', () => {
    // The single most load-bearing rule in the design, and nothing asserted it.
    const view = viewOf('public_report_photos')
    expect(view).toMatch(/case[\s\S]*moderation_status\s*=\s*'approved'[\s\S]*storage_path[\s\S]*else\s+null/i)
  })

  it('masks the note in the public view', () => {
    const view = viewOf('public_reports')
    expect(view).toMatch(/case[\s\S]*note_status\s*=\s*'approved'[\s\S]*else\s+null/i)
  })

  it('never grants the worker RPCs to a browser role', () => {
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+mo\.claim_moderation_jobs[\s\S]{0,120}to\s+(anon|authenticated)/i,
    )
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+mo\.record_moderation_verdict[\s\S]{0,160}to\s+(anon|authenticated)/i,
    )
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+mo\.escalate_moderation_job[\s\S]{0,160}to\s+(anon|authenticated)/i,
    )
  })

  it('revokes mark_report_cleaned from anon, not just from public', () => {
    // Revoking from PUBLIC does not remove Supabase's explicit default grant
    // to anon, so `from public` alone leaves a signed-out caller with EXECUTE.
    //
    // Deliberately NOT asserted for is_admin(): the definer views call it, and
    // function-execute privilege is checked against the current user rather
    // than the view owner, so revoking it from anon would break anonymous map
    // reads entirely.
    expect(flat).toContain('revoke all on function mo.mark_report_cleaned(uuid) from public, anon')
  })

  it('carries the author name in the comments view the app reads', () => {
    // The app and the schema have drifted apart here before -- a view was
    // replaced by an RPC while the app kept querying the view, and every
    // author silently rendered as "someone". Pin the two together.
    expect(viewOf('public_comments')).toMatch(/\)\s+as\s+author_name/i)
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'data', 'supabaseSource.ts'),
      'utf8',
    )
    expect(source).toContain('author_name')
    expect(source).not.toContain("rpc('profile_names'")
  })

  it('reports whether an escalation was actually applied', () => {
    // Returning void made the caller assume success even when the guard
    // refused the write, so the log claimed escalations that never happened.
    expect(bodyOf('escalate_moderation_job')).toMatch(/returns\s+boolean/i)
  })

  it('lets a complaint outrank a machine verdict', () => {
    const body = bodyOf('record_moderation_verdict')
    expect(body).toMatch(/from\s+mo\.flags/i)
    expect(body).toMatch(/resolved_at\s+is\s+null/i)
  })

  it('only reopens review for jobs the machines have finished with', () => {
    // Resetting a pending job would let anyone push items past tiers 2 and 3.
    expect(bodyOf('flag_reopens_review')).toMatch(/status\s*=\s*'done'/i)
  })

  it('cleans up moderation jobs when their subject is deleted', () => {
    // subject_id is polymorphic so nothing cascades; an orphan is claimed,
    // found missing, escalated, and sits in the human queue forever.
    expect(flat).toContain('create trigger cleanup_moderation_on_report_delete')
    expect(flat).toContain('create trigger cleanup_moderation_on_comment_delete')
    expect(flat).toContain('create trigger cleanup_moderation_on_photo_delete')
  })
})

describe('migrations — row level security is actually on', () => {
  it.each(TABLES)('enables RLS on %s', (table) => {
    // Nothing else in this file would notice if every `enable row level
    // security` line were deleted.
    expect(flat).toContain('alter table mo.' + table + ' enable row level security')
  })

  it('defines policies rather than relying on RLS alone', () => {
    // RLS with no policies denies everything, which fails closed but silently
    // breaks the app; RLS with policies deleted is the dangerous direction.
    const policies = allCode.match(/create\s+policy/gi) ?? []
    expect(policies.length).toBeGreaterThanOrEqual(10)
  })

  it.each(['comments', 'admins'])(
    'never grants whole-table select on %s to a browser role',
    (table) => {
      // A later grant beats an earlier revoke in Postgres, so the revoke
      // assertions above are not enough on their own.
      expect(flat).not.toContain('grant select on mo.' + table + ' to anon')
      expect(flat).not.toContain('grant select on mo.' + table + ' to authenticated')
    },
  )

  it('scopes votes to your own rows, since it is readable', () => {
    // Granted deliberately: it holds no content awaiting review, and the app
    // needs it. What matters is that the policy stops you reading anybody
    // else's.
    expect(flat).toContain('grant select on mo.votes to authenticated')
    const policy = flat.slice(flat.indexOf('create policy votes_select_own'))
    expect(policy.slice(0, 300)).toMatch(/auth\.uid\(\)/)
  })

  it('gives no browser role any way to read flags back, not even your own', () => {
    // A name flag's subject_id is a person's id. flag_comment_author and
    // flag_report_author file it so the reader never sees it; a select grant,
    // even scoped to your own rows, handed it straight back -- and with it,
    // one lookup away, the author's email prefix.
    expect(flat).not.toMatch(/grant select[^;]* on mo\.flags to (anon|authenticated)/)
    expect(flat).not.toMatch(/grant all[^;]* on mo\.flags/)
    expect(flat).toContain('revoke all on mo.flags from anon, authenticated')
  })

  it('never exposes votes or flags to anonymous visitors', () => {
    // Who voted for what, and who complained about whom, are not public.
    expect(flat).not.toContain('grant select on mo.votes to anon')
    expect(flat).not.toContain('grant select on mo.flags to anon')
  })
})

describe('migrations — triggers are attached to the right tables', () => {
  it.each([
    ['flag_reopens_review', 'flags'],
    ['flag_withholds_content', 'flags'],
    ['validate_flag_subject', 'flags'],
    ['enforce_flag_rate_limit', 'flags'],
    ['default_note_status', 'reports'],
    ['enforce_report_rate_limit', 'reports'],
    ['enforce_comment_rate_limit', 'comments'],
    ['sync_vote_count_on_insert', 'votes'],
  ])('%s fires on %s', (trigger, table) => {
    expect(triggerFor(trigger)).toContain('on mo.' + table + ' ')
  })
})

describe('migrations — the queue selects the right jobs', () => {
  it('only surfaces jobs with no verdict', () => {
    // `where true` would pass every other assertion in this file.
    expect(bodyOf('admin_moderation_queue')).toMatch(/where\s+j\.verdict\s+is\s+null/i)
  })

  it('surfaces jobs the worker gave up on, not only cleanly escalated ones', () => {
    const body = bodyOf('admin_moderation_queue')
    expect(body).toMatch(/status\s*=\s*'failed'/i)
    expect(body).toMatch(/status\s*=\s*'in_progress'/i)
  })

  it('counts the same set it lists', () => {
    expect(bodyOf('admin_queue_size')).toMatch(/verdict\s+is\s+null/i)
  })
})

describe('migrations — a decision cannot be undone by the machine', () => {
  it('settles the complaints it ruled on', () => {
    // Counting lifetime flags meant the next flagger re-withheld a decided item
    // immediately, forever.
    expect(bodyOf('admin_decide_moderation')).toMatch(/set\s+resolved_at\s*=\s*now\(\)/i)
  })

  it('only counts unresolved complaints when withholding', () => {
    expect(bodyOf('flag_withholds_content')).toMatch(/resolved_at\s+is\s+null/i)
  })

  it('guards the escalate path like the verdict path', () => {
    expect(bodyOf('escalate_moderation_job')).toMatch(/verdict\s+is\s+null/i)
  })

  it('requires a null verdict before the worker writes one', () => {
    expect(bodyOf('record_moderation_verdict')).toMatch(/and\s+verdict\s+is\s+null/i)
  })
})

describe('migrations — a pin and its note are judged separately', () => {
  it('stores them in different columns', () => {
    expect(stripComments(sql['0001_init_schema.sql'])).toMatch(/note_status\s+moderation_status/i)
  })

  it('decides a note by writing note_status on the admin path', () => {
    // Writing the pin's column instead destroys an approved note permanently
    // and erases a rejected one's report from the map.
    expect(stripComments(sql['0005_admin_queue.sql'])).toMatch(/set\s+note_status\s*=\s*new_verdict/i)
  })

  it('decides a note by writing note_status on the worker path too', () => {
    expect(stripComments(sql['0004_rollup_and_worker_rpc.sql'])).toMatch(
      /set\s+note_status\s*=\s*new_verdict/i,
    )
  })

  it('never sets moderation_status inside a note branch', () => {
    const branches = allCode.match(/subject_type\s*=\s*'note'\s*then[\s\S]{0,240}?;/gi) ?? []
    expect(branches.length).toBeGreaterThan(0)
    for (const branch of branches) {
      if (!/update\s+mo\.reports/i.test(branch)) continue
      expect(branch).not.toMatch(/set\s+moderation_status/i)
    }
  })

  it('leaves a note-less report with nothing to wait for', () => {
    expect(allCode).toMatch(/create\s+trigger\s+default_note_status/i)
  })
})

describe('migrations — the map rollup', () => {
  it('defaults to open only, so a cleanup cools the map', () => {
    // A five-argument call is the form the README documents. Defaulting to
    // 'all' would silently change what that call means and start returning
    // cleaned reports with full weight.
    expect(flat).toContain("status_filter text default 'open'")
  })

  it('handles all three status choices', () => {
    const body = bodyOf('reports_rollup')
    expect(body).toMatch(/status_filter\s*=\s*'all'/i)
    expect(body).toMatch(/status_filter\s*=\s*'open'\s+and\s+r\.status\s*=\s*'open'/i)
    expect(body).toMatch(/status_filter\s*=\s*'cleaned'\s+and\s+r\.status\s*=\s*'cleaned'/i)
  })

  it('applies the distance filter where the data is', () => {
    // Applying it only on the client meant the panel said "3 of 200" while all
    // 200 stayed coloured on the map.
    expect(bodyOf('reports_rollup')).toMatch(/st_dwithin/i)
  })

  it('resolves postgis, which is not in the public schema on Supabase', () => {
    const body = bodyOf('reports_rollup')
    // `mo` first, then public, then extensions. MO's own objects resolve
    // before anything in public -- which is the whole point of the schema --
    // and `extensions` is still needed because postgis does not live in
    // public on Supabase.
    expect(body).toMatch(/set\s+search_path\s*=\s*mo,\s*public,\s*extensions/i)
  })

  it('handles a viewport that crosses the antimeridian', () => {
    // Leaflet never wraps longitude, so this arrives as min_lng > max_lng.
    expect(bodyOf('reports_rollup')).toMatch(/min_lng\s*>\s*max_lng/i)
  })

  it('only ever counts approved reports', () => {
    expect(bodyOf('reports_rollup')).toMatch(/r\.moderation_status\s*=\s*'approved'/i)
  })

  it('counts through a function, since PostgREST cannot express st_dwithin', () => {
    // A count that skipped the distance filter said "60 reports" while twelve
    // pins were drawn -- contradicting both the pins and the cells.
    expect(flat).toContain('create or replace function mo.count_reports_in_view')
    expect(bodyOf('count_reports_in_view')).toMatch(/st_dwithin/i)
  })

  it('counts the same rows the rollup weighs', () => {
    const count = bodyOf('count_reports_in_view')
    expect(count).toMatch(/r\.moderation_status\s*=\s*'approved'/i)
    expect(count).toMatch(/status_filter\s*=\s*'cleaned'\s+and\s+r\.status\s*=\s*'cleaned'/i)
    expect(count).toMatch(/min_lng\s*>\s*max_lng/i)
  })

  it('grants exactly the signature it declares', () => {
    // A mismatched arg list makes the grant apply to no function at all, and
    // every call then fails on permissions.
    const grant = flat.slice(flat.indexOf('grant execute on function mo.reports_rollup'))
    const args = grant.slice(0, grant.indexOf(')')).split(',').length
    expect(args).toBe(11)
  })
})

describe('migrations — the admin surface refuses non-admins', () => {
  it('checks is_admin in admin_moderation_queue', () => {
    expect(bodyOf('admin_moderation_queue')).toMatch(/if\s+not\s+mo\.is_admin\(\)/i)
  })

  it('checks is_admin in admin_decide_moderation', () => {
    expect(bodyOf('admin_decide_moderation')).toMatch(/if\s+not\s+mo\.is_admin\(\)/i)
  })

  it('checks is_admin in admin_queue_size', () => {
    expect(bodyOf('admin_queue_size')).toMatch(/if\s+not\s+mo\.is_admin\(\)/i)
  })

  it('pins search_path on every security definer function', () => {
    // A definer function without a pinned search_path is a privilege
    // escalation waiting for someone to create a shadowing schema.
    const definers = allCode.split(/create\s+or\s+replace\s+function/i).slice(1)
    const offenders: string[] = []
    for (const body of definers) {
      const head = body.slice(0, body.indexOf('$$') === -1 ? 600 : body.indexOf('$$'))
      if (!/security\s+definer/i.test(head)) continue
      if (!/set\s+search_path\s*=/i.test(head)) {
        offenders.push(body.slice(0, 60).trim())
      }
    }
    expect(offenders).toEqual([])
  })

  it('bounds each function body at its own terminator', () => {
    // Guards the guard: if bodyOf over-reads, an assertion about one function
    // is really reading its neighbour, or an entire migration file.
    expect(bodyOf('admin_moderation_queue')).not.toContain('admin_decide_moderation')
    expect(bodyOf('admin_decide_moderation')).not.toContain('admin_queue_size')
    expect(bodyOf('admin_queue_size')).not.toContain('flag_reopens_review')
    // set_display_name is followed directly by its grants, so an over-read
    // picks them up.
    expect(bodyOf('set_display_name(')).not.toContain('grant ')
    expect(bodyOf('has_display_name(')).not.toContain('my_display_name')
  })

  it('closes the double-decide race', () => {
    const body = bodyOf('admin_decide_moderation')
    expect(body).toMatch(/for\s+update/i)
    expect(body).toMatch(/where\s+id\s*=\s*job_id[\s\S]{0,60}and\s+verdict\s+is\s+null/i)
  })

  it('rejects a null verdict explicitly', () => {
    // `null not in (...)` is NULL, not true, so it would fall straight through.
    expect(bodyOf('admin_decide_moderation')).toMatch(/new_verdict\s+is\s+null\s+or/i)
  })
})

describe('migrations — nothing hands out unreviewed content', () => {
  it('mark_report_cleaned does not return the report row', () => {
    // Returning mo.reports handed the caller the note as well, and
    // SECURITY DEFINER meant the column grants did not apply.
    const body = bodyOf('mark_report_cleaned')
    expect(body).toMatch(/returns\s+void/i)
    expect(body).not.toMatch(/returns\s+mo\.reports/i)
  })

  it('grants nothing on the marketplace profiles table', () => {
    // Not because that would expose anything -- the marketplace already grants
    // anon SELECT on it -- but because it is not MO's table to grant on.
    expect(allCode).not.toMatch(/grant\s+\w+\s+on\s+public\.profiles/i)
  })

  // Both ids are the key of the marketplace's public.profiles, which anon can
  // read and where a magic-link signup's name is their email prefix. So a
  // published id is a published email prefix, one request away.
  it.each([
    ['public_reports', 'reporter_id'],
    ['public_comments', 'author_id'],
  ])('%s gives %s to its owner and admins only', (view, column) => {
    const definition = viewOf(view).replace(/\s+/g, ' ')
    expect(definition).toContain(
      `case when ${column === 'reporter_id' ? 'r' : 'c'}.${column} = auth.uid() or mo.is_admin() then ${column === 'reporter_id' ? 'r' : 'c'}.${column} else null end as ${column}`,
    )
  })

  it('shows a chosen name to others only once it is approved', () => {
    const definition = viewOf('public_comments').replace(/\s+/g, ' ')
    const name = definition.slice(definition.indexOf('select d.name'))
    expect(name).toContain("d.moderation_status = 'approved'")
    expect(name).toContain('d.user_id = c.author_id')
  })

  it('still lets the app find out whether YOU are an admin', () => {
    // Without this the review queue cannot be opened by anyone: the app has no
    // other way to know, and the failure is silent.
    // anon as well, spelled out. The public views call is_admin() and are not
    // security_invoker, so EXECUTE is checked against the invoking role -- and
    // a signed-out map load invokes as anon. That used to work only through
    // Postgres's implicit PUBLIC grant, which these files revoke from five
    // other functions on the grounds that relying on it is a trap. Doing the
    // consistent thing here would have broken every anonymous map load.
    expect(allCode).toMatch(
      /grant\s+execute\s+on\s+function\s+mo\.is_admin\(\)\s+to\s+anon,\s*authenticated/i,
    )
  })

  it('stops the worker overwriting a job a person flagged', () => {
    // flag_reopens_review resets a job to done/verdict-null; without this guard
    // the worker writes its verdict over the top and the flag never surfaces.
    expect(bodyOf('record_moderation_verdict')).toMatch(/and\s+status\s*=\s*'in_progress'/i)
  })
})

describe('migrations — a complaint reaches a person', () => {
  it('reopens review when something is flagged', () => {
    expect(allCode).toMatch(/create\s+trigger\s+flag_reopens_review/i)
  })

  it('clears the verdict, which is what puts it back in the queue', () => {
    expect(bodyOf('flag_reopens_review')).toMatch(/verdict\s*=\s*null/i)
  })

  it('validates the subject, since subject_id carries no foreign key', () => {
    expect(allCode).toMatch(/create\s+trigger\s+validate_flag_subject/i)
  })

  it('rate limits flags like every other table a person can write to', () => {
    expect(allCode).toMatch(/create\s+trigger\s+enforce_flag_rate_limit/i)
  })

  it('takes more than one person to withhold content', () => {
    // Otherwise one account could walk the map unpublishing every photo.
    expect(bodyOf('flag_withholds_content')).toMatch(/complaints\s*<\s*2/i)
  })

  it('does not set note_status on a report that has no note', () => {
    // note_status_matches_note would reject it and roll the whole flag back.
    const body = bodyOf('flag_withholds_content')
    const noteUpdate = body.match(/update\s+mo\.reports[\s\S]{0,200}?;/i)
    expect(noteUpdate).not.toBeNull()
    expect(noteUpdate![0]).toMatch(/note\s+is\s+not\s+null/i)
  })
})

describe('migrations — a policy never reads a table the caller cannot', () => {
  // A policy expression runs with the CALLER'S privileges. `reports` is revoked
  // from anon and authenticated with only `select (id)` re-granted, so a policy
  // that reaches into it raises `permission denied for table reports` instead of
  // returning false -- and every insert it guards fails for everyone, including
  // the owner. The 403 that comes back reads like "not yours", not
  // "misconfigured", so this is expensive to diagnose and cheap to prevent.
  const policies = [...allCode.matchAll(/create\s+policy[\s\S]*?;/gi)].map((m) => m[0])

  it('finds the policies at all, so this is not checking an empty list', () => {
    expect(policies.length).toBeGreaterThanOrEqual(10)
  })

  // Literals, not assembled strings. Written as `new RegExp('...\b')` the
  // escape is not an escape: a JS string turns `\b` into a literal backspace
  // byte and `\s` into a plain `s`, so the pattern matches nothing and the
  // check passes on every schema. That is the mistake this whole file's header
  // warns about, and it happened here first time round.
  it.each([
    ['mo.reports', /from\s+mo\.reports\b/i],
    // public.profiles is the marketplace's, and MO holds no grant on it at
    // all, so a policy reaching into it is even less allowed than before.
    ['public.profiles', /from\s+public\.profiles\b/i],
  ] as const)('never selects from %s inside a policy', (_table, pattern) => {
    expect(policies.filter((policy) => pattern.test(policy))).toEqual([])
  })

  it('has patterns that actually match something', () => {
    // Guards the guard: if these stopped matching, the check above would pass
    // on a schema full of offenders.
    expect(/from\s+mo\.reports\b/i.test('select 1 from mo.reports r')).toBe(true)
    expect(/from\s+public\.profiles\b/i.test('select 1 from public.profiles')).toBe(true)
  })

  it('asks through the security definer helpers instead', () => {
    for (const helper of ['owns_report', 'report_accepts_votes']) {
      const definition = flat.slice(flat.indexOf('create or replace function mo.' + helper))
      expect(definition.slice(0, 300)).toContain('security definer')
      expect(flat).toContain('grant execute on function mo.' + helper + '(uuid)')
    }
  })
})

describe('migrations — rate limits exist for every table a person can write to', () => {
  it.each(['report', 'comment', 'flag', 'upload_grant'])('limits %s inserts', (kind) => {
    expect(allCode).toContain('enforce_' + kind + '_rate_limit')
  })

  // A limit on the wrong table is no limit at all.
  it.each([
    ['enforce_upload_grant_rate_limit', 'upload_grants'],
    ['enforce_photo_limit', 'report_photos'],
    ['enforce_flag_rate_limit', 'flags'],
  ])('attaches %s to %s', (name, table) => {
    expect(triggerFor(name)).toContain('on mo.' + table)
  })

  // A count-based limit has to be checked once per STATEMENT, over a
  // transition table -- not once per row. A BEFORE ROW trigger cannot see the
  // other rows of its own statement: they carry the current command id, so the
  // count treats them as not yet inserted. PostgREST inserts a JSON array as
  // one statement, and `authenticated` can insert into both of these tables,
  // so in the row form one request carrying ten thousand rows had every
  // invocation read the same pre-statement count and every row pass.
  it.each(['enforce_upload_grant_rate_limit', 'enforce_photo_limit', 'enforce_flag_rate_limit'])(
    '%s counts once per statement, over a transition table',
    (name) => {
      const trigger = triggerFor(name)
      expect(trigger).toContain('after insert')
      expect(trigger).toContain('referencing new table as new_rows')
      expect(trigger).toContain('for each statement')
      expect(trigger).not.toContain('for each row')
    },
  )

  it('enforces the photo cap the app is built around, not a number of its own', () => {
    // MAX_PHOTOS lives in one place for the app, but the trigger and its
    // message are SQL and cannot import it. Asserting only `/> \d+/` let the
    // constant move to 4 while the database stayed at 3, with the suite green
    // -- the exact drift photoLimits.ts exists to prevent. This is the seam,
    // so it is checked here.
    const fn = flat.slice(
      flat.indexOf('function mo.enforce_photo_limit()'),
      flat.indexOf('create trigger enforce_photo_limit'),
    )
    expect(fn).toContain(`> ${MAX_PHOTOS}`)
    expect(fn).toContain(`at most ${MAX_PHOTOS} photos`)
  })

  // Separate from visibility, and missed the first time: counting per statement
  // still lets two CONCURRENT statements each read a count that excludes the
  // other's uncommitted rows, so both pass. Two of the three had the lock and
  // one did not, while HANDOFF.md said all three did.
  it.each(['enforce_upload_grant_rate_limit', 'enforce_photo_limit', 'enforce_flag_rate_limit'])(
    '%s takes a transaction-scoped lock before it counts',
    (name) => {
      const fn = flat.slice(
        flat.indexOf('function mo.' + name + '()'),
        flat.indexOf('create trigger ' + name),
      )
      expect(fn).toContain('pg_advisory_xact_lock')
      // Once per distinct subject in the statement, not once per row.
      expect(fn).toMatch(/for \w+ in select distinct \w+ from new_rows loop/)
      // And before the count, or it serialises nothing.
      expect(fn.indexOf('pg_advisory_xact_lock')).toBeLessThan(fn.indexOf('count(*)'))
    },
  )

  it.each(['enforce_upload_grant_rate_limit', 'enforce_photo_limit', 'enforce_flag_rate_limit'])(
    '%s compares against the count INCLUDING the new rows',
    (name) => {
      // Counted after the statement, the new rows are already in the total, so
      // the limit is "more than N" rather than "at least N". Leaving `>=` here
      // would refuse the last legitimate row of every batch.
      const fn = flat.slice(
        flat.indexOf('function mo.' + name + '()'),
        flat.indexOf('create trigger ' + name),
      )
      expect(fn).toMatch(/> \d+/)
      expect(fn).not.toMatch(/>= \d+/)
    },
  )
})

describe('migrations — no count-based limit hides in a row-level trigger', () => {
  // This exact defect was found three times, in three separate rounds, because
  // each round fixed the instances it knew about and then claimed the sweep was
  // done. A count is only a limit if it is taken once per STATEMENT: a
  // row-level BEFORE trigger cannot see the other rows of its own statement,
  // and PostgREST posts a JSON array as one statement.
  //
  // So this finds them rather than naming them. Any function whose body counts
  // rows must be attached per statement, unless it is on the list of known
  // exceptions below -- and that list is the debt, written down.
  // Genuinely still wrong, and recorded in HANDOFF.md. Delete these entries
  // when they are fixed; leaving them here is what keeps this honest.
  const KNOWN_ROW_LEVEL = ['enforce_report_rate_limit', 'enforce_comment_rate_limit']

  /** Every trigger statement naming this function, however it is named. */
  const triggersUsing = (name: string) =>
    [...flat.matchAll(/create trigger [\s\S]*?;/g)]
      .map((match) => match[0])
      .filter((trigger) => trigger.includes('function mo.' + name + '('))

  // Counts AND refuses on the result. `sync_vote_count` counts too, but it
  // writes the total rather than rejecting, and per-row is right for that.
  const limits = [...allCode.matchAll(/create or replace function mo\.(\w+)\(\)/g)]
    .map((match) => match[1])
    .filter((name) => {
      const start = allCode.indexOf('function mo.' + name + '()')
      const body = allCode.slice(start, allCode.indexOf('$$;', start))
      return /count\(\*\)/.test(body) && /raise exception/.test(body)
    })

  it('finds the counting limits at all, so this is not checking an empty list', () => {
    expect(limits.length).toBeGreaterThanOrEqual(5)
  })

  it('has every counting limit firing once per statement', () => {
    const offenders = limits.filter(
      (name) =>
        !KNOWN_ROW_LEVEL.includes(name) &&
        triggersUsing(name).some((trigger) => /for each row/.test(trigger)),
    )
    expect(offenders).toEqual([])
  })

  it('still lists exactly the exceptions HANDOFF.md admits to', () => {
    // If one of these is fixed without being taken off the list, the list stops
    // meaning anything and the next reader trusts it anyway.
    const stillRowLevel = KNOWN_ROW_LEVEL.filter((name) =>
      triggersUsing(name).some((trigger) => /for each row/.test(trigger)),
    )
    expect(stillRowLevel).toEqual(KNOWN_ROW_LEVEL)
  })
})

describe('migrations — a signed upload URL is recorded and countable', () => {
  // This table is the only thing bounding writes to the R2 bucket. An earlier
  // version of api/sign-upload counted the photos already attached to the
  // report instead, which bounds nothing: that count only rises when the
  // client inserts a photo row, and a caller who never inserts can sign and
  // upload 8 MB in a loop forever.
  // Scoped to the `create table` block, and taken from the comment-stripped
  // text. Searching the whole file found these names in the index, the trigger,
  // the policy, the grant and the prose, so every column could be deleted from
  // the table and the assertion stayed green.
  const grantTable = () => {
    const start = flat.indexOf('create table mo.upload_grants')
    expect(start).toBeGreaterThan(-1)
    return flat.slice(start, flat.indexOf(');', start))
  }

  it('records who asked, for which report, and for which object', () => {
    for (const column of ['user_id', 'report_id', 'storage_path']) {
      expect(grantTable()).toContain(column)
    }
  })

  // Scoped to this policy's own text, not searched for across the whole
  // schema: `user_id = auth.uid()` also appears in the votes policy, so a
  // global containment check passed even with this one replaced by `true`.
  const grantPolicy = () => {
    const start = flat.indexOf('create policy upload_grants_insert_own')
    expect(start).toBeGreaterThan(-1)
    return flat.slice(start, flat.indexOf(';', start))
  }

  it('pins user_id to the caller, so the count cannot be sidestepped', () => {
    // Without this, an insert could name somebody else and the per-person
    // count would never reach its limit for the person actually uploading.
    expect(grantPolicy()).toContain('user_id = auth.uid()')
  })

  it('requires the report to be the caller’s', () => {
    expect(grantPolicy()).toContain('mo.owns_report(report_id)')
  })

  it('never grants select to a browser role', () => {
    // It is a counter, not content. Reading it would list the reports somebody
    // is part-way through submitting.
    expect(flat).not.toContain('grant select on mo.upload_grants to anon')
    expect(flat).not.toContain('grant select on mo.upload_grants to authenticated')
    expect(flat).not.toContain('create policy upload_grants_select')
  })

  it('outlives the report it was for, so the count cannot be reset', () => {
    // A cascade here would make the limit resettable by the person it limits:
    // sign thirty URLs, upload 240 MB, delete your own report -- which
    // `reports_delete_own` allows and createReport itself does -- and the
    // trigger's count of live rows is back to zero. A cascade also runs
    // without consulting RLS, so no policy would stop it.
    // Comment-stripped, so the prose above the column explaining why a cascade
    // would be wrong cannot satisfy -- or violate -- the assertion.
    expect(grantTable()).toContain('references mo.reports (id) on delete set null')
    expect(grantTable()).not.toContain('references mo.reports (id) on delete cascade')
  })

  it('is the authority for what may be linked, not just a record of it', () => {
    // Without this, a grant is traceability and nothing more: the client sends
    // storage_path, so somebody whose photo was rejected could relink the same
    // object to a new report for a second verdict, with no upload and no charge
    // against the hourly limit.
    expect(flat).toContain('create trigger enforce_photo_has_grant')
    expect(triggerFor('enforce_photo_has_grant')).toContain(
      'before insert on mo.report_photos',
    )
    const fn = flat.slice(
      flat.indexOf('function mo.enforce_photo_has_grant'),
      flat.indexOf('create trigger enforce_photo_has_grant'),
    )
    // Matched on both the object and the report: on the object alone, a grant
    // for one report would authorise linking that object to another.
    expect(fn).toContain('storage_path = new.storage_path')
    expect(fn).toContain('report_id = new.report_id')
  })

  it('lets one object be linked once and never relinked', () => {
    expect(flat).toContain('create unique index report_photos_storage_path_key')
  })

  describe('and the key it is unique on has exactly one spelling', () => {
    // Both unique indexes are on the literal string, and both photo URLs are
    // built by concatenation and then parsed by a URL parser -- so two
    // different strings can address one object, and the indexes cannot see it.
    // Pulled out of the SQL and run here: POSIX ARE and JS agree on every
    // construct this pattern uses, so exercising it is fair.
    const pattern = () => {
      const match = /select key ~ '(\^[^']+\$)'/.exec(sql['0006_upload_grants.sql'])
      expect(match).not.toBeNull()
      return new RegExp(match![1])
    }

    const KEY =
      '11111111-1111-4111-8111-111111111111/' +
      '22222222-2222-4222-8222-222222222222/' +
      '33333333-3333-4333-8333-333333333333.jpg'

    it('is added as a constraint, never by altering the column type', () => {
      // `public_report_photos` selects storage_path, and Postgres refuses to
      // alter the type of a column a view depends on -- so an `alter column
      // ... type` here aborts the whole migration and rolls back the rate
      // limit with it. This file is applied as one transaction.
      expect(flat).not.toContain('alter column storage_path type')
      expect(flat).not.toContain('create domain photo_object_key')
    })

    it('is immutable, which is what lets a check constraint call it', () => {
      const fn = flat.slice(
        flat.indexOf('function mo.is_photo_object_key'),
        flat.indexOf('create table mo.upload_grants'),
      )
      expect(fn).toContain('immutable')
    })

    it('accepts the shape the endpoint generates', () => {
      expect(pattern().test(KEY)).toBe(true)
      for (const ext of ['png', 'webp']) {
        expect(pattern().test(KEY.replace('.jpg', `.${ext}`))).toBe(true)
      }
    })

    it('rejects a query or a fragment, which a URL parser would drop', () => {
      // `<key>?x=1` is a different string, so unique, but fetches the same
      // object -- enough to relink an image an admin had rejected.
      for (const suffix of ['?x=1', '#a', '?', ' ']) {
        expect(pattern().test(KEY + suffix)).toBe(false)
      }
    })

    it('rejects dot segments, which a URL parser would fold away', () => {
      const escape = `11111111-1111-4111-8111-111111111111/../../${KEY}`
      expect(pattern().test(escape)).toBe(false)
    })

    it('rejects a second extension, an unexpected one, or none', () => {
      for (const key of [
        KEY.replace('.jpg', '.jpg.html'),
        KEY.replace('.jpg', '.svg'),
        KEY.replace('.jpg', ''),
        // Uppercase would be a second spelling of the same object on a
        // case-insensitive store, which is why the endpoint lowercases both ids.
        KEY.toUpperCase(),
      ]) {
        expect(pattern().test(key)).toBe(false)
      }
    })

    it('is the same one spelling on both tables, not a copy', () => {
      // A second `check` with the pattern written out again would be untested
      // here, and a typo in it would leave the PUBLISHED table accepting
      // `<key>?x=1` with this suite still green. Both call one function.
      expect(grantTable()).toContain('check (mo.is_photo_object_key(storage_path))')
      expect(flat).toContain(
        'add constraint report_photos_storage_path_shape check ' +
          '(mo.is_photo_object_key(storage_path))',
      )
      // One occurrence of the extension alternation means one occurrence of the
      // pattern. Counting `[0-9a-f]{8}` instead counted three, because the
      // pattern names three UUIDs -- a guard that could never read 1.
      const patterns = allCode.match(/\(jpg\|png\|webp\)/g) ?? []
      expect(patterns).toHaveLength(1)
    })
  })

  it('spends the grant, rather than only checking that one exists', () => {
    // The unique index alone is not enough: it constrains live rows, and
    // report_photos_delete_own lets the owner delete their own photo row. So
    // delete and re-insert the same object and a mere existence check still
    // passed -- putting an image a human rejected up for a fresh verdict, as
    // often as anybody liked, with no upload and nothing counted.
    const fn = flat.slice(
      flat.indexOf('function mo.enforce_photo_has_grant'),
      flat.indexOf('create trigger enforce_photo_has_grant'),
    )
    expect(fn).toContain('update mo.upload_grants')
    expect(fn).toContain('set linked_at = now()')
    expect(fn).toContain('and linked_at is null')
    // An existence check instead of an update would leave the grant reusable.
    expect(fn).not.toContain('if not exists')
  })

  it('records whether a grant has been spent', () => {
    // Whitespace-normalised: asserting the raw two-space column alignment made
    // reformatting the table a test failure about behaviour that had not moved.
    expect(grantTable()).toContain('linked_at timestamptz')
  })

  it('allows one grant per object, ever', () => {
    // `authenticated` can insert a grant directly -- the endpoint writes with
    // the caller's own token and holds no extra privilege -- so a grant only
    // means somebody claimed the key. Without this index, a spent grant could
    // be replaced by a fresh one for the same object, which re-opens the loop
    // that puts a rejected image up for another verdict.
    expect(flat).toContain('create unique index upload_grants_storage_path_key')
  })

  it('pins a claimed object to the claimant and their report', () => {
    expect(grantPolicy()).toContain(
      "storage_path like (auth.uid()::text || '/' || report_id::text || '/%')",
    )
  })

  it('serialises the count it enforces, so concurrent statements cannot all pass', () => {
    // Separate from the visibility problem above, and covered for all three in
    // the shared cases further up -- this one also pins the key it locks on.
    const fn = flat.slice(
      flat.indexOf('function mo.enforce_upload_grant_rate_limit()'),
      flat.indexOf('create trigger enforce_upload_grant_rate_limit'),
    )
    expect(fn).toContain('pg_advisory_xact_lock')
    // Locked for every person the statement touches, not just one row's.
    expect(fn).toContain('select distinct user_id from new_rows')
  })

  it('cascades from the person but not from the report, and says which', () => {
    // These two go opposite ways on purpose. The report reference must NOT
    // cascade, or deleting your own report resets the hourly count. The person
    // reference does, because deleting somebody should take their records --
    // and that is a path which empties grants inside the window, so the file
    // has to name it rather than claim no such path exists.
    expect(grantTable()).toContain('references public.profiles (id) on delete cascade')
    expect(grantTable()).toContain('references mo.reports (id) on delete set null')
  })

  it('is not deletable by the person it limits', () => {
    // Same reason. Rows disappearing inside the window is the failure mode.
    expect(flat).not.toContain('create policy upload_grants_delete')
    expect(flat).not.toContain('grant delete on mo.upload_grants')
  })

  it('revokes the default privileges rather than merely not granting them', () => {
    // Supabase ships `alter default privileges ... grant all on tables`, so
    // omitting a grant is not withholding one -- the reason 0003 revokes every
    // other table explicitly. Asserting only the absence of a `grant delete`
    // cannot see an inherited one.
    expect(flat).toContain('revoke all on mo.upload_grants from anon, authenticated')
  })
})

describe('migrations — the comments do not promise more than R2 gives', () => {
  it('never claims an unreviewed image is unreachable', () => {
    // The view withholds the PATH. The bytes are on a public hostname, and the
    // uploader is handed their own key, so "unreachable" was true of Supabase
    // storage and is not true of R2. The claim lived in two places and was
    // corrected in only one of them for a while.
    for (const [name, text] of Object.entries(sql)) {
      expect(text, name).not.toMatch(/genuinely unreachable(?!")/)
    }
  })
})

describe('.env.example', () => {
  const lines = readFileSync(join(process.cwd(), '.env.example'), 'utf8').split('\n')
  const names = lines
    .map((line) => /^([A-Z0-9_]+)=/.exec(line.trim())?.[1])
    .filter((name): name is string => Boolean(name))

  it('names every variable once', () => {
    // A name that appears twice takes its LAST value, so a second empty
    // `NAME=` silently overrides the one somebody filled in higher up. The
    // endpoint then reports "not set up" with nothing pointing at why.
    const seen = new Set<string>()
    const duplicated = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)))
    expect(duplicated).toEqual([])
  })

  it('lists every variable the upload endpoint refuses to sign without', () => {
    for (const name of [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      // The VITE_ name, and only that one: the endpoint checks it on the
      // bundle's behalf and the bundle reads exactly this. There is
      // deliberately no PHOTO_BASE_URL alias, because accepting one let the
      // gate pass on a value the app would never see.
      'VITE_PHOTO_BASE_URL',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ]) {
      expect(names).toContain(name)
    }
  })

  it('never contains a real-looking value', () => {
    // The file's own first rule. A filled-in secret here is committed.
    for (const line of lines) {
      const match = /^(SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID)=(.+)$/.exec(
        line.trim(),
      )
      expect(match).toBeNull()
    }
  })
})

describe('the test sources themselves', () => {
  it('contain no stray control characters', () => {
    // A `\b` written through a shell heredoc can land in the file as a literal
    // backspace byte, turning a regex into one that matches nothing. That is
    // exactly how the profile_names role check came to pass on a schema that
    // leaked `role` -- silently, with a green suite.
    // `api` included: it holds the hand-rolled SigV4 signer, which is the most
    // regex-dense code in the repo and the likeliest place for a regex escape written
    // through a heredoc to land as a literal backspace byte.
    const roots = [
      join(process.cwd(), 'src'),
      join(process.cwd(), 'api'),
      join(process.cwd(), 'worker', 'src'),
    ]
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8')
          // Tab, CR and LF are fine; nothing else below 0x20 belongs in source.
          const match = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
          if (match) offenders.push(full)
        }
      }
    }

    for (const root of roots) walk(root)
    expect(offenders).toEqual([])
  })
})

describe('migrations — the name a person posts under', () => {
  // A chosen name is free text shown in public. Everything else a person
  // writes is withheld until reviewed, and a name is no exception -- it is
  // also the thing that replaced publishing an email prefix, so the ways it
  // could leak one again are pinned here too.

  it('is a kind of thing that can be reviewed', () => {
    expect(flat).toContain("create type mo.subject_type as enum ('photo', 'comment', 'note', 'name')")
  })

  it('refuses an email address as a name in the table itself', () => {
    const table = flat.slice(flat.indexOf('create table mo.display_names'))
    const definition = table.slice(0, table.indexOf(');'))
    expect(definition).toContain("position('@' in name) = 0")
    expect(definition).toContain("moderation_status moderation_status not null default 'pending'")
  })

  it('is not readable or writable by either browser role directly', () => {
    expect(flat).toContain('revoke all on mo.display_names from anon, authenticated')
    expect(flat).not.toMatch(/grant \w+[^;]* on mo\.display_names to (anon|authenticated)/)
  })

  it('is readable by the worker, which has to judge it', () => {
    expect(flat).toContain('grant select on mo.display_names to service_role')
  })

  it.each(['reports_insert_own', 'comments_insert_own'])(
    'requires a name before %s lets anything be posted',
    (policy) => {
      const text = flat.slice(flat.indexOf('create policy ' + policy))
      expect(text.slice(0, text.indexOf(';'))).toContain('mo.has_display_name()')
    },
  )

  it('does not count a rejected name as having one', () => {
    expect(bodyOf('has_display_name(')).toMatch(/moderation_status\s*<>\s*'rejected'/)
    expect(bodyOf('has_display_name(')).toMatch(/security\s+definer/)
  })

  it.each(['has_display_name()', 'my_display_name()', 'set_display_name(text)'])(
    'keeps %s from signed-out visitors',
    (fn) => {
      expect(flat).toContain('revoke all on function mo.' + fn + ' from public, anon')
      expect(flat).toContain('grant execute on function mo.' + fn + ' to authenticated')
    },
  )

  it('acts only on the caller’s own name', () => {
    for (const fn of ['has_display_name(', 'my_display_name(', 'set_display_name(']) {
      expect(bodyOf(fn)).toContain('auth.uid()')
    }
    expect(bodyOf('set_display_name(')).toMatch(/where\s+user_id\s*=\s*me/)
  })

  it('sends every new name back through review, under a NEW job', () => {
    // Resetting the old job row let a decision made about the OLD text land on
    // the new one: admin_decide_moderation only checks that the verdict is
    // null. A fresh job id means anything holding the old one names a job that
    // no longer exists.
    const body = bodyOf('set_display_name(')
    expect(body).toMatch(/moderation_status\s*=\s*'pending'/)
    const flatBody = body.replace(/\s+/g, ' ')
    expect(flatBody).toContain("delete from mo.moderation_jobs where subject_type = 'name' and subject_id = me;")
    expect(flatBody).toContain("insert into mo.moderation_jobs (subject_type, subject_id) values ('name', me);")
    expect(flatBody.indexOf('delete from mo.moderation_jobs')).toBeLessThan(
      flatBody.indexOf('insert into mo.moderation_jobs'),
    )
    expect(flatBody).not.toContain('on conflict (subject_type, subject_id) do update')
  })

  it('refuses, rather than errors, when the job a worker holds has vanished', () => {
    // A renamed name's old job is deleted under the worker. That is the same
    // situation as another worker finishing first, and gets the same answer.
    const body = bodyOf('record_moderation_verdict').replace(/\s+/g, ' ')
    expect(body).toContain('if not found then')
    const branch = body.slice(body.indexOf('if not found then'))
    expect(branch.slice(0, branch.indexOf('end if;'))).toContain('return false;')
    expect(body).not.toContain("raise exception 'no such moderation job")
  })

  it('refuses an email address and the exact name that was rejected', () => {
    const body = bodyOf('set_display_name(')
    expect(body).toContain("position('@' in chosen) > 0")
    expect(body).toMatch(/existing\.moderation_status\s*=\s*'rejected'[\s\S]*existing\.name\s*=\s*chosen[\s\S]*raise exception/)
  })

  it('names a pasted tab or line break itself, rather than leaving it to the CHECK', () => {
    // The CHECK's failure arrives as a constraint name, which reads as "please
    // try again" for input that can never succeed.
    expect(bodyOf('set_display_name(')).toContain("if chosen ~ '[[:cntrl:]]' then")
  })

  it('limits how often a name can change, since each change is review work', () => {
    expect(bodyOf('set_display_name(')).toMatch(/updated_at\s*>\s*now\(\)\s*-\s*interval\s*'1 day'/)
  })

  it.each(['record_moderation_verdict', 'admin_decide_moderation'])(
    '%s applies a verdict on a name to that person’s name',
    (fn) => {
      // By user_id: a name has no id of its own, and `where id = ...` would
      // not even compile against this table.
      expect(bodyOf(fn)).toMatch(
        /elsif job\.subject_type = 'name' then\s+update mo\.display_names set moderation_status = new_verdict where user_id = job\.subject_id/,
      )
    },
  )

  it('shows the admin the name, and never labels a person’s id as a report', () => {
    const body = bodyOf('admin_moderation_queue')
    expect(body).toMatch(/when 'name'\s+then \(select d\.name from mo\.display_names d where d\.user_id = j\.subject_id\)/)
    // The report_id column used to end `else j.subject_id`, which for a name
    // is a user id.
    const reportColumn = body.slice(body.indexOf("when 'photo'   then (select p.report_id"))
    expect(reportColumn.slice(0, reportColumn.indexOf('end'))).not.toMatch(/else\s+j\.subject_id/)
  })

  it('validates a complaint about a name, and refuses any kind it does not know', () => {
    const body = bodyOf('validate_flag_subject')
    expect(body).toMatch(/elsif new\.subject_type = 'name' then/)
    expect(body).toMatch(/else\s+raise exception/)
  })

  it('withholds a name again when two people complain, like anything else', () => {
    expect(bodyOf('flag_withholds_content')).toMatch(
      /update mo\.display_names set moderation_status = 'pending'\s+where user_id = new\.subject_id and moderation_status = 'approved'/,
    )
  })

  it('leaves no review job behind when a name is deleted', () => {
    expect(triggerFor('cleanup_moderation_on_name_delete')).toContain('on mo.display_names')
    expect(bodyOf('cleanup_moderation_for_deleted_name')).toMatch(/subject_id\s*=\s*old\.user_id/)
  })
})

describe('migrations — a reader can complain about a name', () => {
  // public_comments withholds author ids, so a reader has nothing to put in a
  // 'name' flag's subject_id. flag_comment_author takes the comment instead.

  it('is signed-in only, and hands nothing back', () => {
    expect(flat).toContain('revoke all on function mo.flag_comment_author(uuid, text) from public, anon')
    expect(flat).toContain('grant execute on function mo.flag_comment_author(uuid, text) to authenticated')
    expect(bodyOf('flag_comment_author')).toMatch(/returns\s+void/)
  })

  it('files an ordinary flag, so every trigger on flags still applies', () => {
    const body = bodyOf('flag_comment_author').replace(/\s+/g, ' ')
    expect(body).toContain(
      "insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('name', author, auth.uid(),",
    )
  })

  it('only reaches a name other people can actually see', () => {
    const body = bodyOf('flag_comment_author').replace(/\s+/g, ' ')
    expect(body).toContain("c.moderation_status = 'approved'")
    expect(body).toContain("d.user_id = author and d.moderation_status = 'approved'")
    expect(body).toContain('if author = auth.uid() then')
  })

  it('tells the app whether you wrote a comment without giving it the id', () => {
    expect(viewOf('public_comments').replace(/\s+/g, ' ')).toContain(
      'coalesce(c.author_id = auth.uid(), false) as viewer_is_author',
    )
  })
})

describe('migrations — the name on a report', () => {
  it('shows the reporter’s name on the same terms as a comment author’s', () => {
    const definition = viewOf('public_reports').replace(/\s+/g, ' ')
    expect(definition).toContain('as reporter_name')
    const name = definition.slice(definition.indexOf('select d.name'))
    expect(name).toContain('d.user_id = r.reporter_id')
    expect(name).toContain("d.moderation_status = 'approved'")
  })
})

describe('migrations — complaining about the name on a report', () => {
  it('is signed-in only, and hands nothing back', () => {
    expect(flat).toContain('revoke all on function mo.flag_report_author(uuid, text) from public, anon')
    expect(flat).toContain('grant execute on function mo.flag_report_author(uuid, text) to authenticated')
    expect(bodyOf('flag_report_author')).toMatch(/returns\s+void/)
  })

  it('files an ordinary name flag, only for a visible approved name, never your own', () => {
    const body = bodyOf('flag_report_author').replace(/\s+/g, ' ')
    expect(body).toContain(
      "insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('name', author, auth.uid(),",
    )
    expect(body).toContain("r.moderation_status <> 'rejected'")
    expect(body).toContain("d.user_id = author and d.moderation_status = 'approved'")
    expect(body).toContain('if author = auth.uid() then')
  })
})

describe('migrations — naming cannot be turned into unlimited review work', () => {
  it('caps names a day whatever became of them, rejection included', () => {
    const body = bodyOf('set_display_name(').replace(/\s+/g, ' ')
    expect(body).toContain(
      "if existing.window_started > now() - interval '1 day' and existing.changes_in_window >= 3 then",
    )
    // After the rejected/accepted branch, so a rejection cannot skip it.
    expect(body.indexOf('changes_in_window >= 3')).toBeGreaterThan(
      body.indexOf("if existing.moderation_status = 'rejected' then"),
    )
    expect(body).toContain('changes_in_window = case')
  })

  it('keeps the count in the table, where the client cannot reset it', () => {
    const table = flat.slice(flat.indexOf('create table mo.display_names'))
    const definition = table.slice(0, table.indexOf(');'))
    expect(definition).toContain('changes_in_window integer not null default 1')
    expect(definition).toContain('window_started timestamptz not null default now()')
  })

  it('never lets a name be flagged by a direct insert', () => {
    const policy = flat.slice(flat.indexOf('create policy flags_insert_own'))
    expect(policy.slice(0, policy.indexOf(';'))).toContain("and subject_type <> 'name'")
  })

  it('refuses a complaint about your own name, whatever the route', () => {
    expect(bodyOf('validate_flag_subject')).toMatch(
      /if new\.subject_id = new\.flagger_id then\s+raise exception 'you cannot report your own name'/,
    )
  })
})

describe('migrations — a name has to be visible, and pending names are not shown around', () => {
  it('refuses invisible names in the table and in the function, with the same ranges as the app', async () => {
    const { INVISIBLE_RANGES } = await import('../names/displayName')
    const body = bodyOf('visible_length(')
    const pairs = [...body.matchAll(/\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(pairs).toEqual(INVISIBLE_RANGES.map(([lo, hi]) => [lo, hi]))
    expect(body).toMatch(/immutable/)

    const table = flat.slice(flat.indexOf('create table mo.display_names'))
    expect(table.slice(0, table.indexOf('moderation_status moderation_status'))).toContain(
      'mo.visible_length(name) >= 2',
    )
    expect(bodyOf('set_display_name(')).toContain('if mo.visible_length(chosen) < 2 then')
  })

  it.each([
    ['public_reports', 'reporter_name'],
    ['public_comments', 'author_name'],
  ])('%s shows a pending %s to its owner only, not to admins', (view, column) => {
    const definition = viewOf(view).replace(/\s+/g, ' ')
    const end = definition.indexOf('as ' + column)
    const subquery = definition.slice(definition.lastIndexOf('select d.name', end), end)
    expect(subquery).toContain("d.moderation_status = 'approved'")
    expect(subquery).toContain('d.user_id = auth.uid()')
    expect(subquery).not.toContain('is_admin')
  })
})

describe('migrations — a renamed name can be reported afresh', () => {
  it('deletes complaints about the old name, since flags allow one per person per subject', () => {
    const body = bodyOf('set_display_name(').replace(/\s+/g, ' ')
    expect(body).toContain("delete from mo.flags where subject_type = 'name' and subject_id = me;")
    expect(body).not.toMatch(/update mo\.flags set resolved_at/)
  })
})

describe('migrations — a rename and a decision cannot deadlock', () => {
  it('takes the review job before the name, the same order the decision paths use', () => {
    const body = bodyOf('set_display_name(').replace(/\s+/g, ' ')
    const jobLock = body.indexOf(
      "perform 1 from mo.moderation_jobs where subject_type = 'name' and subject_id = me for update;",
    )
    const nameLock = body.indexOf('select * into existing from mo.display_names where user_id = me for update;')
    expect(jobLock).toBeGreaterThan(-1)
    expect(nameLock).toBeGreaterThan(jobLock)
  })
})
