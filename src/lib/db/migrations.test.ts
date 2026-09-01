import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

const TABLES = [
  'profiles',
  'reports',
  'report_photos',
  'votes',
  'comments',
  'flags',
  'moderation_jobs',
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
  const at = allCode.indexOf('create view public.' + name)
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
  const at = allCode.indexOf('function public.' + name)
  expect(at, 'function not found: ' + name).toBeGreaterThan(-1)
  const rest = allCode.slice(at + name.length)
  const next = rest.search(/create\s+or\s+replace\s+function/i)
  return next === -1 ? allCode.slice(at) : allCode.slice(at, at + name.length + next)
}

describe('migrations — structure', () => {
  it('has migrations, numbered and ordered', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const name of files) expect(name).toMatch(/^\d{4}_/)
  })

  it('strips comments before checking anything', () => {
    // Guards the guard: if this broke, every check below could be satisfied by
    // a comment describing the rule rather than the rule itself.
    expect(stripComments('foo -- revoke all on public.reports from anon')).toBe('foo ')
  })
})

describe('migrations — unreviewed content stays unreachable', () => {
  it('revokes reports from browser roles rather than merely not granting it', () => {
    // Supabase ships default privileges granting SELECT on every new table to
    // anon and authenticated. Omitting a grant leaves the table world-readable,
    // which made the column masking in the views decorative.
    expect(allCode).toMatch(/revoke\s+all\s+on\s+public\.reports\s+from\s+anon/i)
  })

  it('revokes report_photos from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+public\.report_photos\s+from\s+anon/i)
  })

  it('revokes comments from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+public\.comments\s+from\s+anon/i)
  })

  it('revokes moderation_jobs from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+public\.moderation_jobs\s+from\s+anon/i)
  })

  it('revokes the default privileges that would re-grant future tables', () => {
    expect(allCode).toMatch(/alter\s+default\s+privileges[\s\S]{0,120}revoke\s+all\s+on\s+tables/i)
  })

  it('never grants whole-table select on reports to a browser role', () => {
    expect(allCode).not.toMatch(/grant\s+select\s+on\s+public\.reports\s+to\s+(anon|authenticated)/i)
  })

  it('never grants whole-table select on report_photos to a browser role', () => {
    expect(allCode).not.toMatch(
      /grant\s+select\s+on\s+public\.report_photos\s+to\s+(anon|authenticated)/i,
    )
  })

  it('grants only the single column an insert needs to return', () => {
    // supabase-js turns .insert().select('id') into INSERT ... RETURNING id,
    // which needs SELECT on that column or every submission fails.
    expect(allCode).toMatch(/grant\s+select\s*\(\s*id\s*\)\s+on\s+public\.reports\s+to\s+authenticated/i)
  })

  it('keeps the worker RPCs revoked from browser roles', () => {
    expect(allCode).toMatch(/revoke\s+all\s+on\s+function\s+public\.claim_moderation_jobs/i)
    expect(allCode).toMatch(/revoke\s+all\s+on\s+function\s+public\.record_moderation_verdict/i)
    expect(allCode).toMatch(/revoke\s+all\s+on\s+function\s+public\.escalate_moderation_job/i)
  })

  it('never hands a browser role blanket privileges on anything', () => {
    // `grant all` is how the worst leak got in: the views inherited it from
    // Supabase's default privileges, and every check here matched only the
    // literal `grant select ...` shape, so none of them noticed.
    expect(flat).not.toContain('grant all on public.')
    expect(flat).not.toContain('grant all on all tables');
  })

  it('revokes the default privileges BEFORE creating anything', () => {
    // ALTER DEFAULT PRIVILEGES is not retroactive. Run after the views, it
    // leaves every one of them carrying GRANT ALL to anon -- and because they
    // are definer views, writing through them bypasses RLS entirely.
    const revokeAt = flat.indexOf('alter default privileges in schema public revoke all on tables')
    const firstView = flat.indexOf('create view public.')
    expect(revokeAt).toBeGreaterThan(-1)
    expect(firstView).toBeGreaterThan(-1)
    expect(revokeAt).toBeLessThan(firstView)
  })

  it.each([
    'public_reports',
    'public_report_photos',
    'public_comments',
  ])('revokes %s explicitly before granting select on it', (view) => {
    const revokeAt = flat.indexOf('revoke all on public.' + view + ' from anon')
    const grantAt = flat.indexOf('grant select on public.' + view + ' to anon')
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
      /grant\s+execute\s+on\s+function\s+public\.claim_moderation_jobs[\s\S]{0,120}to\s+(anon|authenticated)/i,
    )
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.record_moderation_verdict[\s\S]{0,160}to\s+(anon|authenticated)/i,
    )
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.escalate_moderation_job[\s\S]{0,160}to\s+(anon|authenticated)/i,
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
    expect(flat).toContain('revoke all on function public.mark_report_cleaned(uuid) from public, anon')
  })

  it('looks profile names up by id instead of listing them', () => {
    // A listable view let anyone enumerate every account in the database.
    expect(flat).toContain('create or replace function public.profile_names(ids uuid[])')
    expect(flat).not.toContain('create view public.public_profiles')
  })

  it('is the relation the app actually calls', () => {
    // The view was replaced by this RPC while the app kept querying the view,
    // so every comment author silently rendered as "someone" and the error was
    // discarded. Pin the two together.
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'data', 'supabaseSource.ts'),
      'utf8',
    )
    expect(source).toContain("rpc('profile_names'")
    expect(source).not.toContain("from('public_profiles')")
  })

  it('reports whether an escalation was actually applied', () => {
    // Returning void made the caller assume success even when the guard
    // refused the write, so the log claimed escalations that never happened.
    expect(bodyOf('escalate_moderation_job')).toMatch(/returns\s+boolean/i)
  })

  it('lets a complaint outrank a machine verdict', () => {
    const body = bodyOf('record_moderation_verdict')
    expect(body).toMatch(/from\s+public\.flags/i)
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
    expect(flat).toContain('alter table public.' + table + ' enable row level security')
  })

  it('defines policies rather than relying on RLS alone', () => {
    // RLS with no policies denies everything, which fails closed but silently
    // breaks the app; RLS with policies deleted is the dangerous direction.
    const policies = allCode.match(/create\s+policy/gi) ?? []
    expect(policies.length).toBeGreaterThanOrEqual(10)
  })

  it.each(['comments', 'profiles'])(
    'never grants whole-table select on %s to a browser role',
    (table) => {
      // A later grant beats an earlier revoke in Postgres, so the revoke
      // assertions above are not enough on their own.
      expect(flat).not.toContain('grant select on public.' + table + ' to anon')
      expect(flat).not.toContain('grant select on public.' + table + ' to authenticated')
    },
  )

  it.each(['votes', 'flags'])(
    'scopes %s to your own rows, since it is readable',
    (table) => {
      // These two ARE granted, deliberately: neither holds content awaiting
      // review, and the app needs them. What matters is that the policy stops
      // you reading anybody else's.
      expect(flat).toContain('grant select on public.' + table + ' to authenticated')
      const policy = flat.slice(flat.indexOf('create policy ' + table.slice(0, -1) + 's_select_own'))
      expect(policy.slice(0, 300)).toMatch(/auth\.uid\(\)/)
    },
  )

  it('never exposes votes or flags to anonymous visitors', () => {
    // Who voted for what, and who complained about whom, are not public.
    expect(flat).not.toContain('grant select on public.votes to anon')
    expect(flat).not.toContain('grant select on public.flags to anon')
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
    expect(triggerFor(trigger)).toContain('on public.' + table + ' ')
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
      if (!/update\s+public\.reports/i.test(branch)) continue
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
    expect(body).toMatch(/set\s+search_path\s*=\s*public,\s*extensions/i)
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
    expect(flat).toContain('create or replace function public.count_reports_in_view')
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
    const grant = flat.slice(flat.indexOf('grant execute on function public.reports_rollup'))
    const args = grant.slice(0, grant.indexOf(')')).split(',').length
    expect(args).toBe(11)
  })
})

