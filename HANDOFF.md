# Where this project stands

Written 2026-09-09, so a fresh machine — or a fresh Claude Code session — can
pick up without re-reading the whole history.

Read `CLAUDE.md` first for the rules; this file is the state.

## Where this is going, as of 2026-09-16

**MO is becoming a route inside the wearechintu Next app**, not a standalone
deploy. That project is `D:\VisualStudioProjects\gitbuddywebsite` (its
`package.json` is named `wearechintu`): Next 14, React 18, already on Vercel,
already holding a Supabase project and a Cloudflare R2 bucket.

Why that decision: the alternative was MO on its own subdomain sharing the
backend, which is less work but cannot cheaply share a sign-in — supabase-js
keeps the session in `localStorage`, which is per-origin. Same origin is the
one thing the subdomain cannot buy back, and it is most of what "an extension
of the site" means.

What that project already has, which MO was blocked on:

| MO needed | chintu has |
|---|---|
| A Supabase project | one, with `public.profiles` auto-created per auth user |
| An R2 bucket | `chintubucket`, with credentials in `.env.local.example` |
| A presigner | `src/lib/r2.js` on the AWS SDK, including `deleteObject` |
| Request auth | `src/lib/auth.js` `authenticateRequest` |

**Still missing, and the reason item 6 below is unchanged:** `R2_PUBLIC_URL` is
a `pub-<hash>.r2.dev` address, which is Cloudflare's hostname and not one on
the wearechintu zone. The free CSAM scanning applies to a zone, so it needs a
custom domain attached to the bucket. The existing setup does not satisfy it.

### Done

* MO's six migrations now target a `mo` schema instead of `public`, because
  that database already has `public.reports` (marketplace abuse reports) and
  `public.profiles`. `supabase/README.md` explains the whole shape. MO stopped
  creating profiles and keeps its moderators in `mo.admins`.
* All THREE clients target it, and there are three because they are three
  separate pieces of code: the app passes `db: { schema: 'mo' }`, the upload
  endpoint sends `Content-Profile: mo` (it speaks to PostgREST over plain HTTP
  and has no client to inherit from), and `worker/` sets `db.schema` on its own
  service-role client. Each has a test pinning it.

  The worker was missed on the first pass. It does not fail quietly — against
  `public` its RPCs and tables are simply absent, and `.from('reports')
  .select('note')` finds the marketplace's table without a `note` column, so
  PostgREST answers 400. What is quiet is the consequence: nothing in the app
  breaks, so every photo and note stays `pending` forever, which looks exactly
  like nobody having posted. If a fourth thing ever talks to this database, it
  needs the same treatment.
* `service_role` can actually work, which took two passes. `usage on schema
  mo`, `select` on the tables the worker reads, `execute` on the three RPCs by
  name — and, the part that was missing, those three RPCs are now
  `security definer`. Run as the caller they needed DML on four tables that a
  new schema grants nobody, so the pipeline failed on its first statement with
  a green suite behind it. Reading was granted; writing was not.
* PostGIS installs `with schema extensions`. Without the clause it landed in
  `public`, because `create extension` targets the first existing schema on the
  search path and `mo` does not exist yet — so MO was putting PostGIS into the
  marketplace's schema, which is the one thing this refactor exists to avoid.
* MO issues no statement about the `public` schema at all now: no
  `alter default privileges`, no `grant usage`. Both reached outside MO, and
  `migrations.test.ts` refuses either.

### Decide this before applying the migrations

**Sharing accounts publishes a name derived from each reporter's email
address.** MO signs people in with a magic link, so there is no OAuth
metadata — and chintu's `handle_new_user` sets `display_name` to
`split_part(email, '@', 1)` for exactly that case. `public.profiles` is
readable by anon in that project, `mo.profile_names` is granted to anon, and
`public_reports` hands `reporter_id` to anon. So every report and comment ends
up signed with the author's email prefix, readable by any visitor.

Nothing is applied yet, so nothing is exposed. It is not a default to accept
silently either. `supabase/README.md` lists the three ways out; the cheapest is
to stop returning `reporter_id` to anon from `mo.public_reports` — one column,
one view.

