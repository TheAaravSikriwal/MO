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

describe('rate limits hold against a request carrying many rows', () => {
  // PostgREST posts a JSON array as ONE statement. These tests were written to
  // prove the old per-row report and comment triggers let such a request
  // through -- and they passed against them. A row-level BEFORE trigger sees
  // the rows its own statement has already inserted, so there never was a
  // single-request bypass. They stay, to keep it that way.
  //
  // What they cannot show is the case the advisory locks exist for: two
  // requests at the same moment. PGlite has one connection.
  const HANK = '99999999-9999-4999-8999-999999999999'
  const IVY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const JO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  beforeAll(async () => {
    for (const [id, prefix, name] of [
      [HANK, 'hank.h', 'Hank'],
      [IVY, 'ivy.i', 'Ivy'],
      [JO, 'jo.j', 'Jo'],
    ] as const) {
      await addProfile(db, id, prefix)
      await setName(id, name)
    }
  })

  /** Many report rows in one INSERT, the way one PostgREST request sends them. */
  const reportsInOneStatement = (userId: string, count: number) =>
    as(userId, () => {
      const rows = Array.from(
        { length: count },
        (_, i) => `($1, ${51 + i / 1000}, -0.12, $2, $2, $2, $2, $2, $2, null)`,
      ).join(', ')
      return db.query(
        `insert into mo.reports
           (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7, cell_r9, cell_r12, note)
         values ${rows}`,
        [userId, CELL],
      )
    })

  const reportCount = async (userId: string) =>
    (await db.query<{ n: number }>('select count(*)::int as n from mo.reports where reporter_id = $1', [userId]))
      .rows[0].n

  it('refuses eleven reports sent as one request, and keeps none of them', async () => {
    expect(await failure(() => reportsInOneStatement(HANK, 11))).toMatch(/too many reports in the last hour/)
    expect(await reportCount(HANK)).toBe(0)
  })

  it('takes ten in one request, which is the limit, and then refuses the next', async () => {
    await reportsInOneStatement(IVY, 10)
    expect(await reportCount(IVY)).toBe(10)
    expect(await failure(() => addReport(IVY))).toMatch(/too many reports in the last hour/)
  })

  it('refuses six comments sent as one request', async () => {
    const reportId = await addReport(JO)
    const sent = await failure(() =>
      as(JO, () => {
        const rows = Array.from({ length: 6 }, (_, i) => `($1, $2, 'comment ${i}')`).join(', ')
        return db.query(`insert into mo.comments (report_id, author_id, body) values ${rows}`, [reportId, JO])
      }),
    )
    expect(sent).toMatch(/too many comments in the last minute/)
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from mo.comments where author_id = $1', [JO])
    expect(rows[0].n).toBe(0)
  })
})

describe('rate limits cannot be reset by deleting your own posts', () => {
  const KIM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const LEO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  beforeAll(async () => {
    await addProfile(db, KIM, 'kim.k')
    await addProfile(db, LEO, 'leo.l')
    await setName(KIM, 'Kim')
    await setName(LEO, 'Leo')
  })

  it('still refuses the eleventh report after the first ten are deleted', async () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i += 1) ids.push(await addReport(KIM))
    // By id, the way the app deletes a report: browsers may read `id` and
    // nothing else on the table.
    for (const id of ids) await as(KIM, () => db.query('delete from mo.reports where id = $1', [id]))
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from mo.reports where reporter_id = $1', [KIM])
    expect(rows[0].n).toBe(0)
    expect(await failure(() => addReport(KIM))).toMatch(/too many reports in the last hour/)
  })

  it('still refuses the sixth comment after the first five are deleted', async () => {
    const reportId = await addReport(LEO)
    for (let i = 0; i < 5; i += 1) await addComment(LEO, reportId, `comment ${i}`)
    // A bare DELETE, as an unfiltered PostgREST request sends it. It needs no
    // select privilege, and the delete policy narrows it to your own rows.
    await as(LEO, () => db.query('delete from mo.comments'))
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from mo.comments where author_id = $1', [LEO])
    expect(rows[0].n).toBe(0)
    expect(await failure(() => addComment(LEO, reportId, 'one more'))).toMatch(
      /too many comments in the last minute/,
    )
  })

  it('keeps the record out of reach of the person it limits', async () => {
    expect(await failure(() => as(KIM, () => db.query('select * from mo.post_log')))).toMatch(/permission denied/)
    expect(await failure(() => as(KIM, () => db.query('delete from mo.post_log')))).toMatch(/permission denied/)
  })
})

