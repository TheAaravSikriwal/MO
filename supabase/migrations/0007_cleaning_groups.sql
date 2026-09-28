-- ---------------------------------------------------------------------------
-- 0007 — cleaning groups
-- ---------------------------------------------------------------------------
--
-- People who want to clean up an area together. A group has a name, a short
-- description of what it does and a home area on the map, and anybody signed
-- in can start one or join one.
--
-- The name and description are free text shown in public, so they are judged
-- like a note or a display name: a new group is 'pending', seen only by the
-- people in it (at first, just the person who started it), until the
-- moderation pipeline or an admin approves it. The moderation job is subject 'group'; the shared moderation functions
-- in 0004 and 0005 carry a branch for it (they are plpgsql, so a table created
-- here is resolved when they run, not when they were created).
--
-- Who is in a group is never shown, only how many. A member list would be a
-- list of people who are often in one place at predictable times, and nothing
-- the feature needs requires it.
--
-- Nothing here is readable or writable directly. Every read and write is a
-- security definer function below that checks who is asking, the same shape
-- as mo.display_names.

set search_path = mo, public;

-- ---------------------------------------------------------------------------
-- The tables
-- ---------------------------------------------------------------------------

create table mo.cleaning_groups (
  id                uuid primary key default gen_random_uuid(),
  -- Set null, not cascade: a group other people have joined should outlive its
  -- founder's account. It simply has nobody who can delete it but an admin.
  created_by        uuid references public.profiles (id) on delete set null,
  name              text not null check (
                      name = btrim(name)
                      and char_length(name) between 3 and 60
                      and name !~ '[[:cntrl:]]'
                      and mo.visible_length(name) >= 3
                    ),
  -- Line breaks are allowed in a description; no other control character is.
  description       text not null default '' check (
                      char_length(description) <= 500
                      and translate(description, chr(10), '') !~ '[[:cntrl:]]'
                    ),
  home_lat          double precision not null check (home_lat between -90 and 90),
  home_lng          double precision not null check (home_lng between -180 and 180),
  moderation_status moderation_status not null default 'pending',
  created_at        timestamptz not null default now(),
  -- What the moderation pipeline and the review queue read: both parts of the
  -- public text at once, so neither can be approved without the other.
  review_text       text generated always as (name || chr(10) || chr(10) || description) stored
);

create index cleaning_groups_home_idx on mo.cleaning_groups (home_lat, home_lng);

