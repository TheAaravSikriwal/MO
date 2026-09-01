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

/** The body of a function, from its definition to the end of the file. */
const bodyOf = (name: string) => {
  const at = allCode.indexOf('function public.' + name)
  expect(at, 'function not found: ' + name).toBeGreaterThan(-1)
  return allCode.slice(at, at + 2500)
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
