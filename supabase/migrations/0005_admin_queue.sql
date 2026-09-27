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

create or replace function mo.admin_moderation_queue(max_results integer default 50)
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
  flag_count   bigint,
  -- Whether the report this item sits on is on the map right now, or null
  -- when it sits on no report. Carried with the item so the queue never has
  -- to guess from what it happens to have loaded or done itself.
  pin_on_map   boolean
)
language plpgsql
stable
security definer
set search_path = mo, public
as $$
begin
  if not mo.is_admin() then
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
      when 'comment' then (select c.body from mo.comments c where c.id = j.subject_id)
      when 'note'    then (select r.note from mo.reports  r where r.id = j.subject_id)
      when 'name'    then (select d.name from mo.display_names d where d.user_id = j.subject_id)
      else null
    end,
    case j.subject_type
      when 'photo' then (select p.storage_path from mo.report_photos p where p.id = j.subject_id)
      else null
    end,
    target.rid,
    (select count(*) from mo.flags f
      where f.subject_type = j.subject_type and f.subject_id = j.subject_id
        and f.resolved_at is null),
    -- Null, not false, when the report is gone: there is no pin to be off.
    case when pin.id is null then null
         else pin.moderation_status = 'approved' end
  from mo.moderation_jobs j
  -- The report the item sits on, worked out once for both columns above.
  cross join lateral (
    select case j.subject_type
      when 'photo'   then (select p.report_id from mo.report_photos p where p.id = j.subject_id)
      when 'comment' then (select c.report_id from mo.comments      c where c.id = j.subject_id)
      when 'note'    then j.subject_id
      -- A name belongs to a person, not to a report. Falling through to
      -- subject_id here would hand the admin screen a user id labelled as a
      -- report id.
      else null
    end as rid
  ) target
  left join mo.reports pin on pin.id = target.rid
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
    (select count(*) from mo.flags f
      where f.subject_type = j.subject_type and f.subject_id = j.subject_id
        and f.resolved_at is null) desc,
    j.created_at asc
  limit least(greatest(max_results, 1), 200);
end;
$$;

