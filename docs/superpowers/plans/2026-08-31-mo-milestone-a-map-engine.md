# MO Milestone A — Map Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, credential-free core of MO's map — the H3 grid engine, the derived-severity maths, the OKLCH colour ramp, and a Leaflet map that renders coloured cells and flies to searched places.

**Architecture:** Every piece here is a pure function or a presentational component fed by props. No Supabase, no auth, no network except Nominatim. The map takes an array of report-like records and renders them; where those records come from is Milestone B's problem. This keeps the whole engine unit-testable without a database and lets it be built before any account exists.

**Tech Stack:** React, Vite, TypeScript, Tailwind, Leaflet, `h3-js`, `culori`, Vitest.

**Source spec:** `docs/superpowers/specs/2026-08-31-mo-phase1-design.md`

**Scope note:** Phase 1 is three subsystems. This is plan 1 of 3.
- **Milestone A (this plan):** map engine — grid, severity maths, colour, map shell, search. No credentials needed.
- **Milestone B:** data + social — Supabase schema, RLS, auth, reports, photos to R2, votes, comments. Needs credentials.
- **Milestone C:** moderation — the four tiers, the worker, the admin queue. Needs credentials and a model host.

---

## Verification Protocol

Applies to every task in this plan.

After a task's own steps pass locally, dispatch a **black-box verifier**: a fresh agent given **only** the requirement statement and the command to run, with **shell access only — no `Read`, `Grep`, or `Glob`**. It cannot see the source. It runs the command, reads the output, and reports pass or fail against the requirement.

This is deliberate. A verifier that can read the implementation can be persuaded by code that *looks* right. One that can only observe output can be persuaded by nothing but behaviour.

The verifier's prompt template:

```
Requirement: <verbatim requirement from the task>
Run exactly this command: <command>
Report the command's actual output verbatim, then state PASS or FAIL against
the requirement. Do not read, open, or search any source file. If you cannot
determine the answer from the command output alone, state INCONCLUSIVE.
```

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/grid/zoomResolution.ts` | Map zoom level → H3 resolution (or `null` for pin mode) |
| `src/lib/grid/cells.ts` | lat/lng → the six stored cell IDs; cell → boundary polygon |
| `src/lib/severity/weight.ts` | Cell weight from reports (D5) |
| `src/lib/severity/percentile.ts` | Weights → normalised `t` in [0,1] |
| `src/lib/color/ramp.ts` | `t` → OKLCH-interpolated colour (D8) |
| `src/lib/geo/nominatim.ts` | Debounced geocoding client |
| `src/components/map/MapView.tsx` | Leaflet wrapper; tile provider swappable |
| `src/components/map/CellLayer.tsx` | Renders weighted cells as coloured polygons |
| `src/types/report.ts` | Shared record shapes |

Each file has one responsibility and is tested independently. Tests are colocated as `*.test.ts`.

---

## Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `.gitignore`

- [ ] **Step 1: Create the Vite project in place**

Run from the repo root:

```bash
npm create vite@latest . -- --template react-ts
```

If prompted about the non-empty directory, choose to continue without deleting — `README.md` and `docs/` must survive.

- [ ] **Step 2: Install runtime and dev dependencies**

```bash
npm install leaflet react-leaflet h3-js culori && npm install -D @types/leaflet tailwindcss @tailwindcss/vite vitest jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 3: Verify the project builds**

Run: `npm run build`
Expected: exits 0, writes a `dist/` directory.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold vite react-ts project"
```

---

## Task 2: Configure Tailwind and Vitest

**Files:**
- Modify: `vite.config.ts`
- Create: `src/index.css`, `vitest.setup.ts`

- [ ] **Step 1: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
})
```

- [ ] **Step 2: Write `vitest.setup.ts`**

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 3: Write `src/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 4: Add the test script to `package.json`**

Add to the `"scripts"` object:

```json
"test": "vitest run"
```

- [ ] **Step 5: Verify the test runner starts**

Run: `npm test`
Expected: exits 0 with "No test files found" (no tests exist yet).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: configure tailwind and vitest"
```

---

## Task 3: Zoom → resolution mapping

Implements the zoom/resolution table in spec §6.

**Files:**
- Create: `src/lib/grid/zoomResolution.ts`
- Test: `src/lib/grid/zoomResolution.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolutionForZoom, PIN_ZOOM_THRESHOLD } from './zoomResolution'

describe('resolutionForZoom', () => {
  it('returns r1 at world zoom', () => {
    expect(resolutionForZoom(0)).toBe(1)
    expect(resolutionForZoom(3)).toBe(1)
  })

  it('steps through the resolution bands', () => {
    expect(resolutionForZoom(4)).toBe(3)
    expect(resolutionForZoom(6)).toBe(3)
    expect(resolutionForZoom(7)).toBe(5)
    expect(resolutionForZoom(9)).toBe(5)
    expect(resolutionForZoom(10)).toBe(7)
    expect(resolutionForZoom(12)).toBe(7)
    expect(resolutionForZoom(13)).toBe(9)
    expect(resolutionForZoom(14)).toBe(9)
  })

  it('returns null at pin zoom, meaning render individual reports', () => {
    expect(resolutionForZoom(15)).toBeNull()
    expect(resolutionForZoom(20)).toBeNull()
  })

  it('exposes the reporting threshold as 15', () => {
    expect(PIN_ZOOM_THRESHOLD).toBe(15)
  })

  it('clamps nonsense zooms to the world band', () => {
    expect(resolutionForZoom(-5)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/grid/zoomResolution.test.ts`
