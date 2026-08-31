-- MO — functions and triggers
--
-- Everything here maintains an invariant the application must not be trusted to
-- maintain itself: vote counts, moderation queue entries, role escalation,
-- photo limits, and rate limits.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose. A policy on profiles that reads profiles would
-- recurse forever under RLS; running as definer bypasses RLS and breaks the loop.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Every auth user gets a profile
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Nobody promotes themselves
-- ---------------------------------------------------------------------------

-- Column grants stop an ordinary user writing `role` at all, but a grant is easy
-- to loosen by accident later. This trigger is the belt to that braces: role can
-- only change if an existing admin is making the change.
create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null only outside a browser session -- the Supabase SQL
  -- editor, a migration, or the service role key. Those contexts are already
  -- trusted, and excluding them is what makes the documented first-admin
  -- bootstrap in 0004 possible; without this the guard would lock out the very
  -- promotion it tells you to run.
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'only an admin may change a profile role';
  end if;
  return new;
end;
$$;

create trigger guard_profile_role
  before update on public.profiles
  for each row execute function public.guard_profile_role_change();

-- ---------------------------------------------------------------------------
-- Keep geom in step with lat/lng
-- ---------------------------------------------------------------------------

create or replace function public.sync_report_geom()
returns trigger
language plpgsql
as $$
begin
  new.geom = st_setsrid(st_makepoint(new.lng, new.lat), 4326)::geography;
  return new;
end;
$$;

create trigger sync_report_geom
  before insert or update of lat, lng on public.reports
  for each row execute function public.sync_report_geom();

-- A report with no note has nothing to review, so it must not sit pending
-- forever waiting for a job that is never created.
create or replace function public.default_note_status()
returns trigger
language plpgsql
as $$
begin
  if new.note is null or char_length(trim(new.note)) = 0 then
    new.note_status = 'approved';
  else
    new.note_status = 'pending';
  end if;
  return new;
end;
$$;

create trigger default_note_status
  before insert on public.reports
  for each row execute function public.default_note_status();

-- ---------------------------------------------------------------------------
-- Vote count denormalisation
-- ---------------------------------------------------------------------------

-- Recomputed from the votes table rather than incremented, so the count can
-- never drift away from the rows that justify it.
create or replace function public.sync_vote_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(new.report_id, old.report_id);
begin
  update public.reports
     set vote_count = (select count(*) from public.votes where report_id = target)
   where id = target;
  return null;
end;
$$;

create trigger sync_vote_count_on_insert
  after insert on public.votes
  for each row execute function public.sync_vote_count();

create trigger sync_vote_count_on_delete
  after delete on public.votes
  for each row execute function public.sync_vote_count();

-- ---------------------------------------------------------------------------
-- A report carries at most three photos
-- ---------------------------------------------------------------------------

create or replace function public.enforce_photo_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.report_photos where report_id = new.report_id) >= 3 then
    raise exception 'a report may have at most 3 photos';
  end if;
  return new;
end;
$$;

create trigger enforce_photo_limit
  before insert on public.report_photos
  for each row execute function public.enforce_photo_limit();

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------

create or replace function public.enforce_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.reports
    where reporter_id = new.reporter_id
      and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'too many reports in the last hour; please slow down';
  end if;
  return new;
end;
$$;

create trigger enforce_report_rate_limit
  before insert on public.reports
  for each row execute function public.enforce_report_rate_limit();

create or replace function public.enforce_comment_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.comments
    where author_id = new.author_id
      and created_at > now() - interval '1 minute'
  ) >= 5 then
    raise exception 'too many comments in the last minute; please slow down';
  end if;
  return new;
end;
$$;

create trigger enforce_comment_rate_limit
  before insert on public.comments
  for each row execute function public.enforce_comment_rate_limit();

-- ---------------------------------------------------------------------------
-- Queue everything a human might object to
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_moderation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kind subject_type;
begin
  kind := case tg_table_name
            when 'report_photos' then 'photo'::subject_type
            when 'comments'      then 'comment'::subject_type
            else 'note'::subject_type
          end;

  -- A report with no note has nothing for the text tiers to judge. Its
  -- note_status is already 'approved' by the trigger below, so it is not left
  -- waiting on a job that will never exist.
  if kind = 'note' and (new.note is null or char_length(trim(new.note)) = 0) then
    return null;
  end if;

  insert into public.moderation_jobs (subject_type, subject_id)
  values (kind, new.id)
  on conflict (subject_type, subject_id) do nothing;

  return null;
end;
$$;

create trigger enqueue_photo_moderation
  after insert on public.report_photos
  for each row execute function public.enqueue_moderation();

create trigger enqueue_comment_moderation
  after insert on public.comments
  for each row execute function public.enqueue_moderation();

create trigger enqueue_note_moderation
  after insert on public.reports
  for each row execute function public.enqueue_moderation();

create trigger touch_moderation_jobs
  before update on public.moderation_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Marking a report cleaned
-- ---------------------------------------------------------------------------

-- Exposed as an RPC rather than a table UPDATE so the RLS policy for reports can
-- stay narrow: no ordinary user needs direct UPDATE on the table at all.
create or replace function public.mark_report_cleaned(target_report uuid)
returns public.reports
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.reports;
begin
  if auth.uid() is null then
    raise exception 'you must be signed in to mark a report cleaned';
  end if;

  update public.reports
     set status     = 'cleaned',
         cleaned_by = auth.uid(),
         cleaned_at = now()
   where id = target_report
     and status = 'open'
     and moderation_status = 'approved'
  returning * into updated;

  if updated is null then
    raise exception 'report not found, already cleaned, or not yet approved';
  end if;

  return updated;
end;
$$;

revoke all on function public.mark_report_cleaned(uuid) from public;
grant execute on function public.mark_report_cleaned(uuid) to authenticated;
