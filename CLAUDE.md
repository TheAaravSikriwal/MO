# MO — working notes

A community pollution map. People report litter with a photo and a precise
location, other people confirm those reports, and the map shows where litter has
been reported from street level out to a world view. When a spot gets cleaned up,
the map visibly improves.

## Layout

| Path | What it is |
|---|---|
| `src/lib/` | Pure logic: grid, severity, colour, geocoding, moderation gate |
| `src/components/` | Map, report, auth UI |
| `src/lib/data/` | The `DataSource` seam; UI never touches Supabase directly |
| `worker/` | Standalone moderation worker, its own package and deps |
| `supabase/migrations/` | Schema, RLS, RPCs — **not yet applied to any database** |
| `docs/superpowers/` | Design spec and implementation plans |

## Hard constraints

- **Plain language everywhere.** A report is a "report", cleaned is "cleaned".
  No jargon, no in-jokes, nothing needing a dictionary.
- **Never disparage a place or the people in it.** Copy describes the litter,
  never the location's character or its residents.
- **Severity is derived, never chosen.** No severity picker exists. An area's
  colour comes from how many distinct people flagged it.
- **Zero budget.** Everything runs on free tiers.

## Commands

```bash
npm test              # app suite
npm run build         # typecheck, then build
cd worker && npm test # worker suite
```

## Audit gate

At every stopping point and every milestone, before reporting work
complete, invoke the `blind-auditor` subagent. Pass it ONLY the original
requirement verbatim and the list of changed files — never my own summary
or any "it works" claim. On FAIL or CONCERNS, fix every finding and
re-invoke before calling the step done. Don't argue findings away.
