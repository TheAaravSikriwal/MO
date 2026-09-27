-- MO — Milestone B schema
--
-- Everything MO owns lives in the `mo` schema, not in `public`.
--
-- MO runs as a route inside the wearechintu Next app and shares that project's
-- Supabase database, which already has `public.reports` (abuse reports against
-- marketplace projects) and `public.profiles`. A litter report and an abuse
-- report are not the same thing and must not be the same table, so the whole of
-- MO is namespaced. The client sets `db: { schema: 'mo' }`, which is why the
-- application code still says `.from('reports')`.
--
-- Two consequences worth knowing before reading further:
--   * MO does NOT create or own profiles. chintu's `handle_new_user` trigger
--     already inserts one for every row in auth.users, so `public.profiles` is
--     guaranteed to exist for anybody who can sign in, and MO references it.
--   * chintu's profiles has no `role` column. MO keeps its own admin list in
--     `mo.admins` rather than adding one, because who may review litter
--     reports is MO's business and does not belong in the marketplace's table.
--
-- Design notes that matter for reading this file:
--   * Severity is DERIVED, never chosen. There is no severity column anywhere.
--     An area's colour comes from how many distinct people flagged it.
--   * Every report stores six nested H3 cells so display rollup is a plain
--     indexed GROUP BY, with no Postgres H3 extension required.
--   * Nothing is trusted as safe until the moderation worker has ruled on it.


-- Every object below is created in, and resolves against, the `mo` schema.
--
-- MO shares the wearechintu project's database, which already has
-- `public.reports` and `public.profiles`. Tables, views and functions are
-- written out as `mo.x` so that is never in doubt. The enum types are left
-- bare and resolved through this search path, because `moderation_status` and
-- `subject_type` are the names of both a type and a column -- qualifying every
-- occurrence produced `where mo.moderation_status = ...`, which is a
-- schema-qualified column reference and not valid SQL.
--
-- Set per file: each migration runs in its own session, so this cannot be
-- inherited from the one before it.
-- `extensions` is in the path because PostGIS lives there on a default
-- Supabase project, and `geography` below is written unqualified. 0004 already
-- says this for its own functions; 0001 needs it too, and only appeared not to
-- because `create extension` here runs before the schema exists and so falls
-- back to public. On a project where PostGIS was enabled the normal way, that
-- line is a no-op and `geography(Point, 4326)` would not resolve at all.
set search_path = mo, public, extensions;

-- `with schema extensions`, and it matters.
--
-- CREATE EXTENSION with no SCHEMA clause installs into the first EXISTING
-- schema on the search path. `mo` is not created until below, so that was
-- `public` -- meaning MO dropped PostGIS's types and its thousand-odd
-- functions into the marketplace's schema, which is the one thing this whole
-- refactor exists to avoid. The chintu project has no PostGIS today, so this
-- was not a harmless no-op.
--
-- Not fixed by moving `create schema mo` above it either: then they would land
-- in `mo`, and MO would own an extension the rest of the database might want.
-- `extensions` is where Supabase puts them and where the dashboard would.
-- `extensions` first, because `with schema extensions` aborts with
-- `schema "extensions" does not exist` if it is absent -- and that happens
-- before `create schema mo` below, so it takes the whole file with it.
--
-- It exists on every Supabase project and none of chintu's nine migrations
-- create it, so this is a no-op there. It is here so the file does not depend
-- on that being true, and so a bare Postgres can run it.
create schema if not exists extensions;

create extension if not exists "pgcrypto" with schema extensions;  -- gen_random_uuid()
create extension if not exists "postgis"  with schema extensions;  -- geography + distance

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create schema if not exists mo;

