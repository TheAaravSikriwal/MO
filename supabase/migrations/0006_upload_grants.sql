-- ---------------------------------------------------------------------------
-- 0006 — a rate limit on handing out signed upload URLs
-- ---------------------------------------------------------------------------
--
-- Photo bytes go straight from the browser to Cloudflare R2, using a
-- short-lived signed URL minted by api/sign-upload. Every other write in this
-- schema is rate limited by a trigger; that one was not, and the gap was not
-- theoretical.
--
-- Signing is not inserting. The first version of the endpoint bounded itself by
-- counting the photos already attached to the report, reasoning that three is
-- the cap. But a caller who asks for a URL and never inserts the row leaves
-- that count at zero forever, and each request mints a fresh key: sign, PUT
-- 8 MB, repeat. One account, one report, unbounded storage. Roughly 1,250
-- iterations fill R2's free tier, and sign-up is an open magic link, so "one
-- account" means anybody with an email address.
--
-- The fix has to record the grant itself, because nothing else does. This table
-- is that record, and the trigger below is the limit. Application code cannot
-- skip it: the endpoint has to insert here to get a URL at all.

-- `on delete set null`, and nullable, for the report reference. This is the
-- whole point of the table and it is easy to get backwards.
--
-- Cascading looked tidier: a grant for a report that no longer exists is not
-- interesting. But the trigger below counts live rows, a reporter may delete
-- their own report (`reports_delete_own` in 0003), and a cascade runs without
-- consulting RLS or child-table privileges. So the count would be resettable
-- by the person it limits: insert a report, sign thirty URLs, upload 240 MB,
-- delete the report, and the counter is back to zero. One extra request per
-- cycle reopens exactly the hole this table was written to close.
--
-- The grant has to outlive the report it was for. It is a record of something
-- that happened, not a part of the report.

-- ---------------------------------------------------------------------------
-- What an object key is allowed to look like
-- ---------------------------------------------------------------------------
--
-- The exact shape the signing endpoint generates: the `map/` prefix, three
-- lowercase UUIDs and one of three extensions, and nothing else at all.
--
-- The `map/` prefix is not decoration. The bucket is wearechintu's, shared
-- with the marketplace, which already partitions it: `covers/` is served
-- publicly and `artifacts/` is meant to stay private. Map photos get their own
-- namespace, so a bucket-level rule scoped by prefix -- public read, a
-- lifecycle policy, a CORS rule -- can name them as a group. The same shape is
-- PHOTO_KEY_PREFIX in src/lib/upload/objectKey.ts.
--
-- The unique indexes below are on the literal string, and a photo URL is built
-- by concatenation and then read by a URL parser. Without this, two DIFFERENT
-- strings address the SAME object, which defeats them:
--
--   <uid>/<rid>/<pid>.jpg?x=1                 -- a query the parser drops
--   <uid>/<rid2>/../../<uid>/<rid>/<pid>.jpg  -- dot segments the parser folds
--
-- Either one is unique, satisfies the policy's `like`, and resolves to an
-- object that is already linked -- so an image a human REJECTED could be put up
-- for a fresh verdict after all, which is the whole thing this file exists to
-- stop. A `like` on a prefix cannot see that; only pinning the whole string can.
--
-- A FUNCTION, called from a `check` on each table, rather than a domain.
--
-- This was a domain first, with `report_photos.storage_path` altered to it. That
-- cannot be applied: `public_report_photos` selects that column, and Postgres
-- refuses `alter column ... type` on a column a view depends on -- so the whole
-- migration aborted and rolled back, taking the rate limit with it. Adding a
-- `check` constraint touches no types and no dependencies. It was also two
-- hand-written copies of the pattern before that, of which only one was ever
-- tested. One spelling, reachable from both tables, is the version that neither
-- drifts nor blocks the apply.
--
-- Takes no tables, so it needs no search_path and is genuinely immutable.

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

