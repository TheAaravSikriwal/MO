-- MO — public views and row-level security
--
-- The guiding rule: a report's PIN goes live immediately so the map stays
-- alive, but anything a person wrote or photographed stays withheld until the
-- moderation worker has ruled on it.

-- ---------------------------------------------------------------------------
-- Nothing is handed out by default in this schema
-- ---------------------------------------------------------------------------

-- There used to be an `alter default privileges in schema public revoke all on
-- tables from anon, authenticated` here, and it has been removed. Both halves
-- of the reason matter.
--
-- It no longer did anything for MO. Supabase ships `alter default privileges in
-- schema public grant all on tables to anon, authenticated`, which is what that
-- line countered -- but default privileges are per-schema, and MO's tables and
-- views are in `mo` now. Nothing grants anything by default in a schema this
-- migration has just created, so there was nothing left to revoke.
--
-- And it reached outside MO. With no FOR ROLE clause it applied to the role
-- running the migration, which is the same role chintu's own migrations run as
-- -- so every table the MARKETPLACE created in `public` afterwards would have
-- lost its default anon and authenticated grants. MO breaking the store is
-- not a trade worth making for a statement that had stopped doing its job.
--
-- What protects the views is the explicit `revoke all on mo.public_* from anon,
-- authenticated` further down, immediately before the select grants. That was
-- always the real control; this line was belt to that braces, and the belt no
-- longer fits.
--
-- The hazard it guarded against is still worth knowing: the views are
-- auto-updatable and deliberately not security_invoker, so DML through them
-- runs as the owner and is exempt from RLS. A stray GRANT ALL on one of them
-- would let an unauthenticated PATCH flip moderation_status to 'approved' and
-- read back an unreviewed photo path.

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

create view mo.public_reports as
select
  r.id,
  -- Yours, or nobody's. The id is the key of chintu's `public.profiles`,
  -- which anon can read, and for a magic-link signup that row carries the
  -- email address's local part as display_name. Publishing reporter_id to
  -- everybody was publishing that, one join away.
  --
  -- Masked rather than dropped: the app compares it with the signed-in user
  -- to know "this is your report", and that still works for the one person
  -- it is about.
  case
    when r.reporter_id = auth.uid() or mo.is_admin()
    then r.reporter_id
    else null
  end as reporter_id,
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
      or mo.is_admin()
    then r.note
    else null
  end as note,
  r.note_status,
  r.moderation_status,
  r.status,
  -- No `cleaned_by`. It is a profile id, one join away from a person's
  -- email prefix in `public.profiles` just as reporter_id is, and nothing in the app ever read it -- so it
  -- was an identity column published to anon for no one's benefit. Who cleaned
  -- a spot is recorded on mo.reports for the audit trail; it is not part of
  -- the public read surface. Add it back with a consumer, and with a decision
  -- about attribution, not before.
  r.cleaned_at,
  r.vote_count,
  r.created_at,
  -- The name the reporter chose, on the same terms as public_comments below:
  -- everybody once it is approved, the reporter straight away.
  -- Appended at the end so the column order of the view is otherwise unchanged.
  (
    select d.name from mo.display_names d
    where d.user_id = r.reporter_id
      and (
        d.moderation_status = 'approved'
        or d.user_id = auth.uid()
      )
  ) as reporter_name
from mo.reports r
where r.moderation_status <> 'rejected'
   or r.reporter_id = auth.uid()
   or mo.is_admin();

create view mo.public_report_photos as
select
  p.id,
  p.report_id,
  -- Withheld, not merely hidden. A client-side blur is CSS: anyone can strip it
  -- or read the URL out of the network tab. Returning null means no unreviewed
  -- image can be DISCOVERED through this database, while moderation_status
  -- still lets the UI show a "being checked" placeholder.
  --
  -- This withholds the path, not the bytes. It said "genuinely unreachable"
  -- while photos were going to live in Supabase storage; they live in an R2
  -- bucket on a public hostname now, so anyone HOLDING a key can fetch the
  -- object whatever this view returns -- and api/sign-upload hands the key to
  -- the uploader, so they always hold their own. Keys are three UUIDs and
  -- unguessable, and no pending or rejected path is given to anybody else. But
  -- a rejected photo stays retrievable by whoever uploaded it, because nothing
  -- deletes from the bucket. See HANDOFF.md under what is not done.
  case
    when p.moderation_status = 'approved' or mo.is_admin()
    then p.storage_path
    else null
  end as storage_path,
  p.moderation_status,
  p.created_at
