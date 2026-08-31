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
-- Only open, approved reports contribute. Cleaned reports drop out, which is
-- what makes a cleanup visibly cool the map.
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
  resolution integer
)
returns table (
  cell         text,
  weight       bigint,
  report_count bigint
)
language sql
stable
security definer
set search_path = public
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
  where r.status = 'open'
    and r.moderation_status = 'approved'
    and resolution in (1, 3, 5, 7, 9, 12)
    and r.lat between min_lat and max_lat
    -- A viewport that crosses the antimeridian arrives with min_lng > max_lng.
    -- Treating it as an ordinary BETWEEN would return nothing at all.
    and (
      (min_lng <= max_lng and r.lng between min_lng and max_lng)
      or
      (min_lng >  max_lng and (r.lng >= min_lng or r.lng <= max_lng))
    )
  group by 1;
$$;

grant execute on function public.reports_rollup(
  double precision, double precision, double precision, double precision, integer
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
set search_path = public
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
      where status = 'pending'
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
      order by created_at
      limit least(greatest(batch_size, 1), 100)
      for update skip locked
   )
  returning j.*;
$$;

-- Record a verdict and apply it to the underlying row in one transaction, so a
-- job can never be marked done while the content it judged stays pending.
create or replace function public.record_moderation_verdict(
  job_id       uuid,
  new_verdict  moderation_status,
  decided_by   text,
  tier_results jsonb default '{}'::jsonb,
  reason       text default null
)
returns void
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

  update public.moderation_jobs
     set status       = 'done',
         verdict      = new_verdict,
         decided_by   = record_moderation_verdict.decided_by,
         tier_results = record_moderation_verdict.tier_results,
         reason       = record_moderation_verdict.reason,
         locked_at    = null,
         locked_by    = null
   where id = job_id;

  if job.subject_type = 'photo' then
    update public.report_photos set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'comment' then
    update public.comments set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'note' then
    update public.reports set moderation_status = new_verdict where id = job.subject_id;
  end if;
end;
$$;

-- Mark a job as needing a person. Leaving verdict NULL is what puts it in the
-- admin queue; see the moderation_jobs_review_idx index.
create or replace function public.escalate_moderation_job(
  job_id       uuid,
  tier_results jsonb default '{}'::jsonb,
  reason       text default null
)
returns void
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
   where id = job_id;
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