-- Every role needs this before anything inside the schema is reachable; the
-- grants at the bottom of 0003 decide what they can actually touch.
--
-- `service_role` is in the list because the moderation worker uses it, and a
-- new schema grants it nothing. Supabase's default privileges are per-schema
-- and scoped to `public`, so none of what MO used to get for free there
-- applies here. BYPASSRLS is not a grant: without this the worker fails on its
-- first statement with "permission denied for schema mo", and the symptom is
-- that no photo or note is ever reviewed.
grant usage on schema mo to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- No `user_role`. MO has exactly one privileged role and it is a row in
-- mo.admins, not a column on somebody else's table.
create type mo.report_status     as enum ('open', 'cleaned');
create type mo.moderation_status as enum ('pending', 'approved', 'rejected');
-- 'name' is the display name a person chooses before their first post. It is
-- free text shown in public, so it is judged like a note or a comment.
create type mo.subject_type      as enum ('photo', 'comment', 'note', 'name');
create type mo.job_status        as enum ('pending', 'in_progress', 'done', 'failed');

-- ---------------------------------------------------------------------------
-- admins  --  who may review flagged content
-- ---------------------------------------------------------------------------
--
-- A table rather than a column on public.profiles, for two reasons. Adding
-- `role` to chintu's profiles would mean MO's moderation model lived in the
-- marketplace's schema, where the next person to read it has no idea why. And
-- a separate table can be revoked outright from browser roles, so the admin
-- list is not merely unreadable by policy but ungranted -- nobody can
-- enumerate who moderates the map.
--
-- There is no way to create the first admin from inside the app, by design.
-- The bootstrap snippet is at the bottom of 0004.
create table mo.admins (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  granted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- How much of a name actually shows up
-- ---------------------------------------------------------------------------
--
-- btrim removes only ASCII spaces, and [[:cntrl:]] misses the rest, so a name
-- of non-breaking spaces, zero-width joiners or Hangul fillers passed every
-- check and displayed as nothing. This counts the characters left once all of
-- these are taken out:
--
--       32-32      space
--      160-160     no-break space
--      173-173     soft hyphen
--      847-847     combining grapheme joiner
--     1564-1564    Arabic letter mark
--     4447-4448    Hangul choseong and jungseong fillers
--     5760-5760    Ogham space
--     6068-6069    Khmer inherent vowels
--     6155-6158    Mongolian selectors and vowel separator
--     8192-8207    the space block, zero-width space and joiners, direction marks
--     8232-8239    line and paragraph separators, bidi embeddings, narrow no-break space
--     8287-8303    medium space, word joiner, invisible operators, bidi isolates
--    10240-10240   braille blank
--    12288-12288   ideographic space
--    12644-12644   Hangul filler
--    65024-65039   variation selectors
--    65279-65279   byte-order mark
--    65440-65440   halfwidth Hangul filler
--   119155-119162  musical format controls
--   917505-917505  language tag
--   917536-917631  tag characters
--
-- That is Unicode's default-ignorable characters and its extra spaces, plus the
-- letters that only LOOK blank. The same ranges are INVISIBLE_RANGES in
-- src/lib/names/displayName.ts, and a test keeps the two identical. Written as
-- numbers and chr() so no escape can be mangled on the way in.
--
-- Used by the display_names CHECK below and by set_display_name in 0002.
create or replace function mo.visible_length(t text)
returns integer
language sql
immutable
parallel safe
set search_path = mo, public
as $$
  select char_length(translate(t, (
    select string_agg(chr(c), '')
      from (
        select generate_series(lo, hi) as c
          from (values
      (32, 32),
      (160, 160),
      (173, 173),
      (847, 847),
      (1564, 1564),
      (4447, 4448),
      (5760, 5760),
      (6068, 6069),
      (6155, 6158),
      (8192, 8207),
      (8232, 8239),
      (8287, 8303),
      (10240, 10240),
      (12288, 12288),
      (12644, 12644),
      (65024, 65039),
      (65279, 65279),
      (65440, 65440),
      (119155, 119162),
      (917505, 917505),
      (917536, 917631)
          ) as ranges (lo, hi)
      ) as points
  ), ''));
$$;

-- ---------------------------------------------------------------------------
-- display_names  --  the name shown on a person's reports and comments
-- ---------------------------------------------------------------------------
--
-- MO's own, and deliberately not chintu's `public.profiles.display_name`.
--
-- That column is filled by chintu's handle_new_user, and for a magic-link
-- signup -- which is every MO signup -- it holds the local part of the email
-- address. `public.profiles` is readable by anon in that project, so showing it
-- would sign every comment with the author's email prefix. So a person chooses
-- a name for MO before their first post, it lives here, and MO never reads the
-- marketplace's name at all.
--
-- A name is free text shown in public, so it is reviewed like any other: the
-- moderation job's subject_id is `user_id`, and until the name is approved
-- other people see "someone". Changing it puts it back to pending.
--
-- The check is a sanity guard, not the review. No `@`, so an email address
-- cannot be typed in as a name, and no control characters.
create table mo.display_names (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  name              text not null check (
                      name = btrim(name)
                      and char_length(name) between 2 and 30
                      and position('@' in name) = 0
                      and name !~ '[[:cntrl:]]'
                      -- At least two characters that show up. See
                      -- mo.visible_length above.
                      and mo.visible_length(name) >= 2
                    ),
  moderation_status moderation_status not null default 'pending',
  updated_at        timestamptz not null default now(),
  -- How many names this person has submitted since window_started. Every
  -- submission is a round of review, so set_display_name caps it per day --
  -- including after a rejection, which is otherwise an unlimited retry loop.
  changes_in_window integer     not null default 1 check (changes_in_window >= 0),
  window_started    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

create table mo.reports (
  id                uuid primary key default gen_random_uuid(),
  reporter_id       uuid not null references public.profiles (id) on delete cascade,

  lat               double precision not null check (lat between -90 and 90),
  lng               double precision not null check (lng between -180 and 180),
  -- Maintained by a trigger rather than a generated column: the PostGIS cast
  -- chain is fussy about immutability across versions, and a trigger behaves
  -- identically everywhere.
  geom              geography(Point, 4326),

  -- The six nested H3 cells. r12 is the precision floor (~300 m2); the coarser
  -- five exist only so zoomed-out rollup is a plain GROUP BY.
  --
  -- These are computed client-side by h3-js. Postgres cannot recompute them
  -- without the H3 extension, so lat/lng stays authoritative and these are a
  -- display index derived from it. The format check is a sanity guard, not a
  -- correctness guarantee.
  cell_r1           text not null check (cell_r1  ~ '^[0-9a-f]{15,16}$'),
  cell_r3           text not null check (cell_r3  ~ '^[0-9a-f]{15,16}$'),
  cell_r5           text not null check (cell_r5  ~ '^[0-9a-f]{15,16}$'),
  cell_r7           text not null check (cell_r7  ~ '^[0-9a-f]{15,16}$'),
  cell_r9           text not null check (cell_r9  ~ '^[0-9a-f]{15,16}$'),
  cell_r12          text not null check (cell_r12 ~ '^[0-9a-f]{15,16}$'),

  note              text check (char_length(note) <= 500),

  status            report_status     not null default 'open',
  cleaned_by        uuid references public.profiles (id) on delete set null,
  cleaned_at        timestamptz,

  -- The PIN's own visibility. A location with litter on it is not itself
  -- objectionable, so a report is visible the moment it is made.
  --
  -- NOTHING WRITES THIS. The comment used to say "only an admin ever rejects
  -- the row", and no code path does: `record_moderation_verdict` and
  -- `admin_decide_moderation` write photo and comment statuses and the report's
  -- `note_status`, never this column, and the moderation subject types are
  -- photo, comment and note — there is no pin subject. So in practice this is
  -- always 'approved', `reports_select_visible` reduces to `using (true)`, and
  -- the author-sees-own-rejected branch of `mo.public_reports` is unreachable.
  --
  -- It matters because a spam or malicious pin keeps contributing weight to the
  -- map forever: `reports_rollup` filters on `moderation_status = 'approved'`,
  -- and that is the only value this can hold. Rejecting the photo and the note
  -- withholds the content and leaves the coloured cell. Removing the pin is a
  -- SQL-editor job today. Recorded in HANDOFF.md under what is not done.
  moderation_status moderation_status not null default 'approved',
  -- The NOTE's visibility, judged separately. Free text somebody attached to a
  -- place is exactly what needs review, and withholding it must not take the
  -- pin down with it.
  note_status       moderation_status not null default 'pending',

  -- Denormalised from votes by a trigger, so the rollup query never joins.
  vote_count        integer not null default 0 check (vote_count >= 0),

  created_at        timestamptz not null default now(),

  -- A report with no note has nothing to review, so it is not left waiting.
  constraint note_status_matches_note check (
    note is not null or note_status = 'approved'
  ),

  constraint cleaned_fields_agree check (
    (status = 'cleaned' and cleaned_at is not null) or
    (status = 'open'    and cleaned_at is null and cleaned_by is null)
  )
);

-- One index per resolution: the rollup groups on exactly one of these, chosen
-- by zoom level. Partial on approved, since nothing else contributes weight.
create index reports_cell_r1_idx  on mo.reports (cell_r1)  where moderation_status = 'approved';
create index reports_cell_r3_idx  on mo.reports (cell_r3)  where moderation_status = 'approved';
create index reports_cell_r5_idx  on mo.reports (cell_r5)  where moderation_status = 'approved';
create index reports_cell_r7_idx  on mo.reports (cell_r7)  where moderation_status = 'approved';
create index reports_cell_r9_idx  on mo.reports (cell_r9)  where moderation_status = 'approved';
create index reports_cell_r12_idx on mo.reports (cell_r12) where moderation_status = 'approved';

create index reports_geom_idx        on mo.reports using gist (geom);
create index reports_reporter_idx    on mo.reports (reporter_id, created_at desc);
create index reports_open_recent_idx on mo.reports (created_at desc)
  where status = 'open' and moderation_status = 'approved';

-- ---------------------------------------------------------------------------
-- report_photos
-- ---------------------------------------------------------------------------

create table mo.report_photos (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references mo.reports (id) on delete cascade,
  -- Object key in Cloudflare R2. Never exposed publicly until approved --
  -- see the public_report_photos view.
  storage_path      text not null check (char_length(storage_path) between 1 and 500),
  moderation_status moderation_status not null default 'pending',
  created_at        timestamptz not null default now()
);

create index report_photos_report_idx on mo.report_photos (report_id);

-- ---------------------------------------------------------------------------
-- votes  --  the confirmation signal that drives severity
-- ---------------------------------------------------------------------------

create table mo.votes (
  report_id  uuid not null references mo.reports (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- This primary key IS the anti-stuffing control. One person, one vote.
  primary key (report_id, user_id)
);

create index votes_user_idx on mo.votes (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

create table mo.comments (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references mo.reports (id) on delete cascade,
  author_id         uuid not null references public.profiles (id) on delete cascade,
  body              text not null check (char_length(body) between 1 and 1000),
  moderation_status moderation_status not null default 'pending',
  created_at        timestamptz not null default now()
);

create index comments_report_idx on mo.comments (report_id, created_at desc)
  where moderation_status = 'approved';
create index comments_author_idx on mo.comments (author_id, created_at desc);

-- ---------------------------------------------------------------------------
-- post_log  --  what the report, comment and flag rate limits count
-- ---------------------------------------------------------------------------
--
-- One row per report, comment or flag a person has posted, written by the
-- rate-limit triggers in 0002 and 0005 and never by a browser.
--
-- The limits used to count live rows in mo.reports and mo.comments. People can
-- delete their own of both, so "post ten, delete them, post ten more" reset
-- the count as often as anybody liked -- the pins went straight onto the map,
-- and every note and comment still became a moderation job. 0006 already warned
-- that a count over live rows is only safe while nothing a person can do
-- removes their own rows; for these two tables that was never true.
--
-- Flags too. A person can flag their own comment, and deleting the comment
-- deletes every flag on it (cleanup_moderation_for_deleted in 0005), so the
-- flag limit reset the same way: post, flag, delete, repeat.
--
-- Revoked from both browser roles in 0003, with no policy, so nobody can read
-- or trim their own record.
--
-- Pruning is partial, and deliberately cheap. Each trigger deletes that
-- person's rows of its own kind older than its own window -- an hour for
-- reports and flags, a minute for comments -- and only when they post that
-- kind again. Rows belonging to somebody who stops posting stay. They are a
-- few dozen bytes each and every count filters on created_at, so they change
-- no answer; if the table ever matters, a periodic
-- `delete from mo.post_log where created_at < now() - interval '1 day'`
-- bounds it without touching any limit.
create table mo.post_log (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('report', 'comment', 'flag')),
  created_at timestamptz not null default now()
);

create index post_log_user_kind_idx on mo.post_log (user_id, kind, created_at);

-- ---------------------------------------------------------------------------
-- flags  --  the community "report this" button
-- ---------------------------------------------------------------------------

create table mo.flags (
  id           uuid primary key default gen_random_uuid(),
  subject_type subject_type not null,
  subject_id   uuid not null,
  flagger_id   uuid not null references public.profiles (id) on delete cascade,
  reason       text check (char_length(reason) <= 500),
  -- Set when an admin rules on the subject. Counting LIFETIME flags meant that
  -- once something had two, every new complaint immediately un-published it
  -- again, undoing the decision forever.
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (subject_type, subject_id, flagger_id)
);

create index flags_subject_idx on mo.flags (subject_type, subject_id)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- moderation_jobs  --  the swappable seam
-- ---------------------------------------------------------------------------

create table mo.moderation_jobs (
  id           uuid primary key default gen_random_uuid(),
  subject_type subject_type not null,
  subject_id   uuid not null,
  status       job_status not null default 'pending',
  -- Per-tier scores, e.g. {"nsfw": 0.02, "detoxify": {"insult": 0.91}}.
  tier_results jsonb not null default '{}'::jsonb,
  verdict      moderation_status,
  reason       text,
  -- Which tier or human settled it: 'tier2:nsfw-vit', 'tier3:qwen3-8b', 'human'.
  decided_by   text,
  attempts     integer not null default 0,
  locked_at    timestamptz,
  locked_by    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (subject_type, subject_id)
);

-- The worker's claim query hits exactly this.
create index moderation_jobs_queue_idx on mo.moderation_jobs (status, created_at)
  where status in ('pending', 'failed');
-- The admin queue: finished by the machine tiers but still needing a human.
create index moderation_jobs_review_idx on mo.moderation_jobs (updated_at desc)
  where status = 'done' and verdict is null;

-- ---------------------------------------------------------------------------
-- Put the session back
-- ---------------------------------------------------------------------------
--
-- `set search_path` at the top of this file is session-scoped, not
-- transaction-scoped: a plain SET survives the commit. These migrations are
-- meant to be renumbered into the wearechintu project and applied by that
-- project's CLI, which uses ONE connection for the whole run -- so without this
-- line the search path stays `mo, public` for every marketplace migration
-- applied after MO's, and the next unqualified `create table foo` over there
-- lands in `mo`.
--
-- Nothing breaks today, because all nine of chintu's migrations qualify with
-- `public.`. That is not a guarantee about the tenth. Leaving a session
-- modified for somebody else's code is the same reach outside MO that the
-- `alter default privileges in schema public` statement was removed for.
reset search_path;