-- Granted explicitly below, not left to the implicit grant.
--
-- Two CHECK constraints call this, and a CHECK is evaluated as the INSERTING
-- role. Postgres grants EXECUTE on a new function to PUBLIC, which is how that
-- worked -- but 0002 and 0004 both argue at length that relying on the
-- implicit grant is a trap and revoke it from five other functions. Relying on
-- it here, unmentioned, was the inconsistency.
create or replace function mo.is_photo_object_key(key text)
returns boolean
language sql
immutable
as $$
  select key ~ '^map/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$';
$$;

grant execute on function mo.is_photo_object_key(text) to anon, authenticated;

create table mo.upload_grants (
  id         uuid primary key default gen_random_uuid(),
  -- Set null, NOT cascade, when the person is deleted -- like report_id below.
  --
  -- It used to cascade, on the grounds that deleting somebody should take their
  -- records. But the R2 cleanup finds MO's objects only through these rows. A
  -- cascade took the grants away with the account while the bytes stayed in
  -- the bucket, unfindable for good -- including photos that had been rejected
  -- and were still waiting to be deleted. Kept with no owner, the row still
  -- tells the cleanup the object is MO's, and the cleanup deletes it: the
  -- account's reports and photos have cascaded away, so nothing links it.
  --
  -- What this means for the hourly count: an ownerless grant counts for nobody,
  -- so deleting an account still empties its grants from the window. Nothing in
  -- MO can delete an account -- MO holds no delete grant on public.profiles --
  -- but the marketplace side owns profiles, so a "delete my account" there
  -- would reset this counter. Worth knowing before building one.
  user_id    uuid references public.profiles (id) on delete set null,
  report_id  uuid references mo.reports (id) on delete set null,
  -- The object key the URL was signed for.
  --
  -- UNIQUE, via the index below, and the comment here used to say the opposite.
  -- One grant per object for the lifetime of the database is what stops a spent
  -- grant being replaced by a fresh one for the same object; a retry does not
  -- reuse a key, it gets a new one, so uniqueness costs a retry nothing.
  --
  -- It is also here so an abusive object in the bucket can be traced to the
  -- request that asked for it without listing the bucket.
  storage_path text not null check (mo.is_photo_object_key(storage_path)),
  -- Set when the photo row naming this object is inserted, which is what makes
  -- a grant one-use. See enforce_photo_has_grant below.
  linked_at  timestamptz,
  created_at timestamptz not null default now(),
  -- The object's end, in two steps, written only by the worker's cleanup
  -- functions below. `retired_at` is set first and stops the grant ever being
  -- linked again; `object_deleted_at` once R2 has actually removed the bytes.
  -- Between the two, a failed delete is retried.
  retired_at        timestamptz,
  object_deleted_at timestamptz
);

create index upload_grants_user_idx on mo.upload_grants (user_id, created_at desc);

-- One grant per object, for the lifetime of the database.
--
-- This is what stops a spent grant being replaced by a fresh one for the same
-- object. `authenticated` can insert here directly -- the endpoint uses the
-- caller's own token and holds no privilege the person does not -- so a grant
-- proves "somebody claimed this key", not "the endpoint issued it". Without
-- this index, that was enough to re-open the re-judging loop: delete the photo
-- row, mint a new grant for the same object, link it again.
--
-- With it, an object can be granted once and linked once, ever.
create unique index upload_grants_storage_path_key on mo.upload_grants (storage_path);

-- ---------------------------------------------------------------------------
-- The limit
-- ---------------------------------------------------------------------------
--
-- 30 an hour is ten reports at the three-photo maximum, which is already the
-- most the report rate limit in 0002 allows anyone to create in an hour. It
-- caps one account at 240 MB an hour rather than at nothing.
--
-- It is a budget of 30 ATTEMPTS, not 30 photos. The grant is recorded before
-- the upload and nothing gives it back, so a dropped connection, a signature
-- R2 refuses, or a submission rolled back by `createReport` all spend one. Ten
-- reports of three photos with no failures is exactly 30, which means somebody
-- genuinely at the ceiling who retries once is refused. Raise this number
-- before assuming the refusal is abuse.
--
-- Deliberately counted per person rather than per report: a per-report count is
-- what failed above, because the attacker chooses how many reports to make and
-- the report rate limit is the thing that actually constrains them.
--
-- Counted over live rows, which is only safe because nothing a person can
-- currently do removes their own rows inside the window. The cascade from
-- `profiles` is the one path that would, and it is not reachable from the app;
-- see the note on `user_id`. Do not add a delete policy, a delete grant, or a
-- second cascade onto this table without re-reading both notes.

