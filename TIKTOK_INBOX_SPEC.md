# TikTok inbox delivery: implementation spec

Status: ready to implement. Written 2026-10-17 against `master` at `efed930`.

This document is a hand-off to the agent that builds the feature. Read it end to end before you start, then read `AGENTS.md`: this repo runs Next.js 16, whose APIs differ from older versions. Check `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `16-proxy.md` before you write route handlers.

## 1. What we are building

A signed-in Slideo user connects their TikTok account once. When they approve a slideshow that has a planned time and **Send to my TikTok inbox** selected, Slideo uploads the rendered slides and caption to their TikTok inbox at that time. TikTok sends them a notification. They open it, add a sound, check the caption and visibility, and tap Post in the TikTok app. Slideo follows the upload's status and marks the slideshow **Published** once TikTok reports it posted.

```
approve (revision N, plannedAt, inbox mode)
   └─> delivery "scheduled" ──(cron, plannedAt reached)──> "sending"
         ──init MEDIA_UPLOAD ok──> "processing" ──TikTok fetched images──> "in_inbox"
         ──user taps Post in TikTok──> "posted"  → post.status = "published"
```

### Decisions already made (do not reopen)

- **Inbox upload only** (`post_mode: "MEDIA_UPLOAD"`, scope `video.upload`). No Direct Post (`video.publish`), no automatic public posting. A person always finishes the post in TikTok. This keeps the PRD's rule that nothing is published without the owner's action. It also leaves the TikTok app review simpler and lets the user add a trending sound.
- **Approval covers delivery.** The delivery mode and target account are part of the post's content, so they are part of the approved revision. Changing them creates a new revision and revokes approval, as for every other field.
- **Hosted studios only.** TikTok must fetch the images over public HTTPS from a verified domain, and its redirect URIs must be `https`. The local, loopback-only studio shows the feature as unavailable.
- **Polling, not webhooks, in this version.** TikTok's webhook signature documentation was not readable (HTTP 403). Poll the status endpoint. Webhooks are a later improvement.
- **Manual export and manual link recording keep working** for every post, including inbox ones.

## 2. TikTok facts this design relies on

Sources were read on 2026-10-17. Re-check anything marked *unverified* before you depend on it.

| Topic | Fact | Source |
|---|---|---|
| Upload endpoint | `POST https://open.tiktokapis.com/v2/post/publish/content/init/`, `Authorization: Bearer <user access token>`, `Content-Type: application/json; charset=UTF-8` | [Photo post reference][photo] |
| Body | `{ media_type: "PHOTO", post_mode: "MEDIA_UPLOAD", post_info: { title?, description? }, source_info: { source: "PULL_FROM_URL", photo_cover_index, photo_images: [url…] } }` | [photo] |
| Fields only for Direct Post | `disable_comment`, `auto_add_music`, `brand_content_toggle`, `brand_organic_toggle`; `privacy_level` is required for Direct Post. Send none of these. | [photo] |
| Limits | Up to 35 images. Title at most 90 UTF-16 code units; description at most 4000. Init is limited to 6 requests per minute per access token. | [photo] |
| Pending cap | "There may be at most 5 pending shares within any 24-hour period" (error `spam_risk_too_many_pending_share`) | [photo] |
| App version | `MEDIA_UPLOAD` needs TikTok app 31.8 or later (error `app_version_check_failed`) | [photo] |
| Response | `data.publish_id` (up to 64 characters) | [photo] |
| Image rules | JPEG or WebP, at most 1080p, at most 20 MB each. Slideo renders 1080×1350 and 1080×1920 JPEGs, which qualify. | [Media transfer guide][media] |
| Pull rules | The URL must be `https` and must not redirect (any 3xx is invalid). It must stay reachable while TikTok downloads; the download times out an hour after init. | [media] |
| Ownership | Image URLs must be under a verified **domain** (checked through DNS) or **URL prefix** (`https://host/path/`, matched exactly) in the developer portal. Otherwise you get `url_ownership_unverified` (403). | [media] |
| Status | `POST /v2/post/publish/status/fetch/` with `{ publish_id }`, 30 requests per minute per token. Statuses: `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE` (for uploads, the user posted from the inbox), `FAILED` plus a `fail_reason`. | [Status reference][status] |
| Post id | `publicaly_available_post_id` (sic) is a list, present only after the post is public and has passed moderation, which can take hours. One `publish_id` can produce more than one post. | [status] |
| Sign-in | `https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope=a,b&redirect_uri&state`. The redirect URI must be absolute `https` with no query string or fragment, and is limited to 10 registered URIs. The callback receives `code`, `scopes` and `state`, or `error` and `error_description`. PKCE is not mentioned for web. | [Login Kit web][login] |
| Tokens | `POST https://open.tiktokapis.com/v2/oauth/token/` (form-encoded). The access token lasts 24 hours (`expires_in: 86400`); the refresh token lasts 365 days (`refresh_expires_in`). **A refresh can return a new refresh token: always store the returned one.** `invalid_grant` means the user must reconnect. Revoke with `POST /v2/oauth/revoke/`. | [Token management][tokens] (found by search; the page itself returned 403) |
| Audit | Unaudited apps are limited to private viewing, up to 5 users per 24 hours, and private accounts (`unaudited_client_can_only_post_to_private_accounts`). *Unverified:* whether these limits also apply to `MEDIA_UPLOAD`. Test with a private account. | [Get started][start], [guidelines] |
| Eligibility | Apps must serve a wide audience. Tools for uploading to your own or your team's accounts are not accepted. Slideo qualifies as a public SaaS. | [Content sharing guidelines][guidelines] |

