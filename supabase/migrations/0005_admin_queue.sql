-- MO — tier 4, the admin review queue
--
-- The machine tiers settle the confident cases. Whatever they could not settle
-- lands here, as a job that finished with no verdict. Without at least one
-- admin, nothing in this queue is ever resolved and pending photos stay
-- withheld forever — which is safe, but not useful.

-- ---------------------------------------------------------------------------
-- Reading the queue
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, because an admin has to see the ACTUAL content to judge it,
-- including a photo path the public view deliberately withholds. The is_admin()
-- check is therefore the only thing standing between this and a way to read
-- unreviewed content, so it is checked first and raises rather than returning
-- an empty set — a silent empty result would look like "queue is clear".
create or replace function public.admin_moderation_queue(max_results integer default 50)
returns table (
  job_id       uuid,
  subject_type subject_type,
  subject_id   uuid,
  reason       text,
  tier_results jsonb,
  created_at   timestamptz,
  content_text text,
  storage_path text,
  report_id    uuid,
  flag_count   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'only an admin may read the moderation queue';
  end if;

  return query
  select
    j.id,
    j.subject_type,
    j.subject_id,
    j.reason,
    j.tier_results,
    j.created_at,
    case j.subject_type
      when 'comment' then (select c.body from public.comments c where c.id = j.subject_id)
      when 'note'    then (select r.note from public.reports  r where r.id = j.subject_id)
      else null
    end,
    case j.subject_type
      when 'photo' then (select p.storage_path from public.report_photos p where p.id = j.subject_id)
      else null
    end,
    case j.subject_type
      when 'photo'   then (select p.report_id from public.report_photos p where p.id = j.subject_id)
      when 'comment' then (select c.report_id from public.comments      c where c.id = j.subject_id)
      else j.subject_id
    end,
    (select count(*) from public.flags f
      where f.subject_type = j.subject_type and f.subject_id = j.subject_id)
  from public.moderation_jobs j
  -- Three ways an item ends up needing a person:
  --   * the machine tiers finished but could not decide (verdict is null)
  --   * the worker gave up after repeated failures
  --   * a worker claimed it and never came back, until the retries ran out
  -- The last two matter because their content stays withheld until somebody
  -- rules on it, so a job that quietly exhausts its retries would otherwise be
  -- invisible forever.
  where j.verdict is null
    and (
      j.status = 'done'
      or (j.status = 'failed' and j.attempts >= 5)
      or (j.status = 'in_progress' and j.attempts >= 5
          and j.locked_at < now() - interval '15 minutes')
    )
  order by
    -- Anything people have complained about goes first.
    (select count(*) from public.flags f
      where f.subject_type = j.subject_type and f.subject_id = j.subject_id) desc,
    j.created_at asc
  limit least(greatest(max_results, 1), 200);
end;
$$;

revoke all on function public.admin_moderation_queue(integer) from public, anon;
grant execute on function public.admin_moderation_queue(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Deciding
-- ---------------------------------------------------------------------------

-- The worker's record_moderation_verdict is revoked from browser roles, and
-- must stay that way. This is the admin's equivalent: same effect, but it
-- refuses anyone who is not an admin instead of relying on RLS to quietly
-- update nothing. A silent no-op would leave an admin believing they had
-- rejected something they had not.
create or replace function public.admin_decide_moderation(
  job_id      uuid,
  new_verdict moderation_status,
  reason      text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  job public.moderation_jobs;
begin
  if not public.is_admin() then
    raise exception 'only an admin may decide moderation items';
  end if;

  -- `null not in (...)` is NULL, not true, so a null verdict used to fall
  -- straight through this guard and die on a NOT NULL violation further down
  -- with an opaque Postgres error instead of this message.
  if new_verdict is null or new_verdict not in ('approved', 'rejected') then
    raise exception 'a decision must be approved or rejected, not %', new_verdict;
  end if;

  -- FOR UPDATE, and `verdict is null` repeated on the UPDATE itself.
  --
  -- Without both, two admins deciding the same item concurrently would each
  -- read verdict IS NULL, each pass the guard, and the later write would win --
  -- so one admin could reject an obscene photo and have it silently
  -- re-approved. Locking the row serialises them, and the WHERE makes the
  -- second one a no-op that the row count below turns into a visible error.
  select * into job from public.moderation_jobs where id = job_id for update;
  if not found then
    raise exception 'no such moderation job: %', job_id;
  end if;

  if job.verdict is not null then
    raise exception 'this item has already been decided';
  end if;

  update public.moderation_jobs
     set verdict    = new_verdict,
         status     = 'done',
         decided_by = 'human:' || coalesce(auth.uid()::text, 'unknown'),
         reason     = coalesce(admin_decide_moderation.reason, moderation_jobs.reason),
         locked_at  = null,
         locked_by  = null
   where id = job_id
     and verdict is null;

  if not found then
    raise exception 'this item was decided by someone else a moment ago';
  end if;

  if job.subject_type = 'photo' then
    update public.report_photos set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'comment' then
    update public.comments set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'note' then
    -- note_status, NOT moderation_status. Rejecting one offensive sentence must
    -- withhold the sentence, not erase a legitimate litter report from the map.
    update public.reports set note_status = new_verdict where id = job.subject_id;
  end if;
end;
$$;

revoke all on function public.admin_decide_moderation(uuid, moderation_status, text) from public, anon;
grant execute on function public.admin_decide_moderation(uuid, moderation_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- How full is the queue
-- ---------------------------------------------------------------------------

create or replace function public.admin_queue_size()
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'only an admin may read the moderation queue';
  end if;
  return (
    select count(*) from public.moderation_jobs
    where verdict is null
      and (
        status = 'done'
        or (status = 'failed' and attempts >= 5)
        or (status = 'in_progress' and attempts >= 5
            and locked_at < now() - interval '15 minutes')
      )
  );
end;
$$;

revoke all on function public.admin_queue_size() from public, anon;
grant execute on function public.admin_queue_size() to authenticated;

-- ---------------------------------------------------------------------------
-- A complaint puts something back in front of a person
-- ---------------------------------------------------------------------------

-- Without this, flagging did nothing at all. Content that had already been
-- decided kept its verdict, no job ever returned to the queue, and any number
-- of people could report a comment while it stayed live for good.
--
-- Clearing the verdict is what puts an item back in the queue -- the same
-- condition admin_moderation_queue selects on. Re-flagging something already
-- waiting is harmless: the unique constraint on flags stops one person doing it
-- twice, and the upsert simply refreshes the reason.
create or replace function public.flag_reopens_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.moderation_jobs (subject_type, subject_id, status, verdict, reason)
  values (new.subject_type, new.subject_id, 'done', null, 'people reported this')
  on conflict (subject_type, subject_id) do update
     set status     = 'done',
         verdict    = null,
         reason     = 'people reported this',
         locked_at  = null,
         locked_by  = null,
         updated_at = now();
  return null;
end;
$$;

create trigger flag_reopens_review
  after insert on public.flags
  for each row execute function public.flag_reopens_review();

-- Anything enough people complain about is withheld again while it waits.
--
-- Deliberately NOT on the first flag. One account could otherwise walk the map
-- and unpublish every approved photo one insert at a time. A single flag still
-- puts the item in front of an admin (above); it takes a second, independent
-- person to actually take the content down in the meantime.
create or replace function public.flag_withholds_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  complaints integer;
begin
  select count(*) into complaints
    from public.flags
   where subject_type = new.subject_type and subject_id = new.subject_id;

  if complaints < 2 then
    return null;
  end if;

  if new.subject_type = 'comment' then
    update public.comments set moderation_status = 'pending'
     where id = new.subject_id and moderation_status = 'approved';
  elsif new.subject_type = 'photo' then
    update public.report_photos set moderation_status = 'pending'
     where id = new.subject_id and moderation_status = 'approved';
  elsif new.subject_type = 'note' then
    -- `and note is not null` matters: a report with no note has note_status
    -- 'approved' to satisfy note_status_matches_note, and setting it back to
    -- 'pending' would violate that constraint and roll the whole flag back.
    update public.reports set note_status = 'pending'
     where id = new.subject_id and note_status = 'approved' and note is not null;
  end if;
  return null;
end;
$$;

create trigger flag_withholds_content
  after insert on public.flags
  for each row execute function public.flag_withholds_content();

-- ---------------------------------------------------------------------------
-- Flags cannot be used as a battering ram
-- ---------------------------------------------------------------------------

-- subject_id is polymorphic, so it cannot carry a foreign key. Without this
-- check, any signed-in account could insert flags for invented ids and, through
-- flag_reopens_review (SECURITY DEFINER), fill moderation_jobs -- a table no
-- browser role is granted at all -- with unbounded junk.
create or replace function public.validate_flag_subject()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.subject_type = 'comment' then
    if not exists (select 1 from public.comments where id = new.subject_id) then
      raise exception 'no such comment';
    end if;
  elsif new.subject_type = 'photo' then
    if not exists (select 1 from public.report_photos where id = new.subject_id) then
      raise exception 'no such photo';
    end if;
  elsif new.subject_type = 'note' then
    if not exists (
      select 1 from public.reports
      where id = new.subject_id and note is not null
    ) then
      raise exception 'no such note';
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_flag_subject
  before insert on public.flags
  for each row execute function public.validate_flag_subject();

-- The other tables are rate limited; without the same here, one account can
-- still generate unlimited review work even if it cannot take content down.
create or replace function public.enforce_flag_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.flags
    where flagger_id = new.flagger_id
      and created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'too many reports in the last hour; please slow down';
  end if;
  return new;
end;
$$;

create trigger enforce_flag_rate_limit
  before insert on public.flags
  for each row execute function public.enforce_flag_rate_limit();
