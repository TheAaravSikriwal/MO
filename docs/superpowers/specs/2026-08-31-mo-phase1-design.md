# MO — Phase 1 Design Spec

Date: 2026-08-31
Status: Draft for review

## 1. Summary

MO is a community pollution map. People report polluted spots with a photo and a
precise location; the map colours areas by how many people have flagged them; the
map improves visibly as spots get marked cleaned.

Phase 1 delivers: the map, reporting, voting, commenting, search/filter, auth, the
mark-as-cleaned moment, and a four-tier moderation pipeline.

## 2. Hard constraints (from the brief)

These are not preferences. They constrain every piece of copy and colour below.

- **Plain language everywhere.** A report is a "report", a cleanup is a "cleanup",
  cleaned is "cleaned". No in-jokes, no jargon, no dictionary needed.
- **Never disparage a place or the people in it.** Copy describes the litter, never
  the location's character. "Litter reported here" — never anything about the area
  or its residents.
- **The MO character lives only in motion, mascot and micro-interaction.** Never in
  wording.
- **Zero budget.** Everything runs on free tiers.

## 3. Decisions

Recorded with rationale so they aren't relitigated later.

| # | Decision | Rationale |
|---|---|---|
| D1 | Anyone can view the map signed out. Submitting a report, voting, or commenting requires sign-in (Supabase email magic link). | Every row gets a real owner, so RLS is simple and abuse is traceable. |
| D2 | Any signed-in user can mark a report cleaned. The action records who and when. | The volunteer who cleans a spot is usually not the person who reported it. |
| D3 | **Severity is derived, never chosen.** There is no Low/Medium/High picker. | Self-assessed severity is noise; count of distinct people flagging an area is signal. |
| D4 | A report requires at least one photo (max 3). A vote requires nothing. | Photo is the evidence. Voting stays one tap so confirmation is frictionless. |
| D5 | Cell weight = sum over open reports in the cell of `(1 + vote_count)`. Colour assigned by percentile against what is currently on screen. | Reads correctly in a dense city *and* a quiet suburb. Cleaned reports drop out, so cleanups visibly cool the map. |
| D6 | Store exact lat/lng plus six precomputed H3 columns (r1, r3, r5, r7, r9, r12). Rollup is `GROUP BY cell_rN`. | No Postgres H3 extension dependency. H3 parents never change, so precomputing is safe. Index-only aggregation. |
| D7 | Reports may only be submitted at map zoom ≥ 15. | Forces a precise pin and keeps the data honest. |
| D8 | Continuous OKLCH colour ramp: **white → yellow → orange → red**. No discrete bins, no strokes. Fill opacity rises with severity. | Hues must transition cleanly. White is the resting state, so a clean area reads as clean and the map only gains colour as people flag it. Superseded an earlier teal→amber ramp: measurement showed it passed through a strong green midpoint (chroma 0.126), and green reads as "all clear" on an area that has reported litter. |
| D9 | Moderation is four tiers behind a queue table, each tier swappable by env var. | The model host will move between laptop, PC and local server. The app must not care. |
| D10 | Admin role ships in Phase 1, not "later". | Obscene photos and comments are the primary failure mode. |
| D11 | Photo bytes live in **Cloudflare R2** behind a Cloudflare-proxied hostname. Metadata stays in Supabase. App stays on Vercel. | Supabase free storage (~1 GB) caps MO at roughly 2,000 photos. R2 free tier is ~10 GB with zero egress. R2 is on a Cloudflare zone by definition, so CSAM scanning comes free. |
| D12 | Moderation auto-decides the confident ends; only a narrow ambiguous band reaches a human. All thresholds are env vars. | Manual review must be rare, and rarity must be tunable without a code change. |
| D13 | If the worker is offline, pending photos stay blurred. Fail-closed, never auto-publish on timeout. | An unreviewed photo is the exact risk the pipeline exists to prevent. |

## 4. Stack

- **Frontend:** React + Vite + TypeScript + Tailwind
- **Map:** Leaflet + OpenStreetMap tiles, behind a wrapper component so the tile
  provider is swappable