from mo.report_photos p
where p.moderation_status <> 'rejected'
   or mo.is_admin()
   or exists (
     select 1 from mo.reports r
     where r.id = p.report_id and r.reporter_id = auth.uid()
   );

-- There is no mo.profile_names any more.
--
-- It looked names up in chintu's `public.profiles`, where a magic-link signup's
-- display_name is the local part of their email address. So every comment was
-- signed with its author's email prefix, readable by anyone. MO now asks each
-- person to choose a name (mo.display_names, 0001), and the comments view below
-- carries that name itself -- so there is nothing left to look up by id, and MO
-- reads nothing from the marketplace's profiles at all.

create view mo.public_comments as
select
  c.id,
  c.report_id,
  -- Masked for the same reason as reporter_id above: it is one join away
  -- from the author's email prefix in `public.profiles`.
  case
    when c.author_id = auth.uid() or mo.is_admin()
    then c.author_id
    else null
  end as author_id,
  -- The name the author chose, and only once it has been approved. Until then
  -- other people see no name and the app says "someone"; the author sees their
  -- own straight away, so posting does not look like it lost their name.
  --
  -- Not admins. They judge pending names in the review queue, where they are
  -- labelled as pending; shown here they looked like any approved name, and
  -- the "report this name" button on them could only ever fail.
  (
    select d.name from mo.display_names d
    where d.user_id = c.author_id
      and (
        d.moderation_status = 'approved'
        or d.user_id = auth.uid()
      )
  ) as author_name,
  -- So the app can offer "report this name" on everybody's comments but your
  -- own, without being handed the author's id to compare.
  coalesce(c.author_id = auth.uid(), false) as viewer_is_author,
  c.body,
  c.moderation_status,
  c.created_at
from mo.comments c
where c.moderation_status = 'approved'
   or c.author_id = auth.uid()
   or mo.is_admin();

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table mo.admins          enable row level security;
alter table mo.display_names   enable row level security;
alter table mo.post_log        enable row level security;
alter table mo.reports         enable row level security;
alter table mo.report_photos   enable row level security;
alter table mo.votes           enable row level security;
alter table mo.comments        enable row level security;
alter table mo.flags           enable row level security;
alter table mo.moderation_jobs enable row level security;

-- ---------------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------------

-- No policies at all, and that is the point.
--
-- RLS is on and no policy grants anything, so RLS denies everything: a browser
-- role cannot read the moderator list, add itself to it, or discover whether
-- anybody else is on it. The only reachable answer is `mo.is_admin()`, which is
-- SECURITY DEFINER and tells you about yourself only.
--
-- MO's profiles table used to live here, with a trigger stopping people writing
-- `role = 'admin'` on their own row. Profiles are chintu's now, and MO holds no
-- column on them -- so there is nothing to guard, which is a better answer than
-- guarding it.
--
-- Adding an admin is a service-role or SQL-editor action. See the bootstrap
-- note at the bottom of 0004.

-- ---------------------------------------------------------------------------
-- display_names
-- ---------------------------------------------------------------------------

-- No policies, like admins, and for the same reason. The table is revoked from
-- both browser roles below; a person's own name comes through
-- mo.my_display_name(), writes go through mo.set_display_name(), and everybody
-- else's reaches them only through public_comments, once approved.

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

-- Anyone, signed in or not, sees any report that has not been rejected.
-- The author additionally sees their own rejected reports, so a rejection is
-- not silent to the person it affects.
create policy reports_select_visible
  on mo.reports for select
  using (
    moderation_status <> 'rejected'
    or reporter_id = auth.uid()
    or mo.is_admin()
  );

create policy reports_insert_own
  on mo.reports for insert
  to authenticated
  with check (
    reporter_id = auth.uid()
    -- A name first, so nothing is ever posted under the marketplace's
    -- email-derived one. Through the definer helper: this policy runs as the
    -- caller, who cannot read mo.display_names.
    and mo.has_display_name()
    -- The pin is public on arrival; the note and photos are not, and their
    -- status columns are set by triggers rather than by the client.
    and status = 'open'
    and cleaned_by is null
    and cleaned_at is null
    and vote_count = 0
  );