Three more consequences of one shared account set, all in
`supabase/README.md`. Two are MO's problem: a marketplace account deletion
would cascade litter reports off the map (six MO tables reference
`public.profiles` with `on delete cascade`), and a marketplace ban does not
stop anybody using MO (nothing in `mo` reads `publish_tier`).

**The third is the marketplace's problem, and it is live as soon as anyone
signs in through the map.** A magic-link signup gets
`github_account_created_at = NULL`, and the marketplace's publish gate fails
closed on NULL — so an MO-originated account is permanently barred from
publishing, told it is because of a GitHub account it never had. And the
backfill that gate's own comment proposes would then date every MO account from
its map signup and wave it straight past the age check, turning MO's open
sign-up into a sign-up path into the marketplace. Not fixable from this repo;
somebody has to own that decision on the other side.

### Next, in order

1. **Port the app into the Next project.** `react-leaflet` 5 → 4 for React 18
   (MO only uses `MapContainer`, `TileLayer`, `Polygon`, `CircleMarker`,
   `useMap`, `useMapEvents`, all unchanged in v4), `import.meta.env` →
   `process.env.NEXT_PUBLIC_*`, `'use client'` on the map tree, and a `/map`
   route. The site has no test runner at all, so Vitest goes in with it — MO's
   suite is the only thing making the port safe.
2. **Replace `api/sign-upload` with a Next route handler** over the site's
   existing `lib/r2`. That deletes `api/_lib/sigv4.ts` entirely. `getUploadUrl`
   there signs only `ContentType`, so it needs `ContentLength` and
   `IfNoneMatch` adding or MO loses its size cap and its one-write guarantee —
   see `api/README.md`. Note their own comment: R2 rejects a presigned URL that
   signs `ChecksumAlgorithm`, so treat extra signed headers as unproven.
3. **Three header changes in `next.config.mjs`**, each a hard blocker today:
   `Permissions-Policy: geolocation=()` kills near-me; `script-src` has no
   `esm.sh`, so the browser NSFW check fails open; and the R2 CORS rule needs
   `if-none-match` in `AllowedHeaders`.
4. **Move the migrations in as `010`–`015`** following that project's 3-digit
   numbering. They must be renumbered, not copied: `0001` sorts before `001`
   as a string, and the Supabase CLI compares versions as text and refuses
   out-of-order migrations.
5. **Add `mo` to the project's exposed-schemas list** — Supabase dashboard,
   API settings. This is one checkbox and nothing works without it: PostgREST
   answers 406 `PGRST106` ("The schema must be one of the following") to every
   read, every RPC, the upload endpoint's grant insert and the whole worker
   pipeline. Applying the migrations is not sufficient on its own, which is
   easy to assume because everything else about this is SQL.

## What MO is

A community pollution map. People report litter with a photo and a precise
location, other people confirm those reports, and the map colours areas by how
many distinct people flagged them — from street level out to a world view. When
a spot is marked cleaned, it drops out of the weighting and the map visibly
cools. That last part is the point of the whole product.

Full brief and design: `docs/superpowers/specs/2026-08-31-mo-phase1-design.md`.

## Getting running

```bash
npm install
npm run dev
```

No accounts or keys needed. With no Supabase configured the app runs on seeded
sample reports around central London, so the map is populated and every screen
works. That is deliberate — see `src/lib/data/createDataSource.ts`.

```bash
npm test              # 725 tests
npm run build         # typecheck, then build
cd worker && npm test # 113 tests
```

## What is done

Everything below is built and tested. The upload signing endpoint and
migration `0006` are the newest part and are not committed yet. `git status` is
the list to trust, but at the time of writing the untracked entries are `api/`,
`src/lib/upload/`, `src/lib/data/supabaseSource.createReport.test.ts`,
`src/lib/data/schema.ts`, `worker/src/schema.ts`, `worker/src/schema.test.ts`,
`supabase/migrations/0006_upload_grants.sql` and `tsconfig.node.json`. The
`createReport` test is easy to miss and is the only cover on the app's primary
write; the three `schema` files are what point each of the three clients at
`mo`.