[photo]: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
[media]: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
[status]: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
[login]: https://developers.tiktok.com/doc/login-kit-web
[tokens]: https://developers.tiktok.com/doc/oauth-user-access-token-management
[start]: https://developers.tiktok.com/doc/content-posting-api-get-started
[guidelines]: https://developers.tiktok.com/doc/content-sharing-guidelines

## 3. How the current code works (read these first)

| Area | Where | What matters for this feature |
|---|---|---|
| Storage | `src/lib/db.ts`, `supabase/migrations/20261014013833_slideo_api.sql` | All records are rows in `entities(user_id, kind, id, json)`. The app calls only the `slideo_*` SQL functions, over the Data API with the secret key when hosted, or in-process on PGlite locally. Every function is scoped to one `p_user`. `SCHEMA_VERSION` in `db.ts` must match `slideo_schema_version()`. Migrations are concatenated in filename order and applied to PGlite automatically; hosted operators paste them into the SQL Editor. |
| Writes | `src/lib/store.ts` `transaction()` / `slideo_commit` | Optimistic: a transaction records the account version it read, and the commit fails and retries if another change landed in between. Keep provider calls and other side effects **outside** `transaction()`, and check their results inside it. `put(kind, item)` accepts any lowercase `kind`. `audit(action, id)` appends to the audit trail. |
| Account scope | `withAccount()` (route handlers, seeds the workspace), `asAccount(id, fn)` (no seeding) | The worker and the media route act for a user found in the database. Use `asAccount`. |
| Auth | `src/lib/auth.ts` `authorize()` | Verifies the Supabase session and **refuses `sec-fetch-site: cross-site`**. A top-level redirect back from tiktok.com is cross-site, so the OAuth callback cannot use `authorize()` (see §5.4). `src/proxy.ts` sends signed-out visitors to `/login` except for `/api/*`, `/auth/*` and `/login`. |
| Posts | `src/lib/schema.ts` `postSchema`, `Post` | `status`: `needs_review` → `approved` → `published` (or `archived`). `plannedAt` and `account` are content fields. `publishedUrl` and `publishedAt` already exist. |
| Approval | `store.ts` `approvePost`, `assertApproval`, `savePost` | An approval stores the revision, a hash of `contentOf(post)` and every slide's render hash. `savePost` always writes a new revision and `unapprove`s. `assertApproval(post)` returns the approved render hashes or throws. |
| Published lock | the `slideo_published_post` trigger | Once `status` is `published`, only `publishedUrl`, `metrics` and `metricsHistory` may change. Moving a post into `published` is allowed. |
| Renders | `src/lib/render.ts` `renderSlide`, `renderAll` | These return JPEG buffers and are cached in storage under `renders/`. `src/app/api/export/[id]/route.ts` shows the check to reuse: `renderAll` hashes must equal the approval's `render_hashes`. |
| Files | `src/lib/files.ts` | Private Supabase buckets. Signed URLs live on `*.supabase.co` and redirect-free URLs on your own domain are not available, so TikTok cannot pull from storage directly (§5.6). |
| Studio API | `src/app/api/studio/route.ts` | A single `POST` with `{ action, … }` and an allowlist in `ACTIONS`. The `publish` action records a TikTok link by hand. |
| UI | `src/components/editor-sheet.tsx` (queue and publish sheets), `studio-views.tsx` (`SettingsView`, `PostsView`), `calendar-view.tsx`, `results-view.tsx` | Copy currently says "Publishing is manual." Update it where inbox delivery applies. |
| Test seams | `setBackend()` in `db.ts`, `useFiles()` in `files.ts`, `tests/database.ts` | Add the same kind of seam for the TikTok client. `npm test` runs on PGlite; `npm run test:supabase` runs the same files against a local Supabase stack. |

## 4. Configuration

New environment variables. Add each to `.env.example` with a comment in the existing style, and add them to the README hosting steps.