- **Grid:** `h3-js`
- **Colour:** `culori` (OKLCH interpolation)
- **Geocoding:** Nominatim, debounced to respect ~1 req/sec
- **Backend:** Supabase — Postgres, Auth, Row-Level Security
- **Photo storage:** Cloudflare R2, served via a Cloudflare-proxied hostname (D11)
- **Worker:** standalone Node + TypeScript package in `/worker`
- **Hosting:** Vercel (frontend), Supabase (data), Cloudflare (photo bytes),
  user-controlled host (worker)

## 5. Data model

Nouns, not migrations. Exact DDL belongs in the implementation plan.

**profiles** — `id` (FK `auth.users`), `display_name`, `role` (`user` | `admin`),
`created_at`

**reports** — `id`, `reporter_id`, `lat`, `lng`, `geom` (geography Point),
`cell_r1`, `cell_r3`, `cell_r5`, `cell_r7`, `cell_r9`, `cell_r12`, `note`,
`status` (`open` | `cleaned`), `cleaned_by`, `cleaned_at`, `moderation_status`
(`pending` | `approved` | `rejected`), `vote_count` (denormalised), `created_at`

**report_photos** — `id`, `report_id`, `storage_path`, `moderation_status`,
`created_at`

**votes** — `report_id`, `user_id`, `created_at`. Primary key `(report_id, user_id)`.
This constraint *is* the anti-stuffing mechanism.

**comments** — `id`, `report_id`, `author_id`, `body`, `moderation_status`,
`created_at`

**flags** — `id`, `subject_type`, `subject_id`, `flagger_id`, `reason`, `created_at`.
The community "report this" button.

**moderation_jobs** — `id`, `subject_type` (`photo` | `comment` | `note`),
`subject_id`, `status` (`pending` | `in_progress` | `done` | `failed`),
`tier_results` (jsonb), `verdict`, `reason`, `decided_by`, `attempts`, `locked_at`,
`created_at`

### Why the H3 columns are written by the app

The six cell columns are computed client-side by `h3-js` at submit time and written
with the row. They are derived data with a pure, deterministic, permanently stable
function of lat/lng, so there is no drift risk. This trades six small text columns
for the ability to aggregate with a plain indexed `GROUP BY` — no extension, no
PostGIS-side H3, no runtime geometry maths.

## 6. The grid and rollup

**Store fine, display aggregated.** Every report always attaches to its r12 cell
(~300 m²). Coarser columns exist purely for display rollup. Precision is never lost.

Zoom → resolution:

| Map zoom | H3 resolution | What the user sees |
|---|---|---|
| ≤ 3 | r1 | World view, broad coloured regions |
| 4–6 | r3 | Country / state scale |
| 7–9 | r5 | Metro scale |
| 10–12 | r7 | District scale |
| 13–14 | r9 | Neighbourhood scale |
| ≥ 15 | — | Individual pins; reporting unlocks here |

Rollup is a single Postgres RPC taking a bounding box and a resolution, returning
`(cell, weight, report_count, open_count)` grouped on the matching column. Only
`status = 'open'` and `moderation_status = 'approved'` rows contribute weight.

**Interaction by zoom:** coarse cells are view-only summaries — report count and
recent activity, inviting a drill-in. Submission is gated to zoom ≥ 15 (D7).

## 7. Colour

Weight per cell comes from D5. The client ranks the cells currently on screen by
percentile, giving each a `t` in `[0, 1]`, then interpolates a colour in **OKLCH**.

- **OKLCH, not sRGB.** sRGB interpolation produces muddy, dark midpoints. OKLCH is
  perceptually uniform, so the ramp reads as evenly spaced.
- **Four stops: white → yellow → orange → red.** Four rather than two keeps the
  build gradual — the first third of the range stays white through pale yellow
  before any orange appears, so red is reserved for areas many people have
  confirmed.
- **Lightness falls and chroma rises monotonically** along the ramp, so the map
  still reads in greyscale and under colour-vision deficiency.
- **Fill opacity rises with severity too**, from 0.12 to 0.70. A flat white wash
  over every quiet area would fog the whole basemap; fading the clean end out
  means a clean area simply shows the map underneath — which is what clean should
  look like.
