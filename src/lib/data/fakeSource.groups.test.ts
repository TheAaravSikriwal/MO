import { describe, it, expect } from 'vitest'
import { FakeDataSource } from './fakeSource'
import { plainError } from '../moderation/plainWords'

/**
 * Cleaning groups in the in-memory source. It has to keep the database's rules
 * (0007, pinned in groups.run.test.ts) or every screen tested against it is
 * tested against rules the real map does not have.
 */

const WORLD = { minLat: -85, minLng: -180, maxLat: 85, maxLng: 180 }
const LONDON = { lat: 51.5, lng: -0.12 }
const ALICE = { id: 'alice', email: 'alice@example.com', isAdmin: false }
const ADMIN = { id: 'admin', email: 'admin@example.com', isAdmin: true }

const named = (user = ALICE) => new FakeDataSource(user, { displayName: 'Alice' })
const group = (name = 'Riverside Litter Pickers') => ({ name, description: 'Saturdays by the bridge.', ...LONDON })

describe('FakeDataSource — cleaning groups', () => {
  it('needs a signed-in person with a name, in the database’s words', async () => {
    await expect(new FakeDataSource(null).createGroup(group())).rejects.toThrow('sign in to start a group')
    await expect(new FakeDataSource(ALICE).createGroup(group())).rejects.toThrow('choose a name before you post')
  })

  it('keeps a new group to its founder, as a member, until it is approved', async () => {
    const data = named()
    const { id } = await data.createGroup(group())
    expect(await data.listGroupsInView(WORLD)).toEqual([
      expect.objectContaining({ id, status: 'pending', memberCount: 1, viewerIsMember: true, viewerIsFounder: true }),
    ])
    data.setUser({ id: 'bob', email: 'bob@example.com', isAdmin: false })
    expect(await data.listGroupsInView(WORLD)).toEqual([])
    await expect(data.joinGroup(id)).rejects.toThrow('no such group')
  })

  it('puts a new group in front of a person, with its name and description together', async () => {
    const data = named()
    const { id } = await data.createGroup(group())
    data.setUser(ADMIN)
    const item = (await data.listModerationQueue()).find((q) => q.subjectId === id)
    expect(item).toMatchObject({ subjectType: 'group', text: 'Riverside Litter Pickers\n\nSaturdays by the bridge.' })
    await data.decideModerationItem(item!.jobId, 'approved')
    expect(data.groupStatusOf(id)).toBe('approved')
  })

  it('counts people in and out, once each', async () => {
    const data = named()
    data.seedGroup({ id: 'g1', ...LONDON }, { members: 4 })
    await data.joinGroup('g1')
    await data.joinGroup('g1')
    expect((await data.listGroupsInView(WORLD))[0]).toMatchObject({ memberCount: 5, viewerIsMember: true })
    await data.leaveGroup('g1')
    expect((await data.listGroupsInView(WORLD))[0]).toMatchObject({ memberCount: 4, viewerIsMember: false })
  })

  it('allows three groups a day, and deleting one does not give the slot back', async () => {
    const data = named()
    const first = await data.createGroup(group('One Group'))
    await data.createGroup(group('Two Group'))
    await data.createGroup(group('Three Group'))
    await expect(data.createGroup(group('Four Group'))).rejects.toThrow('too many groups started today')
    await data.deleteGroup(first.id)
    await expect(data.createGroup(group('Four Group'))).rejects.toThrow('too many groups started today')
  })

  it('refuses a tab in the description, as the database does, but keeps line breaks', async () => {
    const data = named()
    await expect(data.createGroup({ ...group(), description: 'Bring\tgloves' })).rejects.toThrow(
      'a group description cannot contain tabs',
    )
    await expect(data.createGroup({ ...group(), description: 'Saturdays.\nBring gloves.' })).resolves.toBeDefined()
  })

  it('refuses a name too short or too long, and a place off the map', async () => {
    const data = named()
    await expect(data.createGroup(group('ab'))).rejects.toThrow('at least 3 letters')
    await expect(data.createGroup(group('x'.repeat(61)))).rejects.toThrow('at most 60')
    await expect(data.createGroup({ ...group(), lat: 95 })).rejects.toThrow('not a place on the map')
  })

  it('lets only the founder or an admin delete a group', async () => {
    const data = named()
    data.seedGroup({ id: 'g1', ...LONDON }, { founderId: 'someone-else' })
    await expect(data.deleteGroup('g1')).rejects.toThrow('only the person who started a group')
    data.setUser(ADMIN)
    await data.deleteGroup('g1')
    expect(await data.listGroupsInView(WORLD)).toEqual([])
  })

  it('takes two complaints to hide a group, and none about your own', async () => {
    const data = named()
    data.seedGroup({ id: 'mine', ...LONDON }, { founderId: ALICE.id })
    await expect(data.flag('group', 'mine', 'rude')).rejects.toThrow('you cannot report your own group')

    data.seedGroup({ id: 'g1', ...LONDON })
    await data.flag('group', 'g1', 'rude')
    expect(data.groupStatusOf('g1')).toBe('approved')
    data.setUser({ id: 'carol', email: 'carol@example.com', isAdmin: false })
    await data.flag('group', 'g1', 'rude')
    expect(data.groupStatusOf('g1')).toBe('pending')
  })

  it('still shows a group taken down to the people in it, so they can leave', async () => {
    const data = named()
    data.seedGroup({ id: 'g1', ...LONDON }, { members: ['dan'] })
    data.setUser({ id: 'bob', email: 'bob@example.com', isAdmin: false })
    await data.flag('group', 'g1', 'rude')
    data.setUser({ id: 'carol', email: 'carol@example.com', isAdmin: false })
    await data.flag('group', 'g1', 'rude')
    expect(await data.listGroupsInView(WORLD)).toEqual([])
    data.setUser({ id: 'dan', email: 'dan@example.com', isAdmin: false })
    expect(await data.listGroupsInView(WORLD)).toEqual([
      expect.objectContaining({ id: 'g1', status: 'pending', viewerIsMember: true, viewerIsFounder: false }),
    ])
    await data.leaveGroup('g1')
    expect(await data.listGroupsInView(WORLD)).toEqual([])
  })

  it('accepts a group at once only when told to, as "The idea" is', async () => {
    const idea = new FakeDataSource(ALICE, { displayName: 'Alice', approveGroupsAtOnce: true })
    const { id } = await idea.createGroup(group())
    expect(idea.groupStatusOf(id)).toBe('approved')
    idea.setUser(ADMIN)
    expect((await idea.listModerationQueue()).some((q) => q.subjectId === id)).toBe(false)
    // Everywhere else it waits.
    const real = named()
    expect(real.groupStatusOf((await real.createGroup(group())).id)).toBe('pending')
  })

  it('gives one more than a page in a busy area, with your own group first', async () => {
    const data = named()
    for (let i = 0; i < 205; i += 1) data.seedGroup({ id: `busy-${i}`, ...LONDON }, { members: 5 })
    const { id } = await data.createGroup(group('Tiny New Group'))
    const listed = await data.listGroupsInView(WORLD)
    expect(listed).toHaveLength(201)
    expect(listed[0].id).toBe(id)
  })

  it('finds a group in a view that crosses the 180th meridian', async () => {
    const data = named()
    data.seedGroup({ id: 'fiji', lat: -17.7, lng: 179.9 })
    const found = await data.listGroupsInView({ minLat: -20, minLng: 170, maxLat: -15, maxLng: -170 })
    expect(found.map((g) => g.id)).toEqual(['fiji'])
  })
})

