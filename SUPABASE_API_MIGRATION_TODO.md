# Claude handoff: simplify Slideo's Supabase setup

- Requested: 2026-10-13
- Repository: `dan-opse/Slideo`
- Working branch: `worktree-vercel-supabase`
- Existing PR: [#15](https://github.com/dan-opse/Slideo/pull/15)
- Planning baseline: `14a5d8e563d714404ee06191c69a34c47b725b85`
- Status: **Implemented and verified locally; core workflow also verified by the user on Vercel (updated 2026-10-16).** Implementation commits: `e9c596a` and `f761fd0`; reviewed code/documentation tip: `fb5cf24`. Hosted persistence uses only Supabase's HTTPS APIs. Password recovery and usable Auth errors were added on 2026-10-16 and verified locally (see "Password recovery record (2026-10-16)"); the remaining hosted checks need the user's live accounts and are listed under "Remaining live checks".

## Outcome in one paragraph

A hosted studio is configured with three Supabase values and no database URL, password, certificate, pooler, or pool size: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and the server-only `SUPABASE_SECRET_KEY`. The secret key is the documented exception to "two variables": rendered slides, approvals, the audit trail, and the AI allowance must be writable only by the server after it renders and validates, and anything a browser session can call can also be called outside the app. So browsers get no table, function, or bucket privileges at all; the server verifies each session, then calls fixed `slideo_*` database functions over the Data API for exactly that account. Schema setup is a one-time paste of `supabase/migrations/20261014013833_slideo_api.sql` into the SQL Editor.

## Final environment variables

| Variable                                                     | Where           | Required | Purpose                                                                                   |
| ------------------------------------------------------------ | --------------- | -------- | ----------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                                   | public          | hosted   | Project URL; browsers sign in against it                                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                       | public          | hosted   | Sign-in and session checks (legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` also accepted)         |
| `SUPABASE_SECRET_KEY`                                        | **server-only** | hosted   | Data API functions and private Storage (legacy `SUPABASE_SERVICE_ROLE_KEY` also accepted) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_DAILY_CALL_LIMIT`      | server          | optional | AI writing, unchanged                                                                     |
| `STORAGE_BUCKET`, `STORAGE_EXPORT_BUCKET`, `EXPORT_LIMIT_MB` | server          | optional | Bucket names and package limit, unchanged                                                 |

Removed: `DATABASE_URL`, `DATABASE_CA_CERT`, `DATABASE_POOL_SIZE`. Setting any one Supabase value without the others makes the studio answer 503 and log which are missing; it never falls back to local files.

## Instructions for this user's `slideo-preview` project

1. **Re-enable the Data API** (Integrations → Data API, or Project Settings → Data API), with `public` exposed. Leave automatic exposure of new tables **off**; the setup SQL grants exactly what is needed.
2. Keep **Enforce SSL** on. The downloaded database certificate is not needed anywhere; don't add it to Vercel.
3. SQL Editor → New query → paste `supabase/migrations/20261014013833_slideo_api.sql` → Run (safe to re-run).
4. Authentication → URL Configuration: Site URL = the Vercel domain; redirect URLs include `https://<domain>/auth/confirm` and the preview domains' `/auth/confirm`.
5. In Vercel, add the three variables above (store the server-only key as a **Secret**, called **Sensitive** in older layouts), deploy a preview, and run `CHECK_ACCOUNTS="a@x:pw,b@x:pw" node --import tsx scripts/hosted-check.ts https://<preview-url>` with two confirmed test accounts.

The user has since configured the remote project and deployed a Vercel preview. See the 2026-10-14 live verification and remaining work below. The earlier implementation made no remote changes itself.

## Design decision that differs from the TODO's suggestion

Section 3 suggested one RPC per domain operation (save, approve, archive, …). I used **one typed commit function plus fixed read functions**, because the domain rules (reference validation, approval checks, slide validation, version checks) already live in shared TypeScript used by both local and hosted modes, and duplicating them in PL/pgSQL would have made two implementations to keep in step. What makes this safe:

- `slideo_commit(p_user, p_expected, p_changes)` accepts only eight change kinds with fixed SQL each (put/delete record, add revision, approve/unapprove, audit, AI attempt, AI update). It is not arbitrary SQL, it is bounded to 20,000 changes, and only `service_role` may execute it.
- **Atomicity:** each `transaction()` in `src/lib/store.ts` reads the account version, runs the operation with its writes held in memory (reads see them), then commits everything in one call. An error before commit writes nothing; a refused change inside the commit rolls the whole call back.
- **Serialization per account:** the commit locks the account's row (`SELECT … FOR UPDATE`) and refuses the change if the version moved since the operation's reads; the operation then runs again on fresh data, up to 8 times, then returns 409. This replaces the advisory lock with an equivalent, tested guarantee (the reads happen before the lock, but the version check proves nothing changed in between). Provider calls and image processing stay outside the retried part.
- **Rules the database enforces for every writer, including the server:** revisions and audit rows are append-only; a revision's hash must equal SHA-256 of its content; an approval must name an existing revision; a published post can change only its link and results and cannot be deleted; no row can change account.
- The local studio runs the same migration on PGlite and calls the same functions, so every local test exercises the hosted SQL.

## Ordered implementation TODOs

### 1. Inventory operations and choose explicit adapters

- [x] Map every SQL read, write, transaction, seed, and import operation to its hosted API equivalent. Reads: `slideo_list`, `slideo_get`, `slideo_find`, `slideo_revision`, `slideo_approval`, `slideo_asset_in_use`, `slideo_ai_usage`, `slideo_state`, `slideo_version`. Writes, seeding, AI reservation/accounting, audit, and import: `slideo_commit`. Setup detection: `slideo_schema_version`.
- [x] Introduce a domain-level persistence interface: `Backend` in `src/lib/db.ts` (`call(fn, args)`), with an embedded PGlite adapter and a Supabase Data API adapter. Route contracts and shared validation are unchanged.
- [x] Do not emulate `transaction()` with independent HTTP requests: writes are buffered and committed in one call with a version check (see above).
- [x] No per-user client is cached. The only global client holds the server's secret key and never a session (`persistSession: false`); every call names the verified account. Session clients are created per request, as before.
- [x] Scripts and imports authenticate with the secret key and an explicit account id (`scripts/import-sqlite.ts`); signed-in users cannot import.

### 2. Supply one-time schema and API provisioning

- [x] Versioned artifact: `supabase/migrations/20261014013833_slideo_api.sql` (created with `supabase migration new`). It keeps the PR #15 tables and columns, adds `accounts`, functions, triggers, grants and buckets, and never drops or rewrites data.
- [x] Dashboard path: paste into SQL Editor; no connection string or certificate. `supabase db push` also works for CLI users.
- [x] Data API: `public` exposed; tables get explicit grants only to `service_role`; `anon`/`authenticated` are revoked on every table, sequence and function; function `EXECUTE` is revoked from `PUBLIC`. Works with automatic exposure off (the local stack runs with `auto_expose_new_tables = false`).
- [x] Hosted runtime never runs DDL. `checkSchema()` calls `slideo_schema_version()` once per server instance; a missing, unreachable or older schema becomes a `SetupError` → 503 "not fully set up" with the reason in the server log.
- [x] Re-running is safe (verified by applying the file twice with `psql`); a PR #15 database upgrades in place. The one-time administrator action is running the SQL.

### 3. Put atomic business operations in database RPCs

- [x] Typed, bounded commit function; no arbitrary SQL (see design decision).
- [x] Post save: references, revision, approval invalidation, and audit in one commit (`savePost`).
- [x] Approval, archive/restore, publication and explicit link correction, metrics history: each one commit.
- [x] Brand/format optimistic versions, asset removal decisions, asset edits and imports (now also transactional), account seeding, and AI reservation are atomic.
- [x] Per-account serialization: account row lock plus version check, verified by `tests/races.test.ts`.
- [x] Image processing and OpenAI calls stay outside commits; uploaded files are written before the record that points at them, and a duplicate found at commit time removes the orphaned file.
- [x] Database refusals map to readable responses: `SL400` → 400, `SL403` → 403, `SL409` → 409, `SL413` → 413; exhausted retries → 409; missing setup → 503.

### 4. Enforce account ownership and business rules through API permissions

- [x] Hosted requests use verified Supabase sessions (`getClaims`); the account id comes from the session, never from request bodies.
- [x] RLS is enabled on every table with no policies, and `anon`/`authenticated` have no privileges. Tested: reads, inserts, owner changes and audit deletes are refused (`42501`) for a signed-in user's JWT and for the publishable key alone.
- [x] No direct table writes for browsers. The server's own writes still pass the database triggers for history, published content and owners.
- [x] Functions are `SECURITY INVOKER` with `search_path = ''` and fully qualified names; trigger functions are not executable by any API role.
- [x] The privileged path is tested separately: two real accounts through every route (`tests/hosted.test.ts`, `scripts/hosted-check.ts`); the secret key is not in browser or server bundles (checked by building with a canary value).
- [x] Unauthorized calls tested directly against the Data API, RPCs and Storage, not only through Next.js routes.

### 5. Adapt private storage without undoing export fixes

- [x] `studio` (JPEG/PNG/WebP, 20 MiB) and `studio-exports` (ZIP, 50 MiB) are created by the setup SQL; users cannot create or change buckets (tested).
- [x] Ownership: there are no storage policies, so browsers can't list, read, write or delete under any path; the server writes `<user-id>/<area>/<name>` with the secret key, and browsers get one-file signed links.
- [x] Signed direct uploads and signed ZIP downloads preserved, with the oversized-package 413.
- [x] Asset retention and the save/removal race fix preserved; file deletion happens after the commit decides the image is unused.
- [x] Verified on real Storage: a signed upload link can't replace its file, can't be redirected to another path (such as a render), refuses >20 MB and non-image types; browser sessions can't write renders or exports.
- [x] Protected server writes require the secret key; it is part of the setup guide, and hosted mode never falls back to local files.

### 6. Remove direct-Postgres runtime requirements

- [x] `src/lib/db.ts`: hosted driver replaced by the Data API backend; the embedded PGlite adapter remains for local mode.
- [x] `src/lib/auth.ts`: no database URL, CA or pool settings.
- [x] Partial settings, missing schema and unreachable projects are reported (`tests/hosted-config.test.ts`); no local database or folder is created in hosted mode.
- [x] `postgres` removed from runtime dependencies; kept as a devDependency only for `tests/database.ts` to inspect the local test database (documented there). TLS helpers, tests and fixtures removed.
- [x] Build and startup never open a Postgres connection (no Postgres client in `src/`; build succeeds with only the three Supabase values).
- [x] Session refresh, email confirmation, sign-in/out, cross-origin protection, and hosted/local copy verified (see below).

### 7. Preserve repeat-safe migration/import behavior

- [x] `importSqlite` uses the store's commits; no database password.
- [x] Add-only; differing records are reported and kept; repeats change nothing.
- [x] A post commits with its revisions and approval; images are copied first; retries after interrupted copying are tested; commits hold at most 200 changes; audit and AI rows keep their ids so repeats add none (450-record test).
- [x] Operator-only via the secret key.

### 8. Update setup documentation and previous review status

- [x] `.env.example` and the README hosting section list only the three Supabase values, public vs server-only.
- [x] Six-step guide in the README: project, Data API, setup SQL, Auth URLs, Vercel variables, preview test.
- [x] This document tells the user to re-enable the Data API in `slideo-preview`, keep SSL enforcement, and not upload the certificate.
- [x] The secret key is explained as a runtime server-only key; nowhere claims "URL and publishable key only".
- [x] `VERCEL_MIGRATION_REVIEW.md`: VM-04 marked superseded (transport is now verified HTTPS); the other five fixes' coverage and history kept, with an update table.
- [x] TLS tests replaced by `tests/hosted-config.test.ts`; local-mode coverage kept.

### 9. Verify the API implementation, not just local PGlite

- [x] `tests/races.test.ts` runs over real HTTP RPC with `npm run test:supabase`: both metrics updates survive, corrected links are kept, both save/removal orderings (removal first at transaction start and at commit; save first), plus the last-AI-attempt race. With the version check disabled, 4 of these tests fail.
- [x] Two real sessions against the Data API and Storage, including a forged `user_id` in a request body and direct attempts at protected transitions (`slideo_commit` approval forgery, owner change, audit delete, render overwrite).
- [x] Import, large-ZIP and workspace-copy coverage preserved (`tests/import.test.ts`, `tests/exports.test.ts` and real Storage in `tests/hosted.test.ts`, `tests/workspace-copy.test.ts`).
- [x] Rollback: a refused approval leaves no approval, status change or audit row; a commit the database refuses applies none of its changes and leaves the account version unchanged; history, published content and owners are protected in the database itself.
- [x] Results recorded separately below for each adapter.
- [ ] **Vercel preview:** the user verified signup/confirmation, image upload, draft creation, approval and ZIP export on 2026-10-14. Normal sign-in after sign-out, session refresh and two-account isolation still need live verification; see the session record below.

### 10. Finish the handoff with implementation evidence

- [x] This checklist records commits, artifacts, commands, results, and the variable list.
- [x] Short deployment instructions above and in the README; the remaining manual step is running the setup SQL once.
- [x] PR #15 title/description and `CLAUDE.md` updated to the API architecture.

## Verification record (2026-10-13)

| Check                                                                                                                  | Adapter                                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`, `npm run lint`, Prettier check                                                                    | —                                                                                                         | pass                                                                                                                                                                                                                                                                                                                                                   |
| `npm test`                                                                                                             | embedded PGlite (same SQL functions in-process)                                                           | 95 tests: 90 pass, 5 skipped (the hosted end-to-end file needs the stack)                                                                                                                                                                                                                                                                              |
| `npm run test:supabase`                                                                                                | local Supabase stack, Data API over HTTP with the secret key; Auth and Storage for `tests/hosted.test.ts` | 95/95 pass                                                                                                                                                                                                                                                                                                                                             |
| `next build` with only the three Supabase values                                                                       | —                                                                                                         | pass; a canary secret value appears in neither `.next/static` nor `.next/server`                                                                                                                                                                                                                                                                       |
| `scripts/hosted-check.ts` against `next start` + local stack (`MAILPIT_URL`, `CHECK_REFRESH_WAIT=25`, JWT expiry 15 s) | hosted                                                                                                    | all checks pass: sign-up form → email → `/auth/confirm` signs in; unconfirmed sign-in refused; cross-site form refused; signed-out redirect to `/login`; session refreshed after the access token expired; direct upload and >20 MB refusal; approval; signed ZIP download; second account isolated (state, media, approve, export); sign-out then 401 |
| Real browser (Playwright, Chromium) against the same server                                                            | hosted                                                                                                    | sign-up and confirmation link; upload through the UI PUTs from `localhost:3000` to Storage cross-origin with 200 and no console errors; hosted Settings copy correct                                                                                                                                                                                   |
| Version check disabled in `slideo_commit`                                                                              | PGlite                                                                                                    | 4 race tests fail as expected; restored                                                                                                                                                                                                                                                                                                                |
| Migration applied twice                                                                                                | local stack                                                                                               | second run succeeds, data kept                                                                                                                                                                                                                                                                                                                         |

Local stack: Supabase CLI 2.119.0, Postgres 17, `supabase/config.toml` on ports 55420–55429 (project id `slideo`), automatic table exposure off, email confirmations on.

Found and fixed along the way: Supabase Storage reports an oversized signed upload as HTTP 400 with `statusCode: "413"` in the body, so the browser showed "upload did not finish" instead of the size limit (`src/components/request.ts`); asset edits and image imports were not atomic and could resurrect a just-deleted image (now transactions).

## Live verification and resume notes (2026-10-14)

The user paused the setup session after reporting **"email rate limit exceeded"** and forgetting the new Slideo password. Keep the existing Supabase project, account and uploaded data. Password recovery was implemented on 2026-10-16 (below); it needs no change to the Supabase project, because reset links return to the already-allowed `/auth/confirm`.

### Confirmed target and completed setup

- Supabase project: `slideo-preview`. The user confirmed enabling the Data API, running the reviewed setup SQL, adding the three Supabase variables to Vercel Preview, and saving the Auth redirect URLs.
- Vercel project: `slideo-preview`, id `prj_3Y8xJiqlrSKO1pNwjSgdrnlelwP7`, under `dan-opses-projects`.
- Vercel's connection confirmed deployment `dpl_JCxKRT7KXmy8KhFyM2mSjyWF7VoJ` was **READY**, from `worktree-vercel-supabase` at reviewed commit `fb5cf24c00949abbc6c1ba62c7ebe9f3e3fb664d`.
- Stable branch URL: `https://slideo-preview-git-worktree-vercel-supabase-dan-opses-projects.vercel.app`.
- Reviewed deployment URL: `https://slideo-preview-dhl839nf5-dan-opses-projects.vercel.app`.
- Site URL was set to the stable branch URL; allowed redirect entries are both addresses above with `/auth/confirm` appended.
- The user initially deployed `master` during import, then created the correct branch preview. Do not assume the project's production-domain deployment contains the migration. PR #15 has not been merged in this session.

### Verification evidence

- Codex independently reran the embedded suite: **90 passed, 5 hosted-only tests skipped**. The first sandboxed run had one local-listener `EPERM`; the unrestricted rerun passed.
- Codex independently reran `npm run test:supabase`: **95/95 passed** against local Supabase's real Auth, Data API and Storage, including the concurrency and direct-access tests.
- Type checking, lint, formatting, local and hosted production builds passed. GitHub CI for the reviewed commit was green.
- `scripts/hosted-check.ts` passed against the production `next start` server and local Supabase with only the three API settings, covering signup, email confirmation, uploads, approval, export, account isolation and sign-out. The temporary server and local stack were stopped afterward, preserving the stack's data volumes.
- **User-reported live results:** signup and email confirmation opened the studio; an uploaded image appeared in Assets; a two-slide manual draft was created; the image was added; approval and ZIP download worked. The user opened the ZIP and reported photos plus the manifest, caption and README files. This exercises the actual Vercel/Supabase workflow; it is not an automated browser trace.
- Automated access to the protected preview through the Vercel connection failed with **403** while reading protection-bypass access. Deployment metadata was readable, but live response bodies and authenticated account behavior were not independently inspected through that connection. Do not disable deployment protection to work around it.

### Password recovery and usable Auth errors (done 2026-10-16)

- [x] **Forgot password** (`/login/forgot`, linked from the sign-in page as "Forgot your password?") and **Choose a new password** (`/login/reset`) screens, plus `forgot`, `reset` and `resend` actions in `src/app/auth/[action]/route.ts`. `src/proxy.ts` lets signed-out visitors reach `/login/*`. Wording lives in `src/lib/auth-messages.ts`.
- [x] Recovery uses `resetPasswordForEmail` with `redirectTo` = the existing `https://<host>/auth/confirm`, so the current redirect allow list already covers it. `/auth/confirm` recognises a reset link from the PKCE exchange's `redirectType: "recovery"` (or `type=recovery` for a `token_hash` link) and sends it to `/login/reset`; the password is changed with `updateUser`. Account ids, records and files are untouched (checked: the same account keeps its slideshow and image).
- [x] New password and confirmation are checked on the server (8–72 bytes, matching); Supabase's `weak_password`, `same_password` and `reauthentication_needed` get their own messages. Expired, used and garbage links say they expired and offer a new one; a link opened in a different browser says to use the asking browser. Saving signs out globally (other devices once their access token expires) and returns to sign-in with "Your password was changed".
- [x] Requesting a reset (or a new confirmation link) gives one neutral answer. Measured on local Auth: an unknown address gets `200`, but a repeat for a **known** address gets `429 over_email_send_rate_limit`, and mailer refusals also happen only for real accounts, so every account-dependent outcome shows the same text; the real reason goes to the server log (`Supabase Auth refused forgot: {...}`).
- [x] Sign-in no longer maps every error to a wrong password: `invalid_credentials` → wrong email/password; `email_not_confirmed` → confirm first, with a **Send the confirmation link again** button; rate limits → wait; unreachable/5xx Auth → "Sign-in is unavailable right now"; anything unknown → generic problem, logged. Sign-up maps the email rate limit, the default mailer's `email_address_not_authorized` (points to custom SMTP), weak/invalid/existing addresses, and checks the 8-character minimum the form already asked for.
- [x] Found while testing: Supabase stores a PKCE flow even for a reset request it refuses as too soon, and matches the emailed link to the address's **newest** flow. The SDK's clean-up deleted the browser's verifier on that refusal, so a second click on "Email me a reset link" broke the first email's link. `sessionClient({ held: true })` now applies the verifier cookies only when the request was accepted or rate-limited (keeping what it first stored), and keeps the previous verifier for other refusals. Covered by `scripts/hosted-check.ts`.
- [x] Verified with local Mailpit and a production `next start`: see the record below.
- [x] Setup instructions: README "Email and password recovery" explains the default sender (team addresses only, about 2 messages an hour), custom SMTP and rate limits, not disabling confirmations, and the optional cross-device `token_hash` reset template.

### Password recovery record (2026-10-16)

| Check                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`, `npm run lint`, Prettier                                                            | pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm test` (embedded PGlite)                                                                             | 100 tests: 95 pass, 5 hosted-only skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run test:supabase` (local Auth, Data API, Storage)                                                  | 100/100 pass, including the new `tests/auth-messages.test.ts` (wording for each Auth refusal, built from the SDK's own error classes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `next build` + `next start` with only the three Supabase values; `MAILPIT_URL=… scripts/hosted-check.ts` | all 46 checks pass. New ones: unconfirmed sign-in offers a new link; resend gets the neutral answer; reset for an unknown and a real address (and a refused repeat) give identical answers, with exactly one email sent; the link opens `/login/reset` naming the account; mismatched and short passwords refused; saving signs the browser out and returns to sign-in; the used link says it expired; the old password fails; the new one signs in and the account keeps its slideshow and image; a link opened in another browser says so; `/login/reset` and `POST /auth/reset` without a reset session offer a new link |
| Expired link (local DB aged 2 h past the 1 h expiry)                                                     | Supabase returns `error_code=otp_expired` in the query; the studio shows "That email link has expired or was already used…"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `token_hash` reset link (admin-generated) from a cookie-less client                                      | signs in and opens `/login/reset`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Real browser (Playwright, Chromium)                                                                      | sign-in → Forgot your password? → neutral note → email link → Choose a new password (mismatch error shown) → saved → sign-in message → signed in with the new password; no console errors; 375 px layout checked                                                                                                                                                                                                                                                                                                                                                                                                            |

### Remaining live checks

- [ ] Recover the existing account with **Forgot your password?** on the branch preview once this commit is deployed, then verify ordinary email/password sign-in after sign-out and persistence of the uploaded image/slideshow. The user explicitly forgot the password; this does not establish an incorrect-password-validation defect. The reset email comes from Supabase's default sender, so the address must be a team member's and the hourly allowance must have recovered.
- [ ] Verify session refresh after expiry against the hosted project.
- [ ] Verify a second confirmed test account cannot see or access the first account's state, media, approvals or exports. The default mailer's team-address restriction must be handled when preparing the second account; do not assume an arbitrary email can receive confirmation.
- [ ] Verify larger packages and Vercel execution limits on the real preview. The user tested a two-slide ZIP; packages over 20 MiB were verified on local Supabase, not the cloud deployment.
- [ ] If automated live testing is needed, restore the Vercel connection's access to this project's team and protected deployment. Do not publish credentials in the repo or chat.

## Not yet verified

- Hosted password recovery, session refresh, second-account isolation and larger-package checks, as listed above. Recovery is verified locally only. The main signup/upload/approval/export workflow has user-reported live evidence.
- After a sign-out, an access token copied out of the browser stays valid until it expires (Supabase JWTs are stateless; 1 hour by default). The studio's cookies are cleared, and this matches Supabase's standard behavior.

## Completion gate

The migration is complete when a fresh hosted project can run the full manual studio workflow over Supabase HTTPS APIs without a Postgres URL/password/CA configured in Vercel, account isolation and immutable approval rules hold even for direct API callers, and all previously verified fixes remain covered. Document any server-only API key required by the chosen trust model. An API-shaped wrapper that still connects to Postgres from the app does not satisfy this request.

**Status against the gate:** met on a fresh local Supabase stack with production `next start`; the server-only secret key is documented above. The user also verified the core workflow on a real Vercel preview. Password recovery is implemented and verified locally; the remaining hosted checks are listed under "Remaining live checks".

This handoff authorizes implementation planning and code changes; it does not authorize merging, production deployment, or destructive changes to existing user data. Prepare any schema/deployment change against the confirmed target before release.

## Official references

- [Supabase Data API permissions and security](https://supabase.com/docs/guides/api/securing-your-api)
- [Database functions and RPC](https://supabase.com/docs/guides/database/functions)
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Explicit table exposure changes](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
- [Supabase Auth redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase password recovery](https://supabase.com/docs/guides/auth/passwords#resetting-a-password)
- [Supabase default email limits and custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