-- AFTER ... FOR EACH STATEMENT, with a transition table, counted with the new
-- rows included so the comparison is `> 30` rather than `>= 30`.
--
-- The advisory lock is what makes it hold: two concurrent statements would
-- each read a count that did not include the other's uncommitted rows. The
-- lock is transaction-scoped, so whichever statement takes it first holds it
-- until commit and the second one counts afterwards, with the first one's
-- rows committed and visible. Keyed on the person, so one account's burst
-- never blocks anybody else.
--
-- This comment used to give a second reason -- that a row-level BEFORE
-- trigger cannot see the other rows of its own statement, so one request of
-- ten thousand rows would pass. That is false; see the note above
-- enforce_report_rate_limit in 0002.
create or replace function mo.enforce_upload_grant_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  claimant uuid;
  offender uuid;
begin
  for claimant in select distinct user_id from new_rows loop
    perform pg_advisory_xact_lock(hashtext('upload_grant:' || claimant::text));
  end loop;

  select n.user_id into offender
    from (select distinct user_id from new_rows) n
   where (
     select count(*) from mo.upload_grants g
      where g.user_id = n.user_id
        and g.created_at > now() - interval '1 hour'
   ) > 30
   limit 1;

  if offender is not null then
    raise exception 'too many photo uploads in the last hour; please slow down';
  end if;
  return null;
end;
$$;

create trigger enforce_upload_grant_rate_limit
  after insert on mo.upload_grants
  referencing new table as new_rows
  for each statement execute function mo.enforce_upload_grant_rate_limit();

-- ---------------------------------------------------------------------------
-- A photo row may only name an object somebody was actually granted
-- ---------------------------------------------------------------------------
--
-- The endpoint decides the object key, but until now nothing checked that the
-- key reaching `report_photos.storage_path` was one it had handed out. The
-- column is free text and the client sends it, so a grant was traceability
-- rather than authority.
--
-- What that allowed: somebody whose photo was REJECTED still knows its key --
-- the endpoint returned it. They could insert a fresh `report_photos` row
-- naming the same object against a new report, with no upload, no grant and no
-- charge against the hourly limit, and it would start at `pending` for a
-- second verdict. Rejection is recorded on the row, not on the object.
--
-- Note what a grant does and does not prove. `authenticated` holds an insert
-- privilege here, because the endpoint deliberately writes with the caller's
-- own token rather than a service role key, so anybody could post one
-- themselves. A grant therefore means "somebody claimed this key", not "the
-- endpoint issued it". What makes it useful anyway is that each object can be
-- granted exactly once (the unique index above) and linked exactly once
-- (`linked_at`, below).
--
-- A grant is therefore ONE USE. `linked_at` is what spends it.
--
-- Checking that a grant merely exists is not enough, and this is the second
-- thing that was wrong here. A unique index on `storage_path` only constrains
-- LIVE rows, and `report_photos_delete_own` in 0003 lets the report's owner
-- delete their own photo row -- so delete, re-insert the same object against
-- the same report, and the grant still matched. `moderation_status` goes back
-- to `pending` and `enqueue_moderation` raises a fresh job, so an image a human
-- REJECTED could be put up for another verdict as often as somebody liked, at
-- no cost: no upload, no new grant, nothing counted. Tier 2 can auto-approve a
-- photo, so that is a human decision being overridden by repetition.
--
-- Spending the grant in the same statement that checks it closes that, and
-- closes it atomically: the UPDATE only matches an unspent row, so two
-- concurrent inserts cannot both claim one grant.

