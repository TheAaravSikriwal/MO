/**
 * Remove from R2 the photos nothing should serve: uploads that never became a
 * photo, photos whose row was deleted, and photos that were rejected.
 *
 * Which ones is decided in the database (claim_objects_to_delete in 0006),
 * working from MO's own upload grants -- never from a listing of the bucket,
 * which MO shares with the marketplace. This only carries out the list.
 */

export interface ToDelete {
  storage_path: string
  reason: string
}

export interface CleanupDeps {
  /** Claims a batch; claimed objects can no longer be linked to a photo. */
  claim(): Promise<ToDelete[]>
  /** Removes the bytes. Throws if R2 did not. */
  deleteObject(key: string): Promise<void>
  /** Records the removal, once R2 has confirmed it. */
  record(key: string): Promise<void>
}

export interface CleanupResult {
  deleted: number
  failed: number
}

/**
 * One pass. A failed delete is logged and left unrecorded: the database offers
 * it again after ten minutes, so it is retried rather than lost -- and the grant
 * stays retired meanwhile, so nothing can link a photo to it.
 */
export async function cleanUpObjects(
  deps: CleanupDeps,
  log: (message: string) => void = () => undefined,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<CleanupResult> {
  const now = options.now ?? (() => Date.now())
  // A pass stops when its time is up, even part-way through a batch. What it
  // did not reach stays retired and is offered again ten minutes later, and
  // moderation, which shares this loop, gets back to work.
  const deadline = now() + (options.budgetMs ?? 60_000)
  const result: CleanupResult = { deleted: 0, failed: 0 }
  for (const item of await deps.claim()) {
    if (now() >= deadline) {
      log('out of time for this pass; the rest will be retried')
      break
    }
    try {
      await deps.deleteObject(item.storage_path)
      await deps.record(item.storage_path)
      result.deleted += 1
      log(`deleted ${item.storage_path} (${item.reason})`)
    } catch (error) {
      result.failed += 1
      log(`could not delete ${item.storage_path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
