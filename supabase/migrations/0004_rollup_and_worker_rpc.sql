-- MO — the rollup query and the worker's queue interface

-- ---------------------------------------------------------------------------
-- reports_rollup  --  the query behind every zoom level
-- ---------------------------------------------------------------------------

-- Returns aggregated cells for the current viewport at the requested H3
-- resolution. This is the whole "world view to street view" mechanism: one
-- GROUP BY over a partial index, with no geometry maths at read time.
--
-- weight = sum over contributing reports of (1 + vote_count)
--
-- By default only open, approved reports contribute, so a cleanup visibly cools
-- the map. Passing status_filter = 'cleaned' or 'all' is an explicit request to
-- see cleaned spots as well.
--
-- SECURITY DEFINER, because browser roles no longer hold SELECT on reports --
-- that grant was what leaked unreviewed notes and photo paths. The function is
-- safe to run as definer because it returns only counts and sums over rows that
-- are already public, never a note, a photo path, or a reporter's identity.

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
-- `extensions` at FILE level, not just on the functions.
--
-- `reports_rollup` and `count_reports_in_view` are `language sql` and call
-- st_dwithin unqualified. A function's own SET clause applies when it RUNS;
-- Postgres validates a SQL function's body when it is CREATED, against the
-- session's search path. So without `extensions` here, creating them fails
-- with "function st_dwithin does not exist" even though each one pins the
-- right path for its own execution.
set search_path = mo, public, extensions;

create or replace function mo.reports_rollup(
  min_lat    double precision,
  min_lng    double precision,
  max_lat    double precision,
  max_lng    double precision,
  resolution integer,
  -- The same filters the panel offers. They have to be applied HERE, not to
  -- whatever subset the client happened to fetch: a client-side rollup over a
  -- capped page silently drops the very cells that should be hottest.
  -- 'open', not 'all'. A five-argument call is the form documented in the
  -- README, and it used to mean open-only; defaulting to 'all' would silently
  -- change what that call returns and break "cleaned reports drop out" for
  -- anyone using the function directly.
  status_filter      text             default 'open',
  min_confirmations  integer          default 0,
  since              timestamptz      default null,
  -- Distance is a filter like any other and has to be applied here too.
  -- Applying it only on the client meant the panel said "3 of 200" while all
  -- 200 stayed coloured on the map.
  origin_lat         double precision default null,
  origin_lng         double precision default null,
  within_metres      double precision default null
)
returns table (
  cell         text,
  weight       bigint,
  report_count bigint
)
language sql
stable
security definer
-- PostGIS lives in `extensions` on a default Supabase project, and this now
-- calls st_dwithin.
set search_path = mo, public, extensions
as $$
  select
    case resolution
      when 1  then r.cell_r1
      when 3  then r.cell_r3
      when 5  then r.cell_r5
      when 7  then r.cell_r7
      when 9  then r.cell_r9
      when 12 then r.cell_r12
    end as cell,
    sum(1 + r.vote_count)::bigint as weight,
    count(*)::bigint              as report_count
  from mo.reports r
  where r.moderation_status = 'approved'
    and resolution in (1, 3, 5, 7, 9, 12)
    -- Open only unless somebody explicitly asked to see cleaned spots. This is
    -- what makes a cleanup cool the map, and why asking for cleaned ones has to
    -- be an explicit choice rather than a silently empty result.
    -- 'all' means both, so the aggregated view and the pins agree about what
    -- exists. The default is 'open', which is what keeps a cleanup visibly
    -- cooling the map.
    and (
      status_filter = 'all'
      or (status_filter = 'open'    and r.status = 'open')
      or (status_filter = 'cleaned' and r.status = 'cleaned')
    )
    and r.vote_count >= greatest(coalesce(min_confirmations, 0), 0)
    and (since is null or r.created_at >= since)
    and r.lat between min_lat and max_lat
    -- A viewport that crosses the antimeridian arrives with min_lng > max_lng.
    -- Treating it as an ordinary BETWEEN would return nothing at all.
    and (
      (min_lng <= max_lng and r.lng between min_lng and max_lng)
      or
      (min_lng >  max_lng and (r.lng >= min_lng or r.lng <= max_lng))
    )
    and (
      origin_lat is null
      or origin_lng is null
      or within_metres is null
      or st_dwithin(
           r.geom,
           st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography,
           within_metres
         )
    )
  group by 1;