| Variable | Purpose |
|---|---|
| `TIKTOK_CLIENT_KEY` | From the TikTok developer portal. |
| `TIKTOK_CLIENT_SECRET` | Server-only. Never give it a `NEXT_PUBLIC_` prefix. |
| `TIKTOK_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Derive three subkeys from it with HKDF-SHA256 and distinct `info` strings: token encryption, media-link signing and OAuth-state signing. |
| `APP_URL` | The studio's stable public origin, such as `https://slideo.example.com`. It builds the redirect URI (`${APP_URL}/api/tiktok/callback`) and the media URLs (`${APP_URL}/api/tiktok/media/…`). It must be the origin registered and verified in TikTok. Preview deployments on other hosts cannot use the feature. |
| `CRON_SECRET` | Bearer token the scheduler sends to `/api/tiktok/tick`. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically. |

`tiktokConfig()` in `src/lib/tiktok.ts` returns either the full config or `null`. The feature is **available** only when `hosted()` is true and every variable is set. When it is unavailable, the connect route answers 503, the worker does nothing, and the UI explains why. Fail closed, matching `hostedSettingsProblem()`.

## 5. Design

### 5.1 Post content

Add one optional field to `postSchema` (`src/lib/schema.ts`):

```ts
delivery: z
  .object({
    mode: z.literal("tiktok_inbox"),
    accountId: z.string().min(1).max(100), // a tiktok_account id
  })
  .optional(),
```

It must stay **optional with no default**. Existing posts and revisions don't have the key, so `JSON.stringify(contentOf(post))`, and with it every existing approval hash, stays unchanged. Add a test proving an existing approved post is still exportable after this change. When the field is missing, delivery is manual. The free-text `account` label stays. The editor may prefill it with `@username` when inbox mode is chosen.

### 5.2 New record kinds

All are stored as `entities` rows through `put()`.

**`tiktok_account`**: safe to send to the browser.

```ts
type TikTokAccount = {
  id: string;            // uid()
  openId: string;        // TikTok open_id; one record per open_id per Slideo user
  displayName: string;
  username?: string;     // needs scope user.info.profile; used to build post links
  status: "connected" | "reconnect_needed" | "disconnected";
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
};
```

**`tiktok_token`**: secret. **Never** include it in `slideo_state` or any response.

```ts
type TikTokToken = {
  id: string;            // same id as its tiktok_account
  sealed: string;        // AES-256-GCM of {accessToken, refreshToken}, base64 "v1.iv.tag.data"
  accessExpiresAt: string;
  refreshExpiresAt: string;
};
```

Seal with additional authenticated data `${userId}:${accountId}`, so a blob copied to another row fails to open.

**`delivery`**: one per approved revision that uses inbox mode.

```ts
type DeliveryState =
  | "scheduled"   // waiting for dueAt
  | "held"        // can't send yet (pending cap, reconnect needed); reason in `error`
  | "sending"     // claimed by a worker; nextAt is the lease expiry
  | "processing"  // init accepted; TikTok is fetching images
  | "in_inbox"    // SEND_TO_USER_INBOX; waiting for the user to post
  | "posted"      // PUBLISH_COMPLETE; may still be polling for the public post id
  | "failed"      // terminal until the user retries
  | "unknown"     // init may or may not have reached TikTok; the user decides
  | "expired"     // in the inbox 7 days without being posted
  | "cancelled";  // revision replaced, post deleted, or tracking stopped

type Delivery = {
  id: string;             // `${postId}-r${revision}`
  postId: string;
  revision: number;
  accountId: string;
  state: DeliveryState;
  dueAt: string;          // new Date(plannedAt).toISOString()
  nextAt: string | null;  // when the worker should look next; null = nothing to do
  attempts: number;
  publishId?: string;
  sentAt?: string;
  inboxAt?: string;
  postedAt?: string;
  postIds?: string[];
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};
```

**Always write `dueAt` and `nextAt` with `toISOString()`.** The due query compares them as strings.

### 5.3 Migration (schema version 2)

Add `supabase/migrations/<timestamp>_tiktok_delivery.sql`. Don't edit the first migration. Use a timestamp after `20261014013833`. Keep it safe to re-run, like the first file. It must:

1. Replace `slideo_schema_version()` so it returns `2`, and set `SCHEMA_VERSION = 2` in `db.ts`. Check `tests/hosted*.test.ts` and `scripts/hosted-check.ts` for version assumptions.
2. Add the worker's only query across accounts:

   ```sql
   create or replace function public.slideo_due_deliveries(p_now text, p_limit integer)
   returns json language sql stable set search_path = '' as $$
     select coalesce(json_agg(json_build_object('user_id', d.user_id, 'id', d.id)), '[]'::json)
     from (
       select e.user_id, e.id from public.entities e
       where e.kind = 'delivery'
         and (e.json::jsonb ->> 'nextAt') is not null
         and (e.json::jsonb ->> 'nextAt') <= p_now
       order by e.json::jsonb ->> 'nextAt'
       limit greatest(1, least(p_limit, 200))
     ) d
   $$;
   ```

   Optionally add a partial expression index on `entities ((json::jsonb ->> 'nextAt')) where kind = 'delivery'`.
