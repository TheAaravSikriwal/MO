-- MO — public views and row-level security
--
-- The guiding rule: a report's PIN goes live immediately so the map stays
-- alive, but anything a person wrote or photographed stays withheld until the
-- moderation worker has ruled on it.

-- ---------------------------------------------------------------------------
-- Public views
-- ---------------------------------------------------------------------------

-- security_invoker keeps RLS on the underlying tables in force. Without it a
-- view would quietly become a way around every policy below.

-- The note is withheld until approved, but the pin is not. A location with
-- litter reported on it is not itself objectionable; the free text somebody
-- attached to it might be.
create view public.public_reports
with (security_invoker = true)
as
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
  case
    when r.moderation_status = 'approved' then r.note
    else null
  end as note,
  r.moderation_status as note_status,
  r.status,
  r.cleaned_by,
  r.cleaned_at,
  r.vote_count,
  r.created_at
from public.reports r
where r.moderation_status <> 'rejected';

-- The storage path is withheld until approved, deliberately.
--
-- The spec originally called for the client to blur a pending photo. That is
-- not privacy -- it is CSS, and anyone can strip it or read the URL straight
-- out of the network tab. Withholding the path means an unreviewed image is
-- genuinely unreachable, while `moderation_status` still tells the UI a photo
-- exists so it can render the "not reviewed yet" placeholder.
create view public.public_report_photos
with (security_invoker = true)
as
select
  p.id,
  p.report_id,
  case
    when p.moderation_status = 'approved' then p.storage_path
    else null
  end as storage_path,
  p.moderation_status,
  p.created_at
from public.report_photos p
where p.moderation_status <> 'rejected';

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

create policy profiles_select_all
  on public.profiles for select
  using (true);

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
    -- A new report is never born approved or pre-cleaned.
    and moderation_status = 'pending'
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

-- Admins read the queue through these policies. The worker uses the service
-- role key, which bypasses RLS entirely; that key must never reach the browser.
create policy moderation_jobs_admin_select
  on public.moderation_jobs for select
  to authenticated
  using (public.is_admin());

create policy moderation_jobs_admin_update
  on public.moderation_jobs for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- Policies decide rows; grants decide columns. Both are needed: a policy alone
-- would still let an authenticated user write `role` or `moderation_status`.

grant usage on schema public to anon, authenticated;

grant select on public.public_reports        to anon, authenticated;
grant select on public.public_report_photos  to anon, authenticated;
grant select on public.profiles              to anon, authenticated;
grant select on public.reports               to anon, authenticated;
grant select on public.report_photos         to anon, authenticated;
grant select on public.comments              to anon, authenticated;

grant select                          on public.votes           to authenticated;
grant select                          on public.flags           to authenticated;
grant select, update                  on public.moderation_jobs to authenticated;

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
grant update (moderation_status, status, cleaned_by, cleaned_at)
                                       on public.reports        to authenticated;
grant update (moderation_status)       on public.report_photos  to authenticated;
grant update (moderation_status)       on public.comments       to authenticated;
grant update (role)                    on public.profiles       to authenticated;
