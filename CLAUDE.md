@AGENTS.md

Hosted persistence uses Supabase's HTTPS APIs only: the server calls the `slideo_*` database functions in [supabase/migrations](supabase/migrations) over the Data API with `SUPABASE_SECRET_KEY`, and the local studio runs the same SQL on PGlite. There is no direct Postgres connection. [SUPABASE_API_MIGRATION_TODO.md](SUPABASE_API_MIGRATION_TODO.md) records the design and verification evidence, including the user's successful live signup, upload, approval and ZIP export on 2026-10-14.

Next work: password recovery, usable Auth messages and review finding AR-01 (account enumeration when email delivery fails) are implemented and verified locally; see **Review follow-up for commit 445d73d (2026-10-16)** in that document. Don't restart that work. What remains is **Remaining live checks**: hosted recovery and ordinary sign-in, session refresh, second-account isolation and larger exports. These need the user's accounts; the default Supabase mailer sends only to team addresses, about 2 an hour. Keep deployment protection enabled and do not merge or promote the preview automatically.

Preserve the PR #15 fixes documented in [VERCEL_MIGRATION_REVIEW.md](VERCEL_MIGRATION_REVIEW.md) (VM-04 is superseded by the HTTPS architecture). Run `npm test`, and with `supabase start`, `npm run test:supabase` for the same suite against a real Supabase stack.