3. Replace `slideo_state` so it also returns `'deliveries', slideo_list(p_user, 'delivery')` and `'tiktokAccounts', slideo_list(p_user, 'tiktok_account')`. Never return `tiktok_token`.
4. Revoke the new function from `public`, `anon` and `authenticated`, and grant `execute` to `service_role`, inside the same `pg_roles` guard as the first file.
5. Add `slideo_due_deliveries: { p_now: "text", p_limit: "integer" }` to `ARGS` in `db.ts`.

Update README step 3 to say "run every file in `supabase/migrations`, in order".

### 5.4 Connecting a TikTok account

**`src/lib/tiktok.ts`** holds config, the HTTP client, sealing and token refresh. Export a `TikTokApi` interface with these methods: `exchangeCode`, `refresh`, `revoke`, `userInfo`, `initPhotoUpload` and `fetchStatus`. Also export `tiktok()` to get the client and `useTikTok(fake | undefined)` for tests, the same pattern as `useFiles`. Every call has a timeout of about 15 seconds. Errors are a typed `TikTokError { code, httpStatus, logId, definite }`. `definite` is true when TikTok answered with an error body; it is false for timeouts, network errors and 5xx responses with no body.

**Scopes requested:** `user.info.basic,user.info.profile,video.upload`. `user.info.profile` supplies `username` for post links. If the user doesn't grant it, continue without `username`.

**`GET /api/tiktok/connect`** (`src/app/api/tiktok/connect/route.ts`):
- Call `authorize(req)`. Navigation from the studio is same-origin, so it passes. Answer 503 if the feature is unavailable.
- Create `state` from 32 random bytes. Set the cookie `slideo_tiktok_oauth` to a signed `{ state, user: account.id, exp: now + 10 min }`, with `HttpOnly; Secure; SameSite=Lax; Path=/api/tiktok`. It must be `Lax`, not `Strict`, or the cookie won't come back from TikTok's redirect.
- Answer 303 to the TikTok authorize URL. Pass `disable_auto_auth=1` when reconnecting so the user can choose a different account.

**`GET /api/tiktok/callback`**:
- **Do not call `authorize()`.** TikTok's redirect arrives with `sec-fetch-site: cross-site` and would be refused. Instead:
  - Read the session with `sessionAccount(req.cookies.getAll())`.
  - Verify the signature and expiry of the state cookie, and that it names the same user.
  - Compare `state` in constant time.
  - Clear the cookie on every outcome.
  - The CSRF protection here is the state check.
- If the callback carries `error`, redirect to the studio with a readable notice. Never echo `error_description` into HTML unescaped.
- Exchange the code. Require `video.upload` among the granted scopes; otherwise show "Allow uploads to connect TikTok". Then fetch `/v2/user/info/?fields=open_id,display_name,username`.
- In one `transaction()`, upsert `tiktok_account` matched by `openId`, so reconnecting the same TikTok account keeps its id and its deliveries. Write the sealed `tiktok_token` and `audit("tiktok.connected", id)`. Move that account's deliveries that are `held` with code `reconnect_needed` back to `scheduled` with `nextAt = now`.
- Answer 303 to `/` (or to wherever Settings lives) with a success flag the UI turns into a toast.

**Disconnect** is a new studio action, `tiktokDisconnect { id }`. It revokes the token (best effort, outside the transaction), deletes `tiktok_token`, and sets the account to `disconnected`. It moves that account's `scheduled` deliveries to `held` with code `reconnect_needed`, and audits `tiktok.disconnected`.

**Getting a usable access token** (`accessToken(accountId)`): if it expires within 10 minutes, refresh outside a transaction, then save the new pair inside one. If the commit finds that another worker refreshed first, use the stored token instead. **Always store the returned refresh token.** On `invalid_grant`, or a refresh token past its expiry, set the account to `reconnect_needed`, audit it, and throw a `reconnect_needed` error that callers map to `held`.

### 5.5 Approval schedules a delivery; edits cancel it

In `store.ts`:

- **`approvePost`**: when `post.delivery?.mode === "tiktok_inbox"`, in the same transaction:
  - require a non-empty `plannedAt` ("Choose a planned time before approving for TikTok");
  - require the `tiktok_account` to exist with status `connected` ("Reconnect TikTok in Settings before approving");
  - `put("delivery", { id: \`${id}-r${revision}\`, state: "scheduled", dueAt, nextAt: dueAt, attempts: 0, … })` and `audit("delivery.scheduled", deliveryId)`.

  A `plannedAt` already in the past sends on the next tick. The approve dialog should say so.
- **`savePost` and `archivePost`**: find this post's deliveries with `list<Delivery>("delivery")` filtered by `postId`.
  - If any is `sending`, `processing` or `in_inbox`, **refuse** with 409: "This slideshow is on its way to your TikTok inbox. Post it from TikTok, or choose Stop tracking, before editing. You can also duplicate it." This stops one revision sitting in TikTok while Slideo shows another as approved.
  - Otherwise move `scheduled` and `held` deliveries to `cancelled` (`nextAt: null`) and audit `delivery.cancelled`.
