# Where this project stands

Written 2026-09-09, so a fresh machine — or a fresh Claude Code session — can
pick up without re-reading the whole history.

Read `CLAUDE.md` first for the rules; this file is the state.

The app is called **tidy** (lower case) wherever a person sees it, as of
2026-09-27. MO stays as the repo's and the code's internal name.

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
| A presigner | `src/lib/r2.js` on the AWS SDK. In the end the map does not use it: it signs with MO's own `shared/sigv4.ts`, because the SDK's presigner adds checksum parameters R2 refuses and drops the signed headers MO relies on |
| Request auth | `src/lib/auth.js` `authenticateRequest` |

**Still missing, and the reason item 8 below is unchanged:** `R2_PUBLIC_URL` is
a `pub-<hash>.r2.dev` address, which is Cloudflare's hostname and not one on
the wearechintu zone. The free CSAM scanning applies to a zone, so it needs a
custom domain attached to the bucket. The existing setup does not satisfy it.
The upload endpoint enforces this: it refuses any `*.r2.dev` photo host and
answers "Photo upload is not set up on this site yet" until the custom domain
is configured. Merging the port therefore cannot switch on unscanned uploads.

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

### Decided 2026-09-26: people choose a name for MO

Sharing accounts would have signed every report and comment with the author's
email prefix: a magic-link signup's `public.profiles.display_name` is
`split_part(email, '@', 1)`, and that table is readable by anon. The user chose
**"pick a name on first post"**, and it is built:

* Before a first report or comment the app asks for a name, kept in
  `mo.display_names` and written only through `mo.set_display_name`. The insert
  policies on reports and comments refuse anybody without one that has not been
  rejected.
* A name is reviewed like a note (moderation subject `'name'`). Once approved
  it is shown on that person's reports ("Added … by Sam") and comments; until
  then reports show no name and comments say "someone".
* `reporter_id` and `author_id` are masked in the public views, because either
  is the key of `public.profiles` and so one request from the email prefix.
  `mo.profile_names` is gone; MO reads nothing from `public.profiles`.

* Readers can report a name from the comment or report it is on
  (`mo.flag_comment_author`, `mo.flag_report_author`), a rename gets a new review job so a stale
  decision cannot land on it, and the judge has its own rules for names.
  `supabase/README.md` has the detail.

### Still open from sharing one account set

Three more consequences, all in
`supabase/README.md`. Two are MO's problem: a marketplace account deletion
would cascade litter reports off the map (seven MO tables reference
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

### The port, as of 2026-09-27

The map is in the wearechintu app at `/map` (its commit `5a76830`), and MO
changes reach it through a script rather than by hand:

```bash
node scripts/sync-wearechintu.mjs ../gitbuddywebsite
```

It copies `src/` into `src/mo/`, MO's upload handler and signer into
`src/mo/server/`, and the migrations in as `010`-`016`, applying the few
changes Next needs as exact replacements. Each replacement is checked to
match, so if MO's code moves under one the script stops and names it instead of
writing something half-converted. Running it twice changes nothing.
`src/mo/README.md` in that repo lists every change it makes. **Edit MO, not
the copies**: the next sync overwrites them.

The latest sync is committed on a local branch, `mo-sync`, in the worktree
`D:\VisualStudioProjects\gitbuddywebsite-mo-sync`. It is not merged, not
pushed and not deployed. That branch also adds what the first port lacked:
`POST /api/map/sign-upload`. The client was already calling that endpoint and
would have had a 404 back. It is a thin route over MO's own handler, which maps
the site's existing variable names (`R2_ENDPOINT`, `R2_BUCKET_NAME`,
`NEXT_PUBLIC_*`) onto what the handler reads. It signs with `shared/sigv4.ts`,
not the site's AWS SDK presigner, so the signed length and `if-none-match`
survive.

Photo keys are now `map/<user>/<report>/<photo>.<ext>` in MO itself, both in
the endpoint and in the `upload_grants` policy. The bucket is shared with the
marketplace, and the prefix keeps the map's objects together.

The first port also changed `next.config.mjs` for `geolocation=(self)`. It
does not add `esm.sh` to `script-src`. Instead the NSFW model is meant to be
self-hosted through `NEXT_PUBLIC_NSFW_MODULE_URL`, which that repo's
`src/mo/README.md` explains.

### Cleaning groups and motion, as of 2026-09-27

