# Slideo

Slideo is a private slideshow studio inspired by ReelFarm's core workflow. It creates editable photo-carousels from reusable formats, requires approval for each exact revision, and exports an ordered TikTok-ready package for manual publishing. Run it on your own computer, or host it on Vercel with Supabase so other people can sign up and use it.

## Run it

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), or the port printed in your terminal if 3000 is occupied. Without Supabase settings the studio is single-user: the server binds to loopback, API routes reject non-local hosts and cross-origin requests, and data lives in an embedded Postgres ([PGlite](https://pglite.dev)) under `data/`. No database server is needed.

The app works without an AI provider. To enable website ideas and AI writing, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY`, and restart the server. `OPENAI_MODEL` defaults to `gpt-5.6-luna` and can be overridden. API keys stay on the server.

## Host it on Vercel

A hosted studio has accounts: people sign up with an email and password, and each account sees only its own brands, formats, slideshows, images, and AI allowance. Supabase provides sign-in, the data, and file storage. The studio talks to Supabase only over its HTTPS APIs, so there is no database password, connection string, or certificate to configure.

1. **Create or select a Supabase project.**
2. **Turn on the Data API** (**Project Settings → Data API**), with `public` among the exposed schemas. You can leave automatic exposure of new tables off: the setup script grants exactly what the studio needs.
3. **Install the schema once.** Open **SQL Editor → New query**, paste the contents of [`supabase/migrations/20261014013833_slideo_api.sql`](supabase/migrations/20261014013833_slideo_api.sql), and run it. (With the Supabase CLI linked to the project, `supabase db push` does the same.) It creates the tables, the `slideo_*` functions the studio calls, and the two private buckets. Running it again is safe: it adds what is missing and never removes data. A project set up by an earlier preview of this branch upgrades the same way, keeping its rows.
4. **Configure sign-in.** In **Authentication → URL Configuration**, set the Site URL to your Vercel domain and add `https://<your-domain>/auth/confirm` (and your preview domains' `/auth/confirm`) to the redirect URLs. Sign-up confirmations and password reset links both return there, so there is nothing more to add for password recovery. Before anyone outside your Supabase team signs up, set up your own email sender; see "Email and password recovery" below.
5. **Add three environment variables in Vercel** (all from **Project Settings → API Keys**; see `.env.example`), plus `OPENAI_API_KEY` if you want AI writing:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: public, used by browsers to sign in.
   - `SUPABASE_SECRET_KEY`: server-only. Mark it **Sensitive** and never give it a `NEXT_PUBLIC_` prefix.
6. **Deploy a preview** and test it: sign up and confirm the email, upload an image, create and approve a slideshow, download its package, sign out, reset your password from **Forgot your password?**, sign in with the new one, and check that a second account sees none of the first one's work.

### Email and password recovery

Supabase sends the sign-up confirmations and password reset emails. Its built-in sender is for trying things out: it delivers only to the email addresses of your Supabase organization's team members, and only a couple of messages an hour across the whole project. When it runs out, sign-up shows "The studio has sent as many emails as it can for now", and the limit recovers within the hour. To accept anyone's address, add your own SMTP provider under **Authentication → Emails → SMTP Settings** (then raise the hourly limit under **Authentication → Rate Limits**). Don't turn off email confirmation to work around the limit.

**Forgot your password?** on the sign-in page emails a reset link. It answers the same way whether or not the address has an account, so it can't be used to find out who has one; the server log records Supabase's actual reason (such as a rate limit). The link signs the account in on a **Choose a new password** page. Saving the new password signs that browser out (other devices lose their sessions within the hour, once their access token expires) and returns to the sign-in page. The account's id, slideshows, and images are unchanged. Links work once, for an hour (Supabase's **Email OTP expiration**), and only in the browser that asked for them, because that browser holds half of the link's proof. An expired, used, or misplaced link explains what happened and offers a new one.

If people often request a link on one device and open it on another, change the **Reset password** template under **Authentication → Emails** to link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`. The studio accepts that form from any browser. (The Site URL must then be the address people use.)

An account that signs in before confirming its email is told so and offered **Send the confirmation link again**.

Why a secret key as well as the publishable one: rendered slides, approvals, the audit trail, and the AI allowance must be written only by the studio's server, after it renders and checks the slides. Anything a signed-in browser's own session can call, that person can also call outside the app, so browsers get no direct access to the tables, functions, or buckets at all. The server verifies each request's session, then acts for exactly that account with the secret key. If any of the three settings is missing, or the project lacks the setup SQL, the studio answers with a "not fully set up" error and logs the reason; it never falls back to local files.

The setup script creates two private buckets (the studio also checks and corrects their settings when it starts):

- `studio` holds images: uploads, the library, and rendered slides. It accepts JPEG, PNG, and WebP up to 20 MB each, which also limits what a signed upload URL accepts.
- `studio-exports` holds approved ZIP packages, up to 50 MB each (the largest file Supabase's free plan accepts). On a paid plan, raise **Storage → Settings → Upload file size limit** and set `EXPORT_LIMIT_MB` to match. A larger package is refused with a message suggesting single-slide downloads.

Images upload from the browser straight to storage through one-file signed URLs, so they aren't limited by Vercel's 4.5 MB request size; downloads of approved packages use short-lived storage links for the same reason. Neither bucket has storage policies, so a browser can't list, read, or replace anything in them with its session.

`AI_DAILY_CALL_LIMIT` applies to each account. Vercel's free Hobby plan is for non-commercial use; charging for the studio needs a Pro plan.

To copy a workspace from the original SQLite release (`data/studio.sqlite` and `data/assets/`) into a hosted account, run the import with the hosted settings and the account's Supabase user id (from **Authentication → Users**):

```bash
node --env-file=.env.production.local --import tsx scripts/import-sqlite.ts ./data <user-id>
```

It needs the same three settings as the deployment, no database password. Only someone holding the secret key can run it; nobody can import into an account from the app. Without settings or a user id, the same script imports into the current local studio.

The import only adds. Records the account already has are left as they are, even when the SQLite copy differs, and the script lists those. A slideshow is imported together with its revisions and approval in one commit, or not at all, so its history always matches it. Records go over in commits of at most 200 changes. Images are copied before any records, so an import that stops partway can simply be run again; a repeat adds nothing that is already there. To replace an account's data with the SQLite copy instead, delete that data first.

## Current workflow

1. Fill in the starter brand brief (or add your own) with your product, audience, tone, and verified facts.
2. Upload images you own or are licensed to use, recording their rights. **Edit details** on an image updates its name, collection, or rights; removing an image hides it from pickers while slideshows that already use it keep it.
3. Create a manual or AI-assisted draft from a reusable format.
4. Edit the slide copy, layout, colors, background images, caption, account, and planned time.
5. Render the final JPEG preview and approve that exact revision.
6. Download the ZIP, publish it manually in TikTok, and record the public URL (a `tiktok.com` or `vm.tiktok.com` share link) and metrics. Each results entry is kept as a snapshot; the CSV export has one row per snapshot.

Edits after approval create a new revision and revoke approval. The planned posting time is part of the approval, so **Add to queue** on an approved post offers **Save and approve again**. A ZIP cannot be downloaded until its current render is approved.

**Delete** moves a slideshow to the **Deleted** tab, where it can be restored for review. Published posts can't be deleted: they stay in Analytics with their link and metrics. A recorded TikTok link can be changed only through **Correct TikTok link**.

## Format dashboards

Select a format to open its dashboard. **Overview** shows slideshows made with that format; **Schedule** shows its planned posts and their posting details. **Settings** contains the original name, description, writing instructions, slide count, canvas, typography, and color defaults.

**Slideshow Format** holds the slide structure and the designs. Click a slide in the preview to set its label (such as “#5” or “Reveal”), its design (Hook, Content, or CTA), and its text; move, remove, or add slides there too. Manual drafts start with each slide’s text; AI drafts follow each slide’s text as a pattern, and generated hooks follow the first slide’s text. Once a structure is saved it sets the slide count, and the creation modal no longer overrides it. **Reset to a simple outline** removes the structure.

The format has separate Hook, Content, and CTA designs with a live preview. Choose image collections, single/stacked/four-image layouts, darkening, text visibility, font, size, text color, style and its outline, shadow, or background color, position, width, and alignment. Like TikTok and Instagram, the **Background** style draws a rounded blob that hugs each line (a blank line splits it), with adjustable roundness; switching to it turns white text black on a white background (and black text white on black), and picking a background color keeps black or white text readable. Advanced image controls adjust fit, zoom, and position. New drafts snapshot these settings; existing posts and approvals are preserved. A creation-modal slide count or image collection overrides the format default.

**Hooks & Style → Hooks** stores one opening hook per line. **Generate 10 more** accepts an optional prompt. With no prompt, the server reads the supplied website (prefilled from the brand) for context. Generation uses the existing OpenAI configuration and daily attempt limit; review and save the returned hooks before using them. Choose a saved opening hook in the creation modal to preserve it verbatim.

**Tone & Style** controls only the slide text after the opening hook and the caption. It is excluded from the separate hook-generation request. The first slide’s text is the pattern for generated hooks. Brand facts and prohibited claims still apply.

## Photo slideshow editor

The **TikTok photo story** preset creates 9:16 slides with locally bundled TikTok Sans, centered white text, and a black outline. Reference defaults are size 12, width 208, height 34, X 16, Y 197 on a 240-unit canvas (scaled 4.5× to a 1080px export). Longer copy gets a taller, centered box; you can edit every value.

Click a gallery cover to preview the slideshow, then **Edit slideshow**. The Text tab supports multiple text boxes, font weights, size, colors, outline/plain/shadow/background styles, alignment, dimensions, and X/Y coordinates. Drag text to move it or use its bottom-right handle to resize. Undo/redo tracks edits. Grid, shrink, and zoom affect the editing workspace only.

The Image tab controls uploaded background images, fill/crop or fit/letterbox, image zoom and positioning, darkening, and background color. Upload your own photos in Assets; the reference screenshots are design references and are not added to the image library.

Browser and JPEG rendering share the same TikTok font outlines and layout calculations. Text overflow is flagged before export. Existing editorial posts retain their revisions and can be edited or converted using **Apply TikTok style to all slides**. Queue dates are planning reminders; TikTok publishing remains manual.

TikTok Sans v4.000 is from [TikTok’s official font repository](https://github.com/tiktok/TikTokSans), under the SIL Open Font License included at `public/fonts/OFL-TikTokSans.txt`.

## Data and backups

A local studio stores everything under `data/` by default:

- `data/pglite/` is the embedded Postgres database: briefs, formats, posts, immutable revisions, approvals, metrics, and audit events.
- `data/files/local/assets/` holds normalized uploaded images.
- `data/files/local/renders/` holds revision-specific JPEGs.

Stop the app and back up the entire `data/` directory together. Set `STUDIO_DATA_DIR` to use a different location.

A hosted studio keeps the same records in its Supabase project's database, scoped by account, and files in the `studio` and `studio-exports` buckets under each account's folder. Both modes run the same SQL in `supabase/migrations`: the local studio applies it to its embedded database on start. Each change to an account commits atomically through `slideo_commit`, and the database itself keeps revisions and the audit trail append-only and published slideshows unchanged. Supabase's free plan keeps no backups; a paid plan adds daily backups.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs every test on the embedded database. To run the same tests against Supabase's real Data API, Auth, and Storage, start the local stack (Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development) required; `supabase/config.toml` uses ports 55420–55429) and run:

```bash
supabase start
npm run test:supabase
```

That run also includes `tests/hosted.test.ts`, which signs in two accounts and checks uploads, a package over 20 MB, account isolation, and that a browser's own session can't reach the tables, functions, or buckets.

To walk a production build through sign-up, confirmation, uploads, approval, export, account isolation, and password recovery as a browser would, with emails read from the local stack's mail catcher:

```bash
npm run build && npm start   # with the local stack's three values in .env.local
MAILPIT_URL=http://127.0.0.1:55424 node --import tsx scripts/hosted-check.ts http://localhost:3000
```

CI (`.github/workflows/ci.yml`) runs these plus a Prettier check and `npm audit --omit=dev` on every pull request. Linting uses [oxlint](https://oxc.rs), because `typescript-eslint` does not support TypeScript 7.

Recurring generation, MP4 export, and publishing-provider integration remain later milestones in [PRD.md](./PRD.md).
