import { describe, it, expect } from 'vitest'
import { FakeDataSource } from './fakeSource'

/**
 * The fake has to refuse what the database refuses, or every UI test that
 * passes against it proves less than it looks. These pin its copy of
 * reports_insert_own / comments_insert_own and of set_display_name.
 */

const photo = () => new File(['x'], 'litter.jpg', { type: 'image/jpeg' })
const report = { lat: 51.5, lng: -0.12, note: '', photos: [photo()] }

const nameless = (now?: () => number) =>
  new FakeDataSource({ id: 'u1', email: 'sam.jones@example.com', isAdmin: false }, { now })

describe('FakeDataSource — a name comes first', () => {
  it('refuses a report from somebody with no name, in Postgres’s words', async () => {
    await expect(nameless().createReport(report)).rejects.toThrow(
      'new row violates row-level security policy for table "reports"',
    )
  })

  it('refuses a comment from somebody with no name', async () => {
    const data = nameless()
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await expect(data.addComment('r1', 'Still here')).rejects.toThrow(
      'new row violates row-level security policy for table "comments"',
    )
  })

  it('accepts both once a name is chosen, even before it is approved', async () => {
    const data = nameless()
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    await data.setDisplayName('Sam')
    await expect(data.createReport(report)).resolves.toBeTruthy()
    await expect(data.addComment('r1', 'Still here')).resolves.toBeUndefined()
  })

  it('refuses again once the name is rejected', async () => {
    const data = nameless()
    await data.setDisplayName('Sam')
    data.decideName('u1', 'rejected')
    await expect(data.createReport(report)).rejects.toThrow('row-level security')
  })
})

describe('FakeDataSource — choosing a name', () => {
  it('refuses an email address', async () => {
    await expect(nameless().setDisplayName('sam@example.com')).rejects.toThrow('cannot contain @')
  })

  it('refuses names that are too short or too long', async () => {
    await expect(nameless().setDisplayName(' a ')).rejects.toThrow('between 2 and 30')
    await expect(nameless().setDisplayName('x'.repeat(31))).rejects.toThrow('between 2 and 30')
  })

  it('refuses the exact name that was rejected, but takes a different one', async () => {
    const data = nameless()
    await data.setDisplayName('Rude Name')
    data.decideName('u1', 'rejected')
    await expect(data.setDisplayName('Rude Name')).rejects.toThrow('not accepted')
    await data.setDisplayName('Sam')
    expect(await data.getMyDisplayName()).toEqual({ name: 'Sam', status: 'pending' })
  })

  it('allows one change a day, and a fix to a rejected name at any time', async () => {
    let clock = 0
    const data = nameless(() => clock)
    await data.setDisplayName('Sam')
    clock += 60 * 60 * 1000
    await expect(data.setDisplayName('Sammy')).rejects.toThrow('once a day')
    clock += 24 * 60 * 60 * 1000
    await data.setDisplayName('Sammy')
    data.decideName('u1', 'rejected')
    await data.setDisplayName('Sam J')
    expect(await data.getMyDisplayName()).toEqual({ name: 'Sam J', status: 'pending' })
  })
})

describe('FakeDataSource — names follow the same review rules as everything else', () => {
  it('refuses tabs and line breaks, in the words the database uses', async () => {
    await expect(nameless().setDisplayName('Sam' + String.fromCharCode(9) + 'J')).rejects.toThrow(
      'tabs or line breaks',
    )
  })

  it('withholds an approved name again when two people complain', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    data.seedName('u9', 'Litter Picker', 'approved')
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    const comment = data.seedComment('r1', { authorId: 'u9', body: 'hello' })
    // One complaint puts it in front of a person but takes nothing down.
    data.seedFlagFromAnotherPerson('name', 'u9')
    expect(data.nameOf('u9')?.status).toBe('approved')
    // The second, from somebody else, withholds it while it waits.
    await data.flagCommentAuthorName(comment, 'reported by a reader')
    expect(data.nameOf('u9')?.status).toBe('pending')
  })
})

