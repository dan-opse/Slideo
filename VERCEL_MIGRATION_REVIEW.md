# PR #15: Vercel migration implementation handoff

- Review date: 2026-10-13
- PR: [Host the studio on Vercel with Supabase](https://github.com/dan-opse/Slideo/pull/15)
- Branch: `worktree-vercel-supabase`
- Reviewed code commit: `dbd5ed62e7771ae60f04fe624d5f7050690b3905`
- Base branch: `master`

The migration has four high-priority defects and two medium-priority defects. Keep the PR in draft until these are addressed and the hosted integration checks below are completed. This document records the review; it does not implement fixes.

## Instructions for the implementing Claude agent

1. Read `AGENTS.md` and inspect the current branch before changing code. For Next.js changes, read the relevant installed guides in `node_modules/next/dist/docs/`.
2. Reproduce each issue against the current code, then implement a focused fix and regression coverage. Locations below refer to the reviewed commit and may move as fixes land.
3. Preserve account isolation, immutable revisions, approval validation, explicit publication-link correction, and historical asset retention.
4. Use an isolated temporary data directory and fixtures for destructive migration and concurrency tests. The review used temporary local databases and storage; it did not modify production or user data.
5. Update this document as work lands: mark completed items, record the fixing commit and verification, and explain any remaining limitation. Do not mark an item complete solely because the existing suite passes.

## Implementation checklist

| ID    | Priority | Finding                                                                       | Status                                         |
| ----- | -------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| VM-01 | High     | Metrics writes lose concurrent updates and revert corrected publication links | Fixed (`84c76de`)                              |
| VM-02 | High     | Asset deletion can race a save and leave a broken immutable revision          | Fixed (`84c76de`)                              |
| VM-03 | High     | Re-running the SQLite importer overwrites newer destination data              | Fixed (`487a172`)                              |
| VM-04 | High     | The documented hosted Postgres configuration does not enable TLS              | Fixed (`7588c4c`); live Supabase check pending |
| VM-05 | Medium   | The image upload bucket limit rejects valid larger ZIP exports                | Fixed (`9d850e2`); live Supabase check pending |
| VM-06 | Medium   | Hosted UI still promises local-only storage and obsolete SQLite backups       | Fixed (`9ed719c`)                              |

**Status (2026-10-13):** All six findings are fixed in code. Each was reproduced first where a reproduction applies; VM-01 and VM-02 fail their new tests on the reviewed commit. Each has focused regression coverage, recorded in the completion record below. The PR stays in draft until the staging checks under "Verification baseline" run against a real Supabase project.

### VM-01 — Serialize metrics updates using fresh state

**Locations:** `src/app/api/studio/route.ts:541,609–624`; `src/lib/store.ts:130–138`.

**Problem:** The route reads a post before dispatching the action. The `metrics` handler modifies that object and writes the entire entity without using the account transaction. Another metrics request can write from the same stale state. A publication-link correction correctly uses a transaction, but a metrics request can subsequently overwrite it with its earlier copy of the post.

**Observed evidence:**

- Two concurrent metrics requests recording 100 and 200 views both returned HTTP 200, but the final post retained only the 200-view snapshot, with the other snapshot lost.
- A controlled interleaving paused a metrics request after its post SELECT returned. A `publish` request with `replace: true` corrected the URL from a TikTok `/photo/1` link to `/photo/2`. After resuming metrics, both requests returned 200 and the stored URL reverted to `/photo/1`.

These reproductions used an isolated PGlite database. The second reproduction controlled the driver query boundary to make the stale read deterministic.

**Implementation direction:** Parse the metrics input, then acquire the existing account `transaction`. Read the current post inside that transaction, validate its current publication status, update the history and latest snapshot, and persist the post and audit event in the same transaction. Do not reuse the post read before acquiring the lock.

**Acceptance criteria:**

- Concurrent successful metrics writes preserve both snapshots, subject to the existing history cap.
- A metrics request overlapping a link correction preserves the corrected URL, original publication timestamp, and current revision and approval state.
- A failed metrics update does not leave a success audit event or partially written state.
- Regression tests force both interleavings with synchronization barriers rather than depending on sleeps or favorable scheduling.

### VM-02 — Validate asset references inside the save transaction

**Locations:** `src/app/api/studio/route.ts:415–428` and `removeAssets` around `210–228`; `src/lib/store.ts:169–208` (`savePost`).

**Problem:** The `save` route verifies brand, format, and asset references before calling `savePost`. The latter acquires the account lock, but does not revalidate those references. In the interval, `removeAssets` can acquire that lock, classify an asset as unused, and delete its entity and file. Saving then succeeds with a missing asset in both the current post and its immutable revision.

**Observed reproduction:**

1. Create a draft without an image and insert an unused asset with a valid JPEG in isolated storage.
2. Start saving that draft with the new asset on a slide. Pause immediately after the asset SELECT has returned a valid row.
3. Remove the asset. Removal returns 200 with `kept: false`.
4. Resume saving. Save returns 200, even though the referenced asset has been deleted.
5. Approving that revision returns 422: "Slide 1: one of its images is missing from your library. Choose another image."

**Implementation direction:** Make reference validation and revision persistence participate in the same account transaction used by asset removal. Consider putting the checks in the shared `savePost` path so create and duplicate paths receive the same guarantees. Preserve the intended behavior of assets retained for historical revisions. Keep slow storage operations outside the lock where possible; the database decision establishing whether deletion is permitted must remain coordinated with saves.

**Acceptance criteria:**

- If saving acquires the lock first, removal recognizes the newly referenced asset and retains the bytes required by the revision.
- If removal acquires the lock first, saving rejects the missing reference and creates neither a post update nor an immutable revision.
- Existing historical revisions remain renderable when their assets are removed from the active library.
- A deterministic overlapping save/removal test covers both orderings, including absence of partial revision or audit writes on rejection.

### VM-03 — Make repeat imports preserve destination changes

**Locations:** `scripts/import-sqlite.ts:46–72`, particularly the entity upsert at `47–50`; migration instructions in `README.md`.

**Problem:** The importer is presented as safe to run again, but entity conflicts use `DO UPDATE SET json=excluded.json`. This unconditionally restores older SQLite state over newer destination edits. Revisions and approvals instead use `DO NOTHING`, so a repeated import can rewind current post metadata while retaining newer immutable history and approval records.

**Observed reproduction:**

1. Create a minimal legacy SQLite fixture with the expected tables and a brand named `Original SQLite brief`.
2. Import it into an isolated destination database.
3. Edit the destination brand to `Edited in the new studio`, add `New verified facts`, and advance its version to 1.
4. Close the store and run the same import again.
5. Both imports succeed. The destination brand reverts to the original name, empty facts, and version 0.

**Implementation direction:** Define safe conflict behavior explicitly. The default repeated import should preserve destination changes, or stop with an actionable conflict report; it should not silently overwrite them. If an overwrite mode is needed, make it explicit and document its consequences. Coordinate hosted imports with the same per-account locking convention as application writes. Validate conflicts affecting immutable revision and approval consistency. Also consider the retry boundary: database import commits before image copying, so a storage-copy failure must be recoverable without restoring stale entity state.

**Acceptance criteria:**

- A clean initial import preserves legacy data and image ownership.
- Re-running after editing destination brands and posts does not silently erase those changes.
- Re-running after creating a newer revision, approving, publishing, or recording metrics preserves a consistent current entity, immutable history, and approval state.
- Retrying after an interrupted image copy completes missing files without rewinding destination edits.
- Migration documentation accurately states the selected conflict behavior and any explicit overwrite option.

### VM-04 — Enable verified TLS for hosted Postgres

**Locations:** `src/lib/db.ts:23–31`; `.env.example:26–27`; hosted database setup in `README.md`.

**Problem:** The `postgres` client is created without an `ssl` option. The documented Supabase transaction-pooler URL also omits an SSL mode. The installed client's resolved configuration therefore has TLS disabled. A project accepting non-SSL connections can receive database credentials and application data over an unencrypted connection; a project enforcing SSL will reject this configuration.

**Observed evidence:** Constructing the installed `postgres` 3.4.9 client with the documented URL shape and current options produced `client.options.ssl === false`. This check did not connect to a live database. Supabase documents that non-SSL database and pooler connections are allowed unless SSL enforcement is enabled: [SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).

**Implementation direction:** Require encrypted, certificate-verified connections for hosted remote Postgres and document the necessary URL, SSL mode, or CA configuration. Handle deliberately local development connections explicitly. Do not introduce `rejectUnauthorized: false` or an insecure fallback to make connection errors disappear.

**Acceptance criteria:**

- Following `.env.example` and the README creates a hosted client with TLS enabled and certificate verification configured.
- Invalid or untrusted certificates fail closed.
- Local PGlite continues working without cloud environment variables; any supported local Postgres exception is explicit.
- Tests check the resolved configuration and rejection behavior without exposing credentials. When a staging Supabase project is available, verify a real connection with SSL enforcement enabled.

### VM-05 — Separate export storage limits from image upload limits

**Locations:** `src/lib/files.ts:18,55–76`; `src/app/api/export/[id]/route.ts:104–115`.

**Problem:** The automatically created private bucket has a `fileSizeLimit` of `UPLOAD_BYTES` (20 MiB). It accepts images and ZIPs, and the export route uploads its complete generated ZIP to that same bucket. A valid slideshow can generate a ZIP exceeding the image upload limit and then fail during export.

**Observed reproduction:** An owned 1080 × 1920 noise JPEG of approximately 1,819,383 bytes was used in a supported legacy 20-slide image-only post. Approval returned 200. Its generated ZIP was 29,955,333 bytes, exceeding the configured bucket cap of 20,971,520 bytes. A storage adapter simulating that cap rejected the write and export returned 500. The ZIP was actually rendered and generated; Supabase size enforcement was simulated, not tested against a live bucket. Although new-post creation caps slides at 10, the schema still accepts legacy posts with up to 20 slides.

Supabase applies bucket upload restrictions to objects: [Creating buckets](https://supabase.com/docs/guides/storage/buckets/creating-buckets).

**Implementation direction:** Give export artifacts suitable storage capacity, for example through a separate private export bucket with an appropriate limit. Keep the 20 MiB restriction on browser image uploads and account-scoped signed upload/download access. Respect the project's actual global storage limits. Provide an actionable error for packages outside supported capacity. Existing buckets need an explicit configuration or migration path because the current initializer returns immediately when a bucket already exists.

**Acceptance criteria:**

- A valid approved slideshow producing a ZIP above 20 MiB can be exported under the supported hosted configuration.
- Image uploads above 20 MiB remain rejected, including direct signed uploads.
- Existing bucket configurations are handled deliberately, not only newly created buckets.
- Export ownership and approval checks remain intact, and smaller packages continue working.
- Keep large downloads on signed storage URLs. Do not route the ZIP bytes through a Vercel Function response; the documented request/response payload limit is 4.5 MB: [Vercel Function limits](https://vercel.com/docs/functions/limitations).

### VM-06 — Correct storage, privacy, and backup copy in both modes

**Locations:** `src/components/studio-views.tsx:279–347` (`SettingsView`); `src/components/studio.tsx` around `159` and `237`.

**Problem:** Hosted settings still display `Local by design`, `This computer only`, and `SQLite + local image files`. They instruct users to stop the app and back up its project data folder. The top bar says `All work stays on this computer`, and settings describe cloud authentication as upcoming. Hosted mode actually uses Supabase authentication, Postgres, and private storage; local mode now uses PGlite rather than SQLite. The existing settings payload already supplies `hosted` and account information.

**Implementation direction:** Use the existing mode information to show accurate storage, account, and backup descriptions. Explain hosted persistence in Supabase and local persistence in the local data folder with embedded Postgres/PGlite. Replace obsolete cloud-authentication copy. Ensure any privacy statement also fits the app's optional AI-provider requests.

**Acceptance criteria:**

- Hosted mode contains no claim that all work or files stay on the current computer.
- Hosted backup instructions apply to the hosted database and object storage rather than a local project folder.
- Local mode identifies the actual current storage implementation and gives applicable backup instructions.
- Cloud authentication is described as available in hosted mode.
- UI coverage or rendered verification checks both modes, including the settings card and persistent workspace/top-bar labels.

## Verification baseline and remaining hosted checks

At the reviewed commit, all 67 existing tests passed, along with type checking, linting, formatting, and the production build. Local verification used Node 24 and isolated local configuration with cloud connection variables removed. These checks did not cover the demonstrated races, destructive re-import, resolved TLS configuration, or oversized remote export behavior.

Before moving the PR out of draft, run the existing checks and the new focused regression tests, then verify these migration flows in a configured staging deployment:

- Sign-up with email confirmation, sign-in, session refresh, and sign-out.
- Direct browser-to-storage upload, including browser CORS and upload size enforcement.
- Approval and signed ZIP download, including a package above 20 MiB under the supported limits.
- Two accounts cannot access each other's API records, uploads, or signed downloads.
- Real hosted database connection with SSL enforcement enabled.

Live Supabase sign-up, email confirmation, and browser storage CORS were not verified during this review. The targeted checks above are outstanding integration verification, not additional confirmed defects.

## Completion record

Fill in one entry per finding as fixes are verified:

| ID    | Fix commit | Regression verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Remaining gap                                                                                                                                                                                              |
| ----- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VM-01 | `84c76de`  | `tests/races.test.ts` wraps the driver to pause one request before its post write. It runs the other request until it finishes or starts a transaction, then resumes the first. No sleeps. Before the fix, two overlapping metrics writes kept `[100]` only, and an overlapping link correction reverted to `/photo/1`. After the fix, both snapshots survive with two audit events, and the corrected URL, `publishedAt`, revision and approval are kept. A rejected metrics update writes no audit event. The fix reads, validates and writes the post and its audit event in one account transaction; no post action reuses a read taken before its lock.                                                                                                                                                | None                                                                                                                                                                                                       |
| VM-02 | `84c76de`  | `tests/races.test.ts`, both orderings. Removal first: save pauses at transaction entry and removal deletes the asset. Before the fix the save then returned 200; now it returns 404 with no post update, revision row or `post.revised` audit event. Save first: save pauses inside its transaction; removal waits for the lock, then keeps the asset (`kept: true`) and its file, and the revision approves. `savePost` checks brand, format and image references inside its transaction, which also covers create and duplicate.                                                                                                                                                                                                                                                                          | None                                                                                                                                                                                                       |
| VM-03 | `487a172`  | `tests/import.test.ts` builds a legacy `studio.sqlite` in the original schema. First import: records, history, approval and the image arrive. Second import, after the destination edited the brand, made revision 2, approved, published and recorded metrics: the brand (name, facts, version 1) and the post are untouched and reported as kept, the approval still validates, revision 2 is intact, and the new legacy post is added. A retry after a failed image copy: nothing was written, and the rerun completes. The import only adds records and reports differing existing ones. A post moves with its revisions and approval or not at all. The import takes the account's advisory lock and copies images before writing records. README documents this behavior; there is no overwrite mode. | None                                                                                                                                                                                                       |
| VM-04 | `7588c4c`  | `tests/database-tls.test.ts`: the documented pooler URL, plain or with `sslmode=require`, resolves to `{ rejectUnauthorized: true, ca }`. A missing CA, or `sslmode=disable`/`allow`/`prefer`, throws. Loopback hosts are the only plain-TCP exception. A TLS handshake against a self-signed test certificate is refused unless that certificate is the configured CA. Hosted requests answer 503 for missing or weak TLS settings. Checked by hand against a local Postgres 15 with `ssl=on`: verify-full with the CA gives `pg_stat_ssl.ssl = true` (TLSv1.3); without the CA it fails with `DEPTH_ZERO_SELF_SIGNED_CERT`.                                                                                                                                                                               | Not yet connected to a real Supabase pooler with SSL enforcement on. The README asks for `DATABASE_CA_CERT` from the dashboard; confirm in staging that the pooler's certificate verifies against it.      |
| VM-05 | `9d850e2`  | `tests/exports.test.ts` uses a stand-in for Supabase Storage that enforces bucket size and type limits. An existing combined bucket is updated to images-only at 20 MiB, and `studio-exports` (ZIP-only, 50 MiB) is created; correctly configured buckets aren't touched. A write over 20 MiB to the image bucket is refused. Through the export route, an approved 18-slide legacy post produces a ZIP over 20 MiB that lands in `studio-exports` and returns a signed link. With `EXPORT_LIMIT_MB=5` the same export returns 413 with guidance. The audit event is now written only once the package is delivered.                                                                                                                                                                                        | Supabase's real size enforcement and signed-upload limits are simulated, not yet tested on a live bucket. Projects on a paid plan must raise the global upload limit to use an `EXPORT_LIMIT_MB` above 50. |
| VM-06 | `9ed719c`  | `tests/workspace-copy.test.ts` renders `SettingsView` in both modes. Hosted shows no "this computer", SQLite or `data/` text, and lists the account email, email sign-in, Supabase Postgres plus private storage, operator-run backups and the OpenAI note; with AI off it shows no `.env.local` hint. Local shows this computer only, PGlite, and backing up `data/` with the app stopped. The test also checks the sidebar and top-bar labels from `workspaceLabels()` and the shared settings subtitle. Local mode was checked visually in the production build. The delete dialog and website hint no longer say "locally" or "this computer".                                                                                                                                                          | Hosted mode was checked through rendered markup, not a signed-in browser session; check it visually in staging.                                                                                            |

All checks pass at `9ed719c`: typecheck, oxlint, Prettier, `next build`, and `npm test` (84 tests on PGlite). The 77 database-backed tests also pass against Postgres 15, each file in a fresh database.
