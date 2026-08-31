# Database

Schema, policies and RPCs for MO. Four migrations, applied in order.

> **These migrations have never been run.** They were written against the design
> spec without a live Postgres instance to test on. Everything else in this repo
> has passing tests behind it; this does not yet. Expect to fix something on
> first apply, and verify the policies against a real database before trusting
> them.

## Files

| File | Contents |
|---|---|
| `0001_init_schema.sql` | Extensions, enums, tables, indexes |
| `0002_functions_triggers.sql` | Vote counts, moderation queueing, rate limits, role guard, cleaned RPC |
| `0003_views_and_rls.sql` | Public views, row-level security, column grants |
| `0004_rollup_and_worker_rpc.sql` | Map rollup, near-me, the worker's queue interface |

## Applying them

Paste each file into the Supabase SQL editor in order, or with the CLI:

```bash
supabase db push
```

Then create the first admin — see the bottom of `0004`. Nothing can be reviewed
until you do, because ambiguous content escalates to a human and there is no
human until an admin exists.

## The shape of it

**Severity has no column.** There is no `severity` field anywhere, because
nobody chooses it. An area's colour comes from `reports_rollup`, which sums
`1 + vote_count` over open, approved reports. Marking a report cleaned removes
it from that sum, so a cleanup visibly cools the map.

**One person, one vote.** The primary key on `votes (report_id, user_id)` is the
anti-stuffing control — not application logic, which can be bypassed. You also
cannot vote on your own report; the report already contributes its own weight,
so self-voting would let one person count twice.

**Six cells per report.** `cell_r1` through `cell_r12` are H3 ancestors of the
same point, computed client-side. Zooming out changes which column the rollup
groups by. This is why a world view is one indexed `GROUP BY` and not a
geometry query, and why no Postgres H3 extension is needed.

Postgres cannot recompute those cells without that extension, so `lat`/`lng`
stays authoritative and the cell columns are a display index derived from it.
The format `CHECK` is a sanity guard, not a correctness guarantee — a malicious
client could submit well-formed cells that don't match its coordinates. The blast
radius is its own report appearing in the wrong bucket.

**Pins are public; words and pictures are not.** A report's location goes live
immediately so the map stays alive, but its note is withheld until approved and
its photo path is withheld until approved.

That second point is a deliberate departure from the spec. The spec called for
the client to blur a pending photo — but a blur is CSS, and anyone can strip it
or read the URL out of the network tab. `public_report_photos` returns `null`
for `storage_path` until a photo is approved, so an unreviewed image is
genuinely unreachable rather than merely hidden. `moderation_status` still comes
through, so the UI knows to show a "not reviewed yet" placeholder.

**Read through the views.** `public_reports` and `public_report_photos` apply the
withholding above. Both use `security_invoker`, so table policies still apply —
without it a view becomes a way around every policy in `0003`.

## Verifying the policies

RLS is only meaningfully testable against a live database. The questions worth
answering, each of which should FAIL:

- Can an anonymous visitor insert a report?
- Can user A delete user B's report, or edit their comment?
- Can a user set their own `role` to `admin`?
- Can a user insert a report with `moderation_status` already `approved`?
- Can a user vote twice on one report, or vote on their own?
- Can a non-admin read `moderation_jobs`?
- Does `storage_path` come back non-null for a pending photo?

And these should SUCCEED:

- Can an anonymous visitor read approved reports and call `reports_rollup`?
- Can an author see their own rejected report?
- Does `vote_count` match the row count in `votes` after inserts and deletes?
- Does `reports_rollup` return nothing for a report once it is cleaned?
