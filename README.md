# Slideo

Slideo is a private, local slideshow studio inspired by ReelFarm's core workflow. It creates editable photo-carousels from reusable formats, requires approval for each exact revision, and exports an ordered TikTok-ready package for manual publishing.

## Run it

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), or the port printed in your terminal if 3000 is occupied. The server binds to loopback and API routes reject non-local hosts and cross-origin requests.

The app works without an AI provider. To enable website ideas and AI writing, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY`, and restart the server. `OPENAI_MODEL` defaults to `gpt-5.6-luna` and can be overridden. API keys stay on the server.

## Current workflow

1. Fill in the starter brand brief (or add your own) with your product, audience, tone, and verified facts.
2. Upload images you own or are licensed to use, recording their rights. **Edit details** on an image updates its name, collection, or rights; removing an image hides it from pickers while slideshows that already use it keep it.
3. Create a manual or AI-assisted draft from a reusable format.
4. Edit the slide copy, layout, colors, background images, caption, account, and planned time.
5. Render the final JPEG preview and approve that exact revision.
6. Download the ZIP, publish it manually in TikTok, and record the public URL (a `tiktok.com` or `vm.tiktok.com` share link) and metrics. Each results entry is kept as a snapshot; the CSV export has one row per snapshot.

Edits after approval create a new revision and revoke approval. The planned posting time is part of the approval, so **Add to queue** on an approved post offers **Save and approve again**. A ZIP cannot be downloaded until its current render is approved.

**Delete** moves a slideshow to the **Deleted** tab, where it can be restored for review. Published posts can't be deleted: they stay in Results with their link and metrics. A recorded TikTok link can be changed only through **Correct TikTok link**.

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

All user data is stored under `data/` by default:

- `data/studio.sqlite` holds briefs, formats, posts, immutable revisions, approvals, metrics, and audit events.
- `data/assets/` holds normalized uploaded images.
- `data/renders/` holds revision-specific JPEGs.

Stop the app and back up the entire `data/` directory together. Set `STUDIO_DATA_DIR` to use a different location.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) runs these plus a Prettier check and `npm audit --omit=dev` on every pull request. Linting uses [oxlint](https://oxc.rs), because `typescript-eslint` does not support TypeScript 7.

The first release covers local authoring and manual export. Recurring generation, MP4 export, cloud authentication, and publishing-provider integration remain later milestones in [PRD.md](./PRD.md).