$$;

grant execute on function mo.reports_rollup(
  double precision, double precision, double precision, double precision, integer,
  text, integer, timestamptz, double precision, double precision, double precision
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- count_reports_in_view  --  what the panel counts
-- ---------------------------------------------------------------------------

-- An exact count of the reports matching a viewport and a set of filters.
--
-- Exists because PostgREST cannot express st_dwithin on a plain select, so the
-- distance filter could not be applied to a counting query from the client.
-- Counting without it made the panel read "60 reports" while twelve pins were
-- drawn -- the count contradicting both the pins and the cells.
--
-- Pass no filters for the unfiltered total.
create or replace function mo.count_reports_in_view(
  min_lat    double precision,
  min_lng    double precision,
  max_lat    double precision,
  max_lng    double precision,
  -- 'open', the same default as reports_rollup above.
  --
  -- This was 'all', which is the one thing this function must not do: a caller
  -- that omits the filter would count cleaned reports the rollup at the same
  -- zoom leaves out, and the panel would say "60 reports" over twelve pins.
  -- Removing that contradiction is the whole reason this function exists.
  status_filter      text             default 'open',
  min_confirmations  integer          default 0,
  since              timestamptz      default null,
  origin_lat         double precision default null,
  origin_lng         double precision default null,
  within_metres      double precision default null
)
returns bigint
language sql
stable
security definer
set search_path = mo, public, extensions
as $$
  select count(*)::bigint
  from mo.reports r
  where r.moderation_status = 'approved'
    and (
      status_filter = 'all'
      or (status_filter = 'open'    and r.status = 'open')
      or (status_filter = 'cleaned' and r.status = 'cleaned')
    )
    and r.vote_count >= greatest(coalesce(min_confirmations, 0), 0)
    and (since is null or r.created_at >= since)
    and r.lat between min_lat and max_lat
    and (
      (min_lng <= max_lng and r.lng between min_lng and max_lng)
      or
      (min_lng >  max_lng and (r.lng >= min_lng or r.lng <= max_lng))
    )
    and (
      origin_lat is null
      or origin_lng is null
      or within_metres is null
      or st_dwithin(
           r.geom,
           st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography,
           within_metres
         )
    );
$$;

grant execute on function mo.count_reports_in_view(
  double precision, double precision, double precision, double precision,
  text, integer, timestamptz, double precision, double precision, double precision
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- There is no nearby_reports
-- ---------------------------------------------------------------------------
--
-- There was: a PostGIS `st_dwithin` function with EXECUTE granted to anon, and
-- a comment saying it powered "near me". Nothing called it. Near-me is done
-- through `public_reports` plus `distanceMetres` on the client, and through the
-- `origin_lat`/`origin_lng`/`within_metres` arguments of `reports_rollup` and
-- `count_reports_in_view` above.
--
-- Removed rather than left in place. These migrations are about to be applied
-- to a database the marketplace also uses, and unexercised SQL that anon can
-- call is not something to ship on the strength of a comment that was wrong
-- about what called it. If near-me ever needs a real geography query, this is
-- a small function to write again, against a test.

-- ---------------------------------------------------------------------------
-- The worker's interface
-- ---------------------------------------------------------------------------

-- Claim a batch of jobs atomically.
--
-- FOR UPDATE SKIP LOCKED is what makes it safe to run several workers at once,
-- or to restart one mid-batch, without two of them grading the same photo.
create or replace function mo.claim_moderation_jobs(
  worker_id  text,
  batch_size integer default 10
)
returns setof mo.moderation_jobs
language sql
volatile
set search_path = mo, public
security definer
-- SECURITY DEFINER, like the read RPCs above.
--
-- These are the worker's write path, and they update moderation_jobs,
-- report_photos, comments and reports. Running as the CALLER, they needed
-- DML on all four -- which service_role does not have in this schema,
-- because a new schema grants nothing and Supabase's defaults are scoped
-- to public. Before the move to `mo` that came free, so nothing here said
-- it was needed; after it, claim_moderation_jobs failed on its first
-- statement and the pipeline never started.
--
-- Running as definer instead of granting four tables' worth of DML keeps
-- the privilege inside these three functions, which are already revoked
-- from every browser role and carry their own guards.
as $$
  update mo.moderation_jobs j
     set status    = 'in_progress',
         locked_at = now(),
         locked_by = worker_id,
         attempts  = j.attempts + 1
   where j.id in (
     select id from mo.moderation_jobs
      -- Never re-claim something already decided. Nothing currently moves a
      -- decided job back into these states, but this is the one link in the
      -- chain that was relying on its neighbours rather than its own predicate.
      where verdict is null
        and (
          status = 'pending'
         or (status = 'failed' and attempts < 5)
         -- Reclaim anything a dead worker left holding the lock -- but cap the
         -- retries here too. Without the cap a job that always errors is
         -- reclaimed every 15 minutes forever, never reaches a human, and its
         -- photo stays withheld indefinitely with nobody able to see it.
         or (
           status = 'in_progress'
           and locked_at < now() - interval '15 minutes'
           and attempts < 5
         )
        )
      order by created_at
      limit least(greatest(batch_size, 1), 100)
      for update skip locked
   )
  returning j.*;
$$;

-- Record a verdict and apply it to the underlying row in one transaction, so a
-- job can never be marked done while the content it judged stays pending.
-- Returns whether the verdict was actually applied. It can legitimately be
-- refused -- a flag landed, or another worker got there first -- and the caller
-- needs to know, or its log will claim a decision that never happened.
create or replace function mo.record_moderation_verdict(
  job_id       uuid,
  new_verdict  moderation_status,
  decided_by   text,
  tier_results jsonb default '{}'::jsonb,
  reason       text default null
)
returns boolean
language plpgsql
volatile
set search_path = mo, public
security definer
-- SECURITY DEFINER, like the read RPCs above.
--
-- These are the worker's write path, and they update moderation_jobs,
-- report_photos, comments and reports. Running as the CALLER, they needed
-- DML on all four -- which service_role does not have in this schema,
-- because a new schema grants nothing and Supabase's defaults are scoped
-- to public. Before the move to `mo` that came free, so nothing here said
-- it was needed; after it, claim_moderation_jobs failed on its first
-- statement and the pipeline never started.
--
-- Running as definer instead of granting four tables' worth of DML keeps
-- the privilege inside these three functions, which are already revoked
-- from every browser role and carry their own guards.
as $$
declare
  job mo.moderation_jobs;
begin
  select * into job from mo.moderation_jobs where id = job_id;
  if not found then
    -- A refusal, not an error. The job can legitimately vanish while a worker
    -- is judging it: its subject was deleted, or a name was changed and given
    -- a fresh job (see set_display_name in 0002). Raising made the worker log
    -- a failure and try to mark a row that no longer exists; false is the
    -- same answer as "someone else got there first", which is what happened.
    return false;
  end if;

  -- `status = 'in_progress'` is what stops the worker overwriting a job that a
  -- person flagged while it was being processed. flag_reopens_review sets a job
  -- back to done/verdict-null; without this guard the worker would then write
  -- its own verdict over the top, and the flagged item would never reach a
  -- human -- breaking the rule that a complaint always does.
  update mo.moderation_jobs
     set status       = 'done',
         verdict      = new_verdict,
         decided_by   = record_moderation_verdict.decided_by,
         tier_results = record_moderation_verdict.tier_results,
         reason       = record_moderation_verdict.reason,
         locked_at    = null,
         locked_by    = null
   where id = job_id
     and status = 'in_progress'
     -- verdict too, not just status: a job that was flagged, decided by an
     -- admin, then re-claimed after a worker error would otherwise have the
     -- admin's rejection silently overwritten by the machine.
     and verdict is null;

  if not found then
    -- Someone flagged it, or another worker finished it. Leave their state
    -- alone and do not touch the content.
    return false;
  end if;

  -- A complaint outranks a machine verdict, always. If anyone has flagged this
  -- subject and no admin has ruled on that flag yet, the verdict is discarded
  -- and the item goes to a person instead. This is what makes "community
  -- flagged items always reach a human" true even when the flag arrives while
  -- the worker is mid-decision.
  if exists (
    select 1 from mo.flags
     where subject_type = job.subject_type
       and subject_id = job.subject_id
       and resolved_at is null
  ) then
    update mo.moderation_jobs
       set verdict    = null,
           decided_by = 'escalated',
           reason     = 'people reported this'
     where id = job_id;
    return false;
  end if;

  if job.subject_type = 'photo' then
    update mo.report_photos set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'comment' then
    update mo.comments set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'note' then
    -- note_status, NOT moderation_status. The pin and its note are judged
    -- separately: approving here must release the text, and rejecting here must
    -- withhold the text without erasing the report from the map. Writing
    -- moderation_status would do neither -- it would leave an approved note
    -- permanently hidden with no job left to release it, and drop a rejected
    -- one's pin off the map entirely.
    update mo.reports set note_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'name' then
    -- A name's subject_id is the person's id, not a row id of its own.
    update mo.display_names set moderation_status = new_verdict where user_id = job.subject_id;
  end if;

  return true;
end;
$$;

-- Mark a job as needing a person. Leaving verdict NULL is what puts it in the
-- admin queue; see the moderation_jobs_review_idx index.
-- Returns whether it actually applied, for the same reason the verdict path
-- does: the guard below can legitimately refuse the write when an admin got
-- there first, and a caller that assumes success logs an escalation which
-- never happened.
create or replace function mo.escalate_moderation_job(
  job_id       uuid,
  tier_results jsonb default '{}'::jsonb,
  reason       text default null
)
returns boolean
language sql
volatile
set search_path = mo, public
security definer
-- SECURITY DEFINER, like the read RPCs above.
--
-- These are the worker's write path, and they update moderation_jobs,
-- report_photos, comments and reports. Running as the CALLER, they needed
-- DML on all four -- which service_role does not have in this schema,
-- because a new schema grants nothing and Supabase's defaults are scoped
-- to public. Before the move to `mo` that came free, so nothing here said
-- it was needed; after it, claim_moderation_jobs failed on its first
-- statement and the pipeline never started.
--
-- Running as definer instead of granting four tables' worth of DML keeps
-- the privilege inside these three functions, which are already revoked
-- from every browser role and carry their own guards.
as $$
  update mo.moderation_jobs
     set status       = 'done',
         verdict      = null,
         decided_by   = 'escalated',
         tier_results = escalate_moderation_job.tier_results,
         reason       = escalate_moderation_job.reason,
         locked_at    = null,
         locked_by    = null
   -- Same guard as the verdict path. Without it, escalating or discarding wipes
   -- a decision a person already made, leaving the job and the content
   -- disagreeing about what was decided.
   where id = job_id
     and status = 'in_progress'
     and verdict is null
  returning true;
$$;

-- These are the worker's. No browser-facing role gets execute on them.
--
-- Revoking from PUBLIC is what does the work: Postgres grants EXECUTE on a new
-- function to PUBLIC by default, so listing anon and authenticated alone would
-- leave it reachable by both through that implicit grant.
--
-- Which is also why service_role has to be granted back explicitly below. The
-- old comment here said the worker "authenticates with the service role key,
-- which bypasses RLS" and left it at that — true, and not the point: BYPASSRLS
-- is not a grant, and the revoke above takes service_role's implicit EXECUTE
-- away with everybody else's. When MO lived in `public` this never came up,
-- because Supabase's default privileges there had already granted it.
revoke all on function mo.claim_moderation_jobs(text, integer) from public, anon, authenticated;
revoke all on function mo.record_moderation_verdict(uuid, moderation_status, text, jsonb, text) from public, anon, authenticated;
revoke all on function mo.escalate_moderation_job(uuid, jsonb, text) from public, anon, authenticated;

grant execute on function mo.claim_moderation_jobs(text, integer) to service_role;
grant execute on function mo.record_moderation_verdict(uuid, moderation_status, text, jsonb, text) to service_role;
grant execute on function mo.escalate_moderation_job(uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Admin bootstrap
-- ---------------------------------------------------------------------------

-- There is no way to create the first admin from inside the app, by design:
-- `mo.admins` is revoked from both browser roles and has no insert policy, so
-- nothing a browser can send will add a row.
--
-- Add the first one by hand, from the Supabase SQL editor, which runs as a
-- superuser and is subject to neither the grant nor RLS:
--
--   insert into mo.admins (user_id)
--   select id from auth.users where email = 'you@example.com';
--
-- That person must have signed in at least once, so that chintu's
-- handle_new_user trigger has created their public.profiles row -- mo.admins
-- references it.
--
-- Without at least one admin there is no tier 4, and every ambiguous photo and
-- comment will sit in the queue unreviewed. Do this immediately after the first
-- sign-in.

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