describe('the flag limit cannot be reset by deleting what you flagged', () => {
  const MIA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const NED = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

  it('still refuses the twenty-first flag after the flagged comments are deleted', async () => {
    await addProfile(db, MIA, 'mia.m')
    await addProfile(db, NED, 'ned.n')
    await setName(MIA, 'Mia')
    await setName(NED, 'Ned')
    const reportId = await addReport(NED)

    // Setup, as the table owner: twenty-one of Ned's comments, with the comment
    // limit switched off so the setup is not what is tested. Mia cannot flag
    // her own posts any more, so she flags his.
    await db.exec('alter table mo.comments disable trigger enforce_comment_rate_limit')
    const his: string[] = []
    for (let i = 0; i < 21; i += 1) {
      const { rows } = await db.query<{ id: string }>(
        'insert into mo.comments (report_id, author_id, body) values ($1, $2, $3) returning id',
        [reportId, NED, `his ${i}`],
      )
      his.push(rows[0].id)
    }
    await db.exec('alter table mo.comments enable trigger enforce_comment_rate_limit')

    const flag = (subject: string) =>
      as(MIA, () =>
        db.query(
          "insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('comment', $1, $2, 'x')",
          [subject, MIA],
        ),
      )
    for (const id of his.slice(0, 20)) await flag(id)

    // Ned deletes the twenty she flagged, and the flags on them go too. Her
    // count must not go with them.
    await db.query('delete from mo.comments where id = any($1)', [his.slice(0, 20)])
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from mo.flags where flagger_id = $1', [MIA])
    expect(rows[0].n).toBe(0)

    expect(await failure(() => flag(his[20]))).toMatch(/too many reports in the last hour/)
  })

  it('refuses a complaint about your own post', async () => {
    const reportId = await addReport(NED)
    await addComment(NED, reportId, 'mine')
    const { rows } = await db.query<{ id: string }>(
      "select id from mo.comments where report_id = $1 and body = 'mine'",
      [reportId],
    )
    const own = (type: string, subject: string) =>
      failure(() =>
        as(NED, () =>
          db.query('insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ($1, $2, $3, $4)', [
            type,
            subject,
            NED,
            'x',
          ]),
        ),
      )
    expect(await own('comment', rows[0].id)).toMatch(/your own post/)
    await db.query("update mo.reports set note = 'a note', note_status = 'approved' where id = $1", [reportId])
    expect(await own('note', reportId)).toMatch(/your own post/)
  })
})

