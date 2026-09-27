/**
 * The Postgres schema every MO object lives in.
 *
 * Duplicated from `src/lib/data/schema.ts` on purpose: `worker/` is a separate
 * npm package with its own dependencies and its own tsconfig, and it does not
 * import from the app. One string is a smaller price than a build-time link
 * between the two.
 *
 * It matters here more than anywhere. MO shares the wearechintu project's
 * database, and that database has a `public.reports` holding abuse reports
 * against marketplace projects. Without the schema set, every name this worker
 * uses resolves against `public`, and the pipeline stops dead on its first
 * call: `claim_moderation_jobs`, `moderation_jobs` and `report_photos` are not
 * there at all, and `.from('reports').select('note')` finds the marketplace's
 * table but no `note` column, so PostgREST answers 400.
 *
 * It fails loudly, then. What is silent is the CONSEQUENCE: nothing crashes in
 * the app, so every photo and note simply stays `pending` forever, which is
 * indistinguishable from a quiet week.
 *
 * If these two files ever disagree, the worker silently moderates nothing.
 */
export const MO_SCHEMA = 'mo'