create unique index report_photos_storage_path_key
  on mo.report_photos (storage_path);

-- The same one function, on the table that actually gets published.
--
-- ADD CONSTRAINT, not ALTER COLUMN TYPE: `public_report_photos` selects this
-- column, and Postgres refuses to alter the type of a column a view depends on.
--
-- BOTH of these are validated against rows that already exist, and 0001 only
-- length-checked this column. So on a database that already holds photos with
-- free-text paths -- anything uploaded before this file was written -- the
-- statement aborts, and because the file applies as one transaction it takes
-- the rate limit down with it. The only symptom would be uploads answering
-- "not set up", pointing at nothing.
--
-- There is no such database yet: no migration here has ever been applied. If
-- that changes, check first
--
--   select count(*) from mo.report_photos
--    where not mo.is_photo_object_key(storage_path);
--
-- and either rewrite those keys or add the constraint `not valid` and validate
-- it once they are gone.
alter table mo.report_photos
  add constraint report_photos_storage_path_shape
  check (mo.is_photo_object_key(storage_path));

create or replace function mo.enforce_photo_has_grant()
returns trigger
language plpgsql
security definer
set search_path = mo, public
as $$
declare
  spent uuid;
begin
  update mo.upload_grants
     set linked_at = now()
   where storage_path = new.storage_path
     and report_id = new.report_id
     and linked_at is null
     -- Not an object the cleanup has retired: its bytes are gone, or going.
     and retired_at is null
     -- Nor one old enough for the cleanup to be claiming it. An unused grant
     -- is deletable after an hour; refusing to link after fifty minutes keeps
     -- the two sets from ever meeting. An upload URL lives two minutes, and a
     -- report links its photos moments after uploading them.
     and created_at > now() - interval '50 minutes'
  returning id into spent;

  if spent is null then
    -- Plain, and it says what to do. Mapped in plainWords, so this wording
    -- never reaches anybody as-is.
    raise exception 'that photo could not be added; please choose it again';
  end if;
  return new;
end;
$$;

create trigger enforce_photo_has_grant
  before insert on mo.report_photos
  for each row execute function mo.enforce_photo_has_grant();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table mo.upload_grants enable row level security;

-- Your own grants, on your own report. `user_id = auth.uid()` is what makes the
-- count above uncheatable: the endpoint inserts with the CALLER'S token, never
-- a service role key, so it cannot record a grant against somebody else and it
-- cannot exempt itself from the trigger.
-- `owns_report` rather than a subquery on `reports`: a policy expression runs
-- with the caller's privileges, and 0003 revokes that table from browser roles.
-- Reading r.reporter_id here would raise permission denied instead of returning
-- false, so every upload would fail -- and the 403 that reaches the person says
-- their report could not be found. See 0002.
--
-- The `like` clause pins the object to the caller's own prefix and their own
-- report, which is the shape the endpoint generates. It cannot stop somebody
-- inventing a filename inside their own prefix -- see the note on phantom rows
-- in api/README.md -- but it does mean a self-minted grant can never name
-- somebody else's object.
create policy upload_grants_insert_own
  on mo.upload_grants for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and mo.owns_report(report_id)
    -- Not for a pin that is off the map. The photo row would be refused, so a
    -- grant here only signed an upload whose bytes nothing would ever point
    -- at, and spent one of the hour's thirty.
    and mo.report_on_map(report_id)
    and storage_path like ('map/' || auth.uid()::text || '/' || report_id::text || '/%')
  );

-- Nobody reads this table from a browser. It is a counter, not content, and
-- listing it would show which reports a person is part-way through submitting.
-- No select policy and no select grant: the trigger reads it as SECURITY
-- DEFINER, which is the only read that has to work.
-- REVOKE first, like every other table in 0003, and for the reason spelled out
-- there: an explicit revoke says this table is not a read surface, and it
-- covers the case where somebody has set default privileges on `mo` itself.
--
-- (It used to cite an `alter default privileges in schema public` statement in
-- 0003. That statement is gone -- it reached into the marketplace's schema and
-- did nothing for objects in `mo` -- so the citation was stale.)
--
-- DELETE is the privilege that matters most here: the trigger counts live
-- rows, so a delete grant would make the hourly limit resettable by the person
-- it limits.
revoke all                        on mo.upload_grants from anon, authenticated;
-- No select grant for service_role. The R2 cleanup below reaches this table
-- only through its two SECURITY DEFINER functions, so it needs none.
grant insert (user_id, report_id, storage_path)
                                  on mo.upload_grants to authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