* **A "Cleaning groups" tab**, beside "Reports". A group has a name, a short
  description and a home where the map was looking when it was started (zoom
  11 or closer). Anyone signed in with a name can start one, three a day at
  most. Anyone signed in can join or leave one. Only its founder or an admin
  can delete it, and people can report a group like any other post. All of this
  is migration `0007` (wearechintu's `016`), with 'group' branches in the shared
  moderation functions in `0004` and `0005`. `src/lib/db/groups.run.test.ts`
  runs it in PGlite.
* **The name and description are reviewed like a note.** A new group is
  pending and seen only by its founder until the worker (`GROUP_RUBRIC` in
  `worker/src/providers/llmJudge.ts`) or an admin approves it. Two complaints
  hide it again until a person looks.
* **A group's members still see it after complaints take it down**, with a note
  saying why, so they can leave it. Everybody else stops seeing it.
* **On "The idea" side a new group is accepted at once**, because nothing there
  runs the worker. The form says so. On the real side it is checked first.
* **Who is in a group is never shown, only how many.** A member list would be a
  list of people who are in one place at predictable times.
* **Groups edited three earlier migrations in place.** `0001` gained the
  `'group'` value in `mo.subject_type` and in `mo.post_log.kind`, and `0004`
  and `0005` gained 'group' branches. That is safe only because no migration
  has been applied anywhere real. **Check that before applying**: if any of
  wearechintu's `010`-`015` has already run on its Supabase project, `016`
  fails, and those changes have to move into a new migration instead
  (`alter type ... add value` in a file of its own, since Postgres will not use
  a new enum value in the same transaction that adds it).
* **Things fade and slide in and out** (`src/components/Reveal.tsx`): panels
  and the notices inside them (`Reveal`), items leaving a list, such as group
  cards, review items, comments and single pins (`useLingeringList`), and a
  control that changes state, such as Join to Leave or the sign-in panel
  (`Swap`). Pins and group markers fade in and out. With "reduce motion"
  switched on, nothing moves.

### The globe, as of 2026-09-28

* **The map is MapLibre GL now, not Leaflet.** Zoomed out it is a globe in
  space, with the night side shaded from the real position of the sun
  (`src/lib/geo/daylight.ts`). Coming in, it turns smoothly into a flat map
  between MapLibre zoom 3 and 5 (`src/lib/map/view.ts`). The basemap is
  OpenFreeMap's "liberty" style: free, and it needs no key.
* **Litter reports stand as 3D towers** on the globe, taller and redder where
  more people reported, and lie flat up close. The map draws only what
  `src/components/map/GlobeMap.tsx` is handed. How each thing looks is decided
  in `src/lib/map/features.ts`, which is tested. MapLibre needs a graphics
  card, so the app's tests use `src/test/globeMapMock.tsx` instead.
* **Zoom numbers:** the app still counts zoom the way it did under Leaflet.
  MapLibre's numbers are one lower for the same view, and
  `toAppZoom`/`toLibreZoom` convert at the map's edge.
* **Hexagons shrink steadily with zoom** (`src/lib/grid/zoomResolution.ts`): at
  every zoom, the H3 size (1 to 7) whose edge is nearest 24 pixels on screen
  at the equator. The switch points are worked out from h3's own sizes, so
  every size covers the same 1.4 zoom steps and stays between about 15 and 39
  pixels there. Further from the equator the flat map draws everything
  larger, hexagons with it (about 1.6 times at London); the size is set by the
  zoom alone, so panning never swaps the grid. The list
  and outline of a picked area go away when the size changes or litter is
  switched off. That needed resolutions 2, 4 and 6 stored with every report too,
  added to `0001`, `0003` and `0004` in place (see the note on groups below
  about editing migrations). Dots appear from zoom 12, city level. Placing a
  report still needs zoom 15, `REPORT_PLACE_ZOOM`.
* **Clicking a tower lists its reports** on the right (`CellCatalog`), most
  confirmed first. Each opens the report and flies there. The list is asked of
  the hexagon itself (`listReportsInCell`, and `mo.reports_in_cell` in `0004`,
  edited in place like the other `0004` changes), not the box round it, with
  every filter, distance included, applied before the page is cut.
  On a phone it is a sheet along the bottom.
* **Night** is 19 bands, a degree apart from sunset to 18 degrees below the
  horizon, each a circle round the point opposite the sun
  (`src/lib/geo/daylight.ts`). They build to about four-fifths dark on the
  globe, ease off as the map flattens, and are gone by street level
  (`NIGHT_OPACITY`). They lie under the place names. What the app draws on
  top -- towers, country slabs, fires, the flat tint -- is darkened by the
  same amount where it stands (`withNight` in `src/lib/map/features.ts`,
  `BY_NIGHT` in `GlobeMap.tsx`), and re-coloured each minute as night moves. Space behind the globe is
  black.
* **If the basemap does not load** (OpenFreeMap down, or offline), the map says
  so in words rather than staying black.
* **Layers**, in the panel at the bottom right: litter reports and cleaning
  groups each switch on and off. World data is one layer at a time: air
  pollution (WHO, via Our World in Data), plastic into the ocean (Meijer et al.
  2021, via Our World in Data), and fires in the last 24 hours (NASA FIRMS).
  All free and keyless. NASA's file cannot be fetched from a browser on
  another site, so it comes through the Vite dev server here (`vite.config.ts`)
  and through `/api/map/fires` on wearechintu. Country outlines are Natural
  Earth, slimmed, in `public/data/countries.geojson`. Fires are grouped on the
  same hexagons as the litter at each zoom, and stand below the lowest litter
  tower. Litter towers are drawn a little inside their hexagons
  (`TOWER_INSET`), so no two 3D walls -- neighbours, or a fire on the same
  hexagon -- ever stand in one place and flicker. As the map flattens, the 3D slabs hand over to a flat 2D tint
  (`mo-world-flat`) under the litter, so nothing flickers at one height. A
  layer left on is asked for again every hour (fresh ones answer from the
  cache), and a failed one has a "Try again" button. Every map layer is
  checked against MapLibre's style validator in `GlobeMap.test.tsx`.
* **Quality of life and water quality** are map layers too: the UN's Human
  Development Index (0 to 1) and the share of rivers, lakes and groundwater in
  good condition (UN goal 6.3.2). Both via Our World in Data, read by a named
  column (`COUNTRY_COLUMNS` in `sources.ts`), since those files carry more
  than one figure.
* **Findings** is the third tab (`src/components/findings/FindingsPanel.tsx`):
  does quality of life go with a healthier environment? Across every country
  with the figures -- quality of life, wealth (GDP per person), air, plastic
  not handled properly per person, water quality, and fires per 10,000 km² of
  land on the day -- it gives each link by rank (Spearman), how likely it is
  luck, and the same link with wealth held level (partial rank correlation),
  plus the middle figure in each of the UN's quality-of-life bands, a chart,
  and every pair. The maths is in `src/lib/worlddata/stats.ts` (tested against
  textbook values), the findings and their sentences in `findings.ts`, the
  loading in `useFindings.ts`, fires per country in `src/lib/geo/countries.ts`.
  It says plainly that a link is not a cause. On today's figures: better
  quality of life goes with cleaner air (moderate) and less plastic dumped or
  burned (strong), and both keep a link with wealth held level; water quality
  runs the other way, weakly, which wealth accounts for, and most likely
  because richer countries test more of their water; fires show no link.
  Quality of life and wealth move almost together (0.96), so holding wealth
  level leaves little room.
* **Findings has two views.** *Explore* is plain words and clicking: pick a
  part of the environment, read the answer, see it on a bar from −1 to +1 with
  the range it most likely lies in, compare only countries of similar wealth
  (GDP quarters, `withinWealth`), hover or search the chart for a country.
  *Research paper* (`src/lib/worlddata/research.ts`) is the formal write-up
  built from the same numbers when it is opened: abstract, hypotheses, data
  and sources, methods (Spearman; partial Spearman on GDP; Fisher-z 95%
  intervals with the Fieller-Hartley-Pearson standard error; Bonferroni over
  the eight main tests; Kruskal-Wallis across the UN's bands), six results
  tables, discussion, limitations, reproducibility, references and a
  glossary. It downloads as Markdown, and the country data as CSV. It is the
  one place that uses statistical terms, because a formal write-up needs them;
  the glossary defines each.
* **The introduction** (`src/components/intro/HighlightReel.tsx`) plays on a
  first visit, remembered in localStorage (`tidy:introduction-seen`): an
  animated "Welcome to tidy", then one big figure at a time -- air above the
  WHO's safe limit, plastic into the ocean, fires today, water in good
  condition, what goes with a cleaner planet -- each with what is behind it
  and its source, worked out live in `src/lib/worlddata/highlights.ts`, then
  "Litter is local. So is cleaning it up." Next, Enter or the arrow keys move
  on; Skip or Escape end it. Then the globe flies in from far out and the
  panels slide in from the edges (`.mo-enter`, `data-entered` on `main`).
  Tests that inject a data source get the bare map unless they pass
  `intro`. Forest-and-leaves styling: `.mo-reel` in `src/index.css`.
* **About** (`src/components/about/AboutPanel.tsx`), beside the name: why
  tidy exists, in the maker's own words, a Share button (the share sheet, or
  the link copied) and "Watch the introduction again".
* **Saved copies** of every source -- the three layers above, quality of life,
  water, GDP per person and plastic per person -- sit in
  `public/data/*-saved.csv`, dated by `SAVED_ON` in
  `src/lib/worlddata/sources.ts`. They are used only when the live file cannot
  be reached, and the app says so, with the day. Refresh them with
  `node scripts/save-world-data.mjs` (it reads its addresses from
  `sources.ts`), then sync.
* **Panels** are frosted glass (`.mo-glass` in `src/index.css`) over the globe
  in space (`.mo-space`).

### Next, in order

1. **Review and merge `mo-sync`** in the wearechintu repo. It is on a branch
   precisely so that happens on purpose.
2. **Add `mo` to the project's exposed-schemas list** in the Supabase
   dashboard, under API settings. This is one checkbox, and nothing works
   without it. PostgREST answers every read, every RPC, the upload endpoint's
   grant insert and the whole worker pipeline with 406 `PGRST106` ("The schema
   must be one of the following"). Applying the migrations is not enough on its
   own. That is easy to miss, because everything else about this is SQL.
   In the same dashboard, under Authentication and URL configuration, add the
   site's `/map` address to Redirect URLs. The sign-in email links back to the
   page it was asked for from, and Supabase sends any address not on that list
   to the Site URL: the home page, where nothing picks the sign-in up.
3. **Apply migrations `010`-`016`** to that project, then make yourself the
   first admin (the snippet is under "Admin bootstrap" in `013`/`0004`).
   Then set `NEXT_PUBLIC_MAP_LIVE=true` on the site. Until you do, the map's
   "Real world" side says it is not connected and asks the database nothing,
   because the Supabase keys there belong to the store and exist before the
   map's tables do.
4. **The R2 CORS rule** has to allow `PUT` from the site with the
   `content-type` and `if-none-match` headers. Then do one real upload. That is
   the first time R2 sees MO's signature.
5. **Attach a custom domain to `chintubucket`** so Cloudflare's CSAM scanning
   applies (item 8 below), switch the scanning on, and set
   `NEXT_PUBLIC_PHOTO_BASE_URL` to it. Uploads stay refused until then:
   the endpoint will not accept an `r2.dev` photo host. So step 4's real
   upload waits on this step too.

   **A custom domain serves the whole bucket, not only `map/`.** R2's public
   access has no prefix setting, so the new hostname also serves the
   marketplace's private `artifacts/` downloads to anyone who knows a key. Add
   a Cloudflare rule on that hostname that blocks every path not starting
   `/map/` (a WAF custom rule on the zone is free). The marketplace's `covers/`
   are served from its own r2.dev address, which is also bucket-wide, so
   `artifacts/` may already be reachable there. That is the marketplace's to
   check, and it is not something MO created.

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

No accounts or keys needed. A switch at the top of the map moves between two
sides:

* **The idea** (violet) is 20,000 made-up reports clustered around 39 cities,
  and three made-up cleaning groups in each.
  Add `?count=` to the address for more or fewer. It shows how the map looks
  at scale, and you can try everything there, signed in as a made-up visitor.
* **Real world** (green) is the database. With no Supabase configured it is
  empty and says it is not connected, and it offers no sign-in and no way to
  add a report.

The choice is kept in the address as `?world=idea` or `?world=real`. See
`src/lib/data/worlds.ts` and `src/lib/data/largeDemo.ts`.

```bash
npm test              # 1338 tests, including real Postgres via PGlite
npm run build         # typecheck, then build
cd worker && npm test # 138 tests
```

## What is done

Everything below is built and tested. `git status` is the list to trust for
what is not committed yet. The upload endpoint, migration `0006` and the move to
the `mo` schema were committed in `a03272a`. When committing new work, check for
untracked files as well as modified ones: several pieces of this project are
new files that a `git commit -a` would leave behind, and the build breaks
without them.

| Area | Where |
|---|---|
| H3 grid: one resolution per zoom step, nine nested cells per report | `src/lib/grid/` |
| Derived severity: weight from reports + votes, relative ranking | `src/lib/severity/` |
| Colour ramp, OKLCH | `src/lib/color/ramp.ts` |
| Globe to flat map, basemap, night, towers, dots, groups, fly-to | `src/components/map/GlobeMap.tsx` |
| Tower and dot shapes, cross-fades, zoom numbers (tested without a browser) | `src/lib/map/` |
| The list behind a tower | `src/components/map/CellCatalog.tsx`, `mo.reports_in_cell` in `0004` |
| World data: air, ocean plastic, fires, saved copies | `src/lib/worlddata/`, `public/data/`, `scripts/save-world-data.mjs` |
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

1. **The database has run, but only in PGlite, never on Supabase.** Since
   2026-09-26, `src/lib/db/migrations.run.test.ts` applies all the migrations
   to a real Postgres in process (PGlite, `src/lib/db/pgHarness.ts`) and
   exercises them as `anon`, `authenticated` and `service_role`. They applied
   cleanly first time. What that does NOT cover: PostGIS (a small stand-in
   provides `st_dwithin` and friends), Supabase's own `auth` schema (a stand-in
   `auth.uid()`), PostgREST, and the exposed-schemas setting. So apply them to
   the real project before trusting them, and work through the RLS questions in
   `supabase/README.md` there. `migrations.test.ts` still reads the SQL as text
   for invariants that are about wording rather than behaviour.
2. **Photo upload is written but has never reached R2.** The endpoint exists:
   `api/sign-upload` verifies the caller with Supabase, decides the object key
   itself, and signs a two-minute PUT with the type and the exact byte length
   baked into the signature. The signature is pinned against AWS's own
   published example, so the maths is proven. What is NOT proven is that R2
   accepts it: nothing has been uploaded to `chintubucket` yet. `api/README.md` says what has to
   exist — a bucket, a CORS rule, a Cloudflare-proxied hostname — and names
   the two things most likely to need adjusting on first contact: the signed
   `content-length` and `if-none-match` headers. Neither may simply be deleted.
   `content-length` is the only thing enforcing the 8 MB cap, and
   `if-none-match` is the only thing stopping a signed URL being reused to swap
   the bytes after they have been judged.
3. **R2 cleanup: written 2026-09-27, never run against a real bucket.**
   Uploads that never became a photo, photos whose row was deleted, and photos
   that were REJECTED are now deleted from R2 by the worker. The last matters
   most: the database withheld a rejected path, but the bytes stayed on a
   public hostname and the uploader holds the key, so rejection only withheld
   the row.

   * **What decides.** `mo.claim_objects_to_delete` in `0006`, working from MO's
     own `upload_grants` -- never from a listing of the bucket. `chintubucket`
     is shared with the marketplace; every object MO writes has a grant and
     nothing else does, so the worker never looks at anything MO did not write.
     Unused uploads wait an hour (the upload URL lives two minutes); rejected
     photos are held for thirty days first, so an admin can reverse a wrong
     automatic rejection -- a choice made on 2026-09-27. The review queue
     lists photos removed in the last thirty days, says whether a machine or a
     person removed each, and offers "Allow after all"
     (`mo.admin_allow_rejected_photo`), the ones due soonest first. The hold
     runs from a photo's FIRST rejection (`report_photos.rejected_at`), so a
     complaint and a fresh rejection -- from any account -- cannot restart it;
     an open complaint does keep the bytes until a person rules on it. Nobody
     can complain about their own post. Photos on a pin taken off the map are kept, since
     the pin can be put back.
   * **How it stays safe.** Claiming an object retires its grant under a row
     lock, so a photo can never be linked to bytes that are gone or going. A
     failed delete is offered again after ten minutes. All of it runs against
     real Postgres in `src/lib/db/cleanup.run.test.ts`.
   * **The worker.** `worker/src/cleanup.ts` carries the list out every ten
     minutes, signing each DELETE with the SigV4 signer now in `shared/`
     (moved from `api/_lib`, still pinned against AWS's published example).
     It needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
     `R2_BUCKET` -- a token that may delete in that bucket -- and warns at
     start-up without them. The worker now needs `shared/` beside it.

   **Still to verify:** that R2 accepts the signed DELETE, on first contact
   with the bucket, exactly as for the upload signature in item 2. And the row
   locks that keep the cleanup from racing a photo being linked, or a
   complaint reopening a rejected photo, are proven by reading the SQL only:
   PGlite has one connection, so nothing here runs two sessions at once. The
   claim locks its candidates first and then re-decides them in a fresh
   statement, which is what Postgres's default isolation needs for those locks
   to mean anything.

   A deletion is final. A rejected photo can be complained about -- and so
   reopened -- for its thirty-day hold, until the cleanup claims it; after
   that, complaints about it are refused rather than bringing back a broken
   image. Whether anything must be preserved rather than deleted (item 8, if
   CSAM scanning ever reports something) is a legal question, not answered
   here.
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
6. **Rate limits: fixed in code on 2026-09-26, one check left for the real
   database.** This item used to say the report and comment limits could be
   bypassed in one request, because a row-level BEFORE trigger "cannot see the
   other rows of its own statement". That is false: Postgres documents that
   such a trigger sees rows already processed by the same command, and the
   PGlite harness confirmed it -- eleven reports in one insert were refused by
   the old per-row triggers. Three earlier rounds rewrote three other limits
   to fix a bug that did not exist.

   The real gaps were two others, both now closed in the migrations:

   * **Deleting your own posts reset the limit.** The report and comment limits
     counted live rows, and people can delete their own reports and comments,
     so "post ten, delete, post ten more" had no end. The flag limit reset the
     same way, because deleting a comment deletes the flags on it and you can
     flag your own. All three now count `mo.post_log`, which the triggers
     write and no browser role can read or delete. `migrations.run.test.ts`
     proves it for each: ten reports deleted and the eleventh still refused,
     and the same for comments and flags.
   * **Simultaneous requests could all pass.** The report and comment limits
     took no lock. All five counting limits now share one shape --
     statement-level, advisory lock per person before the count, `> N` -- and
     `migrations.test.ts` finds every counting trigger by what it does and
     fails if one counts without the lock.

   **Still to verify:** PGlite runs on one connection, so no test here has
   ever sent two requests at once. Against the real project, thirty
   simultaneous inserts should stop at the limit. Until that has been tried,
   the lock is proven by reading the SQL, not by running it.

   The comments in `0002`, `0005`, `0006`, `api/README.md` and
   `supabase/README.md` that repeated the false reason are corrected.
7. **Done 2026-09-26: an admin can take a pin off the map, and put it back.**
   `mo.admin_set_report_on_map` (0005) is the only writer of
   `reports.moderation_status`. It refuses non-admins, and asking for the
   state a pin is already in changes nothing, so a double click or two admins
   at once cannot overwrite who took it off or why.

   * **What it hides.** A pin off the map is sent only to its reporter and to
     admins, through its own query (`listOffMapInView`, with the same filters
     as the live pins), so it never takes a place in the main page of pins or
     counts as a report on the map. Its photos and comments go with it (the public views check the
     pin), it drops out of the colours and the counts, and it takes no votes,
     no "cleaned", no new comments, no new photos and no new upload URLs.
     Votes, comments, photos and "cleaned" are each refused in words -- the
     report is off the map -- rather than reading as "choose a name", "you
     cannot confirm this" or "already cleaned".
   * **Who can still find it.** Its reporter sees it greyed out and dashed, with
     a notice that it was taken off, and comments are closed. Admins see it the
     same way, and the review queue lists the pins off the map, most recently
     taken off first, fifty at a time and saying so when there are more, each
     with "Put back on the map". Each queue item carries its pin's state from
     the database (`pin_on_map` in `admin_moderation_queue`), so an item on a
     pin that is already off says so however old the removal, and the whole
     queue is re-read when a pin is changed from a report's screen. On the map,
     off-map pins are drawn a hundred per viewport; when the database returned
     more than that, or they failed to load, the map says so rather than
     showing fewer.
   * **The record.** `reports.removed_by`, `removed_at` and `removal_reason`
     describe the current removal. `mo.pin_history` keeps every change,
     including putting a pin back, which clears the others -- and it holds the
     report id as a plain value, not a foreign key, so it survives the reporter
     deleting the report. The reason is what
     the admin typed on the report, or nothing -- never a stand-in. The queue
     records none; `pin_history` still says who and when.

   All of it runs against real Postgres in `migrations.run.test.ts` and
   `pinPhotos.run.test.ts`, and through the whole app in
   `App.offMap.test.tsx`.
8. **CSAM scanning is not implemented.** None of the four moderation tiers
   address it, and it is a legal obligation rather than a preference. The plan is
   Cloudflare's free scanning tool applied to the R2 hostname serving the photos,
   which is why photos are meant to live in R2 behind Cloudflare.

Nothing of MO's is deployed. The wearechintu site, its Supabase project and
`chintubucket` exist and are live, but the map is only on the local `mo-sync`
branch: none of its migrations are applied and no photo has been uploaded.

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
  --listFiles` should list twelve of the project's own files, not one.
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