revoke all on function mo.admin_moderation_queue(integer) from public, anon;
grant execute on function mo.admin_moderation_queue(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Deciding
-- ---------------------------------------------------------------------------

-- The worker's record_moderation_verdict is revoked from browser roles, and
-- must stay that way. This is the admin's equivalent: same effect, but it
-- refuses anyone who is not an admin instead of relying on RLS to quietly
-- update nothing. A silent no-op would leave an admin believing they had
-- rejected something they had not.
create or replace function mo.admin_decide_moderation(
  job_id      uuid,
  new_verdict moderation_status,
  reason      text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = mo, public
as $$
declare
  job mo.moderation_jobs;
begin
  if not mo.is_admin() then
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
  select * into job from mo.moderation_jobs where id = job_id for update;
  if not found then
    raise exception 'no such moderation job: %', job_id;
  end if;

  if job.verdict is not null then
    raise exception 'this item has already been decided';
  end if;

  update mo.moderation_jobs
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

  -- Ruling on something settles the complaints about it, so they cannot
  -- re-withhold it the moment somebody else objects.
  update mo.flags
     set resolved_at = now()
   where subject_type = job.subject_type
     and subject_id = job.subject_id
     and resolved_at is null;

  if job.subject_type = 'photo' then
    update mo.report_photos set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'comment' then
    update mo.comments set moderation_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'note' then
    -- note_status, NOT moderation_status. Rejecting one offensive sentence must
    -- withhold the sentence, not erase a legitimate litter report from the map.
    update mo.reports set note_status = new_verdict where id = job.subject_id;
  elsif job.subject_type = 'name' then
    update mo.display_names set moderation_status = new_verdict where user_id = job.subject_id;
  end if;
end;
$$;

revoke all on function mo.admin_decide_moderation(uuid, moderation_status, text) from public, anon;
grant execute on function mo.admin_decide_moderation(uuid, moderation_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Taking a pin off the map, and putting it back
-- ---------------------------------------------------------------------------

-- The only writer of reports.moderation_status. A function rather than a
-- column grant, for the reason 0003 gives for removing those: a direct PATCH
-- would change what the map shows with no record of who did it or why. This
-- one refuses anybody who is not an admin -- raising, not quietly updating
-- nothing, so an admin is never told a pin is gone when it is not -- and
-- writes who, when and why alongside the status.
--
-- Rejecting a photo or a note withholds that content and leaves the pin. This
-- is for the pin itself: spam, a joke, a pin in the sea. Its photos and
-- comments are hidden with it (the public views check the pin) but not
-- changed, so putting it back restores it as it was.
--
-- Asking for the state a pin is already in changes nothing and records
-- nothing, so a double click, or two admins at once, cannot overwrite who took
-- it off or why. Every real change is appended to mo.pin_history, which keeps
-- the record the reports columns lose when a pin is put back.
create or replace function mo.admin_set_report_on_map(
  target_report uuid,
  on_map        boolean,
  reason        text default null
)
-- Whether the pin actually moved. False means it was already where it was
-- asked to be, so the screen can say so instead of claiming it just happened.
returns boolean
language plpgsql
volatile
security definer
set search_path = mo, public
as $$
begin
  if not mo.is_admin() then
    raise exception 'only an admin may take a pin off the map';
  end if;
  if on_map is null then
    raise exception 'say whether the pin should be on the map';
  end if;

  update mo.reports
     set moderation_status = case when on_map then 'approved' else 'rejected' end::moderation_status,
         removed_by        = case when on_map then null else auth.uid() end,
         removed_at        = case when on_map then null else now() end,
         removal_reason    = case when on_map then null else left(admin_set_report_on_map.reason, 500) end
   where id = target_report
     and moderation_status <> case when on_map then 'approved' else 'rejected' end::moderation_status;

  if not found then
    -- Either it does not exist, or it is already where it was asked to be.
    if not exists (select 1 from mo.reports where id = target_report) then
      raise exception 'no such report';
    end if;
    return false;
  end if;

  insert into mo.pin_history (report_id, action, acted_by, reason)
  values (
    target_report,
    case when on_map then 'on' else 'off' end,
    auth.uid(),
    left(admin_set_report_on_map.reason, 500)
  );
  return true;
end;
$$;

revoke all on function mo.admin_set_report_on_map(uuid, boolean, text) from public, anon;
grant execute on function mo.admin_set_report_on_map(uuid, boolean, text) to authenticated;

-- No new comments or photos on a pin that is off the map, refused in words.
--
-- The insert policies already refuse both (report_on_map in 0003). But a
-- policy refusal arrives as "new row violates row-level security policy",
-- which the app cannot tell apart from the comment policy's other reason --
-- no name yet -- and so asked people for a name they already had. BEFORE
-- triggers run ahead of a policy's WITH CHECK, so this one's message is the one
-- that comes back. The policies stay, so removing this trigger fails closed.
-- Touches only report_id, which both tables have.
create or replace function mo.refuse_post_on_off_map_pin()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
begin
  if exists (
    select 1 from mo.reports r
    where r.id = new.report_id and r.moderation_status = 'rejected'
  ) then
    raise exception 'this report is off the map';
  end if;
  return new;
end;
$$;

create trigger refuse_comment_on_off_map_pin
  before insert on mo.comments
  for each row execute function mo.refuse_post_on_off_map_pin();

create trigger refuse_photo_on_off_map_pin
  before insert on mo.report_photos
  for each row execute function mo.refuse_post_on_off_map_pin();

-- Votes too. votes_insert_own already refuses them, through
-- report_accepts_votes, but its refusal read as "You cannot confirm this one"
-- to somebody whose panel did not yet know the pin had gone.
create trigger refuse_vote_on_off_map_pin
  before insert on mo.votes
  for each row execute function mo.refuse_post_on_off_map_pin();

-- ---------------------------------------------------------------------------
-- How full is the queue
-- ---------------------------------------------------------------------------

create or replace function mo.admin_queue_size()
returns bigint
language plpgsql
stable
security definer
set search_path = mo, public
as $$
begin
  if not mo.is_admin() then
    raise exception 'only an admin may read the moderation queue';
  end if;
  return (
    select count(*) from mo.moderation_jobs
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

revoke all on function mo.admin_queue_size() from public, anon;
grant execute on function mo.admin_queue_size() to authenticated;

-- ---------------------------------------------------------------------------
-- A complaint puts something back in front of a person
-- ---------------------------------------------------------------------------

-- Without this, flagging did nothing at all. Content that had already been
-- decided kept its verdict, no job ever returned to the queue, and any number
-- of people could report a comment while it stayed live for good.
--
-- Clearing the verdict is what puts an item back in the queue -- the same
-- condition admin_moderation_queue selects on.
--
-- Re-flagging is refused, not refreshed. This used to say "the upsert simply
-- refreshes the reason"; there is no upsert — the app does a plain `.insert()`
-- into mo.flags, and the unique constraint on
-- (subject_type, subject_id, flagger_id) makes a second flag from the same
-- person a duplicate-key error.
--
-- One person, one complaint, which is right. But it reaches the browser as a
-- Postgres error string, so `plainWords` needs a rule for it or somebody is
-- told "something went wrong, please try again" about an action that cannot
-- ever succeed. The same is true of a duplicate vote and of voting on your own
-- report.
create or replace function mo.flag_reopens_review()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
begin
  -- UPDATE, not an upsert, and that is the fix to a real hole.
  --
  -- Only pull back something the machines have already finished with.
  --
  -- Resetting a job that is still pending or in progress would let anyone shove
  -- items straight past tiers 2 and 3 into the human queue -- and the ids of
  -- the whole unreviewed backlog are public, because the UI needs them to show
  -- "being checked" placeholders. A flag on a job still in the machine queue is
  -- not lost: record_moderation_verdict below refuses to publish anything
  -- carrying an unresolved complaint, and escalates it instead.
  --
  -- This used to be `insert ... on conflict do update ... where status = 'done'`,
  -- and the guard only ever applied to the update branch. With no existing job
  -- the INSERT ran unconditionally and put a `status = 'done', verdict = null`
  -- row straight into the human queue. That was reachable: a report whose note
  -- is whitespace gets no job at all (enqueue_moderation returns early), while
  -- validate_flag_subject accepts any note that is not null and nothing stops
  -- you flagging your own report. So a whitespace note plus a self-flag
  -- manufactured an admin queue item with blank text, as often as the report
  -- rate limit allowed.
  --
  -- An UPDATE cannot do that: no job, nothing to reopen. Which is also the
  -- right answer on the merits -- there is no text to review.
  update mo.moderation_jobs
     set status     = 'done',
         verdict    = null,
         reason     = 'people reported this',
         locked_at  = null,
         locked_by  = null,
         updated_at = now()
   where subject_type = new.subject_type
     and subject_id   = new.subject_id
     and status       = 'done';
  return null;
end;
$$;

create trigger flag_reopens_review
  after insert on mo.flags
  for each row execute function mo.flag_reopens_review();

-- Anything enough people complain about is withheld again while it waits.
--
-- Deliberately NOT on the first flag. One account could otherwise walk the map
-- and unpublish every approved photo one insert at a time. A single flag still
-- puts the item in front of an admin (above); it takes a second, independent
-- person to actually take the content down in the meantime.
-- One path here produces content that stays pending forever.
--
-- A report whose note is whitespace gets no moderation job: enqueue_moderation
-- returns early, and default_note_status has already set note_status to
-- 'approved'. But validate_flag_subject accepts any note that is not null, so
-- that report can be flagged — and this function then sets note_status back to
-- 'pending' with no job for anyone to rule on, and flag_reopens_review only
-- ever updates a job that already exists.
--
-- The note is whitespace, so nothing of value is withheld and the pin stays on
-- the map either way. It is recorded because it is the only way to reach
-- permanently-pending content that admin_moderation_queue cannot see, and that
-- is worth knowing before adding a "why is this still pending?" screen.
create or replace function mo.flag_withholds_content()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  complaints integer;
begin
  select count(*) into complaints
    from mo.flags
   where subject_type = new.subject_type
     and subject_id = new.subject_id
     -- Only complaints an admin has not already ruled on. Otherwise a decided
     -- item with two old flags is un-published again by the very next flagger,
     -- and no admin surface can ever make it stick.
     and resolved_at is null;

  if complaints < 2 then
    return null;
  end if;

  if new.subject_type = 'comment' then
    update mo.comments set moderation_status = 'pending'
     where id = new.subject_id and moderation_status = 'approved';
  elsif new.subject_type = 'photo' then
    update mo.report_photos set moderation_status = 'pending'
     where id = new.subject_id and moderation_status = 'approved';
  elsif new.subject_type = 'note' then
    -- `and note is not null` matters: a report with no note has note_status
    -- 'approved' to satisfy note_status_matches_note, and setting it back to
    -- 'pending' would violate that constraint and roll the whole flag back.
    update mo.reports set note_status = 'pending'
     where id = new.subject_id and note_status = 'approved' and note is not null;
  elsif new.subject_type = 'name' then
    update mo.display_names set moderation_status = 'pending'
     where user_id = new.subject_id and moderation_status = 'approved';
  end if;
  return null;
end;
$$;

create trigger flag_withholds_content
  after insert on mo.flags
  for each row execute function mo.flag_withholds_content();

-- ---------------------------------------------------------------------------
-- Flags cannot be used as a battering ram
-- ---------------------------------------------------------------------------

-- subject_id is polymorphic, so it cannot carry a foreign key. Without this
-- check, any signed-in account could insert flags for invented ids and, through
-- flag_reopens_review (SECURITY DEFINER), fill moderation_jobs -- a table no
-- browser role is granted at all -- with unbounded junk.
create or replace function mo.validate_flag_subject()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
begin
  if new.subject_type = 'comment' then
    if not exists (select 1 from mo.comments where id = new.subject_id) then
      raise exception 'no such comment';
    end if;
    -- Nobody complains about their own post. There is no honest reason to, and
    -- a complaint reopens a decided item -- so it was a way for the author of
    -- something rejected to send it back to a person, and, for a photo, to
    -- restart the thirty-day hold on its bytes.
    if exists (select 1 from mo.comments where id = new.subject_id and author_id = new.flagger_id) then
      raise exception 'you cannot report your own post';
    end if;
  elsif new.subject_type = 'photo' then
    if not exists (select 1 from mo.report_photos where id = new.subject_id) then
      raise exception 'no such photo';
    end if;
    if exists (
      select 1 from mo.report_photos p join mo.reports r on r.id = p.report_id
       where p.id = new.subject_id and r.reporter_id = new.flagger_id
    ) then
      raise exception 'you cannot report your own post';
    end if;
    -- Nor one whose bytes the R2 cleanup has retired (0006). Reopening it would
    -- put an image that is gone, or going, back in front of an admin.
    --
    -- The grant row is locked first, FOR SHARE, because the cleanup claims it
    -- FOR UPDATE. Without a lock both sides only read, and a complaint and a
    -- cleanup pass at the same moment could each miss the other: the photo
    -- back in the queue with its bytes deleted. With it, whichever comes second
    -- waits, and then sees what the first did -- the cleanup skips a grant a
    -- complaint holds, and a complaint that waited finds the grant retired.
    perform 1
       from mo.upload_grants g
       join mo.report_photos p on p.storage_path = g.storage_path
      where p.id = new.subject_id
        for share of g;
    if exists (
      select 1 from mo.report_photos p
        join mo.upload_grants g on g.storage_path = p.storage_path
       where p.id = new.subject_id and g.retired_at is not null
    ) then
      raise exception 'no such photo';
    end if;
  elsif new.subject_type = 'note' then
    if not exists (
      select 1 from mo.reports
      where id = new.subject_id and note is not null
    ) then
      raise exception 'no such note';
    end if;
    if exists (select 1 from mo.reports where id = new.subject_id and reporter_id = new.flagger_id) then
      raise exception 'you cannot report your own post';
    end if;
  elsif new.subject_type = 'name' then
    if not exists (select 1 from mo.display_names where user_id = new.subject_id) then
      raise exception 'no such name';
    end if;
    -- Belt to flags_insert_own's braces: whatever the route, nobody complains
    -- about their own name. That would only buy their name a place at the top
    -- of the human queue.
    if new.subject_id = new.flagger_id then
      raise exception 'you cannot report your own name';
    end if;
  else
    -- Every kind is handled above. Without this, a kind added to the enum
    -- later would pass validation with no check at all.
    raise exception 'cannot report this kind of thing';
  end if;
  return new;
end;
$$;

create trigger validate_flag_subject
  before insert on mo.flags
  for each row execute function mo.validate_flag_subject();

-- The other tables are rate limited; without the same here, one account can
-- still generate unlimited review work even if it cannot take content down.
--
-- The same shape as every counting limit here -- statement-level, locked per
-- person, counted with the new rows included so the test is `> 20`. The note
-- above enforce_report_rate_limit in 0002 explains why the lock is the part
-- that matters, and corrects the reason this comment used to give.
--
-- Counted in mo.post_log, not mo.flags, for the same reason as reports and
-- comments: flags disappear when their subject is deleted, and the subject can
-- be the flagger's own comment.
create or replace function mo.enforce_flag_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  flagger uuid;
  offender uuid;
begin
  for flagger in select distinct flagger_id from new_rows loop
    perform pg_advisory_xact_lock(hashtext('flag:' || flagger::text));
  end loop;

  insert into mo.post_log (user_id, kind)
  select flagger_id, 'flag' from new_rows;

  delete from mo.post_log l
   using (select distinct flagger_id from new_rows) n
   where l.user_id = n.flagger_id
     and l.kind = 'flag'
     and l.created_at <= now() - interval '1 hour';

  select n.flagger_id into offender
    from (select distinct flagger_id from new_rows) n
   where (
     select count(*) from mo.post_log l
      where l.user_id = n.flagger_id
        and l.kind = 'flag'
        and l.created_at > now() - interval '1 hour'
   ) > 20
   limit 1;

  if offender is not null then
    raise exception 'too many reports in the last hour; please slow down';
  end if;
  return null;
end;
$$;

create trigger enforce_flag_rate_limit
  after insert on mo.flags
  referencing new table as new_rows
  for each statement execute function mo.enforce_flag_rate_limit();

-- ---------------------------------------------------------------------------
-- Deleted content leaves nothing behind
-- ---------------------------------------------------------------------------

-- moderation_jobs.subject_id is polymorphic, so it cannot carry a foreign key
-- and nothing cascades. Reports, photos and comments are all user-deletable, so
-- without this a deleted subject leaves its job behind: the worker claims it,
-- finds nothing, escalates it, and it sits in the human queue forever reading
-- "This content is no longer available" with buttons that update no rows.
create or replace function mo.cleanup_moderation_for_deleted()
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

  delete from mo.moderation_jobs
   where subject_type = kind and subject_id = old.id;
  delete from mo.flags
   where subject_type = kind and subject_id = old.id;

  -- Nothing extra is needed for a report's photos and comments: Postgres does
  -- fire row-level triggers on cascade deletes, so their own cleanup triggers
  -- below run for each cascaded row and clear their flags too.

  return old;
end;
$$;

create trigger cleanup_moderation_on_report_delete
  before delete on mo.reports
  for each row execute function mo.cleanup_moderation_for_deleted();

create trigger cleanup_moderation_on_photo_delete
  after delete on mo.report_photos
  for each row execute function mo.cleanup_moderation_for_deleted();

create trigger cleanup_moderation_on_comment_delete
  after delete on mo.comments
  for each row execute function mo.cleanup_moderation_for_deleted();

-- A name is keyed by user_id rather than id, so it gets its own function
-- rather than a branch in the shared one above -- reaching `old.user_id` there
-- would fail on the three tables that have no such column, for the reason
-- enqueue_moderation in 0002 spells out. Names are only ever deleted by the
-- cascade from public.profiles, but an orphaned job would sit in the human
-- queue forever all the same.
create or replace function mo.cleanup_moderation_for_deleted_name()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
begin
  delete from mo.moderation_jobs
   where subject_type = 'name' and subject_id = old.user_id;
  delete from mo.flags
   where subject_type = 'name' and subject_id = old.user_id;
  return old;
end;
$$;

create trigger cleanup_moderation_on_name_delete
  after delete on mo.display_names
  for each row execute function mo.cleanup_moderation_for_deleted_name();

-- ---------------------------------------------------------------------------
-- Complaining about a name, from the comment it is shown on
-- ---------------------------------------------------------------------------

-- A name's subject_id is its owner's id, and public_comments withholds that id
-- from everybody but the author -- it is one request away from their email
-- prefix in public.profiles. So a reader cannot raise a 'name' flag directly;
-- they have nothing to put in subject_id. Without this, a name the machines
-- wrongly approved could only ever be taken down from the SQL editor.
--
-- The caller names the COMMENT, which they can see, and this files the flag
-- against its author's name. It returns nothing, so the id never leaves the
-- database. The insert goes through every trigger on mo.flags as usual --
-- validation, the rate limit, reopening review, and withholding after two
-- people -- so this adds no route around any of them.
--
-- Only an approved comment carrying an approved name: that is the name other
-- people can see, and so the only one a reader could be complaining about.
create or replace function mo.flag_comment_author(target_comment uuid, reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = mo, public
as $$
declare
  author uuid;
begin
  if auth.uid() is null then
    raise exception 'you must be signed in to report this';
  end if;

  select c.author_id into author
    from mo.comments c
   where c.id = target_comment
     and c.moderation_status = 'approved';

  if author is null
     or not exists (
       select 1 from mo.display_names d
        where d.user_id = author and d.moderation_status = 'approved'
     )
  then
    raise exception 'no such name';
  end if;

  if author = auth.uid() then
    raise exception 'you cannot report your own name';
  end if;

  insert into mo.flags (subject_type, subject_id, flagger_id, reason)
  values ('name', author, auth.uid(), left(flag_comment_author.reason, 500));
end;
$$;

revoke all on function mo.flag_comment_author(uuid, text) from public, anon;
grant execute on function mo.flag_comment_author(uuid, text) to authenticated;

-- The same, from a report. public_reports shows the reporter's approved name,
-- and withholds reporter_id for the same reason, so somebody who reports
-- litter but never comments would otherwise have a name nobody could complain
-- about. The pin itself stays on the map regardless: this is about the name.
create or replace function mo.flag_report_author(target_report uuid, reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = mo, public
as $$
declare
  author uuid;
begin
  if auth.uid() is null then
    raise exception 'you must be signed in to report this';
  end if;

  select r.reporter_id into author
    from mo.reports r
   where r.id = target_report
     and r.moderation_status <> 'rejected';

  if author is null
     or not exists (
       select 1 from mo.display_names d
        where d.user_id = author and d.moderation_status = 'approved'
     )
  then
    raise exception 'no such name';
  end if;

  if author = auth.uid() then
    raise exception 'you cannot report your own name';
  end if;

  insert into mo.flags (subject_type, subject_id, flagger_id, reason)
  values ('name', author, auth.uid(), left(flag_report_author.reason, 500));
end;
$$;

revoke all on function mo.flag_report_author(uuid, text) from public, anon;
grant execute on function mo.flag_report_author(uuid, text) to authenticated;

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