-- Ordinary users never UPDATE reports directly. Marking cleaned goes through
-- the mark_report_cleaned RPC, which is narrower and auditable.


create policy reports_delete_own
  on mo.reports for delete
  to authenticated
  using (reporter_id = auth.uid() or mo.is_admin());

-- ---------------------------------------------------------------------------
-- report_photos
-- ---------------------------------------------------------------------------

-- Unreachable today, and kept on purpose. Same for comments_select_approved
-- below.
--
-- `mo.report_photos` and `mo.comments` are revoked from both browser roles and
-- nothing re-grants SELECT, so a policy on them is never evaluated by a
-- browser: reads go through the views, which run as owner. Every app write to
-- these two uses a plain `.insert()` with no `.select()`, so not even
-- `INSERT ... RETURNING` needs it. (`mo.reports` is different -- createReport
-- does `.select('id')` -- which is why its select policy is live.)
--
-- 0005 deletes moderation_jobs' policies for exactly this reason, so the
-- difference here is a decision rather than an oversight: these two carry the
-- visibility rules for CONTENT, and the cost of being wrong is an unreviewed
-- photo or comment becoming readable. If somebody ever adds a select grant --
-- to debug, or by copying a line -- the rules should already be in place
-- rather than needing to be remembered. A policy that guards nothing costs
-- nothing; a missing one costs the thing this whole design protects.
create policy report_photos_select_visible
  on mo.report_photos for select
  using (
    moderation_status <> 'rejected'
    or mo.is_admin()
    -- Through the function, not a subquery: `reports` is revoked from browser
    -- roles, and a policy expression runs with the caller's privileges, so
    -- reading r.reporter_id here would raise permission denied instead of
    -- returning false. See owns_report in 0002.
    or mo.owns_report(report_id)
  );

create policy report_photos_insert_own_report
  on mo.report_photos for insert
  to authenticated
  with check (
    moderation_status = 'pending'
    and mo.owns_report(report_id)
  );



create policy report_photos_delete_own
  on mo.report_photos for delete
  to authenticated
  using (
    mo.is_admin()
    or mo.owns_report(report_id)
  );

-- ---------------------------------------------------------------------------
-- votes
-- ---------------------------------------------------------------------------

-- Individual votes are not public. The aggregate lives on reports.vote_count,
-- which is what the map needs; exposing who voted for what is a privacy leak
-- with no product benefit.
create policy votes_select_own
  on mo.votes for select
  to authenticated
  using (user_id = auth.uid() or mo.is_admin());

create policy votes_insert_own
  on mo.votes for insert
  to authenticated
  with check (
    user_id = auth.uid()
    -- You cannot confirm your own report. The report already contributes its
    -- own weight of 1; letting the author vote would let one person count twice.
    and not mo.owns_report(report_id)
    -- Nothing unreviewed or already dealt with can be voted up.
    and mo.report_accepts_votes(report_id)
  );

create policy votes_delete_own
  on mo.votes for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

create policy comments_select_approved
  on mo.comments for select
  using (
    moderation_status = 'approved'
    or author_id = auth.uid()
    or mo.is_admin()
  );

create policy comments_insert_own
  on mo.comments for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and mo.has_display_name()
    and moderation_status = 'pending'
  );



create policy comments_delete_own
  on mo.comments for delete
  to authenticated
  using (author_id = auth.uid() or mo.is_admin());

-- ---------------------------------------------------------------------------
-- flags
-- ---------------------------------------------------------------------------

-- Flags are write-only from a browser. This policy is unreachable -- there is no
-- select grant on mo.flags (see the grants below for why) -- and is kept so
-- that if a grant is ever added back, it still cannot read anybody else's
-- complaints. It would read back the ids behind your own name flags, which is
-- why the grant must stay out.
create policy flags_select_own
  on mo.flags for select
  to authenticated
  using (flagger_id = auth.uid() or mo.is_admin());

