@AGENTS.md

Hosted persistence uses Supabase's HTTPS APIs only: the server calls the `slideo_*` database functions in [supabase/migrations](supabase/migrations) over the Data API with `SUPABASE_SECRET_KEY`, and the local studio runs the same SQL on PGlite. There is no direct Postgres connection. [SUPABASE_API_MIGRATION_TODO.md](SUPABASE_API_MIGRATION_TODO.md) records the design, the verification evidence, and what remains (a Vercel preview check).

Preserve the PR #15 fixes documented in [VERCEL_MIGRATION_REVIEW.md](VERCEL_MIGRATION_REVIEW.md) (VM-04 is superseded by the HTTPS architecture). Run `npm test`, and with `supabase start`, `npm run test:supabase` for the same suite against a real Supabase stack.