| Area | Where |
|---|---|
| H3 grid: zoom→resolution bands, six nested cells per report | `src/lib/grid/` |
| Derived severity: weight from reports + votes, relative ranking | `src/lib/severity/` |
| Colour ramp, OKLCH | `src/lib/color/ramp.ts` |
| Map, tile provider seam, viewport bounds, fly-to | `src/components/map/MapView.tsx` |
| Aggregated cells with cross-fade between zoom bands | `src/components/map/CellLayer.tsx` |
| Individual report pins | `src/components/map/ReportPinLayer.tsx` |
| Filters + near-me | `src/components/map/FilterPanel.tsx`, `src/lib/filters/`, `src/lib/geo/` |
| Place search (Nominatim, debounced) | `src/lib/geo/nominatim.ts` |
| Report form, detail, votes, comments, mark-cleaned animation | `src/components/report/` |
| Sign in (magic link) | `src/components/auth/SignInPanel.tsx` |
| Admin review queue | `src/components/admin/AdminQueue.tsx` |
| Upload signing endpoint, SigV4 on Web Crypto | `api/`, `src/lib/upload/` |
| Moderation worker, four tiers, swappable model and host | `worker/` |
| Schema, RLS, RPCs, upload rate limit | `supabase/migrations/` |

## What is NOT done

Eight things. The first two are blocked on accounts rather than on code:

1. **The database has never been run.** Every migration in `supabase/migrations/`
   is a careful draft that has never touched Postgres. `src/lib/db/migrations.test.ts`
   pins invariants by reading the SQL as text — useful, but it proves nothing
   about whether the schema works. `supabase/README.md` lists the specific RLS
   questions to answer once a project exists.
2. **Photo upload is written but has never reached R2.** The endpoint exists:
   `api/sign-upload` verifies the caller with Supabase, decides the object key
   itself, and signs a two-minute PUT with the type and the exact byte length
   baked into the signature. The signature is pinned against AWS's own
   published example, so the maths is proven. What is NOT proven is that R2
   accepts it, because there is no bucket. `api/README.md` says what has to
   exist — a bucket, a CORS rule, a Cloudflare-proxied hostname — and names
   the two things most likely to need adjusting on first contact: the signed
   `content-length` and `if-none-match` headers. Neither may simply be deleted.
   `content-length` is the only thing enforcing the 8 MB cap, and
   `if-none-match` is the only thing stopping a signed URL being reused to swap
   the bytes after they have been judged.
3. **Nothing ever deletes from the R2 bucket, and that includes rejected
   photos.** Two things follow, and the second is the one that matters.

   A submission that fails after its bytes have landed leaves them
   unreferenced forever: the report row is deleted, the photo row cascades
   away, the object stays.

   More seriously, **a photo a human rejected stays retrievable.** The database
   withholds an unapproved `storage_path`, so nobody can discover one through
   it — but the bytes are on a public Cloudflare hostname, and `api/sign-upload`
   hands the key to the person uploading, so they always hold their own. Keys
   are three UUIDs and unguessable, the bucket must not be listable, and no
   pending or rejected path is given to anybody else, so this is not a browsing
   hole. It is still wrong: rejection is the mechanism this project relies on
   for content that must not be hosted at all, and right now rejection only
   withholds the row.

   Both need the same thing — a reconcile pass in `worker/`, which already loops
   with service role access, holding an R2 credential that can list and delete.
   It does not hold one, and none of it can be verified without a real bucket.
   `api/README.md` has the detail. Note both `supabase/README.md` and the comment
   on `public_report_photos` in `0003` used to claim an unreviewed image was
   "genuinely unreachable"; that was true of Supabase storage and is not true
   of R2. Both are corrected, and a test refuses the wording anywhere in the
   migrations.
4. **A signed upload URL is rate limited but not proven.** `authenticated` can
   insert an `upload_grants` row directly, because `api/sign-upload` writes with
   the caller's own token rather than a service role key. So a grant means
   "somebody claimed this key", not "the endpoint issued it". One grant per
   object and one link per grant keep the damage to phantom rows: a photo row,
   and a moderation job, for an image that was never uploaded — capped at
   thirty an hour per account, touching nobody else's data. Closing it means
   putting a privileged credential in the app, which `.env.example` currently
   forbids ("never in this app"), so it is a decision to take on purpose rather
   than a fix to slip in. `api/README.md` has the reasoning.
