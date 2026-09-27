// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { addProfile, asRole, failure, freshDatabase } from './pgHarness'

/**
 * Which R2 objects the worker is told to delete, in a real Postgres.
 *
 * Every case the cleanup must claim, and every case it must leave alone -- a
 * photo still being judged, an approved one, one on a pin that is off the map
 * and may be put back, and an upload that may still be on its way.
 */

const OWNER = '31313131-3131-4131-8131-313131313131'
const ADMIN = '32323232-3232-4232-8232-323232323232'
const CELL = '8a1fb46622dffff'

let db: PGlite
let report: string
let offMapReport: string

const as = <T>(userId: string | null, work: () => Promise<T>) =>
  asRole(db, userId ? 'authenticated' : 'anon', userId, work)
const worker = <T>(work: () => Promise<T>) => asRole(db, 'service_role', null, work)

const key = (reportId: string, n: number) =>
  `${OWNER}/${reportId}/${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000.jpg`

// This file files more reports than the hourly limit allows one person, and
// the limit is not what it tests, so each report starts from a clear record.
const addReport = async () => {
  await db.query('delete from mo.post_log where user_id = $1', [OWNER])
  return addReportAsOwner()
}

const addReportAsOwner = () =>
  as(OWNER, async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into mo.reports (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7, cell_r9, cell_r12)
       values ($1, 51.5, -0.12, $2, $2, $2, $2, $2, $2) returning id`,
      [OWNER, CELL],
    )
    return rows[0].id
  })

const grant = (reportId: string, path: string) =>
  as(OWNER, () =>
    db.query('insert into mo.upload_grants (user_id, report_id, storage_path) values ($1, $2, $3)', [
      OWNER,
      reportId,
      path,
    ]),
  )

const photo = (reportId: string, path: string) =>
  as(OWNER, () => db.query('insert into mo.report_photos (report_id, storage_path) values ($1, $2)', [reportId, path]))

const decidePhoto = async (path: string, verdict: 'approved' | 'rejected') => {
  const { rows } = await db.query<{ id: string }>(
    "select j.id from mo.moderation_jobs j join mo.report_photos p on p.id = j.subject_id where j.subject_type = 'photo' and p.storage_path = $1",
    [path],
  )
  await as(ADMIN, () => db.query('select mo.admin_decide_moderation($1, $2::mo.moderation_status)', [rows[0].id, verdict]))
}

/** Move a photo's first rejection back in time, past (or short of) the thirty-day hold. */
const ageRejection = (path: string, interval: string) =>
  db.query(`update mo.report_photos set rejected_at = now() - interval '${interval}' where storage_path = $1`, [path])

const age = (path: string, interval: string) =>
  db.query(`update mo.upload_grants set created_at = now() - interval '${interval}' where storage_path = $1`, [path])

const claim = () =>
  worker(async () =>
    (await db.query<{ storage_path: string; reason: string }>('select * from mo.claim_objects_to_delete(100)')).rows,
  )

const paths = {
  oldUnused: '',
  freshUnused: '',
  pending: '',
  approved: '',
  rejected: '',
  photoDeleted: '',
  offMapPin: '',
}

beforeAll(async () => {
  db = await freshDatabase()
  await addProfile(db, OWNER, 'owner.o')
  await addProfile(db, ADMIN, 'admin.a')
  await db.query('insert into mo.admins (user_id) values ($1)', [ADMIN])
  await as(OWNER, () => db.query("select mo.set_display_name('Owner')"))
  report = await addReport()
  offMapReport = await addReport()

  paths.oldUnused = key(report, 1)
  paths.freshUnused = key(report, 2)
  paths.pending = key(report, 3)
  paths.approved = key(report, 4)
  paths.rejected = key(report, 5)
  paths.photoDeleted = key(report, 6)
  paths.offMapPin = key(offMapReport, 7)

  for (const path of [paths.oldUnused, paths.freshUnused, paths.pending, paths.approved, paths.rejected, paths.photoDeleted]) {
    await grant(report, path)
  }
  await grant(offMapReport, paths.offMapPin)

  // A photo row per linked case. The photo limit is three per report, so the
  // linked ones go on in two batches around the deletion.
  await photo(report, paths.pending)
  await photo(report, paths.approved)
  await photo(report, paths.rejected)
  await decidePhoto(paths.approved, 'approved')
  await decidePhoto(paths.rejected, 'rejected')
  await photo(offMapReport, paths.offMapPin)
  await decidePhoto(paths.offMapPin, 'approved')
  await as(ADMIN, () => db.query('select mo.admin_set_report_on_map($1, false)', [offMapReport]))

  // Photos linked and then removed -- by the reporter deleting them, or with
  // their report. How the row goes does not matter here, only that it is gone,
  // so it is removed as the table owner.
  await db.query('delete from mo.report_photos where storage_path = $1', [paths.pending])
  await photo(report, paths.photoDeleted)
  await db.query('delete from mo.report_photos where storage_path = $1', [paths.photoDeleted])
  // Put the pending one's place back with a fresh pending photo on its own grant.
  paths.pending = key(report, 8)
  await grant(report, paths.pending)
  await photo(report, paths.pending)

  await age(paths.oldUnused, '2 hours')
  await ageRejection(paths.rejected, '31 days')
}, 120_000)

describe('which objects the worker is told to delete', () => {
  it('claims exactly the unused, the orphaned and the rejected', async () => {
    const claimed = await claim()
    const byPath = new Map(claimed.map((row) => [row.storage_path, row.reason]))
    expect(byPath.get(paths.oldUnused)).toBe('unused')
    expect(byPath.get(paths.photoDeleted)).toBe('unused')
    expect(byPath.get(paths.rejected)).toBe('rejected')
    // The first "pending" grant was linked and its photo deleted too.
    expect(byPath.get(key(report, 3))).toBe('unused')
    expect(byPath.size).toBe(4)
  })

  it('leaves alone an upload still on its way, a photo being judged, an approved one, and a pin off the map', async () => {
    // Everything that could be claimed was claimed above; these never are.
    const { rows } = await db.query<{ storage_path: string; retired_at: unknown }>(
      'select storage_path, retired_at from mo.upload_grants where storage_path = any($1)',
      [[paths.freshUnused, paths.pending, paths.approved, paths.offMapPin]],
    )
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.retired_at === null)).toBe(true)
  })

  it('does not hand the same object out twice while it is being deleted', async () => {
    expect(await claim()).toEqual([])
  })

  it('never lets a retired object be linked again', async () => {
    // The old unused grant was retired above; its bytes are gone or going.
    expect(await failure(() => photo(report, paths.oldUnused))).toMatch(/could not be added/)
  })

  it('records a deletion once', async () => {
    const record = (path: string) =>
      worker(async () =>
        (await db.query<{ done: boolean | null }>('select mo.record_object_deleted($1) as done', [path])).rows[0].done,
      )
    expect(await record(paths.oldUnused)).toBe(true)
    expect(await record(paths.oldUnused)).toBeNull()
    // Nothing that was not retired can be marked deleted.
    expect(await record(paths.approved)).toBeNull()
  })

  it('offers a failed deletion again after ten minutes', async () => {
    // The rejected one was claimed but never recorded as deleted.
    await db.query("update mo.upload_grants set retired_at = now() - interval '11 minutes' where storage_path = $1", [
      paths.rejected,
    ])
    const again = await claim()
    expect(again.map((row) => row.storage_path)).toEqual([paths.rejected])
  })

  it('holds a rejected photo for thirty days before deleting it', async () => {
    const held = await addReport()
    const path = key(held, 12)
    await grant(held, path)
    await photo(held, path)
    await decidePhoto(path, 'rejected')
    await ageRejection(path, '29 days')
    expect((await claim()).map((row) => row.storage_path)).not.toContain(path)
    await ageRejection(path, '31 days')
    expect(await claim()).toContainEqual({ storage_path: path, reason: 'rejected' })
  })

  it('does not delete a rejected photo that a complaint has put back in front of an admin', async () => {
    // A fresh report, so the photo limit leaves room.
    const second = await addReport()
    const path = key(second, 9)
    await grant(second, path)
    await photo(second, path)
    await decidePhoto(path, 'rejected')
    await ageRejection(path, '31 days')
    // Somebody objects to the decision before the cleanup gets to it.
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [path])
    await as(ADMIN, () =>
      db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('photo', $1, $2, 'x')", [
        rows[0].id,
        ADMIN,
      ]),
    )
    const claimed = await claim()
    expect(claimed.map((row) => row.storage_path)).not.toContain(path)
  })

  it('takes no complaint about a photo whose bytes are retired', async () => {
    // The rejected photo from the first test was claimed, so its grant is retired.
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [
      paths.rejected,
    ])
    expect(
      await failure(() =>
        as(ADMIN, () =>
          db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('photo', $1, $2, 'x')", [
            rows[0].id,
            ADMIN,
          ]),
        ),
      ),
    ).toMatch(/no such photo/)
  })

  it('refuses to link a grant nearly old enough to be cleaned up', async () => {
    const third = await addReport()
    const path = key(third, 10)
    await grant(third, path)
    await age(path, '55 minutes')
    expect(await failure(() => photo(third, path))).toMatch(/could not be added/)
  })

  it('refuses a rejected photo with an open complaint even while its verdict still says rejected', async () => {
    // A complaint normally clears the verdict as well, so this state is set up
    // directly: it is the case the complaint clause guards on its own, should
    // that ever stop being true.
    const fourth = await addReport()
    const path = key(fourth, 11)
    await grant(fourth, path)
    await photo(fourth, path)
    await decidePhoto(path, 'rejected')
    await ageRejection(path, '31 days')
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [path])
    await db.exec('alter table mo.flags disable trigger flag_reopens_review')
    try {
      await db.query(
        "insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('photo', $1, $2, 'x')",
        [rows[0].id, ADMIN],
      )
    } finally {
      await db.exec('alter table mo.flags enable trigger flag_reopens_review')
    }
    const { rows: job } = await db.query<{ verdict: string }>(
      "select verdict from mo.moderation_jobs where subject_type = 'photo' and subject_id = $1",
      [rows[0].id],
    )
    expect(job[0].verdict).toBe('rejected')
    expect((await claim()).map((row) => row.storage_path)).not.toContain(path)
  })

  it('still finds an object after its owner’s account is deleted', async () => {
    const GONE = '33333333-aaaa-4aaa-8aaa-333333333333'
    await addProfile(db, GONE, 'gone.g')
    await asRole(db, 'authenticated', GONE, () => db.query("select mo.set_display_name('Gone')"))
    const theirs = await asRole(db, 'authenticated', GONE, async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into mo.reports (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7, cell_r9, cell_r12)
         values ($1, 51.5, -0.12, $2, $2, $2, $2, $2, $2) returning id`,
        [GONE, CELL],
      )
      return rows[0].id
    })
    const path = `${GONE}/${theirs}/0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c.jpg`
    await asRole(db, 'authenticated', GONE, async () => {
      await db.query('insert into mo.upload_grants (user_id, report_id, storage_path) values ($1, $2, $3)', [
        GONE,
        theirs,
        path,
      ])
      await db.query('insert into mo.report_photos (report_id, storage_path) values ($1, $2)', [theirs, path])
    })
    // The marketplace deletes the account; the report and photo cascade away.
    await db.query('delete from public.profiles where id = $1', [GONE])
    const claimed = await claim()
    expect(claimed).toContainEqual({ storage_path: path, reason: 'unused' })
  })

  it('lists recent rejections for admins, saying who or what rejected each', async () => {
    // An automatic rejection, recorded the way the worker records one.
    const seventh = await addReport()
    const path = key(seventh, 15)
    await grant(seventh, path)
    await photo(seventh, path)
    const { rows: job } = await db.query<{ id: string }>(
      "select j.id from mo.moderation_jobs j join mo.report_photos p on p.id = j.subject_id where j.subject_type = 'photo' and p.storage_path = $1",
      [path],
    )
    await worker(async () => {
      await db.query("select * from mo.claim_moderation_jobs('test-worker', 100)")
      await db.query("select mo.record_moderation_verdict($1, 'rejected', 'tier2:nsfw')", [job[0].id])
    })

    const recent = await as(ADMIN, async () =>
      (
        await db.query<{ storage_path: string; decided_by: string }>(
          'select storage_path, decided_by from mo.admin_recent_rejected_photos(200)',
        )
      ).rows,
    )
    expect(recent).toContainEqual({ storage_path: path, decided_by: 'tier2:nsfw' })
    // One the cleanup has retired is past saving, so it is not offered.
    expect(recent.map((row) => row.storage_path)).not.toContain(paths.rejected)
    expect(await failure(() => as(OWNER, () => db.query('select * from mo.admin_recent_rejected_photos(10)')))).toMatch(
      /only an admin/,
    )
  })

  it('lets an admin allow a rejected photo after all, which keeps its bytes', async () => {
    const fifth = await addReport()
    const path = key(fifth, 13)
    await grant(fifth, path)
    await photo(fifth, path)
    await decidePhoto(path, 'rejected')
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [path])

    expect(await failure(() => as(OWNER, () => db.query('select mo.admin_allow_rejected_photo($1)', [rows[0].id])))).toMatch(
      /only an admin/,
    )
    await as(ADMIN, () => db.query('select mo.admin_allow_rejected_photo($1)', [rows[0].id]))

    const { rows: after } = await db.query<{ moderation_status: string }>(
      'select moderation_status from mo.report_photos where id = $1',
      [rows[0].id],
    )
    expect(after[0].moderation_status).toBe('approved')
    await ageRejection(path, '31 days')
    expect((await claim()).map((row) => row.storage_path)).not.toContain(path)
  })

  it('cannot allow a photo whose bytes the cleanup has already retired', async () => {
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [
      paths.rejected,
    ])
    expect(await failure(() => as(ADMIN, () => db.query('select mo.admin_allow_rejected_photo($1)', [rows[0].id])))).toMatch(
      /no such photo/,
    )
  })

  it('refuses the uploader’s complaint about their own photo', async () => {
    const sixth = await addReport()
    const path = key(sixth, 14)
    await grant(sixth, path)
    await photo(sixth, path)
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [path])
    expect(
      await failure(() =>
        as(OWNER, () =>
          db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('photo', $1, $2, 'x')", [
            rows[0].id,
            OWNER,
          ]),
        ),
      ),
    ).toMatch(/your own post/)
  })

  it('does not restart the hold when a complaint reopens a photo and it is rejected again', async () => {
    const eighth = await addReport()
    const path = key(eighth, 16)
    await grant(eighth, path)
    await photo(eighth, path)
    await decidePhoto(path, 'rejected')
    await ageRejection(path, '31 days')
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [path])

    // Somebody -- any account -- complains, and an admin rejects it again.
    const OTHER = '34343434-3434-4434-8434-343434343434'
    await addProfile(db, OTHER, 'other.o')
    await asRole(db, 'authenticated', OTHER, () =>
      db.query("insert into mo.flags (subject_type, subject_id, flagger_id, reason) values ('photo', $1, $2, 'x')", [
        rows[0].id,
        OTHER,
      ]),
    )
    expect((await claim()).map((row) => row.storage_path)).not.toContain(path) // held while open
    await decidePhoto(path, 'rejected')

    // The clock ran from the first rejection, so it is due now, not in 30 days.
    expect(await claim()).toContainEqual({ storage_path: path, reason: 'rejected' })
  })

  it('starts a new hold for a photo rejected again after being allowed', async () => {
    const ninth = await addReport()
    const path = key(ninth, 17)
    await grant(ninth, path)
    await photo(ninth, path)
    await decidePhoto(path, 'rejected')
    await ageRejection(path, '40 days')
    const { rows } = await db.query<{ id: string }>('select id from mo.report_photos where storage_path = $1', [path])
    // Allowed after all, well into its hold: rejected_at is cleared...
    await db.query("update mo.upload_grants set retired_at = null where storage_path = $1", [path])
    await as(ADMIN, () => db.query('select mo.admin_allow_rejected_photo($1)', [rows[0].id]))
    const { rows: after } = await db.query<{ rejected_at: unknown }>(
      'select rejected_at from mo.report_photos where id = $1',
      [rows[0].id],
    )
    expect(after[0].rejected_at).toBeNull()
  })

  it('lists the photos closest to deletion first', async () => {
    const recent = await as(ADMIN, async () =>
      (await db.query<{ rejected_at: string }>('select rejected_at from mo.admin_recent_rejected_photos(200)')).rows,
    )
    const times = recent.map((row) => new Date(row.rejected_at).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times.length).toBeGreaterThan(1)
  })

  it('is the worker’s alone', async () => {
    expect(await failure(() => as(OWNER, () => db.query('select * from mo.claim_objects_to_delete(10)')))).toMatch(
      /permission denied/,
    )
    expect(await failure(() => as(null, () => db.query("select mo.record_object_deleted('x')")))).toMatch(
      /permission denied/,
    )
  })
})
