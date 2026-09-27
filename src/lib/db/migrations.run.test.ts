// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { addProfile, asRole, failure, freshDatabase } from './pgHarness'

/**
 * The migrations, applied to a real Postgres and exercised as the roles that
 * will really call them.
 *
 * migrations.test.ts reads the SQL as text; this runs it. Every statement below
 * executes under `anon`, `authenticated` or `service_role` with auth.uid() set
 * the way PostgREST sets it, so row-level security, column grants, triggers and
 * SECURITY DEFINER all behave as they will on Supabase. What is NOT real is
 * PostGIS and Supabase's own schema -- see the stand-ins in pgHarness.ts.
 */

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const CAROL = '44444444-4444-4444-8444-444444444444'
const DAN = '55555555-5555-4555-8555-555555555555'

const CELL = '8a1fb46622dffff'

let db: PGlite

beforeAll(async () => {
  db = await freshDatabase()
  // What chintu's handle_new_user writes for a magic-link signup: the email's
  // local part as display_name, readable by anon.
  await addProfile(db, ALICE, 'alice.smith')
  await addProfile(db, BOB, 'bob.jones')
  await addProfile(db, ADMIN, 'the.admin')
  await addProfile(db, CAROL, 'carol.white')
  await addProfile(db, DAN, 'dan.brown')
  await db.query('insert into mo.admins (user_id) values ($1)', [ADMIN])
}, 120_000)

const as = <T>(userId: string | null, work: () => Promise<T>) =>
  asRole(db, userId ? 'authenticated' : 'anon', userId, work)

const worker = <T>(work: () => Promise<T>) => asRole(db, 'service_role', null, work)

const setName = (userId: string, name: string) =>
  as(userId, () => db.query('select mo.set_display_name($1)', [name]))

const myName = (userId: string) =>
  as(userId, async () => {
    const { rows } = await db.query<{ name: string; moderation_status: string }>(
      'select * from mo.my_display_name()',
    )
    return rows[0] ?? null
  })

