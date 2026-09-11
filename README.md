# Fieldwork

Fieldwork is a private, local slideshow studio inspired by ReelFarm's core workflow. It creates editable photo-carousels from reusable formats, requires approval for each exact revision, and exports an ordered TikTok-ready package for manual publishing.

## Run it

```bash
npm install
npm run dev -- --port 3210
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210). The server binds to loopback and API routes reject non-local hosts and cross-origin requests.

The app works without an AI provider. To enable website ideas and AI writing, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY`, and restart the server. `OPENAI_MODEL` defaults to `gpt-5.6-luna` and can be overridden. API keys stay on the server.

## Current workflow

1. Review the included Pobi brand brief and update it whenever product details or pricing change.
2. Upload images you own or are licensed to use, recording their rights.
3. Create a manual or AI-assisted draft from a reusable format.
4. Edit the slide copy, layout, colors, background images, caption, account, and planned time.
5. Render the final JPEG preview and approve that exact revision.
6. Download the ZIP, publish it manually in TikTok, and record the public URL and metrics.

Edits after approval create a new revision and revoke approval. A ZIP cannot be downloaded until its current render is approved.

## Data and backups

All user data is stored under `data/` by default:

- `data/studio.sqlite` holds briefs, formats, posts, immutable revisions, approvals, metrics, and audit events.
- `data/assets/` holds normalized uploaded images.
- `data/renders/` holds revision-specific JPEGs.

Stop the app and back up the entire `data/` directory together. Set `STUDIO_DATA_DIR` to use a different location.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

The first release covers local authoring and manual export. Recurring generation, MP4 export, cloud authentication, and publishing-provider integration remain later milestones in [PRD.md](./PRD.md).
