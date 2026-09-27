// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { addProfile, asRole, freshDatabase } from './pgHarness'

/**
 * A pin taken off the map takes its photos with it, in a real Postgres.
 *
 * Its own file because a photo needs the whole upload path first: a grant for
 * the object key, then the photo row that spends it, then a decision.
 */

const OWNER = '21212121-2121-4121-8121-212121212121'
const ADMIN = '23232323-2323-4323-8323-232323232323'
const CELL = '8a1fb46622dffff'
const OBJECT = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e'

let db: PGlite
let pin: string

const as = <T>(userId: string | null, work: () => Promise<T>) =>
  asRole(db, userId ? 'authenticated' : 'anon', userId, work)

beforeAll(async () => {
  db = await freshDatabase()
  await addProfile(db, OWNER, 'owner.o')
  await addProfile(db, ADMIN, 'admin.a')
  await db.query('insert into mo.admins (user_id) values ($1)', [ADMIN])
  await as(OWNER, () => db.query("select mo.set_display_name('Owner')"))

  pin = await as(OWNER, async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into mo.reports
         (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7, cell_r9, cell_r12)
       values ($1, 51.5, -0.12, $2, $2, $2, $2, $2, $2) returning id`,
      [OWNER, CELL],
    )
    return rows[0].id
  })

  const key = `${OWNER}/${pin}/${OBJECT}.jpg`
  await as(OWNER, async () => {
    await db.query('insert into mo.upload_grants (user_id, report_id, storage_path) values ($1, $2, $3)', [
      OWNER,
      pin,
      key,
    ])
    await db.query('insert into mo.report_photos (report_id, storage_path) values ($1, $2)', [pin, key])
  })

  const { rows } = await db.query<{ id: string }>(
    "select id from mo.moderation_jobs where subject_type = 'photo'",
  )
  await as(ADMIN, () => db.query("select mo.admin_decide_moderation($1, 'approved')", [rows[0].id]))
}, 120_000)

const photosSeenBy = (viewer: string | null) =>
  as(viewer, async () =>
    (
      await db.query<{ storage_path: string | null }>(
        'select storage_path from mo.public_report_photos where report_id = $1',
        [pin],
      )
    ).rows,
  )

describe('a pin off the map, and its photos', () => {
  it('shows an approved photo to anybody while the pin is on the map', async () => {
    expect(await photosSeenBy(null)).toEqual([{ storage_path: `${OWNER}/${pin}/${OBJECT}.jpg` }])
  })

  it('hides it from everybody but the reporter and admins once the pin is off', async () => {
    await as(ADMIN, () => db.query("select mo.admin_set_report_on_map($1, false, 'spam')", [pin]))
    expect(await photosSeenBy(null)).toEqual([])
    expect(await photosSeenBy(OWNER)).toHaveLength(1)
    expect(await photosSeenBy(ADMIN)).toHaveLength(1)
  })

  it('signs no new upload URLs while the pin is off the map', async () => {
    // The grant is what api/sign-upload writes before it signs. Refusing it
    // means no bytes are ever uploaded for a pin nobody else can see.
    const key = `${OWNER}/${pin}/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f.jpg`
    const refused = await as(OWNER, async () => {
      try {
        await db.query('insert into mo.upload_grants (user_id, report_id, storage_path) values ($1, $2, $3)', [
          OWNER,
          pin,
          key,
        ])
        return null
      } catch (error) {
        return (error as Error).message
      }
    })
    expect(refused).toMatch(/row-level security policy for table "upload_grants"/)
  })

  it('takes no new photo either, even with a grant made before the pin came off', async () => {
    // A grant written as the table owner stands in for one minted while the
    // pin was still on the map.
    const key = `${OWNER}/${pin}/0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d.jpg`
    await db.query('insert into mo.upload_grants (user_id, report_id, storage_path) values ($1, $2, $3)', [
      OWNER,
      pin,
      key,
    ])
    const refused = await as(OWNER, async () => {
      try {
        await db.query('insert into mo.report_photos (report_id, storage_path) values ($1, $2)', [pin, key])
        return null
      } catch (error) {
        return (error as Error).message
      }
    })
    expect(refused).toMatch(/this report is off the map/)
  })

  it('tells admins, and only admins, when it was taken off', async () => {
    const removedAt = (viewer: string | null) =>
      as(viewer, async () =>
        (await db.query<{ removed_at: unknown }>('select removed_at from mo.public_reports where id = $1', [pin]))
          .rows[0]?.removed_at ?? null,
      )
    expect(await removedAt(ADMIN)).not.toBeNull()
    expect(await removedAt(OWNER)).toBeNull()
  })

  it('shows it again when the pin is put back', async () => {
    await as(ADMIN, () => db.query('select mo.admin_set_report_on_map($1, true)', [pin]))
    expect(await photosSeenBy(null)).toHaveLength(1)
  })
})
