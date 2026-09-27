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
-- The exact shape api/sign-upload generates: three lowercase UUIDs and one of
-- three extensions, and nothing else at all.
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
  select key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$';
$$;

grant execute on function mo.is_photo_object_key(text) to anon, authenticated;

create table mo.upload_grants (
  id         uuid primary key default gen_random_uuid(),
  -- Cascades, unlike report_id below. Deleting a person should take their
  -- records with them, and this one row is not worth keeping over that.
  --
  -- Be aware of what it means for the count, though: it IS a path that empties
  -- somebody's grants inside the window. Nothing in MO exposes it -- MO holds
  -- no delete grant on public.profiles and does not own that table -- but the
  -- marketplace side owns profiles now, so a "delete my account" feature added
  -- THERE would reset this counter here. Worth knowing before building one.
  user_id    uuid not null references public.profiles (id) on delete cascade,
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
  created_at timestamptz not null default now()
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
    and storage_path like (auth.uid()::text || '/' || report_id::text || '/%')
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
-- No select grant for service_role. The orphan sweep in api/README.md would
-- need one, and that sweep is not built (see HANDOFF.md) -- granting a
-- privilege for code that does not exist is how a schema ends up carrying
-- privileges nobody can account for. Add it with the sweep.
grant insert (user_id, report_id, storage_path)
                                  on mo.upload_grants to authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
--
-- Rows older than the window are dead weight. There is no scheduler on the free
-- tier, so this is not automatic; run it from the SQL editor, or from the worker
-- if it ever grows a maintenance pass. Leaving them costs a few bytes a row, so
-- forgetting is not a correctness problem.
--
-- Keep the interval comfortably wider than the trigger's window. Deleting rows
-- younger than an hour would hand back the reset this table exists to prevent.
--
--   delete from mo.upload_grants where created_at < now() - interval '2 days';
--
-- Note there is no delete POLICY and no delete GRANT, so this is a maintenance
-- task for whoever holds the service role key, not something a person can do.
--
-- Do not delete SPENT grants on a shorter schedule than unspent ones either. A
-- spent grant is what stops its object being linked a second time, so removing
-- it early hands back the re-judging loop described above.

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
