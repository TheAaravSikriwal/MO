import { describe, it, expect, vi } from 'vitest'
import { cleanUpObjects } from './cleanup.js'
import { deleteObject, type R2Config } from './r2.js'

const r2: R2Config = { accountId: 'acct', accessKeyId: 'AKID', secretAccessKey: 'secret', bucket: 'chintubucket' }

describe('cleanUpObjects', () => {
  it('deletes each claimed object, then records it', async () => {
    const order: string[] = []
    const result = await cleanUpObjects({
      claim: async () => [
        { storage_path: 'a', reason: 'unused' },
        { storage_path: 'b', reason: 'rejected' },
      ],
      deleteObject: async (key) => {
        order.push(`delete ${key}`)
      },
      record: async (key) => {
        order.push(`record ${key}`)
      },
    })
    expect(result).toEqual({ deleted: 2, failed: 0 })
    expect(order).toEqual(['delete a', 'record a', 'delete b', 'record b'])
  })

  it('does not record an object R2 did not delete, and carries on with the rest', async () => {
    const record = vi.fn(async () => undefined)
    const result = await cleanUpObjects({
      claim: async () => [
        { storage_path: 'a', reason: 'unused' },
        { storage_path: 'b', reason: 'unused' },
      ],
      deleteObject: async (key) => {
        if (key === 'a') throw new Error('R2 refused to delete a: 500')
      },
      record,
    })
    expect(result).toEqual({ deleted: 1, failed: 1 })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('b')
  })
})

describe('deleteObject', () => {
  const at = () => new Date('2026-09-27T12:00:00Z')

  it('sends a signed DELETE for exactly that key in that bucket', async () => {
    const send = vi.fn(async () => ({ status: 204 }))
    await deleteObject(r2, 'u/r/p.jpg', { fetch: send, now: at })
    const [url, init] = send.mock.calls[0] as unknown as [string, { method: string }]
    expect(init.method).toBe('DELETE')
    const parsed = new URL(url)
    expect(parsed.host).toBe('acct.r2.cloudflarestorage.com')
    expect(parsed.pathname).toBe('/chintubucket/u/r/p.jpg')
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(parsed.searchParams.get('X-Amz-Credential')).toBe('AKID/20260927/auto/s3/aws4_request')
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('treats a missing object as deleted', async () => {
    await expect(deleteObject(r2, 'k', { fetch: async () => ({ status: 404 }), now: at })).resolves.toBeUndefined()
  })

  it('throws when R2 refuses, so the object is retried', async () => {
    await expect(deleteObject(r2, 'k', { fetch: async () => ({ status: 403 }), now: at })).rejects.toThrow('403')
  })
})

describe('deleteObject — the signature is the one for this request', () => {
  it('signs a DELETE for this exact path, not any other method or key', async () => {
    const { presignUrl } = await import('../../shared/sigv4.js')
    const send = vi.fn(async () => ({ status: 204 }))
    const at = new Date('2026-09-27T12:00:00Z')
    await deleteObject(r2, 'u/r/p.jpg', { fetch: send, now: () => at })
    const [sent] = send.mock.calls[0] as unknown as [string]
    const expected = await presignUrl({
      method: 'DELETE',
      url: 'https://acct.r2.cloudflarestorage.com/chintubucket/u/r/p.jpg',
      region: 'auto',
      service: 's3',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      expiresInSeconds: 60,
      signedAt: at,
    })
    expect(sent).toBe(expected)
    // And a PUT for the same key signs differently, so a wrong method fails.
    const asPut = await presignUrl({
      method: 'PUT',
      url: 'https://acct.r2.cloudflarestorage.com/chintubucket/u/r/p.jpg',
      region: 'auto',
      service: 's3',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      expiresInSeconds: 60,
      signedAt: at,
    })
    expect(sent).not.toBe(asPut)
  })

  it('gives each request a timeout, so a hanging R2 cannot hold the worker', async () => {
    const send = vi.fn(async (_url: string, init: { method: string; signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return { status: 204 }
    })
    await deleteObject(r2, 'k', { fetch: send })
    expect(send).toHaveBeenCalled()
  })
})

describe('cleanUpObjects — a time budget', () => {
  it('stops when its time is up, leaving the rest for the next pass', async () => {
    let clock = 0
    const deleteObject = vi.fn(async () => {
      clock += 40_000
    })
    const result = await cleanUpObjects(
      {
        claim: async () => ['a', 'b', 'c'].map((storage_path) => ({ storage_path, reason: 'unused' })),
        deleteObject,
        record: async () => undefined,
      },
      () => undefined,
      { budgetMs: 60_000, now: () => clock },
    )
    // a at 0s, b at 40s, then 80s is past the minute: c is left.
    expect(result).toEqual({ deleted: 2, failed: 0 })
    expect(deleteObject).toHaveBeenCalledTimes(2)
  })
})
