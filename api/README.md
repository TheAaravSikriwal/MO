# The upload signing endpoint

One serverless function, `POST /api/sign-upload`. It hands a signed-in person a
URL that accepts exactly one photo, and nothing else.

Photo bytes live in Cloudflare R2 and the R2 credentials must never reach a
browser, so something server-side has to hold them. This is the smallest thing
that can: it checks who is asking, decides the object key itself, signs a single
PUT, and never touches the bytes.

## Files

| File | Contents |
|---|---|
| `sign-upload.ts` | The Vercel route. Four lines: supplies the environment, the clock and the random id |
| `_lib/signUpload.ts` | The handler. Auth, validation, and the reply |
| `_lib/r2.ts` | The object key, and the R2 presigned PUT |
| `../supabase/migrations/0006_upload_grants.sql` | The table and trigger that limit how many URLs one account can get |
| `../shared/sigv4.ts` | AWS Signature Version 4, query-string flavour, on Web Crypto. Shared with the worker, which signs DELETEs with it |

Vercel ignores files under `api/` whose names begin with `_`, so only
`sign-upload.ts` becomes a route.

## Why it is not an open upload relay

Five independent limits, because any one of them can be wrong:

1. **A valid Supabase access token.** Checked *with* Supabase, not decoded and
   trusted. Verifying the JWT here would mean holding the project's signing
   secret and tracking which algorithm the project signs with; asking Supabase
   costs one round-trip on a request that is about to upload a photo anyway,
   and it cannot drift out of step with key rotation.
2. **Every grant is recorded, and the record is rate limited.** This is the
   limit on *volume*, and it is the one that took two attempts to get right.
   See below.
3. **The key is decided here**, from the verified user id — never from the
   request. It is `map/<user-id>/<report-id>/<photo-id>.<ext>` -- `map/` because
   the bucket is shared with the marketplace -- every part after it a UUID
   and the extension taken from the declared content type. Nothing
   attacker-controlled reaches the key, a signed URL can only ever write inside
   the caller's own prefix, and the grant row is what makes that key the only
   one linkable to the report — see below.
4. **The type, the exact byte length, and `if-none-match: *` are signed.** R2
   recomputes the signature from the headers it actually receives, so a URL
   issued for a 2 MB JPEG cannot be used to push half a gigabyte of anything
   into the bucket — and the conditional header means it is good for one
   write, not for every write of that shape until it expires. See below.
5. **It expires in two minutes.**

Every question it asks the database, it asks with the **caller's own token**,
never a service role key. The answers are the ones row level security would
give that person anyway, so this endpoint holds no database privilege of its
own — and `public_reports` is the only public read path, which is why an
unapproved or somebody else's report simply is not there to find.

## Why the grant is recorded, and not merely checked

Two earlier versions of this got it wrong, in instructive ways.

**The first had no volume limit at all.** It reasoned that row level security
refuses a `report_photos` insert against somebody else's report, so the worst a
misdirected URL could do was leave an unreferenced object in the caller's own
prefix. True, and beside the point: signing is not inserting.

**The second counted the photos already on the report** and refused once there
were three. That looks like a limit and is not one. The count only rises when
the *client* inserts a photo row, and nothing obliges it to. A caller that
never inserts leaves the count at zero forever, while every request mints a
fresh random key — so sign, PUT 8 MB, repeat was an unbounded loop from one
account and one report. About 1,250 iterations fill R2's free tier, and sign-up
is an open magic link, so "one account" means anybody with an email address.
Against the zero-budget constraint that is the whole game.

The lesson is the one the schema already states about votes: the control has to
be something the database enforces, not something application code checks.
Nothing recorded the grant, so nothing could count it. Now
`upload_grants` does, a trigger refuses the thirty-first in an hour, and the
endpoint cannot get a URL without inserting there first.

Thirty an hour is ten reports at the three-photo maximum, which is already the
most the report rate limit allows anyone to create in an hour.

The count is taken once per **statement**, over a transition table, behind an
advisory lock keyed on the person. The lock is what makes it hold: without it,
two simultaneous requests each read a count that misses the other's rows, and
both pass. Every counting limit in the migrations has the same shape.

This paragraph used to say the per-statement form was needed because a
row-level BEFORE trigger cannot see the other rows of its own statement. That
is false -- such a trigger sees rows already processed by the same command --
and the note above `enforce_report_rate_limit` in `0002` has the detail.