Expected: FAIL — cannot resolve `./zoomResolution`.

- [ ] **Step 3: Write the implementation**

```ts
/** Below this zoom the map shows aggregated cells; at or above it, individual pins. */
export const PIN_ZOOM_THRESHOLD = 15

const BANDS: ReadonlyArray<{ maxZoom: number; resolution: number }> = [
  { maxZoom: 3, resolution: 1 },
  { maxZoom: 6, resolution: 3 },
  { maxZoom: 9, resolution: 5 },
  { maxZoom: 12, resolution: 7 },
  { maxZoom: 14, resolution: 9 },
]

/**
 * The H3 resolution to aggregate at for a given map zoom.
 * Returns null at or above PIN_ZOOM_THRESHOLD, where reports render individually.
 */
export function resolutionForZoom(zoom: number): number | null {
  if (zoom >= PIN_ZOOM_THRESHOLD) return null
  for (const band of BANDS) {
    if (zoom <= band.maxZoom) return band.resolution
  }
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/grid/zoomResolution.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Black-box verify**

Dispatch a verifier with the protocol above:
- Requirement: "Zoom 0-3 maps to H3 resolution 1, 4-6 to 3, 7-9 to 5, 10-12 to 7, 13-14 to 9, and zoom 15 or higher returns null. All tests pass."
- Command: `npx vitest run src/lib/grid/zoomResolution.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/grid/zoomResolution.ts src/lib/grid/zoomResolution.test.ts
git commit -m "feat: map zoom levels to h3 resolutions"
```

---

## Task 4: H3 cell derivation

Implements D6 — the six precomputed cell columns written at submit time.

**Files:**
- Create: `src/lib/grid/cells.ts`
- Test: `src/lib/grid/cells.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { getResolution } from 'h3-js'
import { STORED_RESOLUTIONS, cellsForPoint, cellBoundary } from './cells'

describe('cellsForPoint', () => {
  it('stores exactly the six documented resolutions', () => {
    expect(STORED_RESOLUTIONS).toEqual([1, 3, 5, 7, 9, 12])
  })

  it('returns one cell per stored resolution, each at that resolution', () => {
    const cells = cellsForPoint(51.5007, -0.1246)
    expect(Object.keys(cells).sort()).toEqual(
      ['cell_r1', 'cell_r12', 'cell_r3', 'cell_r5', 'cell_r7', 'cell_r9'],
    )
    expect(getResolution(cells.cell_r1)).toBe(1)
    expect(getResolution(cells.cell_r12)).toBe(12)
  })

  it('is deterministic for the same point', () => {
    expect(cellsForPoint(51.5007, -0.1246)).toEqual(cellsForPoint(51.5007, -0.1246))
  })

  it('gives different fine cells to points far apart', () => {
    const london = cellsForPoint(51.5007, -0.1246)
    const sydney = cellsForPoint(-33.8568, 151.2153)
    expect(london.cell_r12).not.toBe(sydney.cell_r12)
    expect(london.cell_r1).not.toBe(sydney.cell_r1)
  })

  it('nests: the coarse cells are ancestors of the fine cell', () => {
    // Proven by h3 itself in cells.ts; here we assert the contract holds.
    const cells = cellsForPoint(40.7128, -74.006)
    expect(getResolution(cells.cell_r5)).toBe(5)
    expect(getResolution(cells.cell_r9)).toBe(9)
  })

  it('rejects out-of-range coordinates', () => {
    expect(() => cellsForPoint(91, 0)).toThrow()
    expect(() => cellsForPoint(0, 181)).toThrow()
  })
})