describe('FakeDataSource — a new name reaches a person', () => {
  it('puts each new name in the review queue, replacing the old one', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: true }, { now: () => 0 })
    await data.setDisplayName('Sam')
    let queue = await data.listModerationQueue()
    expect(queue).toEqual([expect.objectContaining({ subjectType: 'name', subjectId: 'u1', text: 'Sam' })])

    data.decideName('u1', 'rejected')
    await data.setDisplayName('Sam J')
    queue = await data.listModerationQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ subjectType: 'name', text: 'Sam J' })

    await data.decideModerationItem(queue[0].jobId, 'approved')
    expect(await data.getMyDisplayName()).toEqual({ name: 'Sam J', status: 'approved' })
  })

  it('signs a report with the reporter’s own name', async () => {
    const data = nameless()
    await data.setDisplayName('Sam')
    const { id } = await data.createReport(report)
    expect((await data.getReport(id))!.reporterName).toBe('Sam')
  })
})

describe('FakeDataSource — name length counts characters', () => {
  it('takes a name of emoji the database would take', async () => {
    // Sixteen emoji: 32 UTF-16 units, 16 characters to char_length.
    const name = '🌳'.repeat(16)
    const data = nameless()
    await data.setDisplayName(name)
    expect((await data.getMyDisplayName())!.name).toBe(name)
  })

  it('still refuses thirty-one characters', async () => {
    await expect(nameless().setDisplayName('🌳'.repeat(31))).rejects.toThrow('between 2 and 30')
  })
})

describe('FakeDataSource — a rejected name cannot be replaced endlessly', () => {
  it('allows three names a day, rejected or not, then refuses', async () => {
    let clock = 0
    const data = nameless(() => clock)
    await data.setDisplayName('One')
    data.decideName('u1', 'rejected')
    await data.setDisplayName('Two')
    data.decideName('u1', 'rejected')
    await data.setDisplayName('Three')
    data.decideName('u1', 'rejected')
    await expect(data.setDisplayName('Four')).rejects.toThrow('too many new names today')

    // A day later the window starts afresh.
    clock += 24 * 60 * 60 * 1000 + 1
    await data.setDisplayName('Four')
    expect(await data.getMyDisplayName()).toEqual({ name: 'Four', status: 'pending' })
  })
})

describe('FakeDataSource — a name is never flagged directly', () => {
  it('refuses a direct name flag, as flags_insert_own does', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    await expect(data.flag('name' as never, 'u1', 'x')).rejects.toThrow('row-level security')
  })

  it('refuses a complaint about your own name by any route', async () => {
    const data = new FakeDataSource({ id: 'u1', isAdmin: false }, { displayName: 'Sam' })
    const { id } = await data.createReport(report)
    await expect(data.flagReporterName(id, 'x')).rejects.toThrow('your own name')
  })
})

describe('FakeDataSource — the name on a report follows its review', () => {
  it('shows a pending name to the reporter only, and a rejected one to nobody else', async () => {
    const data = nameless()
    await data.setDisplayName('Sam')
    const { id } = await data.createReport(report)
    expect((await data.getReport(id))!.reporterName).toBe('Sam')

    data.setUser({ id: 'u2', isAdmin: false })
    expect((await data.getReport(id))!.reporterName).toBeNull()

    data.decideName('u1', 'approved')
    expect((await data.getReport(id))!.reporterName).toBe('Sam')

    data.decideName('u1', 'rejected')
    expect((await data.getReport(id))!.reporterName).toBeNull()
  })

  it('refuses an invisible name, in the database’s words', async () => {
    const zeroWidth = String.fromCodePoint(8203)
    await expect(nameless().setDisplayName(zeroWidth + zeroWidth)).rejects.toThrow(
      'at least 2 visible characters',
    )
  })
})

describe('FakeDataSource — reporting a name again after a rename', () => {
  it('lets somebody who reported the old name report the new one', async () => {
    const owner = { id: 'u9', isAdmin: false }
    const reader = { id: 'u1', isAdmin: false }
    let clock = 0
    const data = new FakeDataSource(reader, { displayName: 'Sam', now: () => clock })
    data.seedName('u9', 'First Bad Name', 'approved')
    data.seed({ id: 'r1', lat: 51.5, lng: -0.12 })
    const comment = data.seedComment('r1', { authorId: 'u9', body: 'hello' })

    await data.flagCommentAuthorName(comment, 'reported by a reader')
    await expect(data.flagCommentAuthorName(comment, 'again')).rejects.toThrow('already reported')

    data.setUser(owner)
    clock += 2 * 24 * 60 * 60 * 1000
    await data.setDisplayName('Second Bad Name')
    data.decideName('u9', 'approved')

    data.setUser(reader)
    await expect(data.flagCommentAuthorName(comment, 'reported by a reader')).resolves.toBeUndefined()
  })
})
