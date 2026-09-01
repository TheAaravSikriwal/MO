-- MO — public views and row-level security
--
-- The guiding rule: a report's PIN goes live immediately so the map stays
-- alive, but anything a person wrote or photographed stays withheld until the
-- moderation worker has ruled on it.

-- ---------------------------------------------------------------------------
-- Public views
-- ---------------------------------------------------------------------------

-- These views are the ONLY public read path for report content, and they are
-- SECURITY DEFINER (the default) rather than security_invoker.
--
-- The earlier design granted plain SELECT on the base tables and relied on the
-- views to mask columns. That masking was decorative: `select storage_path from
-- report_photos where moderation_status = 'pending'` returned an unreviewed
-- photo path to a signed-out visitor. The column was unlinked, not withheld.
--
-- So the base tables are no longer readable by anon or authenticated at all
-- (see the grants at the bottom), and these views carry the full visibility
-- rules themselves -- including the author's right to see their own rejected
-- content, which RLS used to provide.

create view public.public_reports as
select
  r.id,
  r.reporter_id,
  r.lat,
  r.lng,
  r.cell_r1,
  r.cell_r3,
  r.cell_r5,
  r.cell_r7,
  r.cell_r9,
  r.cell_r12,
  -- The pin is public immediately so the map stays alive. The note is not:
  -- a location with litter on it is not objectionable, but the free text
  -- somebody attached to it might be.
  case
    when r.note_status = 'approved'
      or r.reporter_id = auth.uid()
      or public.is_admin()
    then r.note
    else null
  end as note,
  r.note_status,
  r.moderation_status,
  r.status,
  r.cleaned_by,
  r.cleaned_at,
  r.vote_count,
  r.created_at
from public.reports r
where r.moderation_status <> 'rejected'
   or r.reporter_id = auth.uid()
   or public.is_admin();

create view public.public_report_photos as
select
  p.id,
  p.report_id,
  -- Withheld, not merely hidden. A client-side blur is CSS: anyone can strip it
  -- or read the URL out of the network tab. Returning null means an unreviewed
  -- image is genuinely unreachable, while moderation_status still lets the UI
  -- show a "being checked" placeholder.
  case
    when p.moderation_status = 'approved' or public.is_admin()
    then p.storage_path
    else null
  end as storage_path,
  p.moderation_status,
  p.created_at
from public.report_photos p
where p.moderation_status <> 'rejected'
   or public.is_admin()
   or exists (
     select 1 from public.reports r
     where r.id = p.report_id and r.reporter_id = auth.uid()
   );

-- Only what a person needs to see about somebody else. `role` in particular
-- would let anyone enumerate every admin account, and reporter_id/author_id
-- appear on public content, so a readable profiles table linked every report
-- and comment back to a named account.
create view public.public_profiles as
select p.id, p.display_name
from public.profiles p;

create view public.public_comments as
select
  c.id,
  c.report_id,
  c.author_id,
  c.body,
  c.moderation_status,
  c.created_at
from public.comments c
where c.moderation_status = 'approved'
   or c.author_id = auth.uid()
   or public.is_admin();

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.reports         enable row level security;
alter table public.report_photos   enable row level security;
alter table public.votes           enable row level security;
alter table public.comments        enable row level security;
alter table public.flags           enable row level security;
alter table public.moderation_jobs enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

-- Your own row only. Everything anyone else needs is in public_profiles,
-- which does not carry `role`.
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

-- Anyone, signed in or not, sees any report that has not been rejected.
-- The author additionally sees their own rejected reports, so a rejection is
-- not silent to the person it affects.
create policy reports_select_visible
  on public.reports for select
  using (
    moderation_status <> 'rejected'
    or reporter_id = auth.uid()
    or public.is_admin()
  );

create policy reports_insert_own
  on public.reports for insert
  to authenticated
  with check (
    reporter_id = auth.uid()
    -- The pin is public on arrival; the note and photos are not, and their
    -- status columns are set by triggers rather than by the client.
    and status = 'open'
    and cleaned_by is null
    and cleaned_at is null
    and vote_count = 0
  );

-- Ordinary users never UPDATE reports directly. Marking cleaned goes through
-- the mark_report_cleaned RPC, which is narrower and auditable.
create policy reports_update_admin
  on public.reports for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy reports_delete_own
  on public.reports for delete
  to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- report_photos
-- ---------------------------------------------------------------------------

create policy report_photos_select_visible
  on public.report_photos for select
  using (
    moderation_status <> 'rejected'
    or public.is_admin()
    or exists (
      select 1 from public.reports r
      where r.id = report_id and r.reporter_id = auth.uid()
    )
  );

create policy report_photos_insert_own_report
  on public.report_photos for insert
  to authenticated
  with check (
    moderation_status = 'pending'
    and exists (
      select 1 from public.reports r
      where r.id = report_id and r.reporter_id = auth.uid()
    )
  );

create policy report_photos_update_admin
  on public.report_photos for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy report_photos_delete_own
  on public.report_photos for delete
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.reports r
      where r.id = report_id and r.reporter_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- votes