5. **Nothing bounds photo uploads across all accounts.** `0006` caps one
   account at thirty signed URLs an hour, which is as many as the report rate
   limit allows anyone to use. It says nothing about the total: sign-up is an
   open magic link, so roughly forty-two accounts could fill R2's free tier in
   an hour. With no payment method on the Cloudflare account the consequence is
   that writes start failing rather than that a bill arrives — so the zero
   budget holds and availability does not. **Do not attach a payment method
   without putting a real ceiling in first.** A global cap is not in yet because
   it trades this for one account being able to deny uploads to everybody;
   invite-only sign-up or a human-raised quota are the better answers and both
   are product decisions. `api/README.md` has the reasoning.
6. **Two of the older rate limits can still be bypassed in one request.**
   `enforce_report_rate_limit` and `enforce_comment_rate_limit` in `0002` are
   row-level BEFORE triggers doing `count(*)`, and a row-level BEFORE trigger
   cannot see the other rows of its own statement — they carry the current
   command id, so the count treats them as not yet inserted. PostgREST posts a
   JSON array as one statement, and `authenticated` can insert into both
   tables, so one request carrying ten thousand rows passes every check. Ten
   reports an hour is not ten.

   `enforce_upload_grant_rate_limit`, `enforce_photo_limit` and
   `enforce_flag_rate_limit` had the same bug and are fixed: `after insert ...
   referencing new table as new_rows ... for each statement`, comparing `> N`
   because the new rows are in the count by then, each behind a
   transaction-scoped advisory lock for the separate concurrency case — a
   count taken per statement still misses a CONCURRENT statement's uncommitted
   rows. `src/lib/db/migrations.test.ts` asserts the statement shape, the
   comparison, the lock, and the table, for all three. The lock was the part
   that went in late: two of the three had it and one did not, while this file
   already said all three did.

   These last two want exactly the same change. They were left out of this
   piece of work because nothing here made them worse, and getting it wrong
   breaks reports and comments rather than uploads.

   Do not count them by hand. `migrations.test.ts` now finds every function
   that counts rows and then refuses on the result, and fails if any of them
   fires per row -- with these two named as the known exceptions. Take a name
   off that list when you fix it. Three rounds of this audit each fixed the
   instances they knew about and then said the sweep was finished; the test is
   there so the fourth round does not have to be a person.
7. **There is no in-app way to take a pin off the map.**
   `mo.reports.moderation_status` governs whether a pin is visible and defaults
   to `'approved'`, and nothing ever writes it: the moderation subjects are
   photo, comment and note, so rejecting a report withholds its picture and its
   text and leaves the coloured cell exactly where it was. A spam or malicious
   pin keeps contributing weight forever, and the only remedy is a `delete` or
   an `update` from the SQL editor.

   Not new — no code path ever set that column — but it was not written down,
   and the audit gate found it while checking something else. The fix is an
   admin-gated `security definer` RPC plus a control in the review queue.
   Deliberately not a column grant: 0003 removed those for letting an admin
   change content status without writing a verdict.
8. **CSAM scanning is not implemented.** None of the four moderation tiers
   address it, and it is a legal obligation rather than a preference. The plan is
   Cloudflare's free scanning tool applied to the R2 hostname serving the photos,
   which is why photos are meant to live in R2 behind Cloudflare.

Nothing is deployed. No Supabase project, no R2 bucket, no Vercel project.

## The original next three steps

Superseded in part by the integration above: steps 1 and 2 are now "apply the
migrations into the wearechintu project" and "attach a custom domain to
chintubucket", because the project and the bucket already exist.

1. **Create the Supabase project** and apply `supabase/migrations/` in order.
   Then make yourself the first admin — the snippet is at the bottom of `0004`,
   under "Admin bootstrap". Without an admin nothing in the review queue can
   ever be resolved.
2. **Create the Cloudflare R2 bucket** behind a Cloudflare-proxied hostname.
   The signing endpoint is written and tested; what is left is the account side
   — bucket, API token, CORS rule, hostname — and then one real upload to
   confirm R2 accepts the signature. Follow `api/README.md`. This unblocks
   photo upload and CSAM scanning together, since both need the same hostname.
   Note that uploads also need migration `0006` applied, or every one of them
   fails closed.