It is a budget of thirty **attempts**, though, not thirty photos. The grant is
recorded before the upload and nothing gives it back, so a dropped connection,
a signature R2 refuses, or a submission `createReport` rolls back each spend
one. Ten flawless reports of three photos is exactly thirty, which means
somebody genuinely at the ceiling who retries once is refused and told to wait.
Raise the number in `0006` before reading that refusal as abuse.

**Every limit here is post-authentication.** A request carrying any `Bearer`
string at all costs one Vercel invocation and one Supabase `/auth/v1/user`
call before anything is counted, because the count is keyed on a user id that
does not exist until that call returns. So an anonymous caller can drive
invocations and auth volume at will. Both are free-tier metered, so this is the
same class of exposure as below and has the same answer: nothing in this repo
bounds it. Vercel's own per-deployment rate limiting is where that would go.

**It is a per-account limit, so it is not a limit on cost.** One account is
capped at 240 MB an hour; forty-two accounts are not capped at anything useful,
and sign-up is an open magic link, so accounts are free to make. Nothing here
bounds the total. Say that plainly
rather than quoting the per-account figure as if it were the ceiling — the
mistake twice above was exactly this kind of arithmetic.

What saves the zero-budget constraint is R2's own behaviour rather than
anything in this repo: with no payment method on the Cloudflare account,
passing the free tier makes writes start failing instead of generating a bill.
So the exposure is availability, not money — uploads stop working for
everybody until somebody clears the bucket. **Do not add a payment method to
this account** without putting a real ceiling in first.

A global ceiling is the obvious next control and is deliberately not here,
because it is a genuine trade: a single determined account could then spend the
whole allowance and deny uploads to everyone, which is a worse failure than a
slow one. Invite-only sign-up, or a per-account quota that needs a human to
raise, are the better answers and both are product decisions rather than code.
Recorded in `HANDOFF.md` under what is not done.

The row is inserted with the **caller's** token, so the policy pins `user_id`
to `auth.uid()`: the endpoint cannot record a grant against somebody else, and
cannot exempt itself from the trigger. It is also why there is no separate
ownership check — the same policy requires the report to be the caller's, so a
report id that is not theirs is refused by the insert.

## The grant is authority, not just a receipt

Deciding the key server-side settles what can be *written*. It says nothing
about what can be *linked*: `report_photos.storage_path` is free text and the
client sends it. So for a while a grant was traceability and nothing more.

What that allowed: somebody whose photo was rejected still knows its key — this
endpoint returned it. They could insert a fresh `report_photos` row naming the
same object against a new report, with no upload, no grant and no charge
against the hourly limit, and it would start at `pending` for a second verdict.
Rejection is recorded on the row, not on the object. The same gap let a client
name a key that was never uploaded at all, which puts a moderation job for an
unfetchable image in front of a person.

