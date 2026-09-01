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
create or replace function public.reports_rollup(
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
set search_path = public, extensions
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
  from public.reports r
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

grant execute on function public.reports_rollup(
  double precision, double precision, double precision, double precision, integer,
  text, integer, timestamptz, double precision, double precision, double precision
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- nearby_reports  --  powers "near me"
-- ---------------------------------------------------------------------------

create or replace function public.nearby_reports(
  origin_lat  double precision,
  origin_lng  double precision,
  radius_m    double precision default 2000,
  max_results integer default 100
)
returns table (
  id         uuid,
  lat        double precision,
  lng        double precision,
  distance_m double precision,
  vote_count integer,
  status     report_status,
  created_at timestamptz
)
language sql
stable
security definer
-- PostGIS lives in `extensions` on a default Supabase project, so a definer
-- function with search_path pinned to `public` alone cannot resolve st_dwithin.
set search_path = public, extensions
as $$
  select
    r.id,
    r.lat,
    r.lng,
    st_distance(r.geom, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography)
      as distance_m,
    r.vote_count,
    r.status,
    r.created_at
  from public.reports r
  where r.moderation_status = 'approved'
    and st_dwithin(
          r.geom,
          st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography,
          least(greatest(radius_m, 0), 50000)
        )
  order by distance_m
  limit least(greatest(max_results, 1), 500);
$$;

grant execute on function public.nearby_reports(
  double precision, double precision, double precision, integer
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The worker's interface
-- ---------------------------------------------------------------------------

-- Claim a batch of jobs atomically.
--
-- FOR UPDATE SKIP LOCKED is what makes it safe to run several workers at once,
-- or to restart one mid-batch, without two of them grading the same photo.
create or replace function public.claim_moderation_jobs(
  worker_id  text,
  batch_size integer default 10
)
returns setof public.moderation_jobs
language sql
volatile
set search_path = public
as $$
  update public.moderation_jobs j
     set status    = 'in_progress',
         locked_at = now(),
         locked_by = worker_id,
         attempts  = j.attempts + 1
   where j.id in (
     select id from public.moderation_jobs
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
create or replace function public.record_moderation_verdict(
  job_id       uuid,
  new_verdict  moderation_status,
  decided_by   text,
  tier_results jsonb default '{}'::jsonb,
  reason       text default null
)
returns boolean
language plpgsql
volatile
set search_path = public
as $$
declare
  job public.moderation_jobs;
begin
  select * into job from public.moderation_jobs where id = job_id;
  if not found then
    raise exception 'no such moderation job: %', job_id;
  end if;

  -- `status = 'in_progress'` is what stops the worker overwriting a job that a
  -- person flagged while it was being processed. flag_reopens_review sets a job
  -- back to done/verdict-null; without this guard the worker would then write
  -- its own verdict over the top, and the flagged item would never reach a
  -- human -- breaking the rule that a complaint always does.
  update public.moderation_jobs
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
    select 1 from public.flags
     where subject_type = job.subject_type
       and subject_id = job.subject_id
       and resolved_at is null
  ) then
    update public.moderation_jobs
       set verdict    = null,
           decided_by = 'escalated',
           reason     = 'people reported this'
     where id = job_id;
    return false;
  end if;

  if job.subject_type = 'photo' then
    update public.report_photos set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'comment' then
    update public.comments set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'note' then
    -- note_status, NOT moderation_status. The pin and its note are judged
    -- separately: approving here must release the text, and rejecting here must
    -- withhold the text without erasing the report from the map. Writing
    -- moderation_status would do neither -- it would leave an approved note
    -- permanently hidden with no job left to release it, and drop a rejected
    -- one's pin off the map entirely.
    update public.reports set note_status = new_verdict where id = job.subject_id;
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
create or replace function public.escalate_moderation_job(
  job_id       uuid,
  tier_results jsonb default '{}'::jsonb,
  reason       text default null
)
returns boolean
language sql
volatile
set search_path = public
as $$
  update public.moderation_jobs
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

-- These are the worker's, and the worker authenticates with the service role
-- key, which bypasses RLS. No browser-facing role gets execute on them.
revoke all on function public.claim_moderation_jobs(text, integer) from public, anon, authenticated;
revoke all on function public.record_moderation_verdict(uuid, moderation_status, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.escalate_moderation_job(uuid, jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Admin bootstrap
-- ---------------------------------------------------------------------------

-- There is no way to create the first admin from inside the app, by design:
-- guard_profile_role_change requires an existing admin to promote anyone.
--
-- Promote the first one by hand, from the Supabase SQL editor, which runs as a
-- superuser and is not subject to the trigger's auth.uid() check:
--
--   update public.profiles
--      set role = 'admin'
--    where id = (select id from auth.users where email = 'you@example.com');
--
-- Without at least one admin there is no tier 4, and every ambiguous photo and
-- comment will sit in the queue unreviewed. Do this immediately after the first
-- sign-in.
