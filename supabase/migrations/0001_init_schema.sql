-- MO — Milestone B schema
--
-- Design notes that matter for reading this file:
--   * Severity is DERIVED, never chosen. There is no severity column anywhere.
--     An area's colour comes from how many distinct people flagged it.
--   * Every report stores six nested H3 cells so display rollup is a plain
--     indexed GROUP BY, with no Postgres H3 extension required.
--   * Nothing is trusted as safe until the moderation worker has ruled on it.

create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "postgis";       -- geography type + distance queries

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type user_role         as enum ('user', 'admin');
create type report_status     as enum ('open', 'cleaned');
create type moderation_status as enum ('pending', 'approved', 'rejected');
create type subject_type      as enum ('photo', 'comment', 'note');
create type job_status        as enum ('pending', 'in_progress', 'done', 'failed');

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 60),
  role         user_role   not null default 'user',
  created_at   timestamptz not null default now()
);

comment on column profiles.role is
  'Escalation to admin is blocked by the guard_profile_role_change trigger.';

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

create table reports (
  id                uuid primary key default gen_random_uuid(),
  reporter_id       uuid not null references profiles (id) on delete cascade,

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
  cleaned_by        uuid references profiles (id) on delete set null,
  cleaned_at        timestamptz,

  -- The PIN's own visibility. A location with litter on it is not itself
  -- objectionable, so a report is visible the moment it is made; only an admin
  -- ever rejects the row.
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
create index reports_cell_r1_idx  on reports (cell_r1)  where moderation_status = 'approved';
create index reports_cell_r3_idx  on reports (cell_r3)  where moderation_status = 'approved';
create index reports_cell_r5_idx  on reports (cell_r5)  where moderation_status = 'approved';
create index reports_cell_r7_idx  on reports (cell_r7)  where moderation_status = 'approved';
create index reports_cell_r9_idx  on reports (cell_r9)  where moderation_status = 'approved';
create index reports_cell_r12_idx on reports (cell_r12) where moderation_status = 'approved';

create index reports_geom_idx        on reports using gist (geom);
create index reports_reporter_idx    on reports (reporter_id, created_at desc);
create index reports_open_recent_idx on reports (created_at desc)
  where status = 'open' and moderation_status = 'approved';

-- ---------------------------------------------------------------------------
-- report_photos
-- ---------------------------------------------------------------------------

create table report_photos (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references reports (id) on delete cascade,
  -- Object key in Cloudflare R2. Never exposed publicly until approved --
  -- see the public_report_photos view.
  storage_path      text not null check (char_length(storage_path) between 1 and 500),
  moderation_status moderation_status not null default 'pending',
  created_at        timestamptz not null default now()
);

create index report_photos_report_idx on report_photos (report_id);

-- ---------------------------------------------------------------------------
-- votes  --  the confirmation signal that drives severity
-- ---------------------------------------------------------------------------

create table votes (
  report_id  uuid not null references reports (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- This primary key IS the anti-stuffing control. One person, one vote.
  primary key (report_id, user_id)
);

create index votes_user_idx on votes (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

create table comments (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references reports (id) on delete cascade,
  author_id         uuid not null references profiles (id) on delete cascade,
  body              text not null check (char_length(body) between 1 and 1000),
  moderation_status moderation_status not null default 'pending',
  created_at        timestamptz not null default now()
);

create index comments_report_idx on comments (report_id, created_at desc)
  where moderation_status = 'approved';
create index comments_author_idx on comments (author_id, created_at desc);

-- ---------------------------------------------------------------------------
-- flags  --  the community "report this" button
-- ---------------------------------------------------------------------------

create table flags (
  id           uuid primary key default gen_random_uuid(),
  subject_type subject_type not null,
  subject_id   uuid not null,
  flagger_id   uuid not null references profiles (id) on delete cascade,
  reason       text check (char_length(reason) <= 500),
  created_at   timestamptz not null default now(),
  unique (subject_type, subject_id, flagger_id)
);

create index flags_subject_idx on flags (subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- moderation_jobs  --  the swappable seam
-- ---------------------------------------------------------------------------

create table moderation_jobs (
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
create index moderation_jobs_queue_idx on moderation_jobs (status, created_at)
  where status in ('pending', 'failed');
-- The admin queue: finished by the machine tiers but still needing a human.
create index moderation_jobs_review_idx on moderation_jobs (updated_at desc)
  where status = 'done' and verdict is null;