--
-- Most rows here are NOT dead weight, however old. The R2 cleanup below works
-- only from grant rows: a grant is how it knows an object is MO's, and a
-- grant for a live photo is how it will find the bytes if that photo is
-- rejected a month from now. Deleting such a row loses the object for good --
-- a photo rejected later stays on the public hostname, and a failed delete
-- still being retried is dropped.
--
-- The only rows safe to remove are those whose object R2 has already deleted:
--
--   delete from mo.upload_grants
--    where object_deleted_at is not null
--      and created_at < now() - interval '2 days';
--
-- The interval keeps well clear of the hourly limit's window, which counts
-- these rows. There is no delete POLICY and no delete GRANT, so this is a
-- maintenance task for whoever holds the service role key. Leaving them costs
-- a few bytes a row, so forgetting is not a correctness problem.

-- ---------------------------------------------------------------------------
-- Deleting photos from R2 that nothing should serve
-- ---------------------------------------------------------------------------
--
-- Two kinds of object stay in the bucket for good unless something removes
-- them: bytes that were uploaded and never became a photo (a submission rolled
-- back, a connection dropped, a photo row deleted), and photos a person or the
-- worker REJECTED. The database withholds a rejected path, but the bytes are on
-- a public hostname and the uploader holds the key, so rejection only withheld
-- the row. These two functions tell the worker which objects to delete.
--
-- Built on upload_grants rather than on a listing of the bucket, and that is
-- the safety of the whole thing. The bucket is chintubucket, which the
-- marketplace also uses. Every object MO writes has a grant -- the endpoint
-- records one before it signs anything -- and nothing else does, so working
-- from grants means the worker never so much as looks at an object MO did not
-- write. A grant names a key inside its owner's own prefix only (the policy
-- above), so even a grant somebody minted by hand can only point the worker at
-- their own MO objects.
--
-- Photos on a pin taken off the map are NOT deleted: the pin can be put back.

-- Claim a batch to delete, retiring each grant as it goes so it can never be
-- linked again. Row locks (skip locked) make this safe beside a photo being
-- linked at the same moment, and beside a complaint about it: both take the
-- grant row too (enforce_photo_has_grant here, validate_flag_subject in 0005),
-- so whichever gets it first wins, and the other re-checks or is skipped. A grant retired more than ten minutes ago without its
-- object recorded as deleted is offered again, so a failed delete is retried.
--
-- What is claimed:
--   * never linked, and an hour old -- far past the two-minute upload URL, so
--     nothing is still on its way;
--   * linked once, but its photo row has since been deleted;
--   * its photo was rejected THIRTY DAYS AGO, and that rejection is settled.
--     The hold is so a wrong automatic rejection -- an NSFW score over the
--     line on a photo of a bin bag -- can be reversed before the bytes are
--     gone, with admin_allow_rejected_photo below, from the review queue's
--     list of recent rejections. Until then the photo is withheld from
--     everybody but its uploader. Settled
--     means: its review job
--     holds a 'rejected' verdict and nobody has an open complaint about it.
--     Rejection is not always final -- a complaint puts a decided photo back
--     in front of an admin (flag_reopens_review in 0005), and deleting the
--     bytes then would leave an admin judging a broken image, and possibly
--     approving a photo that no longer exists. The two checks overlap on
--     purpose: a complaint also clears the job's verdict, so either alone
--     refuses a reopened photo today, and each still holds if the other's
--     behaviour ever changes.
-- Why an object may be deleted, or null if it may not. One place for the
-- rules, used by both steps of the claim below.
create or replace function mo.deletion_reason(grant_id uuid)
returns text
language sql
stable
security definer
set search_path = mo, public
as $$
  select case
    when g.object_deleted_at is not null then null
    when p.id is null and g.linked_at is null and g.created_at < now() - interval '1 hour'
      then 'unused'
    when p.id is null and g.linked_at is not null
      then 'unused'
    when p.moderation_status = 'rejected'
     -- The thirty-day hold, from the photo's FIRST rejection. The job's
     -- updated_at was used before, and a complaint followed by a fresh
     -- rejection restamped it -- so a throwaway account could restart the
     -- clock as often as it liked. rejected_at is kept by the trigger below.
     and p.rejected_at < now() - interval '30 days'
     and exists (
       select 1 from mo.moderation_jobs j
        where j.subject_type = 'photo' and j.subject_id = p.id and j.verdict = 'rejected'
     )
     and not exists (
       select 1 from mo.flags f
        where f.subject_type = 'photo' and f.subject_id = p.id and f.resolved_at is null
     )
      then 'rejected'
    else null
  end
  from mo.upload_grants g
  left join mo.report_photos p on p.storage_path = g.storage_path
  where g.id = grant_id;
