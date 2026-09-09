# Where this project stands

Written 2026-09-09, so a fresh machine — or a fresh Claude Code session — can
pick up without re-reading the whole history.

Read `CLAUDE.md` first for the rules; this file is the state.

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
npm test              # 464 tests
npm run build         # typecheck, then build
cd worker && npm test # 110 tests
```

## What is done

Everything below is built, tested, and committed.

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
| Moderation worker, four tiers, swappable model and host | `worker/` |
| Schema, RLS, RPCs | `supabase/migrations/` |

## What is NOT done

Three things, all blocked on accounts rather than on code:

1. **The database has never been run.** Every migration in `supabase/migrations/`
   is a careful draft that has never touched Postgres. `src/lib/db/migrations.test.ts`
   pins invariants by reading the SQL as text — useful, but it proves nothing
   about whether the schema works. `supabase/README.md` lists the specific RLS
   questions to answer once a project exists.
2. **Photo upload is not connected.** `uploadPhoto` in
   `src/lib/data/supabaseSource.ts` throws on purpose. Uploading to Cloudflare R2
   from a browser needs a short-lived signed URL, which needs a small server
   endpoint holding the R2 credentials. That endpoint does not exist.
3. **CSAM scanning is not implemented.** None of the four moderation tiers
   address it, and it is a legal obligation rather than a preference. The plan is
   Cloudflare's free scanning tool applied to the R2 hostname serving the photos,
   which is why photos are meant to live in R2 behind Cloudflare.

Nothing is deployed. No Supabase project, no R2 bucket, no Vercel project.

## The next three steps, in order

1. **Create the Supabase project** and apply `supabase/migrations/` in order.
   Then make yourself the first admin — the snippet is at the bottom of `0005`.
   Without an admin nothing in the review queue can ever be resolved.
2. **Create the Cloudflare R2 bucket** behind a Cloudflare-proxied hostname, and
   write the signing endpoint. This unblocks photo upload and CSAM scanning
   together, since both need the same hostname.
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
- **`supabaseSource.ts` has no tests.** It cannot run without a database. It is
  the least trustworthy file in the repo.
- **The bundle is ~860 KB** (~260 KB gzipped), mostly `h3-js`. Fine for now, but
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