- **Fill only, no strokes.** Adjacent cells bleed into each other instead of
  tiling into a hard-edged mosaic.
- **Cross-fade on resolution change.** When zoom crosses a boundary in the table
  above, the old and new cell layers cross-fade rather than snapping.
- Percentile is computed against the on-screen set, so a quiet suburb still shows
  internal variation instead of rendering uniformly cold.

## 8. Moderation

Four tiers, cheapest first. Each tier only sees what the previous tier could not
decide. Every tier is independently replaceable.

| Tier | Text | Image | Runs |
|---|---|---|---|
| 1. Instant gate | `obscenity` (leetspeak-aware slur/profanity match) | `nsfwjs` (TF.js) | User's browser |
| 2. Classifier | **Detoxify** — toxicity / insult / threat / identity-hate scores | **Falconsai/nsfw_image_detection** (ViT) or **NudeNet** | Worker, CPU |
| 3. Judgment | **Qwen3 8B** or **Llama Guard 3** | **Qwen3-VL** or **ShieldGemma 2** | Worker, GPU |
| 4. Human | Admin queue | Admin queue | Admin UI |

**Tier 3 is not redundant with tier 2.** Tier 2 classifiers are trained on generic
toxicity and nudity. They score "this neighbourhood is a slum" as perfectly clean.
Only an LLM handed MO's own tone rubric (§2) catches a house-rule violation, and it
only ever sees the ambiguous middle band.

### Keeping human review rare (D12)

Auto-decide the confident ends. Only the narrow middle reaches a person.

| Signal | Auto-reject | Auto-approve | Reaches a human |
|---|---|---|---|
| Tier 2 NSFW score | > 0.85 | < 0.15 | the 0.15–0.85 band |
| Tier 2 Detoxify max score | > 0.80 | < 0.20 | the 0.20–0.80 band |
| Tier 3 LLM verdict | confident unsafe | confident safe | explicit "uncertain" only |

Every threshold is an env var, so a noisy queue is fixed by widening the auto bands,
not by editing code. Community-flagged items always reach a human regardless of
score — but those are user-initiated and rare by nature.

### CSAM

Any app accepting public photo uploads has legal exposure to child sexual abuse
material. This is a reporting obligation, not a moderation preference, and none of
the four tiers address it.

**Vercel has no image content moderation product.** Image Optimization, Blob, the WAF
and bot management all concern delivery and traffic; none inspect image content. The
zero-budget path is **Cloudflare's CSAM Scanning Tool**, which is enabled per-zone and
scans images served through Cloudflare's proxy.

It does not require the whole app to be on Cloudflare — only the hostname serving the
images. Since photo bytes live in R2 behind a Cloudflare-proxied hostname (D11), this
is satisfied by the storage design, and the app stays on Vercel. Ships in Phase 1.

### Flow

```
submit → tier 1 in browser → hard block, never uploads
              ↓ passes
       row saved, moderation_status = 'pending', moderation_jobs row created
              ↓
       worker polls (outbound HTTPS only) → tier 2 → confident? approve / reject
              ↓ ambiguous
       tier 3 with MO tone rubric → confident? approve / reject
              ↓ still ambiguous
       tier 4 admin queue
```

**Visibility while pending:** the report itself — pin, location, note — goes live
immediately, so the map stays live. The *photo* renders blurred behind a "not
reviewed yet" veil until approved. This bounds exposure without freezing the map
behind the admin's availability.

### Swappability (D9)

The queue table is the seam. The app writes jobs and never learns what drains them.
Ollama, LM Studio, vLLM, llama.cpp and the commercial providers all expose the same
OpenAI-compatible `/v1/chat/completions`, so a single HTTP adapter covers every host.

```
MODERATION_ENDPOINT=http://192.168.1.40:11434/v1    # PC
MODERATION_ENDPOINT=http://homeserver.lan:8000/v1   # local server
MODERATION_ENDPOINT=https://api.openai.com/v1       # cloud
```

