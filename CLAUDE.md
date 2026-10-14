@AGENTS.md

Hosted persistence uses Supabase's HTTPS APIs only: the server calls the `slideo_*` database functions in [supabase/migrations](supabase/migrations) over the Data API with `SUPABASE_SECRET_KEY`, and the local studio runs the same SQL on PGlite. There is no direct Postgres connection. [SUPABASE_API_MIGRATION_TODO.md](SUPABASE_API_MIGRATION_TODO.md) records the design and verification evidence, including the user's successful live signup, upload, approval and ZIP export on 2026-10-14.

Next work: read that document's **Live verification and resume notes (2026-10-14)**. The user forgot the Slideo password and hit Supabase's email rate limit. Password recovery has not been implemented; add the recovery flow and usable Auth error messages while preserving the existing account and workspace. Ordinary sign-in after recovery, session refresh and second-account isolation still need live verification. Keep deployment protection enabled and do not merge or promote the preview automatically.

Preserve the PR #15 fixes documented in [VERCEL_MIGRATION_REVIEW.md](VERCEL_MIGRATION_REVIEW.md) (VM-04 is superseded by the HTTPS architecture). Run `npm test`, and with `supabase start`, `npm run test:supabase` for the same suite against a real Supabase stack.
