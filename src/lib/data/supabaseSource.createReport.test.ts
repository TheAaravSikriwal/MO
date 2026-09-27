import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MO_SCHEMA } from './schema'

/**
 * `createReport`, against a fake Supabase client.
 *
 * The rest of this file's reads cannot be tested without a database, but this
 * path is not a query -- it is the app's primary write, and it is the one place
 * that has to undo its own work. It writes the report row first, because a
 * photo needs a report to belong to, so every later failure has to remove that
 * row again. A miss there leaves a pin on the map with nothing to show, forever,
 * while telling the person their report failed.
 */

const USER = '11111111-1111-4111-8111-111111111111'
const REPORT = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'access-token'

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  clientOptions: undefined as { db?: { schema?: string } } | undefined,
  uploadPhoto: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options?: { db?: { schema?: string } }) => {
    mocks.clientOptions = options
    return mocks.client
  },
}))
vi.mock('../upload/uploadPhoto', () => ({ uploadPhoto: mocks.uploadPhoto }))

const { SupabaseDataSource } = await import('./supabaseSource')

interface Call {
  table: string
  op: 'insert' | 'delete'
  payload?: Record<string, unknown>
  id?: string
}

interface Script {
  user?: { id: string } | null
  session?: { access_token: string } | null
  reportInsert?: { data?: { id: string } | null; error?: { message: string } | null }
  photoInsert?: { error?: { message: string } | null }
  reportDelete?: { error?: { message: string } | null }
}

function fakeClient(script: Script = {}) {
  const calls: Call[] = []

  return {
    calls,
    auth: {
      getUser: async () => ({
        data: { user: script.user === undefined ? { id: USER } : script.user },
      }),
      getSession: async () => ({
        data: {
          session: script.session === undefined ? { access_token: TOKEN } : script.session,
        },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        calls.push({ table, op: 'insert', payload })
        const outcome =
          table === 'reports'
            ? (script.reportInsert ?? { data: { id: REPORT }, error: null })
            : (script.photoInsert ?? { error: null })
        return {
          // `.insert(...).select('id').single()` for the report...
          select: () => ({ single: async () => outcome }),
          // ...and a bare `await .insert(...)` for a photo.
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(outcome).then(resolve, reject),
        }
      },
      delete: () => ({
        eq: async (_column: string, id: string) => {
          calls.push({ table, op: 'delete', id })
          return script.reportDelete ?? { error: null }
        },
      }),
    }),
  }
}

const photo = (name: string) => new File(['bytes'], name, { type: 'image/jpeg' })

const source = (script: Script = {}) => {
  mocks.client = fakeClient(script)
  return {
    source: new SupabaseDataSource('https://project.supabase.co', 'anon-key', 'https://img.example'),
    client: mocks.client as ReturnType<typeof fakeClient>,
  }
}

const newReport = (photos = [photo('a.jpg')]) => ({
  lat: 51.5074,
  lng: -0.1278,
  note: 'Bags of rubbish by the bus stop',
  photos,
})

beforeEach(() => {
  mocks.uploadPhoto.mockReset()
  mocks.uploadPhoto.mockResolvedValue(`${USER}/${REPORT}/photo.jpg`)
})

describe('the client MO talks to', () => {
  it('is pointed at the mo schema, not public', () => {
    // The wearechintu database already has a `public.reports` holding abuse
    // reports against marketplace projects. Without this, every query below
    // reads and writes that table instead: no error, wrong data, and two
    // features quietly sharing one table.
    source()
    expect(mocks.clientOptions?.db?.schema).toBe(MO_SCHEMA)
  })
})

describe('createReport: the happy path', () => {
  it('writes the report with its reporter, coordinates, note and cells', async () => {
    const { source: s, client } = source()
    await s.createReport(newReport())

    const insert = client.calls.find((c) => c.table === 'reports')
    expect(insert?.payload).toMatchObject({
      reporter_id: USER,
      lat: 51.5074,
      lng: -0.1278,
      note: 'Bags of rubbish by the bus stop',
    })
    // Six nested cells, computed client-side because Postgres cannot derive
    // them without the H3 extension.
    for (const column of ['cell_r1', 'cell_r3', 'cell_r5', 'cell_r7', 'cell_r9', 'cell_r12']) {
      expect(insert?.payload?.[column]).toEqual(expect.any(String))
    }
  })

  it('stores no severity, because nobody chooses it', async () => {
    const { source: s, client } = source()
    await s.createReport(newReport())
    const insert = client.calls.find((c) => c.table === 'reports')
    expect(Object.keys(insert?.payload ?? {})).not.toContain('severity')
  })

  it('uploads each photo against the new report, with the access token', async () => {
    const { source: s } = source()
    await s.createReport(newReport([photo('a.jpg'), photo('b.jpg')]))

    expect(mocks.uploadPhoto).toHaveBeenCalledTimes(2)
    for (const [request] of mocks.uploadPhoto.mock.calls) {
      expect(request).toMatchObject({ reportId: REPORT, accessToken: TOKEN })
    }
  })

  it('links each photo by the key the upload returned, never one of its own', async () => {
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto
      .mockResolvedValueOnce(`${USER}/${REPORT}/first.jpg`)
      .mockResolvedValueOnce(`${USER}/${REPORT}/second.jpg`)

    const { source: s, client } = source()
    await s.createReport(newReport([photo('a.jpg'), photo('b.jpg')]))

    const paths = client.calls
      .filter((c) => c.table === 'report_photos')
      .map((c) => c.payload?.storage_path)
    expect(paths).toEqual([`${USER}/${REPORT}/first.jpg`, `${USER}/${REPORT}/second.jpg`])
  })

  it('returns the new report id', async () => {
    const { source: s } = source()
    expect(await s.createReport(newReport())).toEqual({ id: REPORT })
  })

  it('keeps the report when everything worked', async () => {
    const { source: s, client } = source()
    await s.createReport(newReport())
    expect(client.calls.filter((c) => c.op === 'delete')).toEqual([])
  })
})