- Re-approving the same revision after an unapprove-free path can't happen today, because approval always follows a new revision. Still, make the delivery upsert keep a non-`cancelled` existing record unchanged.

New studio actions, added to `ACTIONS` in `src/app/api/studio/route.ts`. Each runs in a `transaction()` and audits:

| Action | Allowed from | Effect |
|---|---|---|
| `deliveryRetry { id }` | `failed` with `retryable` | → `scheduled`, `nextAt = now`. The worker re-checks approval. |
| `deliveryResend { id }` | `unknown` | → `scheduled`, `nextAt = now`. The UI must warn that this may create a second inbox item. |
| `deliveryStopTracking { id }` | `unknown`, `processing`, `in_inbox`, `held` | → `cancelled`. Unlocks editing. The post keeps its approval, so manual export and link recording still work. |
| `deliverySendNow { id }` | `scheduled`, `held` (not for the pending cap) | Sets `nextAt = now` and runs `processDelivery` for that one delivery inline. Useful when the scheduler is slow, and for testing. |

### 5.6 Serving images to TikTok

**`GET /api/tiktok/media/[token]/[file]`**. `file` is `<index>.jpg`. The route is public and uses no cookies, so don't call `authorize()`. It must answer 200 with the bytes and **never redirect**.

- `token` = `base64url(JSON{ u: userId, d: deliveryId, e: expiryUnixSeconds })` + `.` + `base64url(HMAC-SHA256(mediaKey, payload))`. Verify in constant time and reject expired tokens. Expiry is `sentAt + 2h`: TikTok's pull times out an hour after init.
- Under `asAccount(u)`:
  - load the delivery and require state `sending` or `processing`;
  - load the post and approval with `assertApproval`, and require `post.revision === d.revision`;
  - call `renderSlide(postId, revision, index)` and require `digest(bytes) === approvedHashes[index]`.
- Respond with `Content-Type: image/jpeg`, `Content-Length` and `Cache-Control: no-store`. Every failure answers a plain 404 with no detail.
- The URL prefix to register and verify with TikTok is `${APP_URL}/api/tiktok/media/`. `src/proxy.ts` already leaves `/api/*` and `*.jpg` open.

### 5.7 The worker

**`src/lib/delivery.ts`** exports `runDueDeliveries(now = new Date(), budgetMs = 240_000)` and `processDelivery(userId, deliveryId)`. **`GET /api/tiktok/tick`** checks `Authorization: Bearer ${CRON_SECRET}` in constant time (401 otherwise). It returns 204 when the feature is unavailable, and otherwise calls `runDueDeliveries`. Set `maxDuration = 300` and `runtime = "nodejs"`. It loops over `slideo_due_deliveries(now, 25)` and stops starting new work once the budget is spent. Each delivery runs under `asAccount(user_id)` and its errors are caught and logged with `logUnexpected`, so one bad record never blocks the rest.

`processDelivery` by state:

**`scheduled` / `held`**:
1. **Claim, in `transaction()`**: re-read the delivery and confirm it is still due.
   - Re-validate. The post exists and `post.revision === d.revision`, `post.status === "approved"`, `assertApproval(post)` passes, and `post.delivery?.accountId === d.accountId`. If any check fails, move to `cancelled` with a reason.
   - The account must be `connected`; otherwise move to `held` with `reconnect_needed` and `nextAt: null`.
   - **Pending cap**: count this account's deliveries in `processing` or `in_inbox` whose `sentAt` is within the last 24 hours. If there are 5 or more, move to `held`, with `nextAt` set to the oldest `sentAt + 24h` and the message "TikTok holds at most 5 unposted uploads a day. Post some from your TikTok inbox; Slideo will send this one after <time>."
   - Otherwise move to `sending`, with `attempts + 1` and `nextAt = now + 10 min` as the lease. If two workers race, the optimistic commit lets only one claim through.
2. **Outside the transaction**: run `renderAll(postId, revision)` and compare the hashes with the approval. A mismatch moves to `failed`, not retryable: "The rendered slides changed. Approve the slideshow again."
3. Get an access token (§5.4).
4. Call `initPhotoUpload`:
   - `photo_images` are the signed media URLs from §5.6, in slide order;
   - `photo_cover_index: 0`;
   - `post_info: { description: caption }`, with `caption` already limited to 2200 by the schema;
   - no `title` in this version (see open questions).
5. **Record the outcome in `transaction()`**:
   - Success → `processing`, with `publishId`, `sentAt` and `nextAt = now + 1 min`; audit `delivery.sent`.
   - A definite TikTok error → see §5.8.
   - A non-definite error (timeout, network, 5xx with no body) → `unknown`, with `nextAt: null`, audit `delivery.unknown`. **Never resend automatically**: TikTok has no idempotency key, so a resend may create a second inbox item. This matches PRD requirement DL-04 and the PRD's failure rules.

**`sending` with an expired lease**: the worker died after claiming. Move to `unknown`, for the same reason.