$$;

revoke all on function mo.deletion_reason(uuid) from public, anon, authenticated;

-- Two steps, and the second is what makes it safe.
--
-- One statement was not enough. Under Postgres's default isolation, a row that
-- changes under a `for update` is re-checked, but only that row: the join to
-- report_photos and the verdict and complaint checks keep the statement's
-- first snapshot. So a photo linked, or a complaint filed, just after that
-- snapshot could still see its object claimed.
--
-- Step one locks the candidates, skipping any a photo link or a complaint
-- already holds. Step two runs as a new statement, so it sees everything
-- committed before the locks were taken, and re-decides each one with the
-- same rules; only those still deletable are retired. Nothing can change them
-- in between, because a link and a complaint both need the grant row, which
-- this now holds until it commits.
create or replace function mo.claim_objects_to_delete(batch_size integer default 50)
returns table (storage_path text, reason text)
language plpgsql
volatile
security definer
set search_path = mo, public
as $$
declare
  held uuid[];
begin
  select array_agg(c.id) into held
    from (
      select g.id
        from mo.upload_grants g
       where g.object_deleted_at is null
         and (g.retired_at is null or g.retired_at < now() - interval '10 minutes')
         and mo.deletion_reason(g.id) is not null
       order by g.created_at
       limit least(greatest(batch_size, 1), 500)
       for update of g skip locked
    ) c;

  if held is null then
    return;
  end if;

  return query
  with still as (
    select g.id as grant_id, mo.deletion_reason(g.id) as why
      from mo.upload_grants g
     where g.id = any(held)
  )
  update mo.upload_grants g
     set retired_at = now()
    from still s
   where g.id = s.grant_id
     and s.why is not null
  returning g.storage_path, s.why;
end;
$$;

-- Record that R2 has removed an object. Returns whether this changed anything.
create or replace function mo.record_object_deleted(path text)
returns boolean
language sql
volatile
security definer
set search_path = mo, public
as $$
  update mo.upload_grants
     set object_deleted_at = now()
   where storage_path = path
     and retired_at is not null
     and object_deleted_at is null
  returning true;
$$;

-- The worker's, and nobody else's. See the note on revoking from PUBLIC in
-- 0004 for why service_role has to be granted back explicitly.
revoke all on function mo.claim_objects_to_delete(integer) from public, anon, authenticated;
revoke all on function mo.record_object_deleted(text)     from public, anon, authenticated;
grant execute on function mo.claim_objects_to_delete(integer) to service_role;
grant execute on function mo.record_object_deleted(text)     to service_role;

