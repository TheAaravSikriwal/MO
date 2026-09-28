// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { addProfile, asRole, failure, freshDatabase } from './pgHarness'

/**
 * Cleaning groups (0007), run against a real Postgres as the roles that will
 * call them. See migrations.run.test.ts for what the harness does and does not
 * stand in for.
 */

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const CAROL = '44444444-4444-4444-8444-444444444444'
const NONAME = '55555555-5555-4555-8555-555555555555'

let db: PGlite

beforeAll(async () => {
  db = await freshDatabase()
  for (const [id, prefix] of [
    [ALICE, 'alice'],
    [BOB, 'bob'],
    [ADMIN, 'admin'],
    [CAROL, 'carol'],
    [NONAME, 'noname'],
  ]) {
    await addProfile(db, id, prefix)
  }
  await db.query('insert into mo.admins (user_id) values ($1)', [ADMIN])
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
    [ADMIN, 'Admin'],
    [CAROL, 'Carol'],
  ]) {
    await asRole(db, 'authenticated', id, () => db.query('select mo.set_display_name($1)', [name]))
  }
}, 120_000)

const as = <T>(userId: string | null, work: () => Promise<T>) =>
  asRole(db, userId ? 'authenticated' : 'anon', userId, work)

const worker = <T>(work: () => Promise<T>) => asRole(db, 'service_role', null, work)

/** Each group starts afresh on its founder's daily allowance. */
const clearLog = () => db.query("delete from mo.post_log where kind = 'group'")

const start = (userId: string | null, name = 'Riverside Litter Pickers', lat = 51.5, lng = -0.12) =>
  as(userId, async () => {
    const { rows } = await db.query<{ id: string }>(
      'select mo.create_cleaning_group($1, $2, $3, $4) as id',
      [name, 'We meet on Saturday mornings by the bridge.', lat, lng],
    )
    return rows[0].id
  })

interface Listed {
  id: string
  name: string
  moderation_status: string
  member_count: string
  viewer_is_member: boolean
  viewer_is_founder: boolean
}

const inView = (userId: string | null, box = [51, -1, 52, 1]) =>
  as(userId, async () => {
    const { rows } = await db.query<Listed>(
      'select * from mo.cleaning_groups_in_view($1, $2, $3, $4)',
      box,
    )
    return rows
  })

const find = async (userId: string | null, id: string) =>
  (await inView(userId)).find((group) => group.id === id)

