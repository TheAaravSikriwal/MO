-- MO — functions and triggers
--
-- Everything here maintains an invariant the application must not be trusted to
-- maintain itself: vote counts, moderation queue entries, role escalation,
-- photo limits, and rate limits.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose. Policies all over 0003 call this, and mo.admins
-- is revoked from browser roles, so running as definer is the only way the
-- answer is available at all.

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
set search_path = mo, public;

create or replace function mo.is_admin()
returns boolean
language sql
stable
security definer
set search_path = mo, public
as $$
  select exists (select 1 from mo.admins where user_id = auth.uid());
$$;

-- The app has to be able to ask this, and it cannot read mo.admins: 0003
-- revokes the table so nobody can enumerate the moderators. Exposing the
-- answer about YOURSELF leaks nothing -- you already know -- while the list
-- itself stays unreachable.
--
-- anon as well as authenticated, spelled out. The three public views call this
-- and are not security_invoker, so EXECUTE is checked against the INVOKING
-- role -- which for a signed-out map load is `anon`. That worked only through
-- Postgres's implicit grant of EXECUTE on new functions to PUBLIC, and this
-- file revokes exactly that implicit grant from five other functions on the
-- grounds that relying on it is a trap. Relying on it here too, silently, was
-- the inconsistency: the consistent move elsewhere -- `revoke ... from public`
-- -- would have broken every anonymous map load with nothing to show why.
grant execute on function mo.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Asking about a report from a policy on another table
-- ---------------------------------------------------------------------------
--
-- 0003 revokes `reports` from anon and authenticated and re-grants only
-- `select (id)`, so that nobody can read an unapproved note off the base table.
-- That makes a policy which reaches into `reports` from another table illegal:
-- a policy expression runs with the CALLER'S privileges, so
--
--   exists (select 1 from mo.reports r
--            where r.id = report_id and r.reporter_id = auth.uid())
--
-- raises `permission denied for table reports` rather than returning false.
-- Every insert it guards fails, for everyone, including the owner -- and the
-- error arrives as a 403, which reads like "not yours" rather than
-- "misconfigured".
--
-- These two functions are the way out, and they are the same pattern
-- `is_admin()` already uses: SECURITY DEFINER, so the read happens with the
-- function owner's privileges, and only a boolean comes back. Neither leaks
-- anything: you already know which reports are yours, and whether a report is
-- open and approved is public in `public_reports`.