describe('migrations — the admin surface refuses non-admins', () => {
  it('checks is_admin in admin_moderation_queue', () => {
    expect(bodyOf('admin_moderation_queue')).toMatch(/if\s+not\s+public\.is_admin\(\)/i)
  })

  it('checks is_admin in admin_decide_moderation', () => {
    expect(bodyOf('admin_decide_moderation')).toMatch(/if\s+not\s+public\.is_admin\(\)/i)
  })

  it('checks is_admin in admin_queue_size', () => {
    expect(bodyOf('admin_queue_size')).toMatch(/if\s+not\s+public\.is_admin\(\)/i)
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

  it('bounds each function body at the next definition', () => {
    // Guards the guard: if bodyOf over-reads, the is_admin checks above pass on
    // a neighbouring function's guard rather than the one they name.
    expect(bodyOf('admin_moderation_queue')).not.toContain('admin_decide_moderation')
    expect(bodyOf('admin_decide_moderation')).not.toContain('admin_queue_size')
    expect(bodyOf('admin_queue_size')).not.toContain('flag_reopens_review')
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
    // Returning public.reports handed the caller the note as well, and
    // SECURITY DEFINER meant the column grants did not apply.
    const body = bodyOf('mark_report_cleaned')
    expect(body).toMatch(/returns\s+void/i)
    expect(body).not.toMatch(/returns\s+public\.reports/i)
  })

  it('does not expose profiles, which carry the admin role', () => {
    expect(allCode).not.toMatch(/grant\s+select\s+on\s+public\.profiles\s+to\s+(anon|authenticated)/i)
  })

  it('keeps role out of the name lookup', () => {
    // Exposing it would let anyone enumerate every admin account.
    expect(bodyOf('profile_names')).not.toMatch(/role/i)
  })

  it('bounds the name lookup so it cannot be used to page through accounts', () => {
    const body = bodyOf('profile_names')
    expect(body).toMatch(/where\s+p\.id\s*=\s*any\(ids\)/i)
    expect(body).toMatch(/limit\s+\d+/i)
  })

  it('still lets the app find out whether YOU are an admin', () => {
    // Without this the review queue cannot be opened by anyone: the app has no
    // other way to know, and the failure is silent.
    expect(allCode).toMatch(/grant\s+execute\s+on\s+function\s+public\.is_admin\(\)\s+to\s+authenticated/i)
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
    const noteUpdate = body.match(/update\s+public\.reports[\s\S]{0,200}?;/i)
    expect(noteUpdate).not.toBeNull()
    expect(noteUpdate![0]).toMatch(/note\s+is\s+not\s+null/i)
  })
})

describe('migrations — rate limits exist for every table a person can write to', () => {
  it.each(['report', 'comment', 'flag'])('limits %s inserts', (kind) => {
    expect(allCode).toContain('enforce_' + kind + '_rate_limit')
  })
})