3. **Connect Vercel** and deploy. Note the Vercel MCP server needs authorising
   from an interactive session; it cannot be done from a non-interactive one.

## How this project is worked on

`CLAUDE.md` has the audit gate, and it is not optional. At every milestone,
invoke the `blind-auditor` subagent (`.claude/agents/blind-auditor.md`) with
**only** the original requirement and the list of changed files — never a
summary of what was built. On FAIL or CONCERNS, fix every finding and re-invoke.

This has been worth it. The auditor caught, among others:

- A `className` that never reached the DOM, so the map's cross-fade was a hard
  cut in production and only appeared to work in dev because StrictMode remounts
  each layer.
- `grant select on reports to anon`, which made the column masking in the public
  views decorative — unreviewed photo paths were readable straight off the base
  table.
- `mark_report_cleaned` returning the whole row, letting any signed-in user drain
  every unreviewed note one RPC call at a time.
- Several tests that passed with the behaviour they named deleted.

When fixing a finding, add a **negative control**: break the fix on purpose and
confirm the test fails. Several "fixes" in this history looked right and changed
nothing.

## Hazards worth knowing

- **Line endings.** The repo had mixed CRLF/LF, and scripted edits written with
  LF silently failed to match while reporting success — including two negative
  controls that appeared to prove tests were sound when they had not run at all.
  `.gitattributes` now pins LF. If an edit reports success, verify it landed.
- **`supabaseSource.ts` is still the least trustworthy file in the repo.** None
  of its reads have run against a database. The one exception is `createReport`,
  which now has tests against a fake client
  (`src/lib/data/supabaseSource.createReport.test.ts`) — they pin its control
  flow, including the rollback that removes a report when its photo fails, and
  they prove nothing at all about the SQL.
- **`@types/node` used to arrive by accident.** It was never declared, but npm
  installed it as an optional peer of something else, so `npm run build` passed
  on the machine this was written on and failed with eleven errors on a cold
  `npm install`. It is now an explicit devDependency.
- **There are two tsconfigs, and that is deliberate.** `tsconfig.json` compiles
  `src` and `api` as browser code and does NOT include `"node"` in its `types`,
  so a stray `process` or `Buffer` in app code fails the typecheck instead of
  failing in the bundle. `tsconfig.node.json` covers the three entry points
  that genuinely run in node -- `vite.config.ts` and the two tests that read
  migration SQL off disk. `npm run typecheck` runs both, and `npm run build`
  runs `typecheck`. If a `node:fs` or `process` error appears, the file needs
  to move between the two, not a change to `types`.
- **`tsconfig.node.json` must keep its own `"exclude": []`.** `extends` inherits
  `exclude`, and `exclude` filters whatever `include` resolves — so without
  that override the parent's exclude list dropped those two test files straight
  back out, leaving them typechecked by NEITHER config while both still passed.
  It was silent until an audit went looking. `npx tsc -p tsconfig.node.json
  --listFiles` should list eight files, not one.
- **The bundle is ~887 KB** (~266 KB gzipped), mostly `h3-js`. Fine for now, but
  it will want code-splitting before this is a serious mobile app. The NSFW model
  is deliberately loaded from a CDN at runtime rather than bundled — bundling it
  took `dist` from 0.85 MB to 39.6 MB.

## Decisions that are settled

Do not re-litigate these without a reason; the rationale is in the spec.

- Severity is derived from confirmations, never chosen. There is no severity
  picker and no severity column.
- The pin is public immediately; the note and photos are withheld until
  reviewed. `reports.moderation_status` governs the pin, `note_status` the text.
- Tier 2 may auto-approve a photo but never text: a generic toxicity classifier
  scores "this neighbourhood is a slum" as clean, and that sentence is the exact
  thing MO's own rules forbid.
- A wordlist match escalates rather than rejects. "Litter near Penistone Road"
  matches on `penis`, and Penistone is a real town.
- Withholding flagged content takes two independent people, so one account
  cannot walk the map unpublishing everything.
- The colour ramp runs white → yellow → orange → red, interpolated in OKLCH,
  with opacity scaled by severity so clean areas show the map underneath
  rather than a white fog. Pins never use the very bottom of the ramp, because
  `colorForT(0)` is white and a white pin on a pale basemap is invisible.
