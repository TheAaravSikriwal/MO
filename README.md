# MO

A community pollution map. People report litter with a photo and a precise
location, other people confirm those reports, and the map shows where litter has
been reported — from street level out to a world view. When a spot gets cleaned
up, the map visibly improves.

## Status

Milestone A of Phase 1 is built: the map engine. It runs with no accounts, no
API keys and no database.

| Milestone | Contents | State |
|---|---|---|
| **A — map engine** | H3 grid, derived severity, colour ramp, map, place search | **Built** |
| B — data & social | Supabase schema, auth, reports, photos, votes, comments | Not started |
| C — moderation | Four-tier pipeline, worker, admin queue | Not started |

## Getting started

```bash
npm install
npm run dev
```

Open the printed URL. You get a world map you can zoom and search. There is no
report data yet — that arrives in Milestone B.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Typecheck, then build for production |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Typecheck without building |

## Environment variables

None. Milestone A deliberately requires no configuration, no accounts and no
secrets. Milestone B introduces Supabase and Cloudflare R2 credentials, and will
ship an `.env.example` alongside them.

## How the map works

**One report, nine cells.** Every report is stored against its H3 cell at
resolution 12 — roughly a 300 m² patch of ground. Eight coarser ancestor cells are
stored alongside it, one for each step of zoom from the globe to city level, so
hexagons shrink steadily as you zoom in. Zooming out swaps which cell the map groups by, so a
world view is a plain `GROUP BY` over data that was never stored coarsely.
Precision is never lost, and the app works anywhere on Earth with no region data
to set up.

**Severity is derived, never chosen.** Nobody picks "high" or "low". An area's
colour comes from how many distinct people have flagged it: each open report
contributes `1 + its vote count`. Marking a report cleaned removes it from the
total, so cleaning up an area visibly cools its colour. That is the whole point.

**Colour is relative, not absolute.** Cells are ranked against the others
currently on screen rather than against fixed thresholds, so a dense city does
not saturate to one colour and a quiet area still shows its own variation.

**The ramp runs white to red, and builds slowly.** White is the resting state:
an area with nothing reported reads as clean, and the map only gains colour as
people flag it. The first third of the scale stays white through pale yellow
before any orange appears, so red is reserved for places many people have
confirmed. Opacity fades out at the clean end too, so quiet areas show the map
underneath rather than washing it out. Lightness and saturation both change
along the ramp, so it survives greyscale and colour-vision deficiency.

## Language

The interface uses plain words. A report is a "report", a cleanup is a "cleanup",
cleaned is "cleaned" — no jargon, and nothing that assumes a shared reference.
Copy describes the litter, never the place or the people who live there.

## Architecture

| Path | Responsibility |
|---|---|
| `src/lib/grid/zoomResolution.ts` | Map zoom → H3 resolution, or pin mode |
| `src/lib/grid/cells.ts` | Coordinates → the nine stored cells; a cell's stored column |
| `src/lib/severity/weight.ts` | Aggregate reports into weighted cells |
| `src/lib/severity/percentile.ts` | Rank weights onto a relative 0–1 scale |
| `src/lib/color/ramp.ts` | Position on the scale → colour |
| `src/lib/geo/nominatim.ts` | Debounced place search |
| `src/components/map/GlobeMap.tsx` | The MapLibre globe; the only file that mounts a map or names its basemap |
| `src/lib/map/` | What the globe draws: tower and dot shapes, fades, zoom numbers |
| `src/components/map/CellCatalog.tsx` | The list of reports behind a tower |
| `src/lib/worlddata/` | Air, ocean plastic, fires, quality of life and water quality: sources, saved copies, loading; and the findings' statistics |
| `src/components/findings/FindingsPanel.tsx` | The Findings tab: how quality of life, wealth and the environment go together |

Everything in `src/lib` is a pure function with no network or framework
dependency, which is why the engine is testable without a browser or a database.

## Documentation

- Design spec: `docs/superpowers/specs/2026-08-31-mo-phase1-design.md`
- Milestone A plan: `docs/superpowers/plans/2026-08-31-mo-milestone-a-map-engine.md`

## Built with

React, Vite, TypeScript, Tailwind, MapLibre GL with OpenFreeMap tiles, `h3-js`,
`culori`, and Nominatim for search. World data from the WHO and Meijer et al.
via Our World in Data, NASA FIRMS, and Natural Earth. Tests run on Vitest.

Map data © OpenStreetMap contributors, © OpenMapTiles.