/** Settle a group the way the worker does: claim its job, then record a verdict. */
const workerDecides = async (groupId: string, verdict: 'approved' | 'rejected') => {
  const { rows: jobs } = await db.query<{ id: string }>(
    "select id from mo.moderation_jobs where subject_type = 'group' and subject_id = $1",
    [groupId],
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

const join = (userId: string | null, id: string) =>
  as(userId, () => db.query('select mo.join_cleaning_group($1)', [id]))

describe('cleaning groups — starting one', () => {
  it('needs a signed-in person who has chosen a name', async () => {
    await clearLog()
    expect(await failure(() => start(null))).toMatch(/permission denied|sign in/)
    expect(await failure(() => start(NONAME))).toMatch(/choose a name before you post/)
  })

  it('refuses a name too short, too long or made of nothing visible', async () => {
    await clearLog()
    expect(await failure(() => start(ALICE, 'ab'))).toMatch(/at least 3 letters/)
    expect(await failure(() => start(ALICE, 'x'.repeat(61)))).toMatch(/at most 60/)
    expect(await failure(() => start(ALICE, '​​​​'))).toMatch(/at least 3 letters/)
    // Its own message, not the table's constraint name, which reads as nothing.
    expect(await failure(() => start(ALICE, 'Tab\tGroup'))).toMatch(/a group name cannot contain tabs or line breaks/)
  })

  it('says a tab in the description is a tab, and keeps line breaks', async () => {
    await clearLog()
    const withAbout = (about: string) =>
      as(ALICE, () =>
        db.query('select mo.create_cleaning_group($1, $2, $3, $4)', ['Tab Test Group', about, 51.5, -0.12]),
      )
    expect(await failure(() => withAbout('Bring\tgloves'))).toMatch(/a group description cannot contain tabs/)
    expect(await failure(() => withAbout('Saturdays.\nBring gloves.'))).toBeNull()
  })

  it('refuses somewhere that is not on the map', async () => {
    await clearLog()
    expect(await failure(() => start(ALICE, 'Nowhere Group', 95, 0))).toMatch(/not a place on the map/)
    expect(await failure(() => start(ALICE, 'Nowhere Group', 0, 181))).toMatch(/not a place on the map/)
  })

  it('waits for review, seen only by its founder, who is its first member', async () => {
    await clearLog()
    const id = await start(ALICE)
    const mine = await find(ALICE, id)
    expect(mine).toMatchObject({ moderation_status: 'pending', viewer_is_founder: true, viewer_is_member: true })
    expect(Number(mine!.member_count)).toBe(1)
    expect(await find(BOB, id)).toBeUndefined()
    expect(await find(null, id)).toBeUndefined()
    // Bob cannot join what he cannot see.
    expect(await failure(() => join(BOB, id))).toMatch(/no such group/)
  })

  it('appears to everybody once approved, and never shows who is in it', async () => {
    await clearLog()
    const id = await start(ALICE)
    await workerDecides(id, 'approved')
    const seen = await find(null, id)
    expect(seen).toMatchObject({ moderation_status: 'approved', viewer_is_member: false, viewer_is_founder: false })
    expect(Object.keys(seen!)).not.toContain('created_by')
  })

  it('stays hidden from everybody else once rejected', async () => {
    await clearLog()
    const id = await start(ALICE, 'Rejected Group')
    await workerDecides(id, 'rejected')
    expect(await find(BOB, id)).toBeUndefined()
    expect((await find(ALICE, id))?.moderation_status).toBe('rejected')
  })

  it('allows three a day, and deleting one does not give the slot back', async () => {
    await clearLog()
    const ids = [await start(CAROL, 'One Group'), await start(CAROL, 'Two Group'), await start(CAROL, 'Three Group')]
    expect(await failure(() => start(CAROL, 'Four Group'))).toMatch(/too many groups started today/)
    await as(CAROL, () => db.query('select mo.delete_cleaning_group($1)', [ids[0]]))
    expect(await failure(() => start(CAROL, 'Four Group'))).toMatch(/too many groups started today/)
  })
})

describe('cleaning groups — joining and leaving', () => {
  it('counts people in and out, once each', async () => {
    await clearLog()
    const id = await start(ALICE, 'Park Tidy-Up')
    await workerDecides(id, 'approved')

    await join(BOB, id)
    await join(BOB, id)
    expect(Number((await find(BOB, id))!.member_count)).toBe(2)
    expect((await find(BOB, id))!.viewer_is_member).toBe(true)

    await as(BOB, () => db.query('select mo.leave_cleaning_group($1)', [id]))
    expect(Number((await find(BOB, id))!.member_count)).toBe(1)
    expect((await find(BOB, id))!.viewer_is_member).toBe(false)
  })

  it('refuses anybody signed out', async () => {
    await clearLog()
    const id = await start(ALICE, 'Signed Out Test')
    await workerDecides(id, 'approved')
    expect(await failure(() => join(null, id))).toMatch(/permission denied|sign in/)
  })

  it('gives no way to read the member list or the tables directly', async () => {
    for (const table of ['mo.group_members', 'mo.cleaning_groups']) {
      expect(await failure(() => as(BOB, () => db.query(`select * from ${table}`)))).toMatch(/permission denied/)
      expect(await failure(() => as(null, () => db.query(`select * from ${table}`)))).toMatch(/permission denied/)
    }
    expect(
      await failure(() =>
        as(BOB, () =>
          db.query("insert into mo.cleaning_groups (name, home_lat, home_lng) values ('Sneaky', 0, 0)"),
        ),
      ),
    ).toMatch(/permission denied/)
  })
})

describe('cleaning groups — where they are', () => {
  it('finds a group in a view that crosses the 180th meridian', async () => {
    await clearLog()
    const id = await start(ALICE, 'Dateline Group', -17.7, 179.9)
    await workerDecides(id, 'approved')
    const found = await as(null, async () => {
      const { rows } = await db.query<Listed>(
        'select * from mo.cleaning_groups_in_view($1, $2, $3, $4)',
        [-20, 170, -15, -170],
      )
      return rows
    })
    expect(found.map((group) => group.id)).toContain(id)
  })
})

describe('cleaning groups — a busy area', () => {
  it('gives one more than a page, and the viewer’s own group first, however small', async () => {
    await clearLog()
    // 205 approved groups in one small box, each with more people than a new one.
    await db.query(
      `insert into mo.cleaning_groups (name, home_lat, home_lng, moderation_status)
       select 'Busy Group ' || n, 10 + n * 0.0001, 10, 'approved' from generate_series(1, 205) n`,
    )
    await db.query(
      `insert into mo.group_members (group_id, user_id)
       select g.id, p.id from mo.cleaning_groups g cross join (values ($1::uuid), ($2::uuid)) p(id)
        where g.name like 'Busy Group %'`,
      [BOB, CAROL],
    )
    const mine = await start(ALICE, 'Tiny New Group', 10.001, 10)
    const listed = await as(ALICE, async () => {
      const { rows } = await db.query<Listed>('select * from mo.cleaning_groups_in_view($1, $2, $3, $4)', [9.9, 9.9, 10.1, 10.1])
      return rows
    })
    expect(listed).toHaveLength(201)
    expect(listed[0].id).toBe(mine)
  })
})

describe('cleaning groups — deleting and complaints', () => {
  it('lets only the founder or an admin delete one, and takes its review job with it', async () => {
    await clearLog()
    const id = await start(ALICE, 'Delete Me')
    expect(
      await failure(() => as(BOB, () => db.query('select mo.delete_cleaning_group($1)', [id]))),
    ).toMatch(/only the person who started a group/)
    await as(ADMIN, () => db.query('select mo.delete_cleaning_group($1)', [id]))
    const { rows } = await db.query("select 1 from mo.moderation_jobs where subject_type = 'group' and subject_id = $1", [id])
    expect(rows).toHaveLength(0)
  })

  it('takes a complaint about an approved group, but not about your own', async () => {
    await clearLog()
    const id = await start(ALICE, 'Complained About')
    await workerDecides(id, 'approved')
    const complain = (userId: string) =>
      as(userId, () =>
        db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('group', $1, $2, 'rude')", [
          id,
          userId,
        ]),
      )
    expect(await failure(() => complain(ALICE))).toMatch(/you cannot report your own group/)
    // One complaint alone changes nothing, as for every other kind of post.
    await complain(BOB)
    expect(await find(CAROL, id)).toBeDefined()
    // A second takes it off the map until a person looks at it.
    await complain(CAROL)
    expect(await find(BOB, id)).toBeUndefined()
  })

  it('still shows a group taken down to the people in it, so they can leave', async () => {
    await clearLog()
    const id = await start(ALICE, 'Taken Down Group')
    await workerDecides(id, 'approved')
    await join(NONAME, id)
    for (const complainer of [BOB, CAROL]) {
      await as(complainer, () =>
        db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('group', $1, $2, 'rude')", [
          id,
          complainer,
        ]),
      )
    }
    // Hidden from everybody else...
    expect(await find(BOB, id)).toBeUndefined()
    // ...but not from a member, who can see why and leave.
    const seen = await find(NONAME, id)
    expect(seen).toMatchObject({ moderation_status: 'pending', viewer_is_member: true, viewer_is_founder: false })
    await as(NONAME, () => db.query('select mo.leave_cleaning_group($1)', [id]))
    expect(await find(NONAME, id)).toBeUndefined()
  })

  it('shows the name and description together to an admin reviewing it', async () => {
    await clearLog()
    const id = await start(ALICE, 'Needs A Person')
    const { rows: jobs } = await db.query<{ id: string }>(
      "select id from mo.moderation_jobs where subject_type = 'group' and subject_id = $1",
      [id],
    )
    await worker(async () => {
      await db.query('select * from mo.claim_moderation_jobs($1, 100)', ['test-worker'])
      await db.query('select mo.escalate_moderation_job($1)', [jobs[0].id])
    })
    const queue = await as(ADMIN, async () => {
      const { rows } = await db.query<{ subject_id: string; content_text: string; report_id: string | null }>(
        'select * from mo.admin_moderation_queue(200)',
      )
      return rows
    })
    const item = queue.find((row) => row.subject_id === id)
    expect(item?.content_text).toBe('Needs A Person\n\nWe meet on Saturday mornings by the bridge.')
    expect(item?.report_id).toBeNull()

    await as(ADMIN, () => db.query("select mo.admin_decide_moderation($1, 'approved')", [jobs[0].id]))
    expect((await find(BOB, id))?.moderation_status).toBe('approved')
  })
})