**`processing` / `in_inbox` / `posted`**: call `fetchStatus(publishId)`.
- `PROCESSING_DOWNLOAD` → stay, `nextAt = now + 1 min`.
- `SEND_TO_USER_INBOX` → `in_inbox` (set `inboxAt` once).
  - `nextAt`: +5 min during the first hour after `inboxAt`, +15 min until 24 hours, then +60 min.
  - Seven days after `inboxAt`, move to `expired` with `nextAt: null`. The UI then offers manual link recording.
- `PUBLISH_COMPLETE` → `posted` (set `postedAt` once). Then, in the same transaction, if the post is still at `d.revision` and not yet `published`:
  - set `status = "published"` and `publishedAt = postedAt`;
  - set `publishedUrl` when a post id and `username` are known;
  - `audit("publication.tiktok_confirmed", postId)`.

  Without a post id yet, keep polling every 15 minutes for up to 48 hours. When an id arrives, set `publishedUrl`; the published-post trigger allows that. Then set `nextAt: null`. If `post.revision !== d.revision`, which §5.5 makes impossible except through a race, don't mark the post published; record the post ids on the delivery and audit it.
- `FAILED` → map `fail_reason` (§5.8).
- A status-fetch error that is not definite keeps the state and sets `nextAt = now + 2 min`.

Build the post link as `https://www.tiktok.com/@${username}/photo/${postId}`. *Unverified*: confirm the path segment on a real photo post. It must pass the existing `TIKTOK_POST_URL` check in the studio route.

### 5.8 Error mapping

| TikTok code or `fail_reason` | Delivery result | Message the user sees | Retry |
|---|---|---|---|
| `spam_risk_too_many_pending_share` | `held`, `nextAt + 1h` | "TikTok holds at most 5 unposted uploads a day. Post some from your TikTok inbox." | automatic |
| `rate_limit_exceeded` | keep `scheduled`, `nextAt + 2 min`, don't count the attempt | (none) | automatic |
| `access_token_invalid`, `scope_not_authorized`, `auth_removed`, refresh `invalid_grant` | `held` (`reconnect_needed`); account set to `reconnect_needed` | "Reconnect TikTok in Settings. This slideshow will send once you do." | after reconnecting |
| `app_version_check_failed` | `failed`, retryable | "Update the TikTok app to version 31.8 or later, then choose Retry." | manual |
| `unaudited_client_can_only_post_to_private_accounts` | `failed`, retryable | "While Slideo is waiting for TikTok's approval, your TikTok account must be private." | manual |
| `spam_risk_too_many_posts` | `failed`, retryable | "This TikTok account has reached today's posting limit. Retry tomorrow." | manual |
| `photo_pull_failed`, `internal` | first time: `scheduled`, `nextAt + 5 min`; after that: `failed`, retryable | "TikTok couldn't fetch the slides. Choose Retry." | one automatic, then manual |
| `url_ownership_unverified` | `failed`, retryable; `console.error` an operator message | "This studio's TikTok setup isn't finished. Its operator has been notified." | manual |
| `picture_size_check_failed`, `file_format_check_failed`, `invalid_param` | `failed`, not retryable; log with `log_id` | "TikTok rejected the slides. Download them and post manually." | none (this is a bug) |
| `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk` | `failed`, not retryable | "TikTok declined this upload. Post manually from the TikTok app." | none |
| `publish_cancelled` | `cancelled` | "Cancelled in TikTok." | none |

Log every TikTok error with its `log_id` through `src/lib/log.ts`. Never log tokens, codes or signed media URLs.

### 5.9 Scheduler

The tick endpoint works with any scheduler. Run it every 1–5 minutes. **Vercel's free Hobby plan only allows cron schedules that run at most once a day; a more frequent schedule in `vercel.json` fails the deploy.** So don't commit a `crons` entry. Document these options in the README:

- **Supabase Cron (recommended; free):** enable the `pg_cron` and `pg_net` extensions, store `CRON_SECRET` in Supabase Vault, and schedule `net.http_get('${APP_URL}/api/tiktok/tick', headers := …Bearer…)` every 5 minutes. Put the SQL in the README, **not** in `supabase/migrations`, because PGlite has neither extension and the URL depends on the deployment.
- **Vercel Pro:** add `{"crons":[{"path":"/api/tiktok/tick","schedule":"*/5 * * * *"}]}` to `vercel.json`. Vercel sends `CRON_SECRET` itself.
- **Any external cron service** that can send a bearer header.

A delay of a few minutes is acceptable; the UI says "around" the planned time. Vercel and Supabase cron runs are best effort and can be duplicated. The optimistic claim in §5.7 makes a duplicate harmless.

### 5.10 UI

Use the existing components and copy style: short, plain sentences in the second person. Don't add Slideo branding inside slides; TikTok forbids watermarks and promotional overlays.