**Which model** is likewise just config, so changing model and changing machine are
the same two-variable edit and neither touches code:

```
MODERATION_TEXT_MODEL=qwen3:8b
MODERATION_VISION_MODEL=qwen2.5vl:7b
```

No specific model is a design commitment. The tiers are defined by *role* — instant
gate, classifier, judgment, human — and any model filling a role can be swapped for
another by name.

The worker needs only **outbound** HTTPS to Supabase — no port forwarding, no tunnel,
no static IP. Relocating it is: copy folder, edit `.env`, run.

Config surface: `MODERATION_ENDPOINT`, `MODERATION_TEXT_MODEL`,
`MODERATION_VISION_MODEL`, per-tier confidence thresholds, and `SUPABASE_SERVICE_ROLE_KEY`.

Model sizing for whichever host wins: Qwen3 8B Q4 ≈ 5–6 GB VRAM; Qwen2.5-VL 7B Q4
≈ 6–7 GB. 8 GB runs either; 12 GB holds both resident. Tier 2 needs no GPU at all.

## 9. Search, filter, navigation

- **Search:** Nominatim geocoding — street, monument, park, landmark, neighbourhood.
  Map flies to the result. Debounced.
- **Filter:** status (reported / cleaned), date range, distance-from-me,
  minimum confirmations. Search takes you *to* a place; filters decide *what you
  see* there.
- **Near me:** browser geolocation, with permission, to centre the map and power
  distance sorting.

## 10. Key flows

**Report.** Zoom to ≥ 15 → drop or auto-capture pin → add photo (required) → note
(optional) → tier 1 runs in browser → submit → pin appears immediately, photo
pending review.

**Vote.** Open a report → one tap to confirm. Unique per user per report. Increments
cell weight, so the map warms.

**Mark cleaned.** Any signed-in user → confirm → status flips to `cleaned` → the pin
plays the scrub animation, dirty wiped to sparkle → cell weight drops, so the map
visibly cools. This is the emotional payoff and the screenshot moment. Pure motion,
zero words.

## 11. Security and abuse

- RLS on every table. Reports, votes and comments are insertable only by
  authenticated users; updatable only by owner or admin.
- Votes: unique `(report_id, user_id)` — the core anti-stuffing control.
- Rate limits: reports per user per hour, comments per user per minute.
- Service-role key lives only in the worker's environment, never in the frontend.
- Tier 1 runs in the browser and is therefore **a UX filter, not a security
  control** — it can be bypassed by calling the API directly. Tiers 2–4 are the
  actual enforcement, which is why nothing is trusted as approved until the worker
  has ruled.

## 12. Testing

- Unit: zoom→resolution mapping, H3 column derivation, severity weight maths,
  OKLCH ramp output.
- Integration: RLS policies (can an anonymous user insert? can user A delete user
  B's report?), rollup RPC correctness at each resolution.
- Worker: tier routing with fixture content — clean, obviously bad, and ambiguous
  — asserting each lands in the right tier and the right verdict.

## 13. Explicitly not in Phase 1

Community-drawn regions, cleanup events, RSVP, volunteer profiles, incentives,
activity feeds, leaderboards, badges, area health-over-time, before/after cards,
Photon autocomplete, self-hosted Nominatim.

## 14. Resolved since first draft

1. **Model choice is deliberately not decided.** Model and host are both env vars
   (§8). Tier 3 can start on whatever machine is available and move later.
2. **Pending photos are blurred, not hidden** — with D12 thresholds keeping the
   human queue small and D13 keeping it fail-closed.
3. **App stays on Vercel.** CSAM scanning is satisfied by putting only the photo
   hostname on Cloudflare (D11), not the whole site.

## 15. Open questions

1. Free-tier figures for Supabase Storage (~1 GB) and R2 (~10 GB, zero egress)
   should be verified against current pricing before the storage split is built on
   them.
2. Photo retention: do photos for a report survive indefinitely after it is marked
   cleaned, or expire? Affects whether the R2 ceiling is ever reached.
3. Admin bootstrap: how does the first admin get the `admin` role? Manual DB update
   is acceptable for Phase 1 but should be written down.