describe('an admin can take a pin off the map, and put it back', () => {
  const OWEN = '12121212-1212-4212-8212-121212121212'
  const PIA = '13131313-1313-4313-8313-131313131313'
  let pin: string

  beforeAll(async () => {
    await addProfile(db, OWEN, 'owen.o')
    await addProfile(db, PIA, 'pia.p')
    await setName(OWEN, 'Owen')
    await setName(PIA, 'Pia')
    // Somewhere nothing else is, so the rollup below counts only this pin.
    pin = await as(OWEN, async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into mo.reports
           (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7, cell_r9, cell_r12, note)
         values ($1, -33.9, 18.4, $2, $2, $2, $2, $2, $2, null)
         returning id`,
        [OWEN, '8abc00000000fff'],
      )
      return rows[0].id
    })
  })

  const setOnMap = (userId: string, onMap: boolean) =>
    as(userId, () => db.query("select mo.admin_set_report_on_map($1, $2, 'spam')", [pin, onMap]))

  const seenBy = (viewer: string | null) =>
    as(viewer, async () => {
      const { rows } = await db.query<{ moderation_status: string }>(
        'select moderation_status from mo.public_reports where id = $1',
        [pin],
      )
      return rows[0] ?? null
    })

  const weightThere = () =>
    as(null, async () => {
      const { rows } = await db.query<{ weight: string }>(
        'select weight from mo.reports_rollup(-34, 18, -33, 19, 12)',
      )
      return rows.reduce((sum, row) => sum + Number(row.weight), 0)
    })

  it('is refused to anybody who is not an admin', async () => {
    expect(await failure(() => setOnMap(PIA, false))).toMatch(/only an admin/)
    expect(await failure(() => setOnMap(OWEN, false))).toMatch(/only an admin/)
    expect(await failure(() => as(null, () => db.query('select mo.admin_set_report_on_map($1, false)', [pin])))).toMatch(
      /permission denied/,
    )
  })

  it('cannot be done by writing the column directly, even by an admin', async () => {
    expect(
      await failure(() =>
        as(ADMIN, () => db.query("update mo.reports set moderation_status = 'rejected' where id = $1", [pin])),
      ),
    ).toMatch(/permission denied/)
  })

  it('takes the pin off the map for everybody but its reporter, and out of the colours', async () => {
    expect(await weightThere()).toBe(1)
    await setOnMap(ADMIN, false)

    expect(await seenBy(null)).toBeNull()
    expect(await seenBy(PIA)).toBeNull()
    expect(await seenBy(OWEN)).toEqual({ moderation_status: 'rejected' })
    expect(await weightThere()).toBe(0)

    const { rows } = await db.query<{ removed_by: string; removal_reason: string }>(
      'select removed_by, removal_reason from mo.reports where id = $1',
      [pin],
    )
    expect(rows[0]).toEqual({ removed_by: ADMIN, removal_reason: 'spam' })
  })

  it('stops a removed pin being confirmed or marked cleaned', async () => {
    expect(
      await failure(() =>
        as(PIA, () => db.query('insert into mo.votes (report_id, user_id) values ($1, $2)', [pin, PIA])),
      ),
    ).toMatch(/this report is off the map/)
    // Said as it is: not "already cleaned", which the old combined message
    // turned into for a pin that had only been taken off.
    expect(await failure(() => as(PIA, () => db.query('select mo.mark_report_cleaned($1)', [pin])))).toMatch(
      /this report is off the map/,
    )
  })

  it('puts it back as it was, and forgets the removal', async () => {
    await setOnMap(ADMIN, true)
    expect(await seenBy(null)).toEqual({ moderation_status: 'approved' })
    expect(await weightThere()).toBe(1)
    const { rows } = await db.query<Record<string, unknown>>(
      'select removed_by, removed_at, removal_reason from mo.reports where id = $1',
      [pin],
    )
    expect(rows[0]).toEqual({ removed_by: null, removed_at: null, removal_reason: null })
  })

  it('refuses a pin marked off the map with no record of the removal', async () => {
    expect(
      await failure(() => db.query("update mo.reports set moderation_status = 'rejected' where id = $1", [pin])),
    ).toMatch(/pin_removal_recorded/)
  })
})

describe('a pin off the map takes its comments with it, and keeps a record', () => {
  const QUIN = '14141414-1414-4414-8414-141414141414'
  const RAY = '15151515-1515-4515-8515-151515151515'
  const ADMIN2 = '16161616-1616-4616-8616-161616161616'
  let pin: string

  beforeAll(async () => {
    await addProfile(db, QUIN, 'quin.q')
    await addProfile(db, RAY, 'ray.r')
    await addProfile(db, ADMIN2, 'second.admin')
    await db.query('insert into mo.admins (user_id) values ($1)', [ADMIN2])
    await setName(QUIN, 'Quin')
    await setName(RAY, 'Ray')
    pin = await addReport(QUIN)
    await addComment(RAY, pin, 'still here')
    const { rows } = await db.query<{ id: string }>(
      "select j.id from mo.moderation_jobs j join mo.comments c on c.id = j.subject_id where j.subject_type = 'comment' and c.report_id = $1",
      [pin],
    )
    await as(ADMIN, () => db.query("select mo.admin_decide_moderation($1, 'approved')", [rows[0].id]))
  })

  const commentsSeenBy = (viewer: string | null) =>
    as(viewer, async () =>
      (await db.query('select body from mo.public_comments where report_id = $1', [pin])).rows,
    )

  it('hides the pin’s comments from everybody but its reporter and admins', async () => {
    expect(await commentsSeenBy(null)).toEqual([{ body: 'still here' }])
    await as(ADMIN, () => db.query("select mo.admin_set_report_on_map($1, false, 'a joke pin')", [pin]))
    expect(await commentsSeenBy(null)).toEqual([])
    // Not even to the person who wrote the comment: the pin is hidden from him,
    // so he could not open the report to see it anyway.
    expect(await commentsSeenBy(RAY)).toEqual([])
    expect(await commentsSeenBy(QUIN)).toEqual([{ body: 'still here' }])
    expect(await commentsSeenBy(ADMIN)).toEqual([{ body: 'still here' }])
  })

  it('takes no new comments while it is off the map, and says so', async () => {
    // In words. The policy's own refusal could not be told apart from "no name
    // yet", and the app asked for a name the person already had.
    expect(await failure(() => addComment(RAY, pin, 'another'))).toMatch(/this report is off the map/)
  })

  it('refuses the same comment by policy alone, if the trigger is ever lost', async () => {
    await db.exec('alter table mo.comments disable trigger refuse_comment_on_off_map_pin')
    try {
      expect(await failure(() => addComment(RAY, pin, 'another'))).toMatch(
        /row-level security policy for table "comments"/,
      )
    } finally {
      await db.exec('alter table mo.comments enable trigger refuse_comment_on_off_map_pin')
    }
  })

  it('shows the reason to admins only', async () => {
    const reasonFor = (viewer: string | null) =>
      as(viewer, async () =>
        (await db.query<{ removal_reason: string | null }>('select removal_reason from mo.public_reports where id = $1', [pin]))
          .rows[0]?.removal_reason,
      )
    expect(await reasonFor(ADMIN)).toBe('a joke pin')
    expect(await reasonFor(QUIN)).toBeNull()
  })

  it('does not let a second removal overwrite the first', async () => {
    await as(ADMIN2, () => db.query("select mo.admin_set_report_on_map($1, false, 'something else')", [pin]))
    const { rows } = await db.query<{ removed_by: string; removal_reason: string }>(
      'select removed_by, removal_reason from mo.reports where id = $1',
      [pin],
    )
    expect(rows[0]).toEqual({ removed_by: ADMIN, removal_reason: 'a joke pin' })
  })

  it('says whether the pin actually moved', async () => {
    // Already off from the tests above.
    const { rows } = await as(ADMIN, () =>
      db.query<{ moved: boolean }>("select mo.admin_set_report_on_map($1, false) as moved", [pin]),
    )
    expect(rows[0].moved).toBe(false)
  })

  it('tells the review queue whether each item’s pin is on the map', async () => {
    const pinState = async () => {
      const { rows } = await as(ADMIN, () =>
        db.query<{ report_id: string; pin_on_map: boolean | null }>(
          'select report_id, pin_on_map from mo.admin_moderation_queue(200)',
        ),
      )
      return rows.filter((row) => row.report_id === pin).map((row) => row.pin_on_map)
    }
    // Reopen a job on this pin so it is in the queue: a complaint about its
    // approved comment does exactly that.
    const { rows: comments } = await db.query<{ id: string }>('select id from mo.comments where report_id = $1', [pin])
    await as(QUIN, () =>
      db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('comment', $1, $2, 'x')", [
        comments[0].id,
        QUIN,
      ]),
    )
    expect(await pinState()).toEqual([false])
  })

  it('keeps every real change in the history, including putting it back', async () => {
    await as(ADMIN2, () => db.query('select mo.admin_set_report_on_map($1, true)', [pin]))
    await as(ADMIN2, () => db.query('select mo.admin_set_report_on_map($1, true)', [pin])) // no-op
    const { rows } = await db.query<{ action: string; acted_by: string; reason: string | null }>(
      'select action, acted_by, reason from mo.pin_history where report_id = $1 order by acted_at, action desc',
      [pin],
    )
    expect(rows).toEqual([
      { action: 'off', acted_by: ADMIN, reason: 'a joke pin' },
      { action: 'on', acted_by: ADMIN2, reason: null },
    ])
    expect(await commentsSeenBy(null)).toEqual([{ body: 'still here' }])
  })

  it('keeps the history after the reporter deletes the report', async () => {
    await as(ADMIN, () => db.query("select mo.admin_set_report_on_map($1, false, 'again')", [pin]))
    await as(QUIN, () => db.query('delete from mo.reports where id = $1', [pin]))
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from mo.pin_history where report_id = $1', [pin])
    expect(rows[0].n).toBe(3)
  })

  it('keeps the history out of reach of browsers', async () => {
    expect(await failure(() => as(ADMIN, () => db.query('select * from mo.pin_history')))).toMatch(/permission denied/)
  })
})