- **`StudioState`** (`schema.ts`, `store.ts` `state()`): add `deliveries: Delivery[]` and `settings.tiktok: { available: boolean; reason?: string; accounts: TikTokAccount[] }`.
- **Settings** (`SettingsView`): add a TikTok card.
  - Unavailable: "Available when the studio is hosted" when local, or "TikTok isn't set up on this studio yet" when configuration is missing.
  - Available: a **Connect TikTok** link to `/api/tiktok/connect`, then each account's display name and `@username`, its status, and **Reconnect** and **Disconnect** buttons.
  - Change the "Publishing" row to "Manual export or TikTok inbox, with approval".
- **Queue sheet** (`editor-sheet.tsx`, `sheet === "queue"`): add a choice, "How it gets to TikTok":
  - "I'll download and post it" (the default; removes `delivery`);
  - "Send to my TikTok inbox", with a select of connected accounts. When none is connected, show a link to Settings.
  - Help text: "Around the planned time, Slideo sends the slides and caption to your TikTok inbox. Open TikTok's notification to add a sound and post. You need TikTok 31.8 or later."
  - The existing "part of your approval" warning applies unchanged.
- **Approve button and dialog**: for inbox posts, label the button "Approve and schedule for TikTok". The dialog names the account and time, and says "Sends on the next run" if the time has passed.
- **Delivery status** on post cards (`PostsView`), the calendar detail panel and the editor header. Show the newest delivery for the post's current revision.

  | State | Label | Actions |
  |---|---|---|
  | `scheduled` | "Sends to TikTok around {time}" | Send now |
  | `held` | the reason message | Send now, unless it's the pending cap; Reconnect when relevant |
  | `sending` / `processing` | "Sending to TikTok…" | (none) |
  | `in_inbox` | "In your TikTok inbox. Open TikTok to post it." | Stop tracking |
  | `posted` | "Posted on TikTok" (link once known) | (none) |
  | `failed` | the error message | Retry (if retryable), Download images |
  | `unknown` | "This may have reached your TikTok inbox. Check TikTok before sending again." | It's in my inbox (Stop tracking), Send again |
  | `expired` | "Not posted from your TikTok inbox within 7 days." | Record link manually |
- **Publish sheet**: when a post is `published` with no `publishedUrl` (posted, link not yet known), allow recording the link without the "Correct link" path. In the studio route's `publish` action, change the "already recorded" guard to `current.status === "published" && current.publishedUrl && !replace`.
- **Calendar and other copy**: replace "Publishing is manual" with text that is true for both modes.

## 6. Security checklist

- [ ] Tokens are only ever in `tiktok_token`, sealed with AES-256-GCM and AAD. `slideo_state`, the API responses and the logs never include them.
- [ ] `TIKTOK_CLIENT_SECRET`, `TIKTOK_ENCRYPTION_KEY` and `CRON_SECRET` are server-only, with no `NEXT_PUBLIC_` prefix.
- [ ] The OAuth `state` is random, signed, expires in 10 minutes, is bound to the session user, and is compared in constant time. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and path-scoped.
- [ ] The callback works without `authorize()` and still verifies the Supabase session itself.
- [ ] Media tokens are HMAC-signed, expire, are scoped to one delivery, and are honored only while the delivery is `sending` or `processing`. Bytes must match the approved render hash. Every failure is a bare 404.
- [ ] The tick endpoint requires the bearer secret, compared in constant time.
- [ ] The worker re-checks approval, revision and account status at claim time. It never sends an unapproved or changed revision, and never resends automatically after an ambiguous error.
- [ ] Only the server acts on TikTok. Browsers never receive a TikTok access token or a signed media URL.
- [ ] The new SQL function is executable only by `service_role`.

## 7. Tests

Add `tests/tiktok.test.ts` (and split it if it grows), using a fake `TikTokApi` installed with `useTikTok`. The tests must pass under both `npm test` and `npm run test:supabase`. The feature gate requires `hosted()`; let tests call `processDelivery` and `runDueDeliveries` directly so the gate applies only at the routes and the UI.