create table mo.group_members (
  group_id  uuid not null references mo.cleaning_groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_members_user_idx on mo.group_members (user_id);

alter table mo.cleaning_groups enable row level security;
alter table mo.group_members enable row level security;

-- No policies: with row level security on and no policy, nobody but the
-- functions below (and the worker, granted below) can see a row.
revoke all on mo.cleaning_groups from anon, authenticated;
revoke all on mo.group_members from anon, authenticated;

-- The worker reads review_text to judge a group, as it reads a note.
grant select on mo.cleaning_groups to service_role;

-- ---------------------------------------------------------------------------
-- A limit on starting groups
-- ---------------------------------------------------------------------------
--
-- Three a day per person, counted from mo.post_log so deleting a group does not
-- give the slot back. Locked per person before counting, like every limit in
-- 0002: see the note on counting limits there.
create or replace function mo.enforce_group_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  founder uuid;
  offender uuid;
begin
  -- A group with no founder can only come from the database itself (nothing
  -- else may insert one), and has nobody to limit.
  for founder in select distinct created_by from new_rows where created_by is not null loop
    perform pg_advisory_xact_lock(hashtext('group:' || founder::text));
  end loop;

  insert into mo.post_log (user_id, kind)
  select created_by, 'group' from new_rows where created_by is not null;

  delete from mo.post_log l
   using (select distinct created_by from new_rows where created_by is not null) n
   where l.user_id = n.created_by
     and l.kind = 'group'
     and l.created_at <= now() - interval '1 day';

  select n.created_by into offender
    from (select distinct created_by from new_rows where created_by is not null) n
   where (
     select count(*) from mo.post_log l
      where l.user_id = n.created_by
        and l.kind = 'group'
        and l.created_at > now() - interval '1 day'
   ) > 3
   limit 1;

  if offender is not null then
    raise exception 'too many groups started today; please try again tomorrow';
  end if;
  return null;
end;
$$;

create trigger enforce_group_rate_limit
  after insert on mo.cleaning_groups
  referencing new table as new_rows
  for each statement execute function mo.enforce_group_rate_limit();

-- A deleted group takes its review job and any complaints with it, or they
-- would sit in the admin queue forever with nothing to decide on.
create trigger cleanup_moderation_on_group_delete
  after delete on mo.cleaning_groups
  for each row execute function mo.cleanup_moderation_for_deleted();

-- ---------------------------------------------------------------------------
-- Reading: the groups in a part of the map
-- ---------------------------------------------------------------------------
--
-- Approved groups, for anybody. A pending or rejected group only for the person
-- who started it, so they can see it is waiting (or why it never appeared), and
-- for the people in it: a group two complaints take down goes back to pending,
-- and its members must still be able to see what happened and leave it.
-- A viewport crossing the 180th meridian arrives with min_lng > max_lng.
create or replace function mo.cleaning_groups_in_view(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision
)
returns table (
  id                uuid,
  name              text,
  description       text,
  home_lat          double precision,
  home_lng          double precision,
  moderation_status moderation_status,
  member_count      bigint,
  viewer_is_member  boolean,
  viewer_is_founder boolean
)
language sql
stable
security definer
set search_path = mo, public
as $$
  select
    g.id,
    g.name,
    g.description,
    g.home_lat,
    g.home_lng,
    g.moderation_status,
    (select count(*) from mo.group_members m where m.group_id = g.id),
    exists (select 1 from mo.group_members m where m.group_id = g.id and m.user_id = auth.uid()),
    coalesce(g.created_by = auth.uid(), false)
  from mo.cleaning_groups g
  where (
          g.moderation_status = 'approved'
          or g.created_by = auth.uid()
          or exists (select 1 from mo.group_members m where m.group_id = g.id and m.user_id = auth.uid())
        )
    and g.home_lat between min_lat and max_lat
    and case when min_lng <= max_lng
             then g.home_lng between min_lng and max_lng
             else g.home_lng >= min_lng or g.home_lng <= max_lng
        end
  -- The viewer's own groups first, so one just started is never the one a
  -- busy area pushes off the end. One more than a page, so the app can say
  -- when it has not been given them all.
  order by
    (coalesce(g.created_by = auth.uid(), false)
      or exists (select 1 from mo.group_members m where m.group_id = g.id and m.user_id = auth.uid())) desc,
    7 desc,
    g.created_at desc
  limit 201;
$$;

-- ---------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------

-- Start a group. The founder joins it, and it waits for review.
create or replace function mo.create_cleaning_group(
  group_name text,
  about text,
  lat double precision,
  lng double precision
)
returns uuid
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  me uuid := auth.uid();
  made uuid;
  clean_name text := btrim(coalesce(group_name, ''));
  clean_about text := btrim(coalesce(about, ''));
begin
  if me is null then
    raise exception 'sign in to start a group';
  end if;
  -- As for a report or a comment: nothing public goes out before its author
  -- has chosen the name it is posted under.
  if not mo.has_display_name() then
    raise exception 'choose a name before you post';
  end if;
  if char_length(clean_name) < 3 or mo.visible_length(clean_name) < 3 then
    raise exception 'a group name needs at least 3 letters';
  end if;
  if char_length(clean_name) > 60 then
    raise exception 'a group name can be at most 60 characters';
  end if;
  -- Said here, before the table's own check refuses it by constraint name and
  -- the person is told something about length instead.
  if clean_name ~ '[[:cntrl:]]' then
    raise exception 'a group name cannot contain tabs or line breaks';
  end if;
  if char_length(clean_about) > 500 then
    raise exception 'a group description can be at most 500 characters';
  end if;
  if translate(clean_about, chr(10), '') ~ '[[:cntrl:]]' then
    raise exception 'a group description cannot contain tabs';
  end if;
  if lat is null or lng is null or lat not between -90 and 90 or lng not between -180 and 180 then
    raise exception 'that is not a place on the map';
  end if;

  insert into mo.cleaning_groups (created_by, name, description, home_lat, home_lng)
  values (me, clean_name, clean_about, lat, lng)
  returning id into made;

  insert into mo.group_members (group_id, user_id) values (made, me);
  insert into mo.moderation_jobs (subject_type, subject_id) values ('group', made);

  return made;
end;
$$;

-- Join a group. Only one that is approved, or your own while it waits.
create or replace function mo.join_cleaning_group(target uuid)
returns void
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in to join a group';
  end if;
  if not exists (
    select 1 from mo.cleaning_groups g
     where g.id = target
       and (g.moderation_status = 'approved' or g.created_by = me)
  ) then
    raise exception 'no such group';
  end if;
  insert into mo.group_members (group_id, user_id)
  values (target, me)
  on conflict do nothing;
end;
$$;

-- Leave a group. Leaving one you are not in changes nothing.
create or replace function mo.leave_cleaning_group(target uuid)
returns void
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in to leave a group';
  end if;
  delete from mo.group_members where group_id = target and user_id = me;
end;
$$;

-- Delete a group. Its founder can, and so can an admin.
create or replace function mo.delete_cleaning_group(target uuid)
returns void
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in to delete a group';
  end if;
  delete from mo.cleaning_groups g
   where g.id = target
     and (g.created_by = me or mo.is_admin());
  if not found then
    raise exception 'only the person who started a group can delete it';
  end if;
end;
$$;

-- Reading is open to anybody; writing needs a signed-in person, which every
-- function also checks itself.
revoke all on function mo.cleaning_groups_in_view(double precision, double precision, double precision, double precision) from public;
grant execute on function mo.cleaning_groups_in_view(double precision, double precision, double precision, double precision) to anon, authenticated;

revoke all on function mo.create_cleaning_group(text, text, double precision, double precision) from public, anon;
grant execute on function mo.create_cleaning_group(text, text, double precision, double precision) to authenticated;

revoke all on function mo.join_cleaning_group(uuid) from public, anon;
grant execute on function mo.join_cleaning_group(uuid) to authenticated;

revoke all on function mo.leave_cleaning_group(uuid) from public, anon;
grant execute on function mo.leave_cleaning_group(uuid) to authenticated;

revoke all on function mo.delete_cleaning_group(uuid) from public, anon;
grant execute on function mo.delete_cleaning_group(uuid) to authenticated;

revoke all on function mo.enforce_group_rate_limit() from public, anon, authenticated;

reset search_path;