describe('what people read when a group is refused', () => {
  // The exact sentence, not merely "some sentence other than the default":
  // an earlier rule about photos once caught "at most 60 characters", and a
  // looser check passed with the person told about photos.
  it.each([
    ['sign in to start a group', 'Please sign in first.'],
    ['choose a name before you post', 'Please choose a name before posting.'],
    ['a group name needs at least 3 letters', 'Please give the group a name of at least 3 letters.'],
    ['a group name can be at most 60 characters', 'Please keep the group name to 60 characters or fewer.'],
    ['a group name cannot contain tabs or line breaks', 'Please give the group a name without tabs or line breaks.'],
    ['a group description can be at most 500 characters', 'Please keep the description to 500 characters or fewer.'],
    ['a group description cannot contain tabs', 'Please take the tabs out of the description. Line breaks are fine.'],
    ['too many groups started today; please try again tomorrow', 'You have started several groups today. Please try again tomorrow.'],
    ['you cannot report your own group', 'You cannot report your own group.'],
    ['no such group', 'That group could not be found. It may have been removed.'],
    ['only the person who started a group can delete it', 'Only the person who started a group can delete it.'],
    ['that is not a place on the map', 'Move the map to where the group will clean up, then try again.'],
  ])('turns "%s" into "%s"', (message, sentence) => {
    expect(plainError(message)).toBe(sentence)
  })
})
