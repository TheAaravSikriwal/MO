# Database

Schema, policies and RPCs for MO. Six migrations, applied in order.

## Where this goes

**Into the wearechintu project's existing database, in a `mo` schema.** MO runs
as a route inside that Next app, so it shares the database rather than having
one of its own.

That is not a tidiness preference. The marketplace side already has
`public.reports` — abuse reports against projects — and `public.profiles`.
A litter report and an abuse report are not the same thing and must not be the
same table, and nothing about the collision fails loudly: MO's `create table
reports` either hits a table full of somebody else's rows or ends up being read
by one feature and written by the other.

So everything MO owns is `mo.*`, and two things follow:

1. **`mo` must be in the project's exposed-schemas list** (Supabase dashboard,
   API settings). Until it is, every request comes back 406 with "The schema
   must be one of the following", whatever the client sends.
2. **MO does not own profiles.** chintu's `handle_new_user` trigger already
   inserts a `public.profiles` row for every auth user, so MO references that
   table and creates nothing. MO never reads a name from it — see below.

**PostGIS has to be enabled, and NOT in `public`.** `0001` installs it `with
schema extensions`, which is where Supabase keeps extensions and where the
dashboard would put it. Without the clause, `create extension` lands in the
first existing schema on the search path — `public`, because `mo` does not
exist yet — so MO would drop PostGIS's types and its thousand-odd functions
into the marketplace's schema. `0001` and `0004` set `search_path = mo, public, extensions` at file level,
because those two are where PostGIS is touched at parse time — `0001` declares
a `geography` column, and `0004`'s rollup functions are `language sql`, whose
bodies Postgres validates at CREATE time against the session's path rather
than the function's own SET clause. The other four set `mo, public`, which is
all they need.

**The worker needs its own grants, and reading is not enough.** It connects as
`service_role`, which a brand-new schema gives nothing at all: Supabase's
default privileges are scoped to `public`, and BYPASSRLS is not a grant. Four
things together make it work, and the first three alone do not:

1. `0001` grants `usage on schema mo`.
2. `0003` grants `select` on the tables it reads directly — the queue, a
   photo's storage path, and a note or comment's text.
3. `0004` grants `execute` on the three worker RPCs by name, necessary because
   revoking them from `PUBLIC` removes service_role's implicit execute too.
4. **Those three RPCs are `security definer`.** They update `moderation_jobs`,
   `report_photos`, `comments` and `reports`; run as the caller they would need
   DML on all four, which service_role has not got. This is the step that was
   missing at first, and the symptom was the whole pipeline failing on its very
   first statement while every test stayed green.

The single exception is `Queue.fail()`, which writes `moderation_jobs` without
an RPC. `0003` grants it `update` on four named columns — deliberately not
`verdict`, so the worker cannot overwrite a decision a machine or a person
already made.

**Names: each person chooses one for MO, and it is reviewed.**

Sharing accounts would otherwise have published a name derived from each
reporter's email address. MO signs people in with a magic link, and chintu's
`handle_new_user` sets `display_name = split_part(NEW.email, '@', 1)` for
exactly that case, in a table anon can read. Three things close it:

1. **MO reads no name from `public.profiles`.** `mo.profile_names` is gone.
   Before someone's first report or comment the app asks them to choose a name,
   stored in `mo.display_names` (0001), written only through
   `mo.set_display_name` (0002). The report and comment insert policies require
   one that has not been rejected (`mo.has_display_name()`).
2. **A name is reviewed like a note.** It is a moderation subject (`'name'`,
   keyed by the person's id). Other people see "someone" until it is approved.
   Tier 2 never approves text, so a name is settled by the tier 3 judge or by a
   person. Changing it sends it back to review, so it is limited: an accepted
   or pending name once a day, and at most three new names a day in all, so a
   rejected name can be fixed straight away but not retried endlessly. Names
   are never flagged by a direct insert (`flags_insert_own` refuses them), and
   nobody can complain about their own.
3. **The ids are masked.** `public_reports.reporter_id` and
   `public_comments.author_id` come back only to their owner and to admins,
   and null to everyone else. Either id is the key of `public.profiles`, so
   publishing it would publish the email prefix one request away, whatever MO
   itself displays. `public_reports.reporter_name` and
   `public_comments.author_name` carry the approved name instead.

**Complaints about a name** go through `mo.flag_comment_author` or
`mo.flag_report_author` (0005), depending on where the name was seen. A reader
never has the author's id, so they name the comment or the report instead, and
the function files an ordinary `'name'` flag against its author — validated, rate
limited, reopened for review, and withheld after two people, like any other
flag. It returns nothing, and neither browser role can select from
`mo.flags` at all, so the id never leaves the database. (A select grant scoped
to your own rows would hand it back: that was how it leaked before.)

**Renaming gets a new review job**, not a reset of the old one. A name is the
only content that changes after it is queued, and a reset job let a decision
about the old text land on the new one: `admin_decide_moderation` checks only
that the verdict is null. With a new job id, an admin's open queue or a
worker mid-judgement is holding a job that no longer exists, and both refuse.

**The judge has separate rules for names** (`NAME_RUBRIC` in
`worker/src/providers/llmJudge.ts`). The report rules reject anything
"unrelated to litter", which every name is.

**A marketplace account deletion would take litter data with it.** Seven MO
tables reference `public.profiles` with `on delete cascade`: `reports`,
`comments`, `votes`, `flags`, `admins`, `display_names` and `post_log`.
(`upload_grants` does not: it sets `user_id` to null instead, so the R2 cleanup
can still find and delete that person's photos. `pin_history.acted_by` also
sets null.) So a "delete my
account" feature on the marketplace side — which does not exist today — would
remove that person's reports from the map rather than merely detach them, and
could delete the last row of `mo.admins`, which `0004` says there is no in-app
way to recreate.

`0006` already warns about one narrow consequence of that cascade (it resets
the upload-grant counter). The broader one is the same mechanism: if account
deletion is ever built, decide first whether a report should outlive its
reporter. `on delete set null` on `reporter_id` would keep the map intact, and
is the same one-word change `upload_grants.report_id` already uses for the same
reason.

**A ban on the marketplace does not reach MO.** chintu's
`profiles.publish_tier` has a `'banned'` value and nothing in `mo` consults it,
so a banned account can still file reports, comment, flag and request upload
URLs. That is the honest state of "one set of user accounts": it shares
identity, not standing.

Linking them means a `mo.is_banned()` helper alongside `mo.owns_report()` —
SECURITY DEFINER, reading `public.profiles.publish_tier`, called from the
insert policies. Not an `exists` clause in the policies themselves: a policy
runs with the caller's privileges, and `src/lib/db/migrations.test.ts` refuses
any policy that selects from `public.profiles` for exactly that reason. It is a
decision about whether the two moderation models should be joined, not an
oversight to patch quietly.

**And one consequence that runs the other way: an MO signup is a marketplace
signup, and it arrives broken.** This is the only one of these that affects the
marketplace rather than MO, and it is live the moment anybody signs in through
the map.

MO signs people in with a magic link, so `handle_new_user` writes their profile
with `github_account_created_at = NULL`. The marketplace's publish gate fails
closed on NULL (`src/app/api/projects/commit/route.js`) and answers *"Account
too new to publish. Your GitHub account must be at least N days old."* So
somebody whose account originated on the litter map is permanently blocked from
publishing, and told it is because of a GitHub account they never had.
`protect_profile_admin_fields` makes that column writable only by the service
role, so there is no in-app remedy.

The backfill the marketplace already plans for itself makes it worse in the
other direction. The comment above that gate proposes
`UPDATE profiles SET github_account_created_at = created_at WHERE
github_account_created_at IS NULL`, which would date every MO account from its
map signup and grandfather it straight through the age check — so MO's open
magic-link sign-up quietly becomes a sign-up path into the marketplace, which
is the thing that gate exists to prevent.

Neither is MO's bug, and neither is fixable from MO's code. They are what
"one set of user accounts" means in both directions, and whoever owns the
marketplace side needs to decide: either that gate learns about accounts with
no GitHub history, or the two features stop sharing `auth.users`.

Moderators live in `mo.admins`, not in a `role` column on `public.profiles`.
Adding a column would have put MO's moderation model in the marketplace's
table; a separate table can be revoked outright, so the moderator list is
ungranted rather than merely unreadable.

> **These migrations have run only in PGlite, never on Supabase.** MO's suite
> applies them to a real Postgres in process and exercises them as `anon`,
> `authenticated` and `service_role`, but with small stand-ins for PostGIS and
> Supabase's `auth` schema, and without PostgREST. Expect to fix something on
> first apply, and verify the policies against the real database before
> trusting them.

## Files

| File | Contents |
|---|---|
| `0001_init_schema.sql` | Extensions, enums, tables, indexes |
| `0002_functions_triggers.sql` | Vote counts, moderation queueing, rate limits, `is_admin`, cleaned RPC |
| `0003_views_and_rls.sql` | Public views, row-level security, column grants |
| `0004_rollup_and_worker_rpc.sql` | Map rollup, near-me, the worker's queue interface |
| `0005_admin_queue.sql` | The admin review queue, and the triggers that make a complaint reach a person |
| `0006_upload_grants.sql` | The record and rate limit behind every signed photo upload URL |

## Applying them

**Apply the renumbered copies in the wearechintu project, not these files.**
chintu's database already has `001` to `009`, and MO's files are `0001` to
`0006`, which sort BEFORE all of them as strings. The Supabase CLI compares
migration versions as text and will refuse them as out-of-order.
`scripts/sync-wearechintu.mjs` copies them into
`gitbuddywebsite/supabase/migrations/` as `010_` to `015_`. There is no
`supabase/config.toml` in MO, so the CLI has no project to push to from here.

Either paste each renumbered file into the Supabase SQL editor in order, or let
that project's CLI setup push them like any other migration.

Then create the first admin — see the bottom of `0004`. Nothing can be reviewed
until you do, because ambiguous content escalates to a human and there is no
human until an admin exists.

## The shape of it

**Severity has no column.** There is no `severity` field anywhere, because
nobody chooses it. An area's colour comes from `reports_rollup`, which sums
`1 + vote_count` over open, approved reports. Marking a report cleaned removes
it from that sum, so a cleanup visibly cools the map.

**One person, one vote.** The primary key on `votes (report_id, user_id)` is the
anti-stuffing control — not application logic, which can be bypassed. You also
cannot vote on your own report; the report already contributes its own weight,
so self-voting would let one person count twice.

**Signed uploads are limited here, not in the endpoint.** `upload_grants` exists
because `api/sign-upload` had no way to bound itself. It counted the photos
already on the report, which sounds like a limit and is not one: that count only
rises when the client inserts a photo row, and a caller who never inserts can
sign and upload 8 MB in a loop forever. Recording each grant is what makes it
countable, and the trigger on that table is what makes it enforced — the same
reasoning as the vote primary key. The endpoint inserts with the caller's own
token, so the policy pins `user_id` to `auth.uid()` and it cannot exempt
itself.

A grant is not proof that the endpoint issued a key: `authenticated` can insert
one directly, because the endpoint writes with the caller's own token rather
than a service role key. What makes it useful is that each object can be
granted once (`upload_grants_storage_path_key`) and linked once (`linked_at`),
and that the insert policy pins the key to the caller's own prefix.

The grant deliberately outlives the report: `report_id` is nullable with
`on delete set null`, because the trigger counts live rows and a reporter may
delete their own report. Cascading would have made the limit resettable by the
person it limits — sign thirty, upload, delete, repeat — and a cascade runs
without consulting RLS, so no policy would have stopped it.

**Six cells per report.** `cell_r1` through `cell_r12` are H3 ancestors of the
same point, computed client-side. Zooming out changes which column the rollup
groups by. This is why a world view is one indexed `GROUP BY` and not a
geometry query, and why no Postgres H3 extension is needed.

Postgres cannot recompute those cells without that extension, so `lat`/`lng`
stays authoritative and the cell columns are a display index derived from it.
The format `CHECK` is a sanity guard, not a correctness guarantee — a malicious
client could submit well-formed cells that don't match its coordinates. The blast
radius is its own report appearing in the wrong bucket.

**Pins are public; words and pictures are not.** A report's location goes live
immediately so the map stays alive, but its note is withheld until approved and
its photo path is withheld until approved.

That second point is a deliberate departure from the spec. The spec called for
the client to blur a pending photo — but a blur is CSS, and anyone can strip it
or read the URL out of the network tab. `public_report_photos` returns `null`
for `storage_path` until a photo is approved, so nobody can *discover* an
unreviewed image through this database. `moderation_status` still comes through,
so the UI knows to show a "not reviewed yet" placeholder.

**This withholds the path, not the bytes.** An earlier version of this file said
an unreviewed image was "genuinely unreachable", and that was true when photos
were going to live in Supabase storage. They live in an R2 bucket served from a
public Cloudflare hostname now, so anyone *holding* a key can fetch the object
whatever this view says — and `api/sign-upload` hands the key to the uploader, so
they always hold their own. The keys are unguessable (three UUIDs), the bucket
must not be listable, and nobody else is given a pending or rejected path. But a
photo a human rejected stays retrievable by whoever uploaded it until the
worker's cleanup deletes the bytes (`claim_objects_to_delete` in `0006`; see
"R2 cleanup" in MO's `HANDOFF.md`). That has not yet run against a real bucket.

**Read through the views, because there is no other way.** `public_reports`,
`public_report_photos` and `public_comments` are the ONLY public read path.
`anon` and `authenticated` hold no SELECT grant on `reports`, `report_photos` or
`comments` at all — the single exception is `select (id) on reports`, which
exists because supabase-js turns an insert into `INSERT ... RETURNING id`.

An earlier version granted plain SELECT on those tables and relied on the views
to mask columns. That masking was decorative: `select storage_path from
report_photos where moderation_status = 'pending'` handed an unreviewed photo to
a signed-out visitor. The column was unlinked, not withheld. The views are
therefore SECURITY DEFINER and carry the visibility rules themselves, including
the author's right to see their own rejected content.

**A pin and its note are judged separately.** `reports.moderation_status` governs
the pin, and defaults to `approved` — a location with litter on it is not itself
objectionable, and the map has to stay alive. `reports.note_status` governs the
free text, and defaults to `pending` unless there is no note. Rejecting an
offensive sentence withholds the sentence; it does not erase the report.

**A complaint puts something back in front of a person.** Inserting into `flags`
fires two triggers: one clears the item's verdict so it re-enters the queue, and
one withholds the content again while it waits. Without them, flagging changed
nothing at all — already-approved content kept its verdict and stayed live no
matter how many people reported it.

## Verifying the policies

RLS is only meaningfully testable against a live database. The questions worth
answering, each of which should FAIL:

- Can an anonymous visitor insert a report?
- Can user A delete user B's report, or edit their comment?
- Can a user add themselves to `mo.admins`? (There is no `role` column to set
  any more; the moderator list is its own table.)
- Can a user insert a report with `moderation_status` already `approved`?
- Can a user vote twice on one report, or vote on their own?
- Can a non-admin read `moderation_jobs`?
- Does `storage_path` come back non-null for a pending photo?
- Can a user read `upload_grants`, or insert one against somebody else's
  report, or with a `user_id` that is not their own?
- Can a user read `mo.admins`, or add themselves to it? Both must fail: the
  table is revoked from both browser roles and has no policy at all.
- Can a signed-out visitor get a `reporter_id` or `author_id` that is not null
  from `public_reports` or `public_comments`? Can they see a name that is still
  pending?
- Can a user post a report or a comment before choosing a name, or after it is
  rejected?
- Can a user read or write another person's row in `mo.display_names`?
- After "Report this name", can the reporter read back the flag's
  `subject_id`? They must not: it is the author's id.
- Does anything in `mo` resolve to a table in `public`? `mo.reports` and
  `public.reports` are different tables owned by different features, and the
  only thing keeping them apart is the schema.

And these should SUCCEED:

- Can an anonymous visitor read approved reports and call `reports_rollup`?
- Can an author see their own rejected report?
- Does `vote_count` match the row count in `votes` after inserts and deletes?
- Does `reports_rollup` return nothing for a report once it is cleaned?
- Does creating a report still work? `createReport` chains `.select('id')`
  onto its insert, which makes it `INSERT ... RETURNING id` and needs
  `grant select (id) on mo.reports`. Without it every submission fails. Note
  this is not something supabase-js does by default: a bare `.insert()` asks
  for nothing back, which is why `report_photos` and `comments` need no select
  grant at all.
- Does a report with no note become visible immediately, rather than waiting
  for a moderation job that is never created?
- Does flagging an approved comment put it back in the admin queue, while
  leaving it visible until a second person flags it too?
- Does a machine verdict on a flagged item escalate instead of publishing?
- Does deleting a report clear its moderation jobs and flags?
- Does rejecting a note leave the pin on the map?
- Does the 31st `upload_grants` insert in an hour fail, and the 30th succeed?
- Does ONE insert of a 40-row array fail? It should, and PGlite says it does
  for reports and comments. (An earlier version of this line said a row-level
  trigger could not see the other rows of its own statement; that is false.)
- Do thirty simultaneous inserts still stop at thirty? This is the check that
  matters, and the one no test here can make: PGlite has one connection. Every
  counting trigger takes an advisory lock for it; without that, concurrent
  statements each read the same count and all pass.
- Does inserting a `report_photos` row whose `storage_path` has no matching
  grant fail? And one naming an object already linked elsewhere?
- After deleting your own photo row, does re-inserting the same `storage_path`
  fail? It must: the grant is spent, and re-linking would put an image an admin
  rejected back in front of the machine tiers for a fresh verdict.
- Does minting a SECOND `upload_grants` row for a `storage_path` that already
  has one fail? That index is what stops a spent grant being replaced.
- Does a `storage_path` with a query string, a `..` segment, a second extension
  or uppercase hex fail the shape `check` on BOTH tables? Each of those is a
  second spelling of an object that is already linked, and the unique indexes
  compare literal strings, so they cannot see it.
- Did `0006` apply at all? It adds the shape rule to `report_photos` with
  `add constraint`, not by altering the column type — `public_report_photos`
  selects that column, and Postgres refuses to alter the type of a column a
  view depends on. Because the file runs as one transaction, getting that wrong
  rolls back the rate limit too, and the only symptom is uploads answering
  "not set up".
- Does an `upload_grants` insert whose `storage_path` is outside
  `map/<your-id>/<report-id>/` fail? Try one without the `map/` prefix too.
- Does deleting the report leave its upload grants in place, with `report_id`
  set to null? A cascade there would let the person the limit applies to reset
  it by deleting their own report, and would do it without consulting RLS.