describe('createReport: refusing before it writes anything', () => {
  it('asks a signed-out person to sign in, and writes nothing', async () => {
    const { source: s, client } = source({ user: null })
    await expect(s.createReport(newReport())).rejects.toThrow(/sign in/i)
    expect(client.calls).toEqual([])
    expect(mocks.uploadPhoto).not.toHaveBeenCalled()
  })

  it('asks for a photo when there are none, and writes nothing', async () => {
    const { source: s, client } = source()
    await expect(s.createReport(newReport([]))).rejects.toThrow(/add a photo/i)
    expect(client.calls).toEqual([])
  })

  it('stops when there is no access token, before inserting the report', async () => {
    // The upload endpoint cannot be called without it. Finding that out after
    // the insert would mean deleting a report that was only just written.
    const { source: s, client } = source({ session: null })
    await expect(s.createReport(newReport())).rejects.toThrow(/sign in/i)
    expect(client.calls).toEqual([])
    expect(mocks.uploadPhoto).not.toHaveBeenCalled()
  })

  it('passes on the database error when the report itself will not insert', async () => {
    const { source: s } = source({
      reportInsert: { error: { message: 'too many reports in the last hour; please slow down' } },
    })
    await expect(s.createReport(newReport())).rejects.toThrow(/too many reports/)
    expect(mocks.uploadPhoto).not.toHaveBeenCalled()
  })
})

describe('createReport: undoing a half-finished report', () => {
  it('removes the report when an upload fails, and passes the reason on', async () => {
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto.mockRejectedValue(new Error('Photo upload is not set up on this site yet.'))

    const { source: s, client } = source()
    await expect(s.createReport(newReport())).rejects.toThrow(/not set up/)
    expect(client.calls).toContainEqual({ table: 'reports', op: 'delete', id: REPORT })
  })

  it('removes the report when linking the photo fails', async () => {
    const { source: s, client } = source({
      photoInsert: { error: { message: 'a report may have at most 3 photos' } },
    })
    await expect(s.createReport(newReport())).rejects.toThrow(/at most 3 photos/)
    expect(client.calls).toContainEqual({ table: 'reports', op: 'delete', id: REPORT })
  })

  it('removes the report when a later photo fails, not just the first', async () => {
    // The earlier photo is already linked and its bytes are already in the
    // bucket. Leaving the report would publish a partial submission.
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto
      .mockResolvedValueOnce(`${USER}/${REPORT}/first.jpg`)
      .mockRejectedValueOnce(new Error('Your photo could not be uploaded. Please try again.'))

    const { source: s, client } = source()
    await expect(
      s.createReport(newReport([photo('a.jpg'), photo('b.jpg')])),
    ).rejects.toThrow(/could not be uploaded/)
    expect(client.calls).toContainEqual({ table: 'reports', op: 'delete', id: REPORT })
  })

  it('stops uploading as soon as one photo fails', async () => {
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto.mockRejectedValue(new Error('nope'))

    const { source: s } = source()
    await expect(
      s.createReport(newReport([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')])),
    ).rejects.toThrow()
    expect(mocks.uploadPhoto).toHaveBeenCalledTimes(1)
  })
})

describe('createReport: when the undo itself fails', () => {
  let logged: unknown[][]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('says so, naming the report that is now stranded', async () => {
    // This is the worst case in the whole path and the only one with no
    // recovery: the person is told their report failed while the pin stays on
    // the map. Swallowing it left that with nothing on screen and nothing in a
    // log to find it by.
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto.mockRejectedValue(new Error('upload failed'))

    const { source: s } = source({ reportDelete: { error: { message: 'permission denied' } } })
    await expect(s.createReport(newReport())).rejects.toThrow('upload failed')

    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain(REPORT)
    expect(String(logged[0][1])).toContain('permission denied')
  })

  it('still reports the original failure, not the failure to undo it', async () => {
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto.mockRejectedValue(new Error('upload failed'))

    const { source: s } = source({ reportDelete: { error: { message: 'permission denied' } } })
    await expect(s.createReport(newReport())).rejects.toThrow('upload failed')
  })

  it('stays quiet when the undo worked', async () => {
    mocks.uploadPhoto.mockReset()
    mocks.uploadPhoto.mockRejectedValue(new Error('upload failed'))

    const { source: s } = source()
    await expect(s.createReport(newReport())).rejects.toThrow('upload failed')
    expect(logged).toEqual([])
  })
})
