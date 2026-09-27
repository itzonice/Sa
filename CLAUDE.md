# CLAUDE.md — Studyly

Web app that keeps a student's grades and tells them what to study next.

## Stack

- Turborepo monorepo, pnpm workspaces
- `apps/web` — Next.js (App Router) + TypeScript, UI only
- `packages/core` — all business logic (pure functions + parser + exporters), Vitest
- `packages/db` — generated Supabase types + SQL migrations (source of truth lives in `supabase/`)
- Supabase (Postgres + Auth + Storage + Edge Functions), local via Supabase CLI
- Zod everywhere inputs cross a boundary; Claude (structured output) only inside `packages/core/parser`

## Folder layout

```
apps/web            Next.js app (App Router, TS)
packages/core       Business logic, parser, exports, eval harness — no I/O except parser HTTP
packages/db         Generated database types (packages/db/src/database.types.ts)
supabase/
  migrations/       SQL migrations, applied with `pnpm db:migrate`
  tests/            SQL tests (RLS, triggers, RPCs): `pnpm db:tests`
  seed.sql          Demo data: `pnpm db:seed`
  functions/        Deno edge functions (upload-syllabus, generate-cards, nightly)
  config.toml       Local Supabase config
```

## Rules

1. **Zod-validate every boundary**: HTTP bodies, edge function payloads, AI structured output, env vars.
2. **No business logic in clients or edge functions** — they orchestrate; logic lives in `packages/core` or Postgres.
3. **UTC everywhere in storage** (`timestamptz`); convert to the user's timezone only at the edge of the system. Timezone lives on `profiles.timezone`.
4. Deadlines with no time of day default to 23:59 in the user's timezone.
5. Migration-first: schema changes are new SQL files in `supabase/migrations`; never edit applied migrations.
6. Generated DB types are checked into `packages/db`; run `pnpm db:types` after migrations; CI fails on stale types.
7. RLS is owner-only everywhere; child tables check ownership through `courses`. Never set `force_rls` off in prod paths.
8. Env access only via the zod-validated configs (`@studyly/core/env` / edge `env.ts`), never `process.env` directly in app code.

## Commands

```
pnpm install
pnpm db:reset        # recreate local DB + seed
pnpm db:migrate      # apply pending migrations
pnpm db:types        # regenerate types after schema changes
pnpm db:tests        # run SQL tests (RLS etc.)
pnpm test            # vitest across packages
pnpm lint / typecheck / build
```
