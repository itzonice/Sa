# Production checklist (item 42)

## Supabase production

- [ ] Create prod project; note region close to most users
- [ ] `supabase link --project-ref <ref>` then `supabase db push` (migrations only — never `db reset`)
- [ ] Re-apply storage bucket + policies via migrations (0005) — confirm `syllabi` bucket is **private**
- [ ] Disable `enable_insecure_test_accounts`; configure SMTP for auth emails
- [ ] Set `site_url` + redirect URLs in auth settings to the prod domain
- [ ] Row estimates + indexes reviewed (`pg_stat_statements`) on hot tables

## Secrets (Supabase edge secrets + Vercel env)

- [ ] `ANTHROPIC_API_KEY` — parser + cards
- [ ] `PARSER_MODEL` — pin exact model snapshot
- [ ] `NIGHTLY_SECRET` — protects the nightly cron trigger
- [ ] `SUPABASE_URL` / `ANON_KEY` on Vercel (NEXT_PUBLIC_ variants)
- [ ] `POSTHOG_KEY` / `POSTHOG_HOST` on Vercel
- [ ] Rotate the anon/service-role keys from local dev before launch

## Vercel

- [ ] Import repo, set root dir `apps/web`
- [ ] Env vars per environment (preview uses Supabase **staging** branch if used)
- [ ] Deploy hooks + preview protection as desired

## RLS & auth audit (item 42)

- [ ] Run `pnpm db:tests` against prod shadow DB — all green
- [ ] Every public table has RLS enabled and at least one policy (`pg_tables` / `pg_policies` check)
- [ ] `storage.objects` policies: only `syllabi` bucket, owner-prefix only
- [ ] Edge functions: `verify_jwt = true` except `nightly` (protected by shared secret)
- [ ] Confirm `commit_parsed_syllabus` and `today_feed` are `security definer` with fixed `search_path`

## Backups & ops

- [ ] Supabase PITR / daily backups enabled
- [ ] Nightly cron scheduled (Supabase scheduled functions or external cron) with alerting on non-200
- [ ] PostHog events flowing: `signup`, `syllabus_parsed`, `course_committed`, `session_logged`
- [ ] Error tracking wired (Sentry or PostHog exceptions)
- [ ] k6 load test pass: `k6 run loadtest/parser.js` against staging (p95 < 30s, error rate < 5%)