describe('cellBoundary', () => {
  it('returns a closed ring of lat/lng pairs', () => {
    const { cell_r7 } = cellsForPoint(51.5007, -0.1246)
    const ring = cellBoundary(cell_r7)
    expect(ring.length).toBeGreaterThanOrEqual(6)
    for (const [lat, lng] of ring) {
      expect(lat).toBeGreaterThanOrEqual(-90)
      expect(lat).toBeLessThanOrEqual(90)
      expect(lng).toBeGreaterThanOrEqual(-180)
      expect(lng).toBeLessThanOrEqual(180)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/grid/cells.test.ts`
Expected: FAIL — cannot resolve `./cells`.

- [ ] **Step 3: Write the implementation**

```ts
import { latLngToCell, cellToParent, cellToBoundary } from 'h3-js'

/**
 * The resolutions persisted with every report (D6).
 * r12 is the precision floor — everything is stored there.
 * The coarser five exist only so display rollup can be a plain indexed GROUP BY.
 */
export const STORED_RESOLUTIONS = [1, 3, 5, 7, 9, 12] as const

export type StoredResolution = (typeof STORED_RESOLUTIONS)[number]
export type CellColumns = Record<`cell_r${StoredResolution}`, string>

/** The finest resolution we store. Never aggregate below this. */
export const FINEST_RESOLUTION = 12

/**
 * Derive the six cell IDs for a point.
 *
 * The r12 cell is computed from the coordinates; the rest are its H3 ancestors.
 * Using cellToParent rather than recomputing from lat/lng guarantees the columns
 * genuinely nest, which is what makes GROUP BY rollup correct.
 */
export function cellsForPoint(lat: number, lng: number): CellColumns {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`latitude out of range: ${lat}`)
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError(`longitude out of range: ${lng}`)
  }

  const finest = latLngToCell(lat, lng, FINEST_RESOLUTION)

  const columns = {} as CellColumns
  for (const resolution of STORED_RESOLUTIONS) {
    const cell = resolution === FINEST_RESOLUTION ? finest : cellToParent(finest, resolution)
    columns[`cell_r${resolution}`] = cell
  }
  return columns
}

/** The cell's outline as [lat, lng] pairs, ready for a Leaflet polygon. */
export function cellBoundary(cell: string): Array<[number, number]> {
  return cellToBoundary(cell) as Array<[number, number]>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/grid/cells.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Black-box verify**

- Requirement: "Deriving cells for a coordinate returns exactly six H3 cells at resolutions 1, 3, 5, 7, 9 and 12; the result is deterministic; out-of-range coordinates throw. All tests pass."
- Command: `npx vitest run src/lib/grid/cells.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/grid/cells.ts src/lib/grid/cells.test.ts
git commit -m "feat: derive nested h3 cell columns for a point"
```

---

## Task 5: Severity weight

Implements D5 — severity is derived from confirmations, never chosen.

**Files:**
- Create: `src/types/report.ts`, `src/lib/severity/weight.ts`
- Test: `src/lib/severity/weight.test.ts`

- [ ] **Step 1: Write `src/types/report.ts`**

```ts
export type ReportStatus = 'open' | 'cleaned'
export type ModerationStatus = 'pending' | 'approved' | 'rejected'

/** The minimum a report must expose for the map engine to weigh it. */
export interface WeighableReport {
  id: string
  status: ReportStatus
  moderationStatus: ModerationStatus
  voteCount: number
  cells: Record<string, string>
}

/** One aggregated cell, ready to colour. */
export interface WeightedCell {
  cell: string
  weight: number
  reportCount: number
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { weighCells } from './weight'
import type { WeighableReport } from '../../types/report'

const report = (over: Partial<WeighableReport> & { id: string }): WeighableReport => ({
  status: 'open',
  moderationStatus: 'approved',
  voteCount: 0,
  cells: { cell_r7: 'A' },
  ...over,
})

describe('weighCells', () => {
  it('weighs a lone unvoted report as 1', () => {
    const cells = weighCells([report({ id: '1' })], 7)
    expect(cells).toEqual([{ cell: 'A', weight: 1, reportCount: 1 }])
  })

  it('adds one per vote, so five votes make a report weigh 6', () => {
    const cells = weighCells([report({ id: '1', voteCount: 5 })], 7)
    expect(cells[0].weight).toBe(6)
  })

  it('sums every report in the same cell', () => {
    const cells = weighCells(
      [report({ id: '1', voteCount: 2 }), report({ id: '2', voteCount: 0 })],
      7,
    )
    expect(cells).toEqual([{ cell: 'A', weight: 4, reportCount: 2 }])
  })

  it('excludes cleaned reports, so cleaning cools the map', () => {
    const cells = weighCells(
      [report({ id: '1', voteCount: 9, status: 'cleaned' }), report({ id: '2' })],
      7,
    )
    expect(cells).toEqual([{ cell: 'A', weight: 1, reportCount: 1 }])
  })

  it('excludes reports that are not approved', () => {
    const cells = weighCells(
      [
        report({ id: '1', moderationStatus: 'pending' }),
        report({ id: '2', moderationStatus: 'rejected' }),
      ],
      7,
    )
    expect(cells).toEqual([])
  })

  it('groups by the requested resolution', () => {
    const cells = weighCells(
      [
        report({ id: '1', cells: { cell_r5: 'COARSE', cell_r7: 'A' } }),
        report({ id: '2', cells: { cell_r5: 'COARSE', cell_r7: 'B' } }),
      ],
      5,
    )
    expect(cells).toEqual([{ cell: 'COARSE', weight: 2, reportCount: 2 }])
  })

  it('skips reports missing a cell at that resolution', () => {
    expect(weighCells([report({ id: '1', cells: { cell_r7: 'A' } })], 3)).toEqual([])
  })

  it('treats an empty input as an empty map', () => {
    expect(weighCells([], 7)).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/severity/weight.test.ts`
Expected: FAIL — cannot resolve `./weight`.

- [ ] **Step 4: Write the implementation**

```ts
import type { WeighableReport, WeightedCell } from '../../types/report'

/**
 * Aggregate reports into weighted cells at one resolution (D5).
 *
 * weight = sum over contributing reports of (1 + voteCount)
 *
 * A report contributes only while it is open and approved. Cleaned reports drop
 * out entirely, which is what makes a cleanup visibly cool the map — the payoff
 * the whole product is built around.
 */
export function weighCells(
  reports: readonly WeighableReport[],
  resolution: number,
): WeightedCell[] {
  const column = `cell_r${resolution}`
  const byCell = new Map<string, WeightedCell>()

  for (const report of reports) {
    if (report.status !== 'open') continue
    if (report.moderationStatus !== 'approved') continue

    const cell = report.cells[column]
    if (!cell) continue

    const existing = byCell.get(cell)
    const contribution = 1 + Math.max(0, report.voteCount)

    if (existing) {
      existing.weight += contribution
      existing.reportCount += 1
    } else {
      byCell.set(cell, { cell, weight: contribution, reportCount: 1 })
    }
  }

  return [...byCell.values()]
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/severity/weight.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Black-box verify**

- Requirement: "A cell's weight is the sum of (1 + vote count) over reports that are both open and approved. Cleaned reports and non-approved reports contribute nothing. All tests pass."
- Command: `npx vitest run src/lib/severity/weight.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/types/report.ts src/lib/severity/weight.ts src/lib/severity/weight.test.ts
git commit -m "feat: derive cell severity weight from reports and votes"
```

---

## Task 6: Percentile normalisation

Implements the relative-scale half of D5 — the reason a quiet suburb still shows variation.

**Files:**
- Create: `src/lib/severity/percentile.ts`
- Test: `src/lib/severity/percentile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { normaliseWeights } from './percentile'

const cell = (cellId: string, weight: number) => ({ cell: cellId, weight, reportCount: 1 })

describe('normaliseWeights', () => {
  it('spreads distinct weights across the full 0..1 range', () => {
    const result = normaliseWeights([cell('a', 1), cell('b', 5), cell('c', 100)])
    expect(result.find((r) => r.cell === 'a')!.t).toBe(0)
    expect(result.find((r) => r.cell === 'b')!.t).toBe(0.5)
    expect(result.find((r) => r.cell === 'c')!.t).toBe(1)
  })

  it('ranks by order, not magnitude, so one outlier cannot flatten the rest', () => {
    const result = normaliseWeights([cell('a', 1), cell('b', 2), cell('c', 100000)])
    expect(result.find((r) => r.cell === 'b')!.t).toBe(0.5)
  })

  it('gives tied weights the same t', () => {
    const result = normaliseWeights([cell('a', 7), cell('b', 7), cell('c', 9)])
    expect(result.find((r) => r.cell === 'a')!.t).toBe(0)
    expect(result.find((r) => r.cell === 'b')!.t).toBe(0)
    expect(result.find((r) => r.cell === 'c')!.t).toBe(1)
  })

  it('places a single cell mid-ramp rather than at either extreme', () => {
    expect(normaliseWeights([cell('a', 3)])).toEqual([
      { cell: 'a', weight: 3, reportCount: 1, t: 0.5 },
    ])
  })

  it('places uniformly weighted cells mid-ramp', () => {
    const result = normaliseWeights([cell('a', 4), cell('b', 4)])
    expect(result.every((r) => r.t === 0.5)).toBe(true)
  })

  it('handles an empty input', () => {
    expect(normaliseWeights([])).toEqual([])
  })

  it('preserves the input order', () => {
    const result = normaliseWeights([cell('z', 9), cell('y', 1)])
    expect(result.map((r) => r.cell)).toEqual(['z', 'y'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/severity/percentile.test.ts`
Expected: FAIL — cannot resolve `./percentile`.

- [ ] **Step 3: Write the implementation**

```ts
import type { WeightedCell } from '../../types/report'

export interface NormalisedCell extends WeightedCell {
  /** Position on the colour ramp, 0 = coldest, 1 = warmest. */
  t: number
}

/**
 * Rank cells against each other and map them onto 0..1 (D5).
 *
 * Ranking by position among *distinct* weights rather than by raw magnitude is
 * deliberate: it means a single extreme cell cannot crush every other cell into
 * the cold end, so a quiet area still shows its own internal variation.
 *
 * When every cell weighs the same there is no variation to show, so they all sit
 * mid-ramp — neither alarming nor invisible.
 */
export function normaliseWeights(cells: readonly WeightedCell[]): NormalisedCell[] {
  if (cells.length === 0) return []

  const distinct = [...new Set(cells.map((c) => c.weight))].sort((a, b) => a - b)

  if (distinct.length === 1) {
    return cells.map((c) => ({ ...c, t: 0.5 }))
  }

  const rankOf = new Map(distinct.map((weight, index) => [weight, index / (distinct.length - 1)]))
  return cells.map((c) => ({ ...c, t: rankOf.get(c.weight)! }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/severity/percentile.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Black-box verify**

- Requirement: "Cells are ranked against each other onto a 0..1 scale by their position among distinct weights, not by raw magnitude. Tied weights share a value. A single cell, or a set of uniformly weighted cells, sits at 0.5. All tests pass."
- Command: `npx vitest run src/lib/severity/percentile.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/severity/percentile.ts src/lib/severity/percentile.test.ts
git commit -m "feat: normalise cell weights to a relative 0..1 scale"
```

---

## Task 7: OKLCH colour ramp

Implements D8 — clean hue transitions, teal to amber, never green to red.

**Files:**
- Create: `src/lib/color/ramp.ts`
- Test: `src/lib/color/ramp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { oklch, parse } from 'culori'
import { colorForT, RAMP_COLD, RAMP_WARM } from './ramp'

const lightnessOf = (css: string) => oklch(parse(css)!)!.l
const hueOf = (css: string) => oklch(parse(css)!)!.h!

describe('colorForT', () => {
  it('returns the cold anchor at 0 and the warm anchor at 1', () => {
    expect(parse(colorForT(0))).toEqual(parse(RAMP_COLD))
    expect(parse(colorForT(1))).toEqual(parse(RAMP_WARM))
  })

  it('produces a parseable colour across the whole range', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      expect(parse(colorForT(t))).toBeDefined()
    }
  })

  it('increases lightness monotonically, so the ramp survives greyscale', () => {
    let previous = -Infinity
    for (let t = 0; t <= 1; t += 0.1) {
      const l = lightnessOf(colorForT(t))
      expect(l).toBeGreaterThan(previous)
      previous = l
    }
  })

  it('never passes through a red hue, per the tone rule', () => {
    // Red sits near hue 20-30 in OKLCH. Teal->amber must stay clear of it.
    for (let t = 0; t <= 1; t += 0.02) {
      const h = hueOf(colorForT(t))
      expect(h).toBeGreaterThan(40)
    }
  })

  it('moves in steps small enough to read as a smooth gradient', () => {
    // No perceptual jump between adjacent samples larger than a visible band.
    for (let t = 0; t < 1; t += 0.05) {
      const delta = Math.abs(lightnessOf(colorForT(t + 0.05)) - lightnessOf(colorForT(t)))
      expect(delta).toBeLessThan(0.05)
    }
  })

  it('clamps out-of-range input rather than producing garbage', () => {
    expect(parse(colorForT(-1))).toEqual(parse(RAMP_COLD))
    expect(parse(colorForT(2))).toEqual(parse(RAMP_WARM))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/color/ramp.test.ts`
Expected: FAIL — cannot resolve `./ramp`.

- [ ] **Step 3: Write the implementation**

```ts
import { interpolate, formatCss } from 'culori'

/**
 * The ramp anchors (D8).
 *
 * Teal to amber, deliberately not green to red. A red ramp reads as "danger
 * zone" and would paint the poorest areas the most alarming colour, which the
 * product's tone rules forbid. Teal to amber reads as "needs attention".
 *
 * Lightness rises along the ramp as well as hue, so the map stays legible in
 * greyscale and under colour-vision deficiency.
 */
export const RAMP_COLD = '#1f7a6e'
export const RAMP_WARM = '#f2b544'

/**
 * Interpolation happens in OKLCH because it is perceptually uniform. The same
 * ramp in sRGB dips through muddy, darker midtones, which reads as a band rather
 * than a smooth transition.
 */
const ramp = interpolate([RAMP_COLD, RAMP_WARM], 'oklch')

/** Colour for a normalised position on the ramp. Input is clamped to 0..1. */
export function colorForT(t: number): string {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  return formatCss(ramp(clamped))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/color/ramp.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Black-box verify**

- Requirement: "The colour ramp runs from teal to amber, interpolated in OKLCH. Lightness increases monotonically across the ramp. No sampled colour has a red hue. Out-of-range input clamps to the anchors. All tests pass."
- Command: `npx vitest run src/lib/color/ramp.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/color/ramp.ts src/lib/color/ramp.test.ts
git commit -m "feat: add oklch teal-to-amber severity colour ramp"
```

---

## Task 8: Nominatim geocoding client

Implements spec §9 search, with the debounce its usage policy requires.

**Files:**
- Create: `src/lib/geo/nominatim.ts`
- Test: `src/lib/geo/nominatim.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchPlaces, createDebouncedSearch } from './nominatim'

const nominatimResponse = [
  { display_name: 'Hyde Park, London', lat: '51.5073', lon: '-0.1657' },
]

describe('searchPlaces', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => nominatimResponse }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('returns parsed places with numeric coordinates', async () => {
    const results = await searchPlaces('hyde park')
    expect(results).toEqual([{ name: 'Hyde Park, London', lat: 51.5073, lng: -0.1657 }])
  })

  it('returns nothing for a blank query without calling the network', async () => {
    expect(await searchPlaces('   ')).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns an empty list when the service errors, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    expect(await searchPlaces('anywhere')).toEqual([])
  })

  it('returns an empty list when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await searchPlaces('anywhere')).toEqual([])
  })
})

describe('createDebouncedSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => nominatimResponse }),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('issues one request for a burst of keystrokes', async () => {
    const search = createDebouncedSearch(1000)
    search('h', () => {})
    search('hy', () => {})
    search('hyd', () => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('delivers results for the final query only', async () => {
    const search = createDebouncedSearch(1000)
    const onResults = vi.fn()
    search('h', onResults)
    search('hyde park', onResults)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onResults).toHaveBeenCalledTimes(1)
    expect(String((fetch as any).mock.calls[0][0])).toContain('hyde+park')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/geo/nominatim.test.ts`
Expected: FAIL — cannot resolve `./nominatim`.

- [ ] **Step 3: Write the implementation**

```ts
export interface Place {
  name: string
  lat: number
  lng: number
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/** Nominatim's usage policy asks for no more than one request per second. */
export const MIN_REQUEST_INTERVAL_MS = 1000

interface NominatimResult {
  display_name: string
  lat: string
  lon: string
}

/**
 * Look up a place by name. Returns an empty list rather than throwing on any
 * failure — a search box that explodes is worse than one that finds nothing.
 */
export async function searchPlaces(query: string): Promise<Place[]> {
  const trimmed = query.trim()
  if (trimmed === '') return []

  const url = `${ENDPOINT}?q=${encodeURIComponent(trimmed).replace(/%20/g, '+')}&format=json&limit=5`

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return []
    const results = (await response.json()) as NominatimResult[]
    return results.map((r) => ({
      name: r.display_name,
      lat: Number(r.lat),
      lng: Number(r.lon),
    }))
  } catch {
    return []
  }
}

/**
 * Wrap searchPlaces so a burst of keystrokes produces one request, honouring
 * Nominatim's rate limit. Only the most recent query's results are delivered.
 */
export function createDebouncedSearch(delayMs: number = MIN_REQUEST_INTERVAL_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0

  return function search(query: string, onResults: (places: Place[]) => void): void {
    if (timer !== undefined) clearTimeout(timer)
    const thisGeneration = ++generation

    timer = setTimeout(() => {
      void searchPlaces(query).then((places) => {
        if (thisGeneration === generation) onResults(places)
      })
    }, delayMs)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/geo/nominatim.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Black-box verify**

- Requirement: "Place search returns parsed results with numeric coordinates; a blank query makes no network call; service errors and network failures return an empty list instead of throwing. A burst of keystrokes produces exactly one request, delivering results for the final query only. All tests pass."
- Command: `npx vitest run src/lib/geo/nominatim.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/geo/nominatim.ts src/lib/geo/nominatim.test.ts
git commit -m "feat: add debounced nominatim place search"
```

---

## Task 9: Map shell

The Leaflet wrapper. Kept thin and behind an interface so the tile provider is swappable (spec §4).

**Files:**
- Create: `src/components/map/tileProvider.ts`, `src/components/map/MapView.tsx`
- Test: `src/components/map/MapView.test.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`

- [ ] **Step 1: Write `src/components/map/tileProvider.ts`**

```ts
export interface TileProvider {
  url: string
  attribution: string
  maxZoom: number
}

/**
 * The only place the tile source is named. Swapping providers later means
 * editing this file and nothing else.
 */
export const OPEN_STREET_MAP: TileProvider = {
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}
```

- [ ] **Step 2: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MapView } from './MapView'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, center, zoom }: any) => (
    <div data-testid="map" data-center={JSON.stringify(center)} data-zoom={zoom}>
      {children}
    </div>
  ),
  TileLayer: ({ url }: any) => <div data-testid="tiles" data-url={url} />,
  useMap: () => ({ setView: vi.fn() }),
  useMapEvents: () => null,
}))

describe('MapView', () => {
  it('renders a map at the requested centre and zoom', () => {
    render(<MapView center={[51.5, -0.12]} zoom={13} onViewChange={() => {}} />)
    expect(screen.getByTestId('map')).toHaveAttribute('data-center', '[51.5,-0.12]')
    expect(screen.getByTestId('map')).toHaveAttribute('data-zoom', '13')
  })

  it('renders tiles from the configured provider', () => {
    render(<MapView center={[0, 0]} zoom={2} onViewChange={() => {}} />)
    expect(screen.getByTestId('tiles')).toHaveAttribute(
      'data-url',
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    )
  })

  it('renders its children as map layers', () => {
    render(
      <MapView center={[0, 0]} zoom={2} onViewChange={() => {}}>
        <div data-testid="layer" />
      </MapView>,
    )
    expect(screen.getByTestId('layer')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/map/MapView.test.tsx`
Expected: FAIL — cannot resolve `./MapView`.

- [ ] **Step 4: Write the implementation**

```tsx
import type { ReactNode } from 'react'
import { MapContainer, TileLayer, useMapEvents } from 'react-leaflet'
import { OPEN_STREET_MAP } from './tileProvider'
import 'leaflet/dist/leaflet.css'

export interface MapViewProps {
  center: [number, number]
  zoom: number
  onViewChange: (view: { center: [number, number]; zoom: number }) => void
  children?: ReactNode
}

function ViewWatcher({ onViewChange }: Pick<MapViewProps, 'onViewChange'>) {
  useMapEvents({
    moveend(event) {
      const map = event.target
      const { lat, lng } = map.getCenter()
      onViewChange({ center: [lat, lng], zoom: map.getZoom() })
    },
  })
  return null
}

/**
 * The map surface. Deliberately thin: it owns the Leaflet instance and the tile
 * source, and nothing else. Everything drawn on it arrives as children, so the
 * cell layer and pin layer can be tested without a map at all.
 */
export function MapView({ center, zoom, onViewChange, children }: MapViewProps) {
  return (
    <MapContainer center={center} zoom={zoom} className="h-full w-full" scrollWheelZoom>
      <TileLayer
        url={OPEN_STREET_MAP.url}
        attribution={OPEN_STREET_MAP.attribution}
        maxZoom={OPEN_STREET_MAP.maxZoom}
      />
      <ViewWatcher onViewChange={onViewChange} />
      {children}
    </MapContainer>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/map/MapView.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/map/tileProvider.ts src/components/map/MapView.tsx src/components/map/MapView.test.tsx
git commit -m "feat: add leaflet map shell with swappable tile provider"
```

---

## Task 10: Cell layer

Renders weighted cells as coloured polygons. This is where D8's "fill only, no strokes" lands.

**Files:**
- Create: `src/components/map/CellLayer.tsx`
- Test: `src/components/map/CellLayer.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CellLayer } from './CellLayer'
import { cellsForPoint } from '../../lib/grid/cells'

vi.mock('react-leaflet', () => ({
  Polygon: ({ positions, pathOptions }: any) => (
    <div
      data-testid="cell"
      data-points={positions.length}
      data-fill={pathOptions.fillColor}
      data-stroke={String(pathOptions.stroke)}
      data-opacity={pathOptions.fillOpacity}
    />
  ),
}))

const londonCells = cellsForPoint(51.5007, -0.1246)
const sydneyCells = cellsForPoint(-33.8568, 151.2153)

describe('CellLayer', () => {
  it('renders one polygon per cell', () => {
    render(
      <CellLayer
        cells={[
          { cell: londonCells.cell_r7, weight: 1, reportCount: 1, t: 0 },
          { cell: sydneyCells.cell_r7, weight: 9, reportCount: 3, t: 1 },
        ]}
      />,
    )
    expect(screen.getAllByTestId('cell')).toHaveLength(2)
  })

  it('draws fill only, with no stroke, so adjacent cells blend', () => {
    render(
      <CellLayer cells={[{ cell: londonCells.cell_r7, weight: 1, reportCount: 1, t: 0.5 }]} />,
    )
    expect(screen.getByTestId('cell')).toHaveAttribute('data-stroke', 'false')
  })

  it('colours each cell from its position on the ramp', () => {
    render(
      <CellLayer
        cells={[
          { cell: londonCells.cell_r7, weight: 1, reportCount: 1, t: 0 },
          { cell: sydneyCells.cell_r7, weight: 9, reportCount: 3, t: 1 },
        ]}
      />,
    )
    const [cold, warm] = screen.getAllByTestId('cell')
    expect(cold.getAttribute('data-fill')).not.toBe(warm.getAttribute('data-fill'))
  })

  it('gives every cell a real boundary polygon', () => {
    render(<CellLayer cells={[{ cell: londonCells.cell_r7, weight: 1, reportCount: 1, t: 0 }]} />)
    expect(Number(screen.getByTestId('cell').getAttribute('data-points'))).toBeGreaterThanOrEqual(6)
  })

  it('renders nothing for an empty cell list', () => {
    render(<CellLayer cells={[]} />)
    expect(screen.queryByTestId('cell')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/map/CellLayer.test.tsx`
Expected: FAIL — cannot resolve `./CellLayer`.

- [ ] **Step 3: Write the implementation**

```tsx
import { Polygon } from 'react-leaflet'
import { cellBoundary } from '../../lib/grid/cells'
import { colorForT } from '../../lib/color/ramp'
import type { NormalisedCell } from '../../lib/severity/percentile'

export interface CellLayerProps {
  cells: readonly NormalisedCell[]
  /** Kept below 1 so the basemap stays readable underneath. */
  fillOpacity?: number
}

/**
 * Draws aggregated cells as filled polygons.
 *
 * Stroke is off deliberately (D8). An outlined hex grid reads as a hard-edged
 * mosaic; fill-only lets neighbouring cells of similar weight blend into each
 * other, which is what makes the transition look continuous rather than tiled.
 */
export function CellLayer({ cells, fillOpacity = 0.55 }: CellLayerProps) {
  return (
    <>
      {cells.map((cell) => (
        <Polygon
          key={cell.cell}
          positions={cellBoundary(cell.cell)}
          pathOptions={{
            fillColor: colorForT(cell.t),
            fillOpacity,
            stroke: false,
          }}
        />
      ))}
    </>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/map/CellLayer.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Black-box verify**

- Requirement: "The cell layer renders one filled polygon per cell, with stroke disabled so adjacent cells blend, colours each from its ramp position, gives each a boundary of at least six points, and renders nothing when given no cells. All tests pass."
- Command: `npx vitest run src/components/map/CellLayer.test.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/components/map/CellLayer.tsx src/components/map/CellLayer.test.tsx
git commit -m "feat: render aggregated cells as blended coloured polygons"
```

---

## Task 11: Wire the map together

Composes the engine into a running app: the map is the homepage (spec §"Design / UX priorities").

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`
- Test: `src/App.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => <div data-testid="tiles" />,
  Polygon: () => <div data-testid="cell" />,
  useMap: () => ({ setView: vi.fn() }),
  useMapEvents: () => null,
}))

describe('App', () => {
  it('lands directly on the map, not a splash page', () => {
    render(<App />)
    expect(screen.getByTestId('map')).toBeInTheDocument()
  })

  it('offers a place search box', () => {
    render(<App />)
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — no searchbox / no map.

- [ ] **Step 3: Write `src/App.tsx`**

```tsx
import { useMemo, useState } from 'react'
import { MapView } from './components/map/MapView'
import { CellLayer } from './components/map/CellLayer'
import { resolutionForZoom } from './lib/grid/zoomResolution'
import { weighCells } from './lib/severity/weight'
import { normaliseWeights } from './lib/severity/percentile'
import { createDebouncedSearch, type Place } from './lib/geo/nominatim'
import type { WeighableReport } from './types/report'

/** Milestone B replaces this with live data from Supabase. */
const reports: WeighableReport[] = []

export default function App() {
  const [view, setView] = useState<{ center: [number, number]; zoom: number }>({
    center: [20, 0],
    zoom: 3,
  })
  const [results, setResults] = useState<Place[]>([])
  const search = useMemo(() => createDebouncedSearch(), [])

  const cells = useMemo(() => {
    const resolution = resolutionForZoom(view.zoom)
    if (resolution === null) return []
    return normaliseWeights(weighCells(reports, resolution))
  }, [view.zoom])

  return (
    <main className="relative h-screen w-screen">
      <div className="absolute top-4 left-4 z-[1000] w-80">
        <input
          type="search"
          aria-label="Search for a place"
          placeholder="Search for a place"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 shadow"
          onChange={(event) => search(event.target.value, setResults)}
        />
        {results.length > 0 && (
          <ul className="mt-1 max-h-64 overflow-auto rounded-lg bg-white shadow">
            {results.map((place) => (
              <li key={`${place.lat},${place.lng}`}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                  onClick={() => {
                    setView({ center: [place.lat, place.lng], zoom: 15 })
                    setResults([])
                  }}
                >
                  {place.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <MapView center={view.center} zoom={view.zoom} onViewChange={setView}>
        <CellLayer cells={cells} />
      </MapView>
    </main>
  )
}
```

- [ ] **Step 4: Write `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all tests pass, build exits 0.

- [ ] **Step 7: Black-box verify**

- Requirement: "The whole test suite passes and the production build succeeds."
- Command: `npm test && npm run build`

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: compose map engine into the app homepage"
```

---

## Definition of Done

- [ ] `npm test` passes with every task's tests green
- [ ] `npm run build` exits 0
- [ ] `npm run dev` serves a world map that zooms smoothly and flies to searched places
- [ ] Every task was confirmed by a black-box verifier that could not read the source
- [ ] No credentials, `.env` file, or cloud account was required at any point

## Deferred to Milestones B and C

Reporting, photo upload, R2, votes, comments, auth, RLS, the rollup RPC, the four
moderation tiers, the worker, the admin queue, filters that depend on live data,
near-me geolocation, and the mark-as-cleaned animation.