create policy flags_insert_own
  on mo.flags for insert
  to authenticated
  with check (
    flagger_id = auth.uid()
    -- Never a name directly. A name's subject_id is a person's id, which a
    -- reader is never given -- except their OWN, which the client knows. A
    -- direct insert let somebody report their own name, and an unresolved
    -- complaint discards the machine verdict and puts the name at the top of
    -- the human queue. Names are reported through flag_comment_author and
    -- flag_report_author (0005), which refuse your own and run as owner, so
    -- this policy does not apply to them.
    and subject_type <> 'name'
  );

-- No flags_delete_admin policy.
--
-- There was one, and nothing could ever reach it: `mo.flags` has no delete
-- grant for either browser role, only select and a column-scoped insert. It is
-- unlike the two unreachable SELECT policies above, which are kept because
-- they carry content visibility rules and the cost of missing one is an
-- unreviewed photo becoming readable. A delete policy guards nothing that
-- another policy does not, and `admin_decide_moderation` resolves a complaint
-- by setting `resolved_at`, never by deleting the row -- deleting it would
-- lose the record of who complained.

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

-- No `grant usage on schema public` here. It used to be, and it is the same
-- class of reach as the `alter default privileges in schema public` removed at
-- the top of this file: a statement about the marketplace's schema issued from
-- MO's migrations. Redundant on Supabase, which grants it to both browser
-- roles already, so nothing is lost by dropping it.
--
-- MO does not need it either. The only thing in `public` MO touches is
-- `public.profiles`, as the target of foreign keys, and those are checked with
-- the table owner's privileges rather than the caller's. Author names used to
-- be read from that table as the caller, which did depend on the marketplace's
-- grants; they now come from mo.display_names through the definer views.

-- REVOKE, not merely "do not grant".
--
-- Supabase ships `alter default privileges in schema public grant all on tables
-- to anon, authenticated`, so every table gets SELECT the moment it is created.
-- That was the reasoning when MO's tables were in `public`, and it is why
-- these lines were written. In `mo` those defaults do not apply, as the note at
-- the top of this file says -- so strictly these revokes now have nothing to
-- undo on a fresh schema.
--
-- They stay for two reasons, and both are about the next person rather than
-- about Postgres. A project CAN have default privileges set on `mo` (somebody
-- runs `alter default privileges in schema mo ...` to make their own life
-- easier), and then omitting a grant would be world-readable again. And an
-- explicit revoke states the intent: these tables are not a read surface, the
-- views are. `grant select (id) on mo.reports` below is the single exception
-- and it is easier to see as one when the revoke is right above it.
--
-- The hazard they were written for: `select storage_path from report_photos
-- where moderation_status = 'pending'` handing an unreviewed photo to a
-- signed-out visitor, with the column masking in the views reduced to
-- decoration.
revoke all on mo.reports         from anon, authenticated;
revoke all on mo.report_photos   from anon, authenticated;
revoke all on mo.comments        from anon, authenticated;
revoke all on mo.votes           from anon, authenticated;
revoke all on mo.flags           from anon, authenticated;
revoke all on mo.admins          from anon, authenticated;
revoke all on mo.display_names   from anon, authenticated;
-- No policy either: written only by the rate-limit triggers, which run as
-- owner. A person who could delete their own rows here could reset the limit.
revoke all on mo.post_log        from anon, authenticated;
revoke all on mo.moderation_jobs from anon, authenticated;



-- Content is readable ONLY through the views above. Granting SELECT on the base
-- tables would expose `note` and `storage_path` for rows that have not been
-- reviewed, which is exactly what this design exists to prevent.
-- Explicit, in case these views were created before the default-privileges
-- change above ever ran (an already-provisioned project, or a re-run).
revoke all on mo.public_reports       from anon, authenticated;
revoke all on mo.public_report_photos from anon, authenticated;
revoke all on mo.public_comments      from anon, authenticated;

-- SELECT only. These are read surfaces; nothing writes through them.
grant select on mo.public_reports       to anon, authenticated;
grant select on mo.public_report_photos to anon, authenticated;
grant select on mo.public_comments      to anon, authenticated;