create or replace function mo.owns_report(report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mo, public
as $$
  select exists (
    select 1 from mo.reports r
    where r.id = report_id and r.reporter_id = auth.uid()
  );
$$;

create or replace function mo.report_accepts_votes(report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mo, public
as $$
  select exists (
    select 1 from mo.reports r
    where r.id = report_id
      and r.moderation_status = 'approved'
      and r.status = 'open'
  );
$$;

-- anon as well as authenticated: the photo select policy has no `to` clause,
-- so it applies to every role. For a signed-out visitor auth.uid() is null and
-- owns_report simply returns false.
grant execute on function mo.owns_report(uuid)          to anon, authenticated;
grant execute on function mo.report_accepts_votes(uuid)  to anon, authenticated;

create or replace function mo.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles are not MO's
-- ---------------------------------------------------------------------------
--
-- MO used to create `public.profiles` and a trigger on auth.users to populate
-- it. Both are gone: chintu's own `handle_new_user` in `001_initial_schema.sql`
-- already inserts a profile for every auth user, and a second trigger of the
-- same name on the same table would simply fail to create.
--
-- Nothing replaces the old `guard_profile_role_change` either. It existed to
-- stop somebody writing `role = 'admin'` on their own profile row; there is no
-- role column now. What replaces it is the absence of a grant: mo.admins is
-- revoked from anon and authenticated in 0003, with no insert or update policy
-- at all, so promotion is not something a browser can attempt. Only the service
-- role key, or the SQL editor, can add an admin.

-- ---------------------------------------------------------------------------
-- Keep geom in step with lat/lng
-- ---------------------------------------------------------------------------

-- `search_path` pinned, like every other function here. This one calls
-- st_setsrid and st_makepoint, which live in `extensions` on Supabase — left
-- unset, they resolve against whatever path the INSERTING role happens to
-- have, which for a browser request is not something this file controls.
-- SECURITY DEFINER, like almost every other trigger function here, and it was
-- the exception. st_setsrid and st_makepoint live in `extensions` on Supabase,
-- so as an invoker function this needed the INSERTING role to hold USAGE on
-- that schema. `authenticated` does by default, but that is Supabase's choice
-- rather than anything MO states or controls, and a report insert failing on
-- `function st_makepoint does not exist` would be a puzzling way to find out.
create or replace function mo.sync_report_geom()
returns trigger
language plpgsql
security definer
set search_path = mo, public, extensions
as $$
begin
  new.geom = st_setsrid(st_makepoint(new.lng, new.lat), 4326)::geography;
  return new;
end;
$$;

create trigger sync_report_geom
  before insert or update of lat, lng on mo.reports
  for each row execute function mo.sync_report_geom();

-- A report with no note has nothing to review, so it must not sit pending
-- forever waiting for a job that is never created.
create or replace function mo.default_note_status()
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
  before insert on mo.reports
  for each row execute function mo.default_note_status();

-- ---------------------------------------------------------------------------
-- Vote count denormalisation
-- ---------------------------------------------------------------------------

-- Recomputed from the votes table rather than incremented, so the count can
-- never drift away from the rows that justify it.
create or replace function mo.sync_vote_count()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  target uuid := coalesce(new.report_id, old.report_id);
begin
  update mo.reports
     set vote_count = (select count(*) from mo.votes where report_id = target)
   where id = target;
  return null;
end;
$$;

create trigger sync_vote_count_on_insert
  after insert on mo.votes
  for each row execute function mo.sync_vote_count();

create trigger sync_vote_count_on_delete
  after delete on mo.votes
  for each row execute function mo.sync_vote_count();

-- ---------------------------------------------------------------------------
-- A report carries at most three photos
-- ---------------------------------------------------------------------------

-- AFTER ... FOR EACH STATEMENT, for the same reason as the upload grant limit
-- in 0006: a BEFORE ROW trigger cannot see the other rows of its own
-- statement, and PostgREST inserts a JSON array as one statement. In the row
-- form, one request could attach any number of photos to a report -- every
-- invocation read the same pre-statement count of zero. Counted after the
-- statement the rows are visible, so the test is `> 3` rather than `>= 3`.
--
-- `enforce_photo_has_grant` (0006) stays a BEFORE ROW trigger: it spends one
-- grant per row, which is per-row work. If this statement trigger then raises,
-- the whole statement rolls back and those spends go with it.
create or replace function mo.enforce_photo_limit()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  subject uuid;
  crowded uuid;
begin
  -- Locked per report before counting, like the grant limit in 0006 and the
  -- flag limit in 0005. Counting per statement fixes visibility but not
  -- contention: two concurrent statements of three photos each see only their
  -- own rows, both pass `> 3`, and the report ends up with six. The lock is
  -- transaction-scoped, so the second one counts after the first has committed.
  for subject in select distinct report_id from new_rows loop
    perform pg_advisory_xact_lock(hashtext('report_photo:' || subject::text));
  end loop;

  select n.report_id into crowded
    from (select distinct report_id from new_rows) n
   where (
     select count(*) from mo.report_photos p where p.report_id = n.report_id
   ) > 3
   limit 1;

  if crowded is not null then
    raise exception 'a report may have at most 3 photos';
  end if;
  return null;
end;
$$;

create trigger enforce_photo_limit
  after insert on mo.report_photos
  referencing new table as new_rows
  for each statement execute function mo.enforce_photo_limit();

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------

create or replace function mo.enforce_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
begin
  if (
    select count(*) from mo.reports
    where reporter_id = new.reporter_id
      and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'too many reports in the last hour; please slow down';
  end if;
  return new;
end;
$$;

create trigger enforce_report_rate_limit
  before insert on mo.reports
  for each row execute function mo.enforce_report_rate_limit();

create or replace function mo.enforce_comment_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
begin
  if (
    select count(*) from mo.comments
    where author_id = new.author_id
      and created_at > now() - interval '1 minute'
  ) >= 5 then
    raise exception 'too many comments in the last minute; please slow down';
  end if;
  return new;
end;
$$;

create trigger enforce_comment_rate_limit
  before insert on mo.comments
  for each row execute function mo.enforce_comment_rate_limit();

-- ---------------------------------------------------------------------------
-- Queue everything a human might object to
-- ---------------------------------------------------------------------------

create or replace function mo.enqueue_moderation()
returns trigger
language plpgsql
security definer
set search_path = mo, public
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
  --
  -- NESTED, not `if kind = 'note' and (new.note is null ...)`.
  --
  -- This one function sits behind three triggers, and `note` exists only on
  -- mo.reports. PL/pgSQL resolves a record field when it builds the
  -- expression's parameters, which happens for the whole condition before any
  -- AND can short-circuit — so the flat form raised `record "new" has no
  -- field "note"` on every insert into mo.report_photos and mo.comments. That
  -- is both core writes of the product, and it was intermittent rather than
  -- reliably loud: a cached plan from an earlier mo.reports insert in the same
  -- backend could let one through, so across pooled PostgREST connections it
  -- would have looked flaky rather than broken.
  --
  -- Nesting means the inner expression is only reached, and only parsed, for a
  -- row whose table actually has the column.
  if kind = 'note' then
    if new.note is null or char_length(trim(new.note)) = 0 then
      return null;
    end if;
  end if;

  insert into mo.moderation_jobs (subject_type, subject_id)
  values (kind, new.id)
  on conflict (subject_type, subject_id) do nothing;

  return null;
end;
$$;

create trigger enqueue_photo_moderation
  after insert on mo.report_photos
  for each row execute function mo.enqueue_moderation();

create trigger enqueue_comment_moderation
  after insert on mo.comments
  for each row execute function mo.enqueue_moderation();

create trigger enqueue_note_moderation
  after insert on mo.reports
  for each row execute function mo.enqueue_moderation();

create trigger touch_moderation_jobs
  before update on mo.moderation_jobs
  for each row execute function mo.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Marking a report cleaned
-- ---------------------------------------------------------------------------

-- Exposed as an RPC rather than a table UPDATE so the RLS policy for reports can
-- stay narrow: no ordinary user needs direct UPDATE on the table at all.
-- Returns nothing on purpose.
--
-- Returning `mo.reports` handed the caller the entire row -- including a
-- note still waiting for review -- and SECURITY DEFINER meant the column grants
-- in 0003 did not apply. Any signed-in person could have drained every
-- unreviewed note in the database one RPC call at a time.
create or replace function mo.mark_report_cleaned(target_report uuid)
returns void
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  updated_id uuid;
begin
  if auth.uid() is null then
    raise exception 'you must be signed in to mark a report cleaned';
  end if;

  update mo.reports
     set status     = 'cleaned',
         cleaned_by = auth.uid(),
         cleaned_at = now()
   where id = target_report
     and status = 'open'
     and moderation_status = 'approved'
  returning id into updated_id;

  if updated_id is null then
    raise exception 'report not found, already cleaned, or not yet approved';
  end if;
end;
$$;

revoke all on function mo.mark_report_cleaned(uuid) from public, anon;
grant execute on function mo.mark_report_cleaned(uuid) to authenticated;

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
