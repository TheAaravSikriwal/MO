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

  it('never grants the worker RPCs to a browser role', () => {
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.claim_moderation_jobs[\s\S]{0,120}to\s+(anon|authenticated)/i,
    )
    expect(allCode).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.record_moderation_verdict[\s\S]{0,160}to\s+(anon|authenticated)/i,
    )
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
    expect(allCode).toMatch(/create\s+view\s+public\.public_profiles/i)
  })

  it('keeps role out of the public profile view', () => {
    // Bounded at the statement, not a fixed 300 chars -- that overran the view
    // and would have passed or failed on whatever followed it.
    expect(viewOf('public_profiles')).not.toMatch(/role/i)
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