- [ ] An existing approved post with no `delivery` key keeps its approval hash and still exports.
- [ ] Approving an inbox post creates a `scheduled` delivery with `dueAt` equal to `plannedAt`. Approval fails without `plannedAt`, or with a disconnected account.
- [ ] Editing or archiving cancels a `scheduled` delivery, and is refused while one is `processing` or `in_inbox`. Stop tracking unlocks editing.
- [ ] The worker skips deliveries that are not yet due. It sends due ones once, and two concurrent runs claim a delivery only once.
- [ ] The worker cancels instead of sending when the revision changed, approval was revoked or the post was archived.
- [ ] A render hash mismatch fails the delivery and makes no init call.
- [ ] The pending cap holds the sixth delivery and resumes it after 24 hours. `spam_risk_too_many_pending_share` also holds.
- [ ] An init timeout becomes `unknown` with no automatic resend. An expired `sending` lease becomes `unknown`.
- [ ] Status mapping: `PROCESSING_DOWNLOAD` → `SEND_TO_USER_INBOX` → `PUBLISH_COMPLETE` publishes the post, and sets `publishedUrl` once a post id arrives. `FAILED` reasons map as in §5.8. The inbox expires after 7 days.
- [ ] A token is refreshed shortly before expiry, and a rotated refresh token is stored. `invalid_grant` marks the account `reconnect_needed` and holds its deliveries. Reconnecting resumes them.
- [ ] The media route: a valid token returns the approved JPEG. Expired tokens, bad signatures, a wrong delivery state, a changed revision or a hash mismatch each return 404. It never answers 3xx.
- [ ] The callback: a state mismatch, a different session user, an expired cookie and an `error` parameter are all refused. A missing `video.upload` grant is refused. Reconnecting the same `open_id` keeps the account id.
- [ ] Tick authorization: a missing or wrong bearer gets 401; an unconfigured feature gets 204.
- [ ] `slideo_due_deliveries` is not executable by `anon` or `authenticated` (in the Supabase test mode; extend the `42501` grant checks in `tests/hosted.test.ts`).
- [ ] The `tiktok_token` kind never appears in `GET /api/studio`.

Before every commit, run `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:supabase` (the local stack uses ports 55420–55429). Run `npm run format` on changed files.

## 8. Milestones

Make each milestone its own commit or commits. Each should be releasable: with the TikTok variables unset, the app behaves exactly as today.

1. **Foundations**: `src/lib/tiktok.ts` (config, client interface, fake seam, sealing, HKDF), the migration to schema v2, `db.ts` `ARGS` and `SCHEMA_VERSION`, record types, and the `postSchema.delivery` field. *Done when* the tests and the hash-stability test pass, and a v1 PGlite database upgrades in place.
2. **Connect and disconnect**: the connect and callback routes, `tiktokDisconnect`, token refresh, the Settings card. *Done when* a fake-backed test connects, refreshes and disconnects, and a real TikTok sandbox account connects on a deployed preview.
3. **Scheduling rules**: the inbox choice in the queue sheet, the `approvePost` hook, cancel and lock rules in `savePost` and `archivePost`, the approve dialog copy. *Done when* the scheduling tests pass.
4. **Sending**: `delivery.ts` claim, render check and init; the media route; the tick route; `deliverySendNow`. *Done when* a real upload reaches a private test account's TikTok inbox through **Send now**.
5. **Following up**: status polling, publishing posts, the error map, the `deliveryRetry`, `deliveryResend` and `deliveryStopTracking` actions, status labels everywhere, the publish-sheet tweak. *Done when* posting from the inbox flips the Slideo post to Published, and `expired` and `unknown` behave as specified.
6. **Docs and review readiness**:
   - README hosting steps, with the scheduler options from §5.9; `.env.example`;
   - update PRD §4 and the Settings copy;
   - public `/privacy` and `/terms` pages, added to the `open` paths in `src/proxy.ts` (TikTok's app registration asks for both; the owner writes the legal text);
   - a short "how Slideo uses TikTok" section to reuse in the review form.

## 9. What the owner must do (not code)

1. Create a TikTok developer account and a **web** app. Add **Login Kit** and the **Content Posting API**, request `user.info.basic`, `user.info.profile` and `video.upload`, and leave Direct Post off.
2. Register the redirect URI `${APP_URL}/api/tiktok/callback`.
3. Under **URL properties**, verify a domain you control (DNS) or the URL prefix `${APP_URL}/api/tiktok/media/`. A `*.vercel.app` host can't be DNS-verified, so a custom domain is the simplest route. *Unverified:* how URL-prefix verification is proven. If TikTok asks for a file at the prefix, the media route needs a small exception to serve it.
4. Set the Section 4 variables in Vercel, marked Sensitive, and set up a scheduler (§5.9).
5. For testing before review: use a **private** TikTok account with app 31.8 or later, and add it as a test or sandbox user if the portal asks.
6. Submit for review with a demo video of the full flow: connect, schedule, approve, inbox notification, post, Published in Slideo.

## 10. Open questions (decide or verify while building)

- **`post_info.title`**: Slideo's `title` is an internal name. Send no title (current plan), the first slide's hook, or an editable field? Ask the owner before milestone 5 if a real upload shows the empty title is a problem.
- **`is_aigc`** (the AI-generated label): the docs don't say whether it is allowed with `MEDIA_UPLOAD`. Leave it out until that is checked; TikTok's own composer can set disclosures.
- Whether the unaudited private-account restriction applies to inbox uploads. Whether the "5 pending" count drops when the user posts, or only after 24 hours. The exact public URL path for photo posts. Whether web Login Kit now expects PKCE. Webhook signature verification, so polling can later be replaced.
- If any of these changes the design, update this document in the same commit.

## 11. Out of scope

Direct Post or any fully automatic public posting; video or MP4 delivery; importing metrics through the `video.list` scope; webhooks; recurring draft generation; more than one TikTok post per `publish_id`; local, non-hosted TikTok support.