const addReport = (userId: string, note: string | null = null) =>
  as(userId, async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into mo.reports
         (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7, cell_r9, cell_r12, note)
       values ($1, 51.5, -0.12, $2, $2, $2, $2, $2, $2, $3)
       returning id`,
      [userId, CELL, note],
    )
    return rows[0].id
  })

const addComment = (userId: string, reportId: string, body: string) =>
  as(userId, () =>
    db.query('insert into mo.comments (report_id, author_id, body) values ($1, $2, $3)', [
      reportId,
      userId,
      body,
    ]),
  )

/** Settle a name the way the worker does: claim its job, then record a verdict. */
const workerDecidesName = async (userId: string, verdict: 'approved' | 'rejected') => {
  const { rows: jobs } = await db.query<{ id: string }>(
    "select id from mo.moderation_jobs where subject_type = 'name' and subject_id = $1",
    [userId],
  )
  expect(jobs).toHaveLength(1)
  await worker(async () => {
    await db.query('select * from mo.claim_moderation_jobs($1, 100)', ['test-worker'])
    const { rows } = await db.query<{ applied: boolean }>(
      "select mo.record_moderation_verdict($1, $2::mo.moderation_status, 'tier3:test') as applied",
      [jobs[0].id, verdict],
    )
    expect(rows[0].applied).toBe(true)
  })
}

/** Move a name's last change back in time, as if a day had passed. */
const ageName = (userId: string) =>
  db.query(
    `update mo.display_names
        set updated_at = now() - interval '2 days', window_started = now() - interval '2 days'
      where user_id = $1`,
    [userId],
  )

describe('the migrations, applied to a real Postgres', () => {
  it('apply cleanly, in order, and create MO’s tables in mo', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'mo' order by 1",
    )
    const names = rows.map((row) => row.table_name)
    for (const table of ['reports', 'comments', 'display_names', 'flags', 'moderation_jobs']) {
      expect(names).toContain(table)
    }
  })
})

describe('a name comes before a first post', () => {
  it('refuses a report from somebody with no name', async () => {
    expect(await failure(() => addReport(ALICE))).toMatch(/row-level security policy for table "reports"/)
  })

  it('takes a name, pending, and then the report', async () => {
    await setName(ALICE, 'Alice')
    expect(await myName(ALICE)).toEqual({ name: 'Alice', moderation_status: 'pending' })
    expect(await addReport(ALICE)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses a comment from somebody with no name', async () => {
    const reportId = await addReport(ALICE)
    expect(await failure(() => addComment(BOB, reportId, 'hello'))).toMatch(
      /row-level security policy for table "comments"/,
    )
  })

  it('does not let a signed-out visitor choose or read a name at all', async () => {
    expect(await failure(() => as(null, () => db.query("select mo.set_display_name('x y')")))).toMatch(
      /permission denied/,
    )
    expect(await failure(() => as(null, () => db.query('select * from mo.my_display_name()')))).toMatch(
      /permission denied/,
    )
  })

  it('does not let anybody read the names table directly', async () => {
    expect(await failure(() => as(BOB, () => db.query('select * from mo.display_names')))).toMatch(
      /permission denied/,
    )
  })
})

describe('what a signed-out visitor can see', () => {
  let reportId: string

  beforeAll(async () => {
    await setName(BOB, 'Bob')
    reportId = await addReport(BOB)
    await addComment(BOB, reportId, 'Still here this morning')
  })

  const publicReport = (viewer: string | null) =>
    as(viewer, async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        'select * from mo.public_reports where id = $1',
        [reportId],
      )
      return rows[0]
    })

  const publicComment = (viewer: string | null) =>
    as(viewer, async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        'select * from mo.public_comments where report_id = $1',
        [reportId],
      )
      return rows[0]
    })

  it('never gets the reporter’s or author’s id', async () => {
    expect((await publicReport(null)).reporter_id).toBeNull()
    expect((await publicReport(ALICE)).reporter_id).toBeNull()
    expect((await publicReport(BOB)).reporter_id).toBe(BOB)
  })

  it('sees no name while it is pending, though the owner sees their own', async () => {
    expect((await publicReport(null)).reporter_name).toBeNull()
    expect((await publicReport(BOB)).reporter_name).toBe('Bob')
  })

  it('does not see a pending name as an admin either', async () => {
    // Admins judge pending names in the queue; shown here they looked approved.
    expect((await publicReport(ADMIN)).reporter_name).toBeNull()
  })

  it('sees the chosen name once approved, and never the email prefix', async () => {
    await workerDecidesName(BOB, 'approved')
    const report = await publicReport(null)
    expect(report.reporter_name).toBe('Bob')

    // Approving a comment the way an admin would, so it is visible to anon.
    const { rows } = await db.query<{ id: string }>(
      "select j.id from mo.moderation_jobs j join mo.comments c on c.id = j.subject_id where j.subject_type = 'comment' and c.report_id = $1",
      [reportId],
    )
    await as(ADMIN, () =>
      db.query("select mo.admin_decide_moderation($1, 'approved')", [rows[0].id]),
    )
    const comment = await publicComment(null)
    expect(comment.author_name).toBe('Bob')
    expect(comment.author_id).toBeNull()
    expect(comment.viewer_is_author).toBe(false)

    expect(JSON.stringify([report, comment])).not.toContain('bob.jones')
  })
})

describe('choosing a name', () => {
  it('refuses an email address, an invisible name, and a tab', async () => {
    expect(await failure(() => setName(CAROL, 'carol@example.com'))).toMatch(/cannot contain @/)
    const zeroWidth = String.fromCodePoint(8203)
    expect(await failure(() => setName(CAROL, zeroWidth + zeroWidth))).toMatch(/2 visible characters/)
    expect(await failure(() => setName(CAROL, 'Car' + String.fromCharCode(9) + 'ol'))).toMatch(
      /tabs or line breaks/,
    )
    expect(await myName(CAROL)).toBeNull()
  })

  it('allows one change a day to an accepted name', async () => {
    await setName(CAROL, 'Carol')
    await workerDecidesName(CAROL, 'approved')
    expect(await failure(() => setName(CAROL, 'Caz'))).toMatch(/once a day/)
    await ageName(CAROL)
    await setName(CAROL, 'Caz')
    expect(await myName(CAROL)).toEqual({ name: 'Caz', moderation_status: 'pending' })
  })

  it('lets a rejected name be replaced at once, but not endlessly, and never with itself', async () => {
    await setName(DAN, 'Name One')
    await workerDecidesName(DAN, 'rejected')
    expect(await failure(() => setName(DAN, 'Name One'))).toMatch(/not accepted/)

    await setName(DAN, 'Name Two')
    await workerDecidesName(DAN, 'rejected')
    await setName(DAN, 'Name Three')
    await workerDecidesName(DAN, 'rejected')
    expect(await failure(() => setName(DAN, 'Name Four'))).toMatch(/too many new names today/)
  })

  it('refuses posts once the name is rejected', async () => {
    // Dan's last name was rejected above.
    expect(await failure(() => addReport(DAN))).toMatch(/row-level security policy for table "reports"/)
  })
})

describe('a rename while a decision is pending', () => {
  it('gives the new name a new job, so a decision on the old one cannot land', async () => {
    const who = '66666666-6666-4666-8666-666666666666'
    await addProfile(db, who, 'eve.green')
    await setName(who, 'Eve')
    const { rows: before } = await db.query<{ id: string }>(
      "select id from mo.moderation_jobs where subject_type = 'name' and subject_id = $1",
      [who],
    )
    await ageName(who)
    await setName(who, 'Something Else')

    const { rows: after } = await db.query<{ id: string }>(
      "select id from mo.moderation_jobs where subject_type = 'name' and subject_id = $1",
      [who],
    )
    expect(after).toHaveLength(1)
    expect(after[0].id).not.toBe(before[0].id)

    // An admin approving what they saw -- the old job -- is refused.
    expect(
      await failure(() =>
        as(ADMIN, () => db.query("select mo.admin_decide_moderation($1, 'approved')", [before[0].id])),
      ),
    ).toMatch(/no such moderation job/)

    // And the worker holding it is told no, rather than erroring.
    const { rows } = await worker(() =>
      db.query<{ applied: boolean }>(
        "select mo.record_moderation_verdict($1, 'approved', 'tier3:test') as applied",
        [before[0].id],
      ),
    )
    expect(rows[0].applied).toBe(false)
    expect(await myName(who)).toEqual({ name: 'Something Else', moderation_status: 'pending' })
  })
})

describe('complaining about a name', () => {
  let commentId: string

  beforeAll(async () => {
    // Bob's name is approved, and so is his comment, from the tests above.
    const { rows } = await db.query<{ id: string }>(
      "select id from mo.comments where author_id = $1 and moderation_status = 'approved' limit 1",
      [BOB],
    )
    commentId = rows[0].id
  })

  it('cannot be done by a direct insert, for somebody else’s name or your own', async () => {
    const direct = (flagger: string, subject: string) =>
      failure(() =>
        as(flagger, () =>
          db.query(
            "insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('name', $1, $2, 'x')",
            [subject, flagger],
          ),
        ),
      )
    // The policy is what refuses somebody else's: the validation trigger is
    // content with a name that exists and is not yours.
    expect(await direct(ALICE, BOB)).toMatch(/row-level security policy for table "flags"/)
    // For your own, the BEFORE trigger gets there first -- Postgres runs BEFORE
    // ROW triggers ahead of the policy's WITH CHECK. Refused either way.
    expect(await direct(BOB, BOB)).toMatch(/your own name/)
  })

  it('is done from the comment, and files the flag against the author', async () => {
    await as(ALICE, () => db.query("select mo.flag_comment_author($1, 'reported by a reader')", [commentId]))
    const { rows } = await db.query<{ subject_id: string; flagger_id: string }>(
      "select subject_id, flagger_id from mo.flags where subject_type = 'name'",
    )
    expect(rows).toContainEqual({ subject_id: BOB, flagger_id: ALICE })
  })

  it('hands the reporter nothing to read back: flags are unreadable', async () => {
    expect(
      await failure(() => as(ALICE, () => db.query("select subject_id from mo.flags where subject_type = 'name'"))),
    ).toMatch(/permission denied/)
  })

  it('refuses a complaint about your own name', async () => {
    expect(
      await failure(() => as(BOB, () => db.query("select mo.flag_comment_author($1, 'x')", [commentId]))),
    ).toMatch(/your own name/)
  })

  it('withholds the name again when a second person complains', async () => {
    await setName(CAROL, 'Caz') // already Caz and pending; a no-op
    await as(CAROL, () => db.query("select mo.flag_comment_author($1, 'reported by a reader')", [commentId]))
    const { rows } = await db.query<{ moderation_status: string }>(
      'select moderation_status from mo.display_names where user_id = $1',
      [BOB],
    )
    expect(rows[0].moderation_status).toBe('pending')
  })
})

describe('complaining about the name on a report', () => {
  const FRANK = '77777777-7777-4777-8777-777777777777'
  const GRACE = '88888888-8888-4888-8888-888888888888'
  let reportId: string

  beforeAll(async () => {
    await addProfile(db, FRANK, 'frank.black')
    await addProfile(db, GRACE, 'grace.hall')
    await setName(FRANK, 'Frank')
    await workerDecidesName(FRANK, 'approved')
    await setName(GRACE, 'Grace')
    reportId = await addReport(FRANK)
  })

  const complain = (flagger: string, report: string) =>
    as(flagger, () => db.query("select mo.flag_report_author($1, 'reported by a reader')", [report]))

  it('files the flag against whoever filed the report, and hands back nothing', async () => {
    const { rows } = await complain(GRACE, reportId)
    expect(rows).toEqual([{ flag_report_author: '' }])
    const { rows: flags } = await db.query<{ subject_id: string; flagger_id: string }>(
      "select subject_id, flagger_id from mo.flags where subject_type = 'name' and subject_id = $1",
      [FRANK],
    )
    expect(flags).toEqual([{ subject_id: FRANK, flagger_id: GRACE }])
  })

  it('refuses a complaint about your own name', async () => {
    expect(await failure(() => complain(FRANK, reportId))).toMatch(/your own name/)
  })

  it('refuses a name nobody else can see yet', async () => {
    // Grace's name is still pending, so no reader has seen it to object to.
    const graceReport = await addReport(GRACE)
    expect(await failure(() => complain(ALICE, graceReport))).toMatch(/no such name/)
  })

  it('is not open to signed-out visitors', async () => {
    expect(
      await failure(() =>
        as(null, () => db.query("select mo.flag_report_author($1, 'x')", [reportId])),
      ),
    ).toMatch(/permission denied/)
  })

  it('withholds the name when a second person complains', async () => {
    await complain(ALICE, reportId)
    const { rows } = await db.query<{ moderation_status: string }>(
      'select moderation_status from mo.display_names where user_id = $1',
      [FRANK],
    )
    expect(rows[0].moderation_status).toBe('pending')
  })
})

describe('invisible names, in the real database', () => {
  it.each([
    ['Hangul filler', 0x3164],
    ['braille blank', 0x2800],
    ['zero-width space', 0x200b],
    ['a tag character', 0xe0041],
  ])('refuses a name made of the %s, in the function and in the table', async (_label, codePoint) => {
    const blank = String.fromCodePoint(codePoint)
    expect(await failure(() => setName(CAROL, blank + blank + blank))).toMatch(/2 visible characters/)
    // And the CHECK holds even for a write that skips the function.
    expect(
      await failure(() =>
        db.query("update mo.display_names set name = $1 where user_id = $2", [blank + blank + blank, CAROL]),
      ),
    ).toMatch(/display_names_name_check/)
  })

  it('counts an ordinary name in full', async () => {
    const { rows } = await db.query<{ n: number }>("select mo.visible_length('Sam J') as n")
    expect(rows[0].n).toBe(4)
  })
})