-- ---------------------------------------------------------------------------
-- The worker
-- ---------------------------------------------------------------------------
--
-- The moderation worker connects with the service role key. It writes through
-- the RPCs in 0004, which are SECURITY DEFINER, but it reads these four
-- directly: the queue, a photo's storage path, and the text of a note, a
-- comment or a chosen name. Named one by one rather than `grant all on all tables`, so adding a
-- table to this schema does not silently widen what the worker can reach.
grant select on mo.moderation_jobs to service_role;
grant select on mo.report_photos   to service_role;
grant select on mo.reports         to service_role;
grant select on mo.comments        to service_role;
grant select on mo.display_names   to service_role;

-- One direct write, and only one: `Queue.fail()` marks a job failed without an
-- RPC in front of it. Every other write the worker makes goes through
-- claim/record/escalate in 0004, which are SECURITY DEFINER and so need no
-- table privilege from the caller at all.
--
-- Columns named rather than a bare `grant update`, so the worker cannot reach
-- `verdict` -- the field that records what a machine or a person decided. Its
-- own guard (`.is('verdict', null)`) is meant to stop it overwriting a
-- decision; this makes that guard unnecessary rather than merely correct.
grant update (status, reason, locked_at, locked_by)
                                   on mo.moderation_jobs to service_role;

grant select on mo.votes to authenticated;

-- No select on mo.flags for either browser role, not even your own rows.
--
-- It used to be granted, scoped by flags_select_own to rows you raised. But a
-- complaint about a NAME has the person's id as its subject_id -- filed for you
-- by flag_comment_author or flag_report_author precisely so you are never given
-- it -- and reading your own flag back handed it over anyway, one lookup away
-- from their email prefix in public.profiles. Nothing in the app reads flags:
-- raising one is a plain `.insert()` with no RETURNING, which needs no select.

-- `createReport` chains `.select('id')` onto its insert, which PostgREST sends
-- as `Prefer: return=representation` and Postgres executes as
-- INSERT ... RETURNING id. That needs SELECT on the returned column, so
-- without this every report submission fails with "permission denied for table
-- reports". Exactly one column, and nothing readable.
--
-- This comment used to say supabase-js sends that preference "after an insert",
-- full stop. It does not: a bare `.insert()` asks for nothing back. The
-- distinction matters because the wrong version implies mo.report_photos and
-- mo.comments need select grants too — they do not, their inserts have no
-- `.select()`, and adding the grant would open the read path this whole design
-- exists to keep shut.
grant select (id) on mo.reports to authenticated;

-- Nothing is granted on public.profiles, and nothing in MO reads it. It is
-- chintu's table; MO references it only as the target of foreign keys.

grant insert (reporter_id, lat, lng, cell_r1, cell_r3, cell_r5, cell_r7,
              cell_r9, cell_r12, note)
                                      on mo.reports        to authenticated;
grant delete                          on mo.reports        to authenticated;

grant insert (report_id, storage_path) on mo.report_photos to authenticated;
grant delete                           on mo.report_photos to authenticated;

grant insert (report_id, user_id)      on mo.votes         to authenticated;
grant delete                           on mo.votes         to authenticated;

grant insert (report_id, author_id, body) on mo.comments   to authenticated;
grant delete                              on mo.comments   to authenticated;

grant insert (subject_type, subject_id, flagger_id, reason)
                                       on mo.flags         to authenticated;

-- No admin column writes, and no *_update_admin policies either.
--
-- There were both: `grant update (moderation_status, note_status, status,
-- cleaned_by, cleaned_at) on mo.reports` and the same for moderation_status on
-- the other two, gated by policies that checked is_admin(). Nothing in the app
-- used them -- `decideModerationItem` calls admin_decide_moderation and
-- `markCleaned` calls mark_report_cleaned, both SECURITY DEFINER -- and they
-- were a way to do the wrong thing.
--
-- A direct PATCH would write the content's status without writing
-- `moderation_jobs.verdict` and without setting `flags.resolved_at`, leaving
-- the job and the content disagreeing about what was decided. That is the
-- exact state 0004 and 0005 are built to prevent, reachable by an admin with
-- a REST client and no intent to break anything.
--
-- Every legitimate write here is a definer function, so nothing needs the
-- grant. The triggers do not either: sync_vote_count is definer, and
-- touch_updated_at and default_note_status only modify the row being written.

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