**What a grant does and does not prove.** `authenticated` holds an insert
privilege on `upload_grants`, because this endpoint writes with the caller's own
token rather than a service role key — so anybody signed in could post a grant
themselves, and a grant means "somebody claimed this key", not "this endpoint
issued it". Making it the latter would mean putting a privileged credential in
this function, which `.env.example` currently forbids for this app ("never in
this app, never behind a `VITE_` prefix, never in the browser"). That is a
decision to take deliberately rather than by accident, so it has not been
taken.

What makes the grant useful anyway is that each object can be granted once and
linked once:

`0006` closes it by making a grant **one use**. A `before insert` trigger on
`report_photos` spends the grant for that exact object on that exact report,
in the same statement that checks it; a unique index on `storage_path` is the
second belt.

The spending matters, and checking that a grant merely *exists* was the second
version of this that was wrong. A unique index only constrains live rows, and
`report_photos_delete_own` lets the report's owner delete their own photo row,
so delete-then-re-insert passed an existence check. `moderation_status` returns
to `pending` and a fresh moderation job is raised, which means an image a human
rejected could be put up for another verdict as often as somebody liked — no
upload, no new grant, nothing counted, and tier 2 can auto-approve a photo. An
`update ... where linked_at is null returning id` closes it and is atomic, so
two concurrent inserts cannot both claim one grant.

A unique index on `upload_grants.storage_path` is what holds the rest of it
together: one grant per object for the lifetime of the database, so a spent
grant cannot be replaced by a fresh one for the same object. And the insert
policy pins the key to the caller's own prefix and their own report, so a
self-minted grant can never name somebody else's object.

**A `check` constraint pins the whole key, and it is load-bearing.** Both unique
indexes are on the literal string, and a photo URL is built by concatenation and
then read by a URL parser — so without it, two different strings address one
object and the indexes cannot tell:

```
<uid>/<rid>/<pid>.jpg?x=1                    a query the parser drops
<uid>/<rid2>/../../<uid>/<rid>/<pid>.jpg     dot segments the parser folds
```

Either is unique, satisfies the policy's `like`, and resolves to an object that
is already linked, which reopens the re-judging loop above. One immutable function, `is_photo_object_key`, holds the pattern, and a `check`
on each of `upload_grants` and `report_photos` calls it — so there is one
spelling, and it is why the endpoint lowercases all three id segments before
building a key. `migrations.test.ts` lifts the pattern out of the SQL and runs
both strings above through it.

It is a `check` rather than a domain on the column for a reason worth keeping:
`public_report_photos` selects `storage_path`, and Postgres refuses to alter the
type of a column a view depends on. A domain therefore aborted `0006` — and
since the file applies as one transaction, that rolled back the rate limit with
it, leaving uploads answering "not set up" for a reason nothing pointed at.

All of these are in the database rather than here, for the usual reason —
this endpoint is not the only thing that can reach that table.

**What is still open: phantom photo rows.** Because a grant can be minted
directly, somebody can claim a key inside their own prefix that was never
uploaded, then link it. The result is a `report_photos` row, and a moderation
job, for an image that does not exist — so an admin is eventually shown
nothing. It is capped at thirty an hour per account by the same trigger, which counts
grants a person cannot delete, behind a lock that stops simultaneous requests
all passing. (This used to credit the per-statement form, on the false premise
that a row-level trigger could not see its own statement's rows.) It does not touch
anybody else's data. Closing it properly needs the grant insert
to be something a browser cannot perform, which is the privileged-credential
decision above.

## One write, not one shape of write

`if-none-match: *` earns its place. Without it a presigned PUT stays usable for
its whole two minutes: R2 would accept any number of writes to that key as long
as each body had the signed length and type, and padding a file to an exact
length is trivial.

That is not a theoretical difference, because the worker judges the **object**.
It fetches the bytes from the photo hostname and writes the verdict to the
`report_photos` row, not to the bytes. With a reusable URL the sequence is:
sign, upload something harmless, link it, let the worker fetch and approve it,
then overwrite the object — all inside the same two minutes — and the row says
approved over content nothing ever reviewed. Everything `0006` does about
re-judging a rejected image concerns the row; this is the same failure class one
layer down, where the database cannot see it.

A conditional PUT closes it: by the time a second write arrives the object
exists, so R2 refuses it. The browser sends the header because the endpoint
returns it in `headers`, and the signature covers it, so a client that drops it
is refused too.

This is the second thing to confirm against a real bucket, after
`content-length`. R2 supports conditional writes, but this exact combination has
never been sent to one. If it is refused, do not simply drop the header — read
the note at the end of this file first, because the alternative is signing
`content-md5`, which pins the bytes themselves and is strictly better than
either.

## What deletes from the bucket

The worker does, since 2026-09-27 -- see `HANDOFF.md` item 3. It removes
uploads that never became a photo, photos whose row was deleted, and photos
rejected more than thirty days ago, which is what makes rejection remove
content rather than only withhold its row. The thirty days are a hold, so a
wrong automatic rejection can be reversed before the bytes are gone. It works from `upload_grants`, not from a listing of
the bucket, because the bucket is shared with the marketplace, and it signs
its DELETEs with the same SigV4 code as this endpoint, now in `shared/`. It has
not yet been run against a real bucket.

## What has to exist before it works

Neither of these is code, and neither has been done — there is no Cloudflare
account yet.

**1. An R2 bucket, and a CORS rule on it.** The browser PUTs straight to R2, so
without a CORS rule the request never leaves the browser. Allow only the site's
own origin and only what is needed:

```json
[
  {
    "AllowedOrigins": ["https://your-site.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "if-none-match"],
    "MaxAgeSeconds": 3600
  }
]
```

`if-none-match` has to be in that list. It is not a CORS-safelisted request
header, and the `image/jpeg` body forces a preflight anyway, so the browser asks
for `content-type,if-none-match` — and R2 fails the preflight if either is
missing. The PUT then never leaves the browser, and the rejection arrives as a
`fetch` TypeError, which `plainError` turns into "Could not reach the server",
pointing at the network rather than at this rule. If uploads fail with nothing
in the R2 logs at all, check this first.

Add the preview and `http://localhost:5173` origins while developing, and take
them out again afterwards.

**2. A Cloudflare-proxied hostname serving the bucket, set as
`VITE_PHOTO_BASE_URL`.** This is a *different* hostname from the S3 API one the
endpoint signs against, and it is the one that matters legally: Cloudflare's
free CSAM scanning applies to a zone, which is the whole reason photos live in
R2 rather than in Supabase storage. Serving photos from anywhere else leaves
that obligation unmet. That includes the bucket's own `pub-<hash>.r2.dev`
address: it works, but it is Cloudflare's hostname rather than one on your
zone, so scanning never applies. The endpoint refuses any `r2.dev` host.

The endpoint therefore **refuses to sign anything until it is set**, even
though it never uses the value itself. Accepting bytes with nowhere to serve
them from gives you an unscanned bucket, a map with no pictures, and admins
asked to judge images they cannot see — a worse state than uploads simply not
working yet.

It reads `VITE_PHOTO_BASE_URL` and nothing else, which is the one place here
with no `PHOTO_BASE_URL` fallback. That is deliberate: this is the only value
the endpoint checks on the *bundle's* behalf rather than using itself, and the
bundle reads that exact name (`src/lib/data/createDataSource.ts`). With an alias
accepted, setting only `PHOTO_BASE_URL` passed the gate while the app never saw
a value — uploads succeeded, every photo URL came back null, and the report
screen said "Photo is being checked" permanently. The gate has to check the
string the bundle will actually use.

## What is proven, and what is not

Proven by `npm test`:

- The signature itself. `../shared/sigv4.test.ts` reproduces AWS's own published
  presigned-URL example exactly, and pins HMAC-SHA-256 against the RFC 4231
  vectors underneath it. A 256-bit match cannot happen by accident.
- Every refusal path: missing token, rejected token, an unreachable auth
  check, a report that is not the caller's, an account over its hourly limit, a
  database that cannot be reached, a bad type, a size over the cap, a report id
  that is not a UUID, a caller-supplied key or user id, a missing variable.
- That nothing is signed before the grant is recorded, so a refusal cannot
  leak a URL.
- That an expired token is asked to sign in again rather than told its report
  could not be found, and that a bucket name whose case or punctuation would
  not resolve is refused up front rather than signed.
- That a 404 or 405 from the route itself — a deployment with no serverless
  function — says uploads are not set up, rather than inviting a retry against
  a route that does not exist. That is the likeliest first-deploy failure.

  **The message is the same one a missing environment variable produces, on
  purpose.** To the person in front of it those are one fact, and neither is
  theirs to fix. To whoever is setting the site up they are completely
  different, so the two are told apart by the status and by a console line:

  | What you see | What it means |
  |---|---|
  | `404`/`405`, and `[mo] /api/sign-upload answered 404` in the console | The function is not deployed, or not being routed to. There is no `vercel.json`; Vercel is expected to pick up `api/sign-upload.ts` by convention. |
  | `503` with the same sentence, no console line | The function is running and a variable is unset or malformed. Check all seven: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_PHOTO_BASE_URL`, and the four `R2_` values. The two URLs must be full `https://` URLs, not bare hostnames. |
  | `503` with "Something went wrong preparing the upload." | Three different causes answer with this one sentence, on purpose: Supabase could not be reached for the token check, the grant could not be recorded, or the handler threw. The person is not told which. **You** are: only the third logs, as `[mo] /api/sign-upload failed unexpectedly:` in the function log. If there is no such line, it is one of the first two, and both mean something upstream is unreachable. |
  | Any other `5xx`, with no JSON body at all | The route seam itself. `sign-upload.ts` reads `process.env` before the handler's own try/catch can run, so a wrong runtime declaration or export shape fails outside it and the platform answers with something that is not our JSON. The client turns that into "Your photo could not be uploaded. Please try again." — the one wording that invites a retry against something that cannot work. Check the function's build log on Vercel. |
  | The upload fails with nothing in the R2 logs | The CORS rule. `if-none-match` has to be in `AllowedHeaders`; without it the preflight fails and the PUT never leaves the browser, arriving as "Could not reach the server". |

  `api/sign-upload.ts` is the one file here with no test, because the route seam
  — the `edge` runtime declaration, the `process.env` handoff, the export shape
  Vercel expects — cannot be verified without a deployment. The table above is
  how to diagnose it when it is wrong.
- That each bad `contentLength` gets the answer that is true of it: too large
  for an oversized one, empty for a zero, and the generic wording for a number
  no browser would send.
- That the browser refuses to PUT a photo anywhere but the object store, even
  if the endpoint hands back some other URL — the one point at which somebody's
  photo could be redirected off-site (`src/lib/upload/uploadPhoto.ts`).
- That a Supabase which cannot be reached is not reported as a rejected token.
  Both refuse, but telling somebody with a good session to sign in again points
  them at the one thing that cannot help, and hides a wrong `SUPABASE_URL` from
  whoever set the site up.

Every check above is expected to be mutation-tested when it changes: break it
on purpose, watch the named test fail, restore it. `CLAUDE.md` requires that.
It is a practice, not an artifact — nothing in the repository records which
mutations were tried, so read it as a requirement on your change rather than a
claim about the last one.

**Not proven, because the migration has never been applied:** that
`0006_upload_grants.sql` works. Like the other five it is a careful draft
against a database that does not exist. If it is skipped, or the table is
missing, every upload fails closed with "Photo upload is not set up on this
site yet" rather than quietly becoming unlimited -- which is the right way
round, but it does mean uploads will not work until 0006 is applied.

**Not proven, because it needs a live bucket:** that R2 accepts this signature.
Two headers are the likely candidates if it does not: `content-length` and
`if-none-match`, both in `_lib/r2.ts`. It is a legitimate use of SignedHeaders, but it has never been
sent to R2. If uploads come back as `SignatureDoesNotMatch` with everything
else correct, that is the first thing to suspect. Record what happens either
way — this file is where it belongs.

**Do not just delete it.** Signing `content-length` is the *only* thing
enforcing the 8 MB cap. The `MAX_PHOTO_BYTES` check in `_lib/signUpload.ts`
validates a number the caller supplied; once the size is out of the signature
that number constrains nothing, and every URL becomes a write of arbitrary
size — R2 takes up to 5 GB in a single PUT. Removing it therefore removes the
per-request cap and leaves only the hourly grant limit, which would then bound
thirty writes an hour at 5 GB each rather than thirty at 8 MB.

If it has to go, the options are, in order of preference:

1. Sign `content-md5` of the file instead. It pins the exact bytes, so it caps
   the size implicitly, and the browser can compute it before uploading.
2. Drop the per-request cap knowingly, and tighten the hourly grant limit in
   `supabase/migrations/0006_upload_grants.sql` to something that is survivable
   at 5 GB a request. Write down that the cap is gone.

What is not an option: leaving the `MAX_PHOTO_BYTES` check in place and
treating it as enforcement. It would read like a limit and be a comment.

R2 does not support presigned POST policies, so the POST-policy
`content-length-range` is not an alternative either.

## Running it locally

`npm run dev` serves this endpoint. Vite knows nothing about Vercel's
functions, so `vite.config.ts` mounts the handler on `/api/sign-upload` for the
dev server only — otherwise the route 404s locally and the app reports a
generic "could not be uploaded", which is the worst possible message for
somebody setting uploads up for the first time.

With nothing configured you get the honest answer:

```
$ curl -s -X POST http://localhost:5173/api/sign-upload     -H 'Content-Type: application/json' -H 'Authorization: Bearer x'     -d '{"reportId":"00000000-0000-4000-8000-000000000000",
         "contentType":"image/jpeg","contentLength":2048}'
{"message":"Photo upload is not set up on this site yet."}
```

The dev route reads `.env` through `loadEnv`, including the variables with no
`VITE_` prefix. It is the same handler the deployed function runs, so a refusal
you see locally is the refusal you would get in production.