-- ---------------------------------------------------------------------------

-- Individual votes are not public. The aggregate lives on reports.vote_count,
-- which is what the map needs; exposing who voted for what is a privacy leak
-- with no product benefit.
create policy votes_select_own
  on public.votes for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy votes_insert_own
  on public.votes for insert
  to authenticated
  with check (
    user_id = auth.uid()
    -- You cannot confirm your own report. The report already contributes its
    -- own weight of 1; letting the author vote would let one person count twice.
    and not exists (
      select 1 from public.reports r
      where r.id = report_id and r.reporter_id = auth.uid()
    )
    -- Nothing unreviewed or already dealt with can be voted up.
    and exists (
      select 1 from public.reports r
      where r.id = report_id
        and r.moderation_status = 'approved'
        and r.status = 'open'
    )
  );

create policy votes_delete_own
  on public.votes for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

create policy comments_select_approved
  on public.comments for select
  using (
    moderation_status = 'approved'
    or author_id = auth.uid()
    or public.is_admin()
  );

create policy comments_insert_own
  on public.comments for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and moderation_status = 'pending'
  );

create policy comments_update_admin
  on public.comments for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy comments_delete_own
  on public.comments for delete
  to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- flags
-- ---------------------------------------------------------------------------

-- Flags are write-mostly: you can raise one and see your own, but the pile of
-- complaints about a given item is admin-only.
create policy flags_select_own
  on public.flags for select
  to authenticated
  using (flagger_id = auth.uid() or public.is_admin());

create policy flags_insert_own
  on public.flags for insert
  to authenticated
  with check (flagger_id = auth.uid());

create policy flags_delete_admin
  on public.flags for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- moderation_jobs
-- ---------------------------------------------------------------------------

-- No policies here on purpose.
--
-- moderation_jobs is not granted to any browser role at all. Admins reach it
-- only through the SECURITY DEFINER functions in 0005, which check is_admin()
-- themselves. Policies without a matching grant can never be reached, and
-- leaving them here would imply an access path that does not exist.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- Policies decide rows; grants decide columns. Both are needed: a policy alone
-- would still let an authenticated user write `role` or `moderation_status`.

grant usage on schema public to anon, authenticated;

-- REVOKE, not merely "do not grant".
--
-- Supabase ships `alter default privileges in schema public grant all on tables
-- to anon, authenticated`, so every table gets SELECT the moment it is created.
-- Simply omitting a grant leaves the base tables world-readable and makes the
-- column masking in the views above decorative: `select storage_path from
-- report_photos where moderation_status = 'pending'` would hand an unreviewed
-- photo to a signed-out visitor. These lines are what actually close that.
revoke all on public.reports         from anon, authenticated;
revoke all on public.report_photos   from anon, authenticated;
revoke all on public.comments        from anon, authenticated;
revoke all on public.votes           from anon, authenticated;
revoke all on public.flags           from anon, authenticated;
revoke all on public.profiles        from anon, authenticated;
revoke all on public.moderation_jobs from anon, authenticated;

-- Future tables in this schema must not be handed out either.
alter default privileges in schema public revoke all on tables from anon, authenticated;


-- Content is readable ONLY through the views above. Granting SELECT on the base
-- tables would expose `note` and `storage_path` for rows that have not been
-- reviewed, which is exactly what this design exists to prevent.
grant select on public.public_reports       to anon, authenticated;
grant select on public.public_report_photos to anon, authenticated;
grant select on public.public_comments      to anon, authenticated;

grant select on public.public_profiles to anon, authenticated;

grant select on public.votes to authenticated;
grant select on public.flags to authenticated;

-- supabase-js sends `Prefer: return=representation` after an insert, which
-- Postgres executes as INSERT ... RETURNING. That needs SELECT on the returned
-- column, so without this every report submission fails with "permission
-- denied for table reports". Exactly one column, and nothing readable.
grant select (id) on public.reports to authenticated;

grant insert (display_name, id)       on public.profiles      to authenticated;
grant update (display_name)           on public.profiles      to authenticated;

grant insert (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7,
              cell_r9, cell_r12, note)
                                      on public.reports        to authenticated;
grant delete                          on public.reports        to authenticated;

grant insert (report_id, storage_path) on public.report_photos to authenticated;
grant delete                           on public.report_photos to authenticated;

grant insert (report_id, user_id)      on public.votes         to authenticated;
grant delete                           on public.votes         to authenticated;

grant insert (report_id, author_id, body) on public.comments   to authenticated;
grant delete                              on public.comments   to authenticated;

grant insert (subject_type, subject_id, flagger_id, reason)
                                       on public.flags         to authenticated;

-- Admin-only column writes. RLS still gates these to actual admins; the grant
-- simply makes the column writable at all.
grant update (moderation_status, note_status, status, cleaned_by, cleaned_at)
                                       on public.reports        to authenticated;
grant update (moderation_status)       on public.report_photos  to authenticated;
grant update (moderation_status)       on public.comments       to authenticated;
grant update (role)                    on public.profiles       to authenticated;
