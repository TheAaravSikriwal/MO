/**
 * The Postgres schema every MO object lives in.
 *
 * MO runs as a route inside the wearechintu Next app and shares that project's
 * Supabase database, which already has a `public.reports` table — abuse reports
 * against marketplace projects — and a `public.profiles`. A litter report and
 * an abuse report are not the same thing, so the whole of MO is namespaced.
 *
 * Two places need this name, and they get it from here rather than from each
 * other. `supabaseSource` passes it as `db.schema`, which is what lets every
 * query stay written as `.from('reports')`. The upload endpoint sends it as a
 * `Content-Profile` header, because it talks to PostgREST over plain HTTP and
 * has no client to inherit the setting from.
 *
 * A leaf module with no imports, on purpose: the endpoint runs in a serverless
 * function, and importing this from `supabaseSource` pulled `h3-js` and
 * `@supabase/supabase-js` into that bundle for the sake of one string.
 *
 * `mo` must also be in the project's exposed-schemas list (Supabase dashboard,
 * API settings). Without that every request comes back 406 with "The schema
 * must be one of the following", whatever this says.
 */
export const MO_SCHEMA = 'mo'
