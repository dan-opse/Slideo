# Claude handoff: simplify Slideo's Supabase setup

- Requested: 2026-10-13
- Repository: `dan-opse/Slideo`
- Working branch: `worktree-vercel-supabase`
- Existing PR: [#15](https://github.com/dan-opse/Slideo/pull/15)
- Planning baseline: `14a5d8e563d714404ee06191c69a34c47b725b85`
- Status: TODO; this document changes no application behavior.

## User decision and desired outcome

The user explicitly prefers the simpler Supabase API setup used in their other web apps. Implement hosted persistence through Supabase's HTTPS Data API and typed database RPCs instead of an application-managed Postgres connection. This supersedes the recommendation to finish setting up the direct Postgres driver.

Normal hosted setup must no longer require `DATABASE_URL`, the database password, `DATABASE_CA_CERT`, pooler selection, or `DATABASE_POOL_SIZE`. Use `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` with Supabase Auth. Keep optional OpenAI configuration separate.

Aim for only those two Supabase variables at runtime. If trusted rendering, protected storage writes, or another privileged operation genuinely requires a server-only Supabase secret/service-role key, document that explicit exception and why it is needed. One server-only API key is preferable to reintroducing database connection strings or certificate configuration. Do not claim two-variable setup works until the entire flow has been tested without an administrative key.

Keep local PGlite mode working unless the user separately chooses to remove it. Keep the existing app UI and workflows; this task changes persistence and setup, not the product design.

## Current setup state

The user created a Supabase project called `slideo-preview`. Following the previous direct-Postgres instructions, they disabled the Data API and automatic exposure of new tables, found the transaction-pooler connection string, downloaded the database certificate, and enabled SSL enforcement. No password or secret was provided in chat.

**The Data API must now be enabled for the new implementation.** Leave automatic exposure disabled and provision narrowly scoped grants/policies deliberately. Existing SSL enforcement can stay enabled; the HTTPS API client does not need the downloaded database certificate.

A live Slideo deployment has not been verified. The Vercel connection could list projects, but no matching Slideo project or PR-branch deployment was found, and explicitly team-scoped access returned 403. Confirm the intended project and account before any deployment. Do not assume staging credentials or working connector permissions exist.

## Read before implementing

- `AGENTS.md`, including the relevant installed Next.js guides before writing framework code.
- `VERCEL_MIGRATION_REVIEW.md`: the six earlier findings, fixing commits, and acceptance criteria.
- `src/lib/db.ts`, `src/lib/store.ts`, `src/lib/auth.ts`, `src/lib/supabase-server.ts`, `src/lib/files.ts`, and `src/lib/import-sqlite.ts`.
- The studio, upload, render, media, export, and authentication routes.
- `.env.example`, `README.md`, and the tests named below.
- Current Supabase changelog and official docs; do not assume older grant defaults or SDK behavior.

The baseline passed 84 tests, type checking, linting, formatting, and production build in local verification. Live Supabase integration was still outstanding. Passing local tests alone is not proof that the API-based backend works.

## Ordered implementation TODOs

### 1. Inventory operations and choose explicit adapters

- [ ] Map every SQL read, write, transaction, seed, and import operation to its hosted API equivalent. Include AI allowance accounting and audit events, not just posts.
- [ ] Introduce a domain-level persistence interface for local PGlite and hosted Supabase. Preserve useful shared validation and public route contracts.
- [ ] Do not emulate the current `transaction(async () => ...)` by running several independent HTTP requests. HTTP calls do not share the current connection or advisory-lock transaction.
- [ ] Keep request/session clients scoped to the active user. Never cache a user's authenticated client or access token in a global singleton shared with another request.
- [ ] Define how scripts and administrative imports authenticate separately from normal signed-in requests.

### 2. Supply one-time schema and API provisioning

- [ ] Add versioned schema, policy, function, and storage provisioning artifacts. Preserve existing tables/data or provide a non-destructive upgrade path; avoid an unrelated schema redesign.
- [ ] Provide a documented dashboard SQL Editor setup path that does not require the user to enter a database connection string or certificate. Use the Supabase CLI's migration-generation workflow if creating migration files through the CLI.
- [ ] Enable the Data API and expose only the intended API surface. Document the required exposed schema and explicit grants; new tables may not be exposed automatically.
- [ ] Move hosted schema creation out of `driver()` at request time. An ordinary publishable-key client cannot execute the existing DDL bootstrap. Detect missing/outdated provisioning and report an actionable setup error.
- [ ] Make schema application/retries safe and document how an existing PR #15 database upgrades. Document any unavoidable one-time administrator action honestly.

The target is simpler runtime configuration, not a promise that an empty Supabase project needs no schema installation.

### 3. Put atomic business operations in database RPCs

- [ ] Implement typed, bounded RPCs for changes that must succeed or roll back together. Use domain inputs, never an arbitrary SQL execution RPC.
- [ ] Cover post save with reference validation, revision creation, approval invalidation, and audit in one operation.
- [ ] Cover approval, archive/restore, publication and explicit link correction, and metrics history updates.
- [ ] Cover optimistic version checks for brand/format edits, asset-removal decisions, account initialization, and AI allowance reservation/accounting where atomicity is needed.
- [ ] Serialize conflicting writes per account inside the database transaction, using the existing advisory-lock convention or an equally well-tested alternative. Read current state after acquiring the lock.
- [ ] Keep image processing and provider/network calls outside database locks. Where work happens before a commit, revalidate the expected state in the atomic commit operation.
- [ ] Translate expected database errors back into the current readable 400/404/409/413/422 responses as appropriate; do not convert every conflict into a generic 500.

**Approval trust boundary:** RPCs and table permissions must not let a caller skip server render validation, forge render attestations, manufacture approval records, or mutate published content. Identify which operations need trusted server authority before selecting the final client/key model. A function callable with a user's JWT is also callable outside the app UI.

### 4. Enforce account ownership and business rules through API permissions

- [ ] Use verified Supabase sessions for hosted requests. For user-authorized database calls, derive the account from `auth.uid()` rather than trusting a client-provided owner ID.
- [ ] Enable RLS and test ownership restrictions on all exposed account data. Include both read restrictions and prevention of changing a row's owner.
- [ ] Do not broadly grant direct table writes that bypass revision immutability, approval checks, optimistic concurrency, AI accounting, or protected audit history. Give RPCs only the privileges their business operations need.
- [ ] Prefer invoker functions where that fits the permission model. If privileged helper functions are necessary, place them in a non-exposed schema, fix their search path, fully qualify referenced objects, and verify caller/ownership checks. Revoke default execution and grant only the intended entry points to the intended roles.
- [ ] If a server-only privileged client is retained, obtain the account from the verified request and explicitly scope every operation. Test this path separately because privileged credentials can bypass RLS. Keep that credential out of browser bundles.
- [ ] Test unauthorized calls directly against the Data API/RPCs as well as through Next.js routes. Application-only checks are insufficient for an exposed API surface.

### 5. Adapt private storage without undoing export fixes

- [ ] Provision private `studio` and `studio-exports` buckets once, with the existing separate image and ZIP limits. Ordinary users must not create buckets or change their privacy/limits at runtime.
- [ ] Define ownership policies for `<user-id>/<area>/<name>` paths, with operation-specific permissions for uploads, normalized assets, renders, and exports.
- [ ] Preserve signed direct browser uploads so images avoid Vercel Function body limits. Preserve signed ZIP downloads and the actionable oversized-package error.
- [ ] Preserve historical asset retention and the save/removal race fix. Coordinate the database deletion decision with the later storage deletion.
- [ ] Verify the permissions actually required by signed uploads, downloads, delete, and upsert. Ensure users cannot replace trusted rendered files or export artifacts through their browser credentials.
- [ ] Decide whether protected server writes require the optional administrative API key. If they do, make it an explicit part of the final setup guide rather than silently falling back to local files when it is absent.

### 6. Remove direct-Postgres runtime requirements

- [ ] Replace the hosted driver selection in `src/lib/db.ts`; retain or extract the embedded adapter for local mode.
- [ ] Remove the database URL, CA, and pool-size requirements from `src/lib/auth.ts` and normal hosted initialization.
- [ ] Detect partially configured hosted settings and missing schema/policies without silently using a local database or filesystem on Vercel.
- [ ] Remove dead Postgres-client/TLS configuration and related runtime dependencies when no supported path needs them. Retain any explicit tooling-only dependency only with a documented reason.
- [ ] Ensure production build and ordinary startup never attempt a raw Postgres connection.
- [ ] Preserve session refresh, email confirmation, sign-in/sign-out, cross-origin request protection, and correct hosted/local UI copy.

### 7. Preserve repeat-safe migration/import behavior

- [ ] Adapt `src/lib/import-sqlite.ts` and its CLI to the new hosted persistence model. Do not leave importing as an undocumented reason to require a database password.
- [ ] Keep imports add-only by default and report differing destination records. A repeat import must not rewind newer edits, revisions, approvals, publication links, or metrics.
- [ ] Preserve consistent post/history/approval imports, account coordination, and retry after interrupted image copying. Define limits/chunking for large API imports and prove retries are idempotent.
- [ ] An operator-only import may use a separately documented server/API credential; ordinary app users must not be able to import into another account.

### 8. Update setup documentation and previous review status

- [ ] Rewrite `.env.example` and the hosted README around API configuration. List only actual required variables, with public and server-only values distinguished.
- [ ] Provide a short numbered guide: create/select Supabase project, enable Data API, install the supplied schema/policies/buckets, configure Auth redirect URLs, add Vercel variables, deploy a preview, test.
- [ ] Explicitly tell this user to re-enable the Data API in `slideo-preview`. Do not ask them to disable existing database SSL enforcement or upload the downloaded certificate to Vercel.
- [ ] Explain any one-time administrator credential and any runtime server-only key. Do not promise "URL and publishable key only" if the final implementation still requires another key.
- [ ] Mark VM-04's raw-driver TLS requirement as superseded by the HTTPS API architecture, while preserving the requirement for verified encrypted transport. Keep the other five fixes covered and their completion history intact.
- [ ] Replace obsolete TLS tests with tests proving hosted startup works without direct-connection settings. Keep local-mode coverage.

### 9. Verify the API implementation, not just local PGlite

- [ ] Port `tests/races.test.ts` to exercise actual concurrent HTTP/RPC requests against local Supabase or an isolated staging project. Preserve both metrics updates, corrected links, and both save/removal orderings.
- [ ] Port account isolation tests to the Data API and Storage with two real test sessions. Include forged owner IDs and direct attempts to bypass protected transitions.
- [ ] Preserve repeat-import coverage in `tests/import.test.ts`, large ZIP coverage in `tests/exports.test.ts`, and mode-copy checks in `tests/workspace-copy.test.ts`.
- [ ] Add rollback verification: failed saves/approvals create no partial revision, approval, or audit state. Verify immutable history, published content, and daily AI limits through the public API surface.
- [ ] Run typecheck, lint, formatting, tests, and production build. Record results separately for local and hosted adapters; do not substitute mock-only checks for real RPC/RLS behavior.
- [ ] In a Vercel preview, verify email confirmation, session refresh, upload CORS/size limits, approval, a ZIP larger than 20 MiB, sign-out, and two-account isolation. Record anything that remains untested.

### 10. Finish the handoff with implementation evidence

- [ ] Update this checklist as work lands and record fixing commits, migration artifacts, test commands/results, and the final required environment-variable list.
- [ ] Provide the user with the shorter deployment instructions and identify any remaining manual provisioning step.
- [ ] Keep PR #15's title/description and `CLAUDE.md` aligned with the final API architecture.

## Completion gate

The migration is complete when a fresh hosted project can run the full manual studio workflow over Supabase HTTPS APIs without a Postgres URL/password/CA configured in Vercel, account isolation and immutable approval rules hold even for direct API callers, and all previously verified fixes remain covered. Document any server-only API key required by the chosen trust model. An API-shaped wrapper that still connects to Postgres from the app does not satisfy this request.

This handoff authorizes implementation planning and code changes; it does not authorize merging, production deployment, or destructive changes to existing user data. Prepare any schema/deployment change against the confirmed target before release.

## Official references

- [Supabase Data API permissions and security](https://supabase.com/docs/guides/api/securing-your-api)
- [Database functions and RPC](https://supabase.com/docs/guides/database/functions)
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Explicit table exposure changes](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [Supabase Auth redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
