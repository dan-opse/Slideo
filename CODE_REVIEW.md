# Codebase review — 2026-10-12

Reviewed commit: `ad783b5a7ab0b9467ac8afc8c714d7de0d6752b6`.

This is an actionable handoff for the next coding agent. The review found **12 issues: 3 High, 7 Medium, 2 Low**. The main concern is preserving the exact content the owner reviewed across generation, concurrent edits, export, and publication recording. No application fixes were made during the review.

**Follow-up status:** Fixes reviewed on branch `worktree-code-review-fixes` at `52e22d806364e6d7224879f2b4d55ff36d72efc6`. **10 findings are addressed; R05 and R06 remain partially fixed.** All three High findings are addressed. Two Medium rendering gaps remain: cached JPEGs bypass the new validation, and background-style blobs can extend beyond the canvas without an error. See [remaining gaps](#remaining-gaps--follow-up-at-52e22d8).

The original descriptions and reproduction steps below describe the baseline commit. Completion notes and the follow-up verification distinguish what changed. Browser checks recorded by the fixing agent were not independently repeated during the follow-up.

## Instructions for the fixing agent

- Read `AGENTS.md` and the relevant installed Next.js guides before changing code. This project uses Next.js 16.3.8; do not assume older API behavior.
- Reproduce each issue against the current branch before fixing it. Line references below refer to the reviewed commit and may move.
- Fix the High issues first, then correctness issues, then cleanup. Keep changes focused and preserve the local-only, manual-publication workflow.
- Use isolated temporary `STUDIO_DATA_DIR` directories for tests. Do not modify the owner's real `data/` directory or call a paid AI provider to reproduce these bugs.
- Add meaningful regression coverage for the behavioral fixes. Preserve immutable revisions, approval hashes, published-post immutability, and retained assets.
- Check off findings only after their acceptance criteria pass. Record the fixing commit and verification evidence next to each completed item.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and the formatting check after the applicable changes.

## Verification and scope

The main project's application source, styles, tests, configuration, and documentation were reviewed. Dependency internals, generated outputs, stored user data, and auxiliary `.claude` worktrees were excluded.

At the reviewed commit:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: all 50 tests passed.
- `node_modules/.bin/prettier --check 'src/**/*.{ts,tsx,css}' 'tests/**/*.ts'`: passed.
- `npm run build`: passed.
- `npm audit --omit=dev --audit-level=high`: reported 0 known vulnerabilities.

Local verification used Node v24.21.0; CI specifies Node 22. Runtime reproductions used temporary workspaces. Browser interactions and live AI-provider calls were not tested. The existing green checks do not cover the cases below.

## Prioritized checklist

| ID  | Severity | Status          | Finding                                                          |
| --- | -------- | --------------- | ---------------------------------------------------------------- |
| R01 | High     | Addressed       | Generated text geometry can violate the post schema              |
| R02 | High     | Addressed       | Stale clients export or publish a different revision             |
| R03 | High     | Addressed       | Concurrent brand and format saves lose newer changes             |
| R04 | Medium   | Addressed       | Website DNS validation does not bind the actual connection       |
| R05 | Medium   | Partially fixed | Horizontal glyph overflow is not rejected                        |
| R06 | Medium   | Partially fixed | Unsupported glyphs silently render substitute shapes             |
| R07 | Medium   | Addressed       | Hidden image references allow blank-slide approval               |
| R08 | Medium   | Addressed       | Photo drafts ignore format color defaults without role templates |
| R09 | Medium   | Addressed       | Format previews select removed images                            |
| R10 | Medium   | Addressed       | Large components duplicate request and dialog responsibilities   |
| R11 | Low      | Addressed       | Obsolete editor and landing-page CSS remains loaded              |
| R12 | Low      | Addressed       | Unexpected server errors discard diagnostic information          |

### Tech debt and correctness

#### R01 — High: Generated text geometry can violate the post schema

- [x] Fixed and verified in `61d9a62`. `tests/review-fixes.test.ts` "R01" tests: the reproduction format (Hook size 48, width 20) now creates, renders, approves and re-saves on both aspects with all layers inside the canvas; `fitText` on 120 words at size 48 returns in-bounds geometry with no render problem. Creation also validates the finished post against `postSchema` (422 with an actionable message otherwise).

**Locations:** `src/lib/photo-layout.ts:279` (`fitText`), `src/lib/format-template.ts:91`, `src/app/api/studio/route.ts:438` and `:451`.

`fitText` expands height to fit all lines and centers the result without respecting the canvas or schema bounds. The create handler saves the derived post without parsing it through `postSchema`.

**Reproduction:** Save a valid photo format whose Hook template has `size: 48` and `width: 20`. Create a two-slide manual draft with the topic `A longer valid opening hook about useful everyday ideas`. Creation returns HTTP 200, but the first text layer has `width: 41.6`, `height: 2475`, and `y: -1024`. `postSchema.safeParse` rejects the persisted post. Rendering fails and subsequent ordinary saves are blocked until the geometry is repaired.

**Suggested fix:** Make automatic fitting produce valid geometry or return an actionable error before persistence. Validate the complete generated post after applying its layout. Apply equivalent checks to the editor's Fit box to text operation.

**Acceptance:** Valid format inputs never persist posts that fail `postSchema`. Oversized text is handled deliberately on both canvas aspects, with no negative coordinates or excessive box dimensions.

#### R02 — High: Stale clients export or publish a different revision

- [x] Fixed and verified in `61d9a62`. "R02" test: after revision 2 is approved, export `?revision=1` and publish/correct with `revision: 1` return 409 and leave the post unpublished; matching requests succeed. Browser check: the editor downloads with `?revision=<shown>` and a stale download/publish shows the conflict message.

**Locations:** `src/app/api/export/[id]/route.ts:15`, `src/app/api/studio/route.ts:480`, `src/components/slideshow-editor.tsx:484` and `:1924`.

Export and publication recording identify a post by ID and use its latest approved revision. Neither operation checks which revision the client displayed. The export's concurrency check only detects changes during the request, not a client that was already stale when it began.

**Reproduction:** Window A displays approved revision 1. Window B saves and approves revision 2. Window A downloads or records a TikTok URL. Both operations succeed against revision 2. An isolated endpoint reproduction returned a ZIP manifest with revision 2 for a revision-1 client; a publication request containing `revision: 1` also returned HTTP 200 with revision 2 because the field is ignored.

**Impact:** The downloaded content may differ from the preview. Recording a URL for an already exported revision can mark different content as published and permanently make that newer revision immutable.

**Suggested fix:** Send and enforce the expected revision for export and publication recording, including link correction as appropriate. Check it against the current approved revision within the relevant transaction/validation boundary. Return a stale-revision conflict instead of silently substituting content.

**Acceptance:** A stale revision-1 export or publication request after revision 2 is approved returns a conflict without changing publication state. Matching-revision requests still succeed; edits during export remain rejected.

#### R03 — High: Concurrent brand and format saves lose newer changes

- [x] Fixed and verified in `61d9a62`. "R03" test: stale brand and format saves return 409 and keep window A's facts/hooks; unversioned updates conflict; fresh saves succeed. Browser check: brand and format saves advance `version`, and a stale save shows "changed in another window".

**Locations:** `src/app/api/studio/route.ts:248` and `:256`, `src/lib/store.ts:62`.

Brand and format updates replace complete records without version checks. Post saves already detect stale revisions, but these settings do not.

**Reproduction:** Read the same brand into windows A and B. A saves new verified facts. B changes only the name and submits its stale complete record. A's facts disappear. This was reproduced through the brand endpoint. Format saves use the same replacement pattern, so stale saves can similarly erase hooks, structures, or template settings.

**Suggested fix:** Add an optimistic version or equivalent expected-state token, check it atomically, and return a conflict for stale updates. Update the corresponding UI save flows.

**Acceptance:** Two clients starting with the same record cannot silently overwrite each other's changes. A stale save conflicts and preserves the first client's facts/hooks/templates; fresh saves succeed.

#### R04 — Medium: Website DNS validation does not bind the actual connection

- [x] Fixed and verified in `61d9a62`. "R04" test: `pinnedLookup` answers only validated addresses; `pinnedTransport` to an unresolvable `.example` host reaches the pinned local listener (so DNS was never consulted); each redirect hop receives its own validated addresses. Live smoke test: https://example.com reads correctly and a certificate/name mismatch is rejected.

**Locations:** `src/lib/website.ts:82`, `:134`, and `:140`.

The code checks DNS answers for public addresses, discards those answers, then passes the hostname to ordinary `fetch`. The transport independently resolves it again. Changing DNS answers can undermine the non-public-address restriction.

**Evidence:** With the validation lookup returning a public address, an intercepted transport-level `dns.lookup` was still called for the hostname. The interception aborted before any connection. No live hostile-domain exploit or private-service access was attempted.

**Suggested fix:** Bind each connection to validated address results while preserving TLS hostname verification and the correct host header. Validate and bind every redirect hop too. Do not replace this with another unbound preflight lookup.

**Acceptance:** The connection cannot use an unvalidated private/local address even if DNS answers change between validation and transport. Existing redirect, HTTPS, byte-limit, and timeout protections remain intact.

#### R05 — Medium: Horizontal glyph overflow is not rejected

- [ ] Partially fixed in `61d9a62`; reopened after follow-up at `52e22d8`. The original `W` reproduction now reports overflow and `renderPhotoSlide` returns 422; ink drawn above the canvas is rejected; ordinary wrapping passes. Background-style bounds are still omitted, and cached JPEGs can skip render validation. Complete both [remaining gaps](#remaining-gaps--follow-up-at-52e22d8) before closing this finding.

**Locations:** `src/lib/photo-layout.ts:94` and `:132`, `src/lib/photo-render.ts:105`.

Long-word splitting still accepts an individual character wider than the available line width. The layout's overflow flag checks height only, and the renderer checks nominal box bounds rather than the drawn glyph bounds.

**Reproduction:** Use `defaultText('W', 'text')` with `style: 'plain'`, `size: 48`, `x: 220`, `width: 20`, `y: 0`, and `height: 100`. The measured width is 48.288 units, yet `overflow` is false and `renderPhotoSlide` succeeds. Part of the character falls beyond the canvas.

**Suggested fix:** Detect horizontal glyph overflow and account for alignment and drawing effects where they extend beyond nominal bounds.

**Acceptance:** A glyph wider than its box, or drawn outside the canvas, produces an actionable error rather than an approved clipped export. Ordinary wrapping continues to work.

#### R06 — Medium: Unsupported glyphs silently render substitute shapes

- [ ] Partially fixed in `61d9a62`; reopened after follow-up at `52e22d8`. Fresh rendering reports emoji and CJK copy ("The font can’t draw …") and returns 422; zero-width and variation-selector characters are dropped; supported punctuation and accents pass. An old cached emoji JPEG still bypasses these checks and can be approved. Complete [gap A](#gap-a--medium-cached-jpegs-bypass-the-new-validation-r05r06) before closing this finding.

**Location:** `src/lib/photo-layout.ts:121`.

The bundled font is used to draw every character without a font-coverage check. Unsupported characters become the font's missing-glyph shape.

**Reproduction:** `photoFont().charToGlyphIndex('😀')` returns 0; both characters in `中文` also return 0. A photo slide containing the emoji renders successfully instead of reporting unsupported copy.

**Suggested fix:** Detect missing glyphs and either report the unsupported characters or use a deliberate supported fallback shared by browser and export. Handle whitespace and nonprinting characters appropriately.

**Acceptance:** Unsupported text cannot silently pass rendering/approval as substitute shapes. Supported text remains deterministic across preview and export.

#### R07 — Medium: Hidden image references allow blank-slide approval

- [x] Fixed and verified in `61d9a62`. "R07" test: hidden references (grid `none`, or beyond a `split` grid) cannot approve a blank slide; a visible image-only slide approves. The editor now trims slot references when the grid shrinks.

**Locations:** `src/lib/store.ts:194`, `src/lib/format-template.ts:129` and `:135`, `src/components/slideshow-editor.tsx:1515`.

Approval treats all stored asset IDs as visible content, but `imageSlots` renders only the slots selected by `imageGrid`. Switching from a four-image grid to a two-image grid retains hidden extra IDs.

**Reproduction:** Save a photo slide with empty title/body, no text layers, `assetId: null`, `imageGrid: 'none'`, and `additionalAssetIds: [anExistingAssetWithRights]`. There are zero rendered image slots. The full render-and-approve endpoint nevertheless returns HTTP 200 and marks this blank slide approved. Hidden leftover IDs after changing grid sizes can cause the same issue.

**Suggested fix:** Determine emptiness and applicable rights checks from visible rendered slots. Normalize inactive slot references when changing grid mode without breaking retained historical revisions.

**Acceptance:** Blank slides with only hidden references cannot approve. Visible image-only slides and intentionally empty grid slots still work.

#### R08 — Medium: Photo drafts ignore format color defaults without role templates

- [x] Fixed and verified in `61d9a62`. "R08" test: a template-less format with `#ff0000`/`#000000` creates slides with those colors, matching the preview; the preset keeps black/white.

**Locations:** `src/lib/photo-layout.ts:302`, `src/app/api/studio/route.ts:438`, `src/components/format-dashboard.tsx:409`.

When a photo format has no explicit role templates, draft creation uses `photoSlide`, which resets background to black and text to white. The format preview always uses `templateSlide`, whose fallback considers format defaults.

**Reproduction:** Save a photo format with `color: '#ff0000'`, `ink: '#000000'`, and no `templates`. Create a manual draft. Its background is `#000000` and text-layer color is `#ffffff`.

**Suggested fix:** Use consistent default/template resolution for preview and creation. Keep the preset's intended defaults while honoring deliberately edited format defaults.

**Acceptance:** Saved photo defaults apply to new drafts even before any role template is customized. Preview and generated drafts agree; existing revisions remain unchanged.

#### R09 — Medium: Format previews select removed images

- [x] Fixed and verified in `61d9a62`. "R09" test: `templateSlide` skips a removed asset ahead of an active one.

**Locations:** `src/components/format-dashboard.tsx:409`, `src/lib/format-template.ts:82`, `src/app/api/studio/route.ts:402`.

The dashboard passes all `state.assets` to `templateSlide`, including removed assets. Creation correctly filters removed assets out first.

**Reproduction:** Supply a collection containing a removed asset followed by an active asset to a role template. The dashboard preview selects the removed asset; draft creation selects the active one. This was reproduced directly against `templateSlide` using the two caller inputs.

**Suggested fix:** Filter the dashboard's selectable preview library consistently with creation. Preserve removed images when displaying existing posts that already reference them.

**Acceptance:** New-format previews never select removed images and match creation for the same active collection. Historical posts retain their removed images.

### Duplication and structure

#### R10 — Medium: Large components duplicate request and dialog responsibilities

- [x] Fixed and verified in `7dc94af`. Shared `request.ts`/`dialog.ts`; `studio.tsx` 2,235 → ~550 lines with views and dialogs in their own files; the editor's controls and action sheets are extracted. Browser check (production build): modal focus, Tab wrap, Escape and focus restoration; dropdown Escape closes only the menu; editor unsaved-changes sheet and focus trap; format dashboard scroll lock, close confirmation and its focus trap; upload, approve, download and publish flows.

**Locations:** `src/components/studio.tsx:89`, `:168`, and `:843`; `src/components/slideshow-editor.tsx:59` and `:179`; `src/components/format-dashboard.tsx:137`.

`studio.tsx` has 2,235 lines, the slideshow editor 1,968, and the format dashboard 1,428. Request parsing/error handling and dialog/focus behavior are repeated while distinct views and editing responsibilities are bundled together.

**Suggested cleanup:** Extract a shared request helper and reusable dialog behavior, then separate major studio views and editor panels. Preserve intentional differences between the dialogs and respect portalled dropdowns/color pickers.

**Acceptance:** Refactoring preserves existing behavior and improves ownership of state and requests. Verify keyboard navigation, focus restoration, unsaved-change prompts, and portal interactions; do not merely move all state into another oversized component.

### Dead code

#### R11 — Low: Obsolete editor and landing-page CSS remains loaded

- [x] Fixed and verified in `34faaed`. A selector scan of all `.ts`/`.tsx` sources (accounting for the `fd-page-`/`photo-panel-`/variant-built classes) shows no remaining unused selectors; `.draft-canvas`, `.draft-copy` and `.legacy-slide` are kept. About 800 lines removed.

**Locations:** `src/app/globals.css:481` and `:1691`, `src/app/format-dashboard.css:863`.

Old landing-page and editor selectors, including `.hero-card`, `.editor-overlay`, `.editor-header`, `.slide-rail`, and inspector styles, have no corresponding current markup. `.fd-font-controls` is also unused. These rules and related responsive overrides remain in globally loaded stylesheets.

**Suggested cleanup:** Remove proven-unused selectors and obsolete responsive rules. Do not remove the shared `.draft-canvas` and legacy-slide styles that the current slideshow editor still uses. Account for dynamically constructed classes before deleting selectors.

**Acceptance:** No active selector is removed; the current studio and legacy editorial editing retain their desktop/mobile layouts.

### Readability and diagnostics

#### R12 — Low: Unexpected server errors discard diagnostic information

- [x] Fixed and verified in `61d9a62`. "R12" test: a corrupt image produces a 500 with the unchanged generic body, while the log carries the operation, post/revision/slide, message, stack and a reference; secrets such as `sk-…` keys are redacted.

**Locations:** `src/app/api/studio/route.ts:538`, `src/app/api/export/[id]/route.ts:80`, `src/app/api/render/[post]/[revision]/[slide]/route.ts:31`.

Unexpected failures log only the exception name, often just `Error`. This makes filesystem, database, and rendering failures hard to distinguish or debug. The client-facing messages are appropriately generic.

**Suggested cleanup:** Retain useful structured server diagnostics or a sanitized stack/error code and operation context. Continue redacting secrets and keep server paths and internals out of HTTP error bodies.

**Acceptance:** A representative unexpected failure can be diagnosed from server logs without exposing sensitive values or changing sanitized client responses.

### Fix verification — 2026-10-12

The branch contains fixes for all twelve original findings, but the follow-up does **not** confirm complete resolution of R05/R06. R01–R04 and R07–R12 are addressed. The high-priority fixes enforce valid generated geometry, the exact client revision for export/publication, and version checks for brand/format saves. The branch also pins website connections, checks fresh-render glyphs, uses visible images for approval, honors photo color defaults, excludes removed preview assets, shares request/dialog helpers, removes obsolete CSS, and improves server diagnostics.

Independently rerun against `52e22d8` using Node v24.21.0:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: all **61 tests passed**, including 11 new review regression tests. The R04 test initially failed because the sandbox blocked its temporary loopback listener; rerunning with the listener permitted passed.
- `npm run build`: passed.
- `node_modules/.bin/prettier --check 'src/**/*.{ts,tsx,css}' 'tests/**/*.ts'`: passed.

API callers now send `expected` for brand/format updates, `revision` for publication, and `?revision=` for exports. Client callers were inspected for those changes. Browser interactions and live provider calls were not independently retested. The dependency audit was not rerun during this follow-up. Additional isolated reproductions confirmed both gaps below despite the green checks. No application code was changed during verification.

### Remaining gaps — follow-up at `52e22d8`

#### Gap A — Medium: Cached JPEGs bypass the new validation (R05/R06)

- [ ] Validate cached revisions and cover the renderer transition with a regression test.

**Current locations:** `src/lib/render.ts:33`, `src/lib/photo-layout.ts:10`, and `src/app/api/studio/route.ts:501`.

`renderSlide` returns an existing JPEG before `renderPhotoSlide` runs `textProblem`. `PHOTO_RENDER_VERSION` remains `3`, the same value as the baseline, so existing `*-photo-v3.jpg` files are still reused. Fixes to fresh rendering do not protect this cache-hit path.

**Reproduction:** In a temporary workspace, save a schema-valid photo post containing `defaultText('😀', 'emoji-text')`. Produce its JPEG with the baseline renderer and place it at `renders/<postId>-<revision>-0-photo-v3.jpg`. On the fix branch:

1. Calling `renderPhotoSlide` directly returns 422: `Slide 1: The font can’t draw “😀”. Remove or replace it.`
2. Calling `renderSlide` returns exactly the baseline cached bytes.
3. Calling the full `approve` endpoint returns HTTP 200 and marks the post `approved`.

This was independently reproduced using the actual baseline and branch renderers. The cache-hit path likewise skips the overflow checks added for R05. The existing tests use fresh caches for these validation cases and do not cover upgrading a workspace with old renders.

**Suggested fix:** Enforce current renderability checks even when a JPEG is cached. Advance the renderer version when drawing behavior changes, keeping disk/browser caches consistent. Handle existing approval hashes deliberately: preserve immutable content/history and require owner review where needed rather than silently rewriting approvals.

**Acceptance:** Old cached unsupported or clipped text cannot pass rendering, approval, or export merely because its JPEG exists. Valid retained revisions remain usable under the documented approval rules. Add regression coverage starting with a baseline cached JPEG, not just a fresh render.

#### Gap B — Medium: Background-style blobs can clip past the canvas (R05)

- [ ] Include background-path bounds in text validation and add an edge-case regression test.

**Current locations:** `src/lib/photo-layout.ts:169` (`effectBounds`), `:195` (`textProblem`), and `:223` (`backgroundPath`).

`effectBounds` accounts for outline/shadow effects, but a `box` style falls back to the glyph bounds. `backgroundPath` adds padding beyond those glyphs. A text box and its glyphs can fit while the visible background extends off-canvas.

**Reproduction:** Create this valid text layer and evaluate it with the bundled font on the 300-unit portrait canvas:

```ts
const layer = {
  ...defaultText("W", "background-overflow"),
  style: "box" as const,
  size: 24,
  align: "right" as const,
  x: 210,
  y: 50,
  width: 30,
  height: 40,
};
```

The nominal box ends at `240` and the glyph ink ends at `237.232`. The background path reaches **`246.16`**, beyond the **240-unit** canvas. `textProblem(layer, font, 300)` returns `null`, and `renderPhotoSlide` succeeds. This was independently reproduced on the branch.

**Suggested fix:** Include the actual background blob's extent in the shared drawn-bounds check. Cover left/right/top/bottom canvas edges and maintain browser/export agreement.

**Acceptance:** Background-style clipping produces an actionable warning/error before approval/export, or fitting deliberately moves/resizes the layer to keep the complete effect visible. The reproduction above no longer silently succeeds; ordinary in-bounds background styles still render.

### Dependencies

No unused direct dependencies or known production dependency vulnerabilities were found at review time. This is a dated observation, not a guarantee about future advisories.