-- ---------------------------------------------------------------------------
-- When a photo was first rejected
-- ---------------------------------------------------------------------------
--
-- Set the first time a photo becomes rejected, and cleared when it is
-- approved. Nothing else touches it: a complaint that reopens a rejected photo
-- leaves its status 'rejected', so the clock keeps running, and rejecting it
-- again does not restart it. Allowing it resets the clock, so a photo rejected
-- long after being allowed gets its full hold.
create or replace function mo.stamp_photo_rejection()
returns trigger
language plpgsql
as $$
begin
  if new.moderation_status = 'rejected' and new.rejected_at is null then
    new.rejected_at = now();
  elsif new.moderation_status = 'approved' then
    new.rejected_at = null;
  end if;
  return new;
end;
$$;

create trigger stamp_photo_rejection
  before update of moderation_status on mo.report_photos
  for each row execute function mo.stamp_photo_rejection();

-- ---------------------------------------------------------------------------
-- Reversing a wrong rejection, inside the thirty-day hold
-- ---------------------------------------------------------------------------
--
-- The hold on rejected photos exists so a mistake can be undone before the
-- bytes are deleted -- above all an automatic one, which no person has seen.
-- A decided rejection is not in the review queue (that holds only items with
-- no verdict), so these two give admins a way to find one and allow it.

-- Photos rejected and not yet claimed by the cleanup, OLDEST first -- the ones
-- closest to being deleted are the ones an admin most needs to see -- with who
-- or what rejected them. The path is included: admins may see a withheld
-- photo, which is the point.
create or replace function mo.admin_recent_rejected_photos(max_results integer default 50)
returns table (
  photo_id     uuid,
  report_id    uuid,
  storage_path text,
  rejected_at  timestamptz,
  decided_by   text
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
  select p.id, p.report_id, p.storage_path, p.rejected_at, j.decided_by
    from mo.report_photos p
    join mo.moderation_jobs j on j.subject_type = 'photo' and j.subject_id = p.id
    join mo.upload_grants g on g.storage_path = p.storage_path
   where p.moderation_status = 'rejected'
     and j.verdict = 'rejected'
     and g.retired_at is null
   order by p.rejected_at asc nulls last
   limit least(greatest(max_results, 1), 201);
end;
$$;

-- Allow a rejected photo after all. Records a person's decision in place of
-- the rejection and settles any complaint about it, as admin_decide_moderation
-- does. The grant row is locked first, the same row the cleanup claims, so
-- this and a cleanup pass cannot both succeed: whichever is second finds the
-- photo already allowed, or already retired.
create or replace function mo.admin_allow_rejected_photo(target_photo uuid)
returns void
language plpgsql
volatile
security definer
set search_path = mo, public
as $$
begin
  if not mo.is_admin() then
    raise exception 'only an admin may decide moderation items';
  end if;

  perform 1
     from mo.upload_grants g
     join mo.report_photos p on p.storage_path = g.storage_path
    where p.id = target_photo
      for update of g;

  if not exists (
    select 1
      from mo.report_photos p
      join mo.upload_grants g on g.storage_path = p.storage_path
     where p.id = target_photo
       and p.moderation_status = 'rejected'
       and g.retired_at is null
  ) then
    raise exception 'no such photo';
  end if;

  update mo.moderation_jobs
     set verdict    = 'approved',
         status     = 'done',
         decided_by = 'human:' || coalesce(auth.uid()::text, 'unknown'),
         reason     = 'allowed after all by an admin',
         locked_at  = null,
         locked_by  = null
   where subject_type = 'photo'
     and subject_id   = target_photo
     and verdict      = 'rejected';

  if not found then
    raise exception 'this item was decided by someone else a moment ago';
  end if;

  update mo.flags
     set resolved_at = now()
   where subject_type = 'photo'
     and subject_id   = target_photo
     and resolved_at is null;

  update mo.report_photos set moderation_status = 'approved' where id = target_photo;
end;
$$;

revoke all on function mo.admin_recent_rejected_photos(integer) from public, anon;
revoke all on function mo.admin_allow_rejected_photo(uuid)       from public, anon;
grant execute on function mo.admin_recent_rejected_photos(integer) to authenticated;
grant execute on function mo.admin_allow_rejected_photo(uuid)       to authenticated;

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
