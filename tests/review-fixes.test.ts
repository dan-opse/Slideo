// Regression tests for the 2026-10-12 code review findings (R01–R12).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, Brand, Format, Post, Slide } from "../src/lib/schema";
import { closeTestDatabase, sql, useTestDatabase } from "./database";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-review-test-"));
process.env.STUDIO_DATA_DIR = folder;
delete process.env.OPENAI_API_KEY;
const store = await import("../src/lib/store");
await useTestDatabase();
const { POST } = await import("../src/app/api/studio/route");
const { GET: exportRoute } = await import("../src/app/api/export/[id]/route");
const { GET: renderRoute } =
  await import("../src/app/api/render/[post]/[revision]/[slide]/route");
const { renderPhotoSlide, photoFont } = await import("../src/lib/photo-render");
const {
  canvasHeight,
  defaultText,
  fitText,
  layoutText,
  photoTextSvg,
  PHOTO_RENDER_VERSION,
  textProblem,
} = await import("../src/lib/photo-layout");
const { renderSlide } = await import("../src/lib/render");
const { templateFor, templateSlide } =
  await import("../src/lib/format-template");
const { postSchema } = await import("../src/lib/schema");
const { pinnedLookup, pinnedTransport, readWebsite } =
  await import("../src/lib/website");
const { logUnexpected } = await import("../src/lib/log");
const { NextRequest } = await import("next/server");
after(async () => {
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const headers = { host: "localhost:3000", origin: "http://localhost:3000" };
const action = async (body: Record<string, unknown>) => {
  const response = await POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};
const upload = async (color: string, collection: string) => {
  const form = new FormData();
  const file = await sharp({
    create: { width: 300, height: 400, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  form.set("file", new Blob([new Uint8Array(file)]), `${color}.jpg`);
  form.set("collection", collection);
  form.set("rights", "Mine");
  const response = await POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers,
      body: form,
    }),
  );
  return (await response.json()).asset as Asset;
};
const preset = () => store.get<Format>("format", "tiktok-photo");
const create = async (formatId: string, extra: Record<string, unknown> = {}) =>
  action({
    action: "create",
    brandId: "demo-brand",
    formatId,
    topic: "A longer valid opening hook about useful everyday ideas",
    mode: "manual",
    slideCount: 2,
    ...extra,
  });
const approve = async (p: Post) =>
  (await action({ action: "approve", id: p.id, revision: p.revision }))
    .body as Post;
const exportAt = (id: string, revision: number) =>
  exportRoute(
    new NextRequest(
      `http://localhost:3000/api/export/${id}?revision=${revision}`,
      { headers },
    ),
    { params: Promise.resolve({ id }) },
  );

test("R01: oversized template text is fitted to valid geometry on both aspects", async () => {
  for (const aspect of ["story", "portrait"] as const) {
    const base = await preset();
    const id = `tiny-box-${aspect}`;
    await store.put<Format>("format", {
      ...base,
      id,
      aspect,
      templates: {
        hook: { ...templateFor(base, "hook"), size: 48, width: 20 },
        body: templateFor(base, "body"),
        cta: { ...templateFor(base, "cta"), position: "top" },
      },
    });
    const response = await create(id);
    assert.equal(response.status, 200, response.body.error);
    const post = response.body as Post;
    assert.ok(postSchema.safeParse(store.contentOf(post)).success);
    const height = canvasHeight(aspect);
    for (const layer of post.slides.flatMap((s) => s.textLayers ?? [])) {
      assert.ok(layer.x >= 0 && layer.y >= 0, `${aspect} position`);
      assert.ok(layer.x + layer.width <= 240, `${aspect} width`);
      assert.ok(layer.y + layer.height <= height, `${aspect} height`);
    }
    const hook = post.slides[0].textLayers![0];
    assert.ok(hook.size < 48, "oversized copy shrinks to fit");
    // The draft renders and approves; ordinary saves still accept it.
    assert.equal((await approve(post)).status, "approved");
    const saved = await action({
      action: "save",
      id: post.id,
      expected: post.revision,
      data: store.contentOf(post),
    });
    assert.equal(saved.status, 200, saved.body.error);
  }
});

test("R01: Fit box to text never produces out-of-bounds geometry", async () => {
  const font = await photoFont();
  for (const aspect of ["story", "portrait"] as const) {
    const fitted = fitText(
      {
        ...defaultText("word ".repeat(120).trim(), "huge"),
        size: 48,
        x: 230,
        width: 240,
      },
      font,
      aspect,
    );
    const height = canvasHeight(aspect);
    assert.ok(fitted.x >= 0 && fitted.x + fitted.width <= 240);
    assert.ok(fitted.y >= 0 && fitted.y + fitted.height <= height + 1e-9);
    assert.ok(fitted.size >= 6 && fitted.size < 48);
    assert.equal(textProblem(fitted, font, height), null);
  }
});

test("R02: stale export and publication requests conflict instead of substituting", async () => {
  await upload("#336699", "Stale");
  const first = await approve(
    (await create("tiktok-photo", { collection: "Stale" })).body,
  );
  assert.equal(first.status, "approved");
  // Another window saves and approves revision 2.
  const revised = await action({
    action: "save",
    id: first.id,
    expected: first.revision,
    data: { ...store.contentOf(first), caption: "Revision two" },
  });
  const second = await approve(revised.body);
  assert.equal(second.revision, first.revision + 1);

  const staleExport = await exportAt(first.id, first.revision);
  assert.equal(staleExport.status, 409);
  const stalePublish = await action({
    action: "publish",
    id: first.id,
    revision: first.revision,
    url: "https://www.tiktok.com/@me/photo/10",
  });
  assert.equal(stalePublish.status, 409);
  assert.equal((await store.get<Post>("post", first.id)).status, "approved");
  assert.equal(
    (await store.get<Post>("post", first.id)).publishedUrl,
    undefined,
  );
  const missing = await action({
    action: "publish",
    id: first.id,
    url: "https://www.tiktok.com/@me/photo/10",
  });
  assert.equal(missing.status, 400);

  assert.equal((await exportAt(first.id, second.revision)).status, 200);
  const published = await action({
    action: "publish",
    id: first.id,
    revision: second.revision,
    url: "https://www.tiktok.com/@me/photo/10",
  });
  assert.equal(published.status, 200, published.body.error);
  assert.equal(published.body.revision, second.revision);
  const staleCorrection = await action({
    action: "publish",
    id: first.id,
    revision: first.revision,
    url: "https://www.tiktok.com/@me/photo/11",
    replace: true,
  });
  assert.equal(staleCorrection.status, 409);
  assert.equal(
    (await store.get<Post>("post", first.id)).publishedUrl,
    "https://www.tiktok.com/@me/photo/10",
  );
});

test("R03: stale brand and format saves conflict and keep the first save", async () => {
  const brand = await store.get<Brand>("brand", "demo-brand");
  const expected = brand.version ?? 0;
  const a = await action({
    action: "brand",
    data: { ...brand, facts: "Verified fact from window A" },
    expected,
  });
  assert.equal(a.status, 200, a.body.error);
  const b = await action({
    action: "brand",
    data: { ...brand, name: "Renamed in window B" },
    expected,
  });
  assert.equal(b.status, 409);
  assert.match(b.body.error, /another window/);
  const stored = await store.get<Brand>("brand", brand.id);
  assert.equal(stored.facts, "Verified fact from window A");
  assert.equal(stored.name, brand.name);
  const unversioned = await action({
    action: "brand",
    data: { ...brand, name: "No version" },
  });
  assert.equal(unversioned.status, 409);
  const fresh = await action({
    action: "brand",
    data: { ...stored, name: "Renamed after reload" },
    expected: stored.version,
  });
  assert.equal(fresh.status, 200, fresh.body.error);
  assert.equal(fresh.body.facts, "Verified fact from window A");

  await store.put<Format>("format", { ...(await preset()), id: "versioned" });
  const format = await store.get<Format>("format", "versioned");
  const first = await action({
    action: "format",
    data: { ...format, hooks: ["Hook from window A"] },
    expected: 0,
  });
  assert.equal(first.status, 200, first.body.error);
  const stale = await action({
    action: "format",
    data: { ...format, name: "Renamed in window B" },
    expected: 0,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual((await store.get<Format>("format", "versioned")).hooks, [
    "Hook from window A",
  ]);
  const created = await action({
    action: "format",
    data: { ...format, id: undefined, name: "Brand new" },
  });
  assert.equal(created.status, 200, created.body.error);
  assert.equal(created.body.version, 1);
});

test("R04: website connections only use validated addresses", async () => {
  const validated = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];
  const lookup = pinnedLookup(validated);
  const answer = (options: Parameters<typeof lookup>[1]) =>
    new Promise<unknown[]>((resolve, reject) =>
      lookup("attacker.example", options, (error, address, family) =>
        error ? reject(error) : resolve([address, family]),
      ),
    );
  assert.deepEqual(await answer({ all: true }), [validated, undefined]);
  assert.deepEqual(await answer({ family: 4 }), ["93.184.216.34", 4]);
  assert.deepEqual(await answer({ family: 6 }), [validated[1].address, 6]);

  // The hostname cannot resolve (.example is reserved), so a connection to
  // the local listener proves the socket used the pinned address, not DNS.
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await assert.rejects(
    pinnedTransport(
      new URL(`https://unresolvable.example:${port}/`),
      [{ address: "127.0.0.1", family: 4 }],
      AbortSignal.timeout(5000),
    ),
  );
  server.close();
  assert.equal(connections, 1);

  // Each hop is connected with the addresses validated for that hop.
  const hops: [string, string[]][] = [];
  const source = await readWebsite("https://first.example/start", {
    lookup: async (hostname) => [
      {
        address: hostname === "first.example" ? "93.184.216.34" : "1.1.1.1",
        family: 4,
      },
    ],
    transport: async (url, addresses) => {
      hops.push([url.hostname, addresses.map((item) => item.address)]);
      return url.hostname === "first.example"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://second.example/page" },
          })
        : new Response("<title>Second</title><main>Body</main>", {
            headers: { "content-type": "text/html" },
          });
    },
  });
  assert.equal(source.title, "Second");
  assert.deepEqual(hops, [
    ["first.example", ["93.184.216.34"]],
    ["second.example", ["1.1.1.1"]],
  ]);
});

const photo = (layer: Slide["textLayers"]): Slide => ({
  id: "s",
  role: "hook",
  title: "",
  body: "",
  assetId: null,
  background: "#000000",
  ink: "#ffffff",
  accent: "#ffffff",
  font: "tiktok",
  design: "photo",
  align: "center",
  position: "center",
  fontSize: 82,
  overlay: 0.25,
  textLayers: layer,
});

test("R05: glyphs wider than their box or drawn off-canvas are rejected", async () => {
  const font = await photoFont();
  const wide = {
    ...defaultText("W", "text"),
    style: "plain" as const,
    size: 48,
    x: 220,
    width: 20,
    y: 0,
    height: 100,
  };
  assert.equal(layoutText(wide, font).overflow, true);
  assert.match(textProblem(wide, font, 300) ?? "", /does not fit/);
  await assert.rejects(renderPhotoSlide(photo([wide]), "portrait", 0), {
    status: 422,
  });
  // An accented capital at the very top draws above the canvas.
  const accent = {
    ...defaultText("É", "accent"),
    style: "plain" as const,
    size: 48,
    y: 0,
    height: 60,
  };
  assert.equal(layoutText(accent, font).overflow, false);
  assert.match(textProblem(accent, font, 300) ?? "", /past the edge/);
  // Ordinary wrapping still renders.
  const ordinary = defaultText("Ordinary copy wraps onto two lines", "ok");
  assert.equal(textProblem({ ...ordinary, height: 60 }, font, 300), null);
});

test("R06: unsupported characters are reported instead of drawn as boxes", async () => {
  const font = await photoFont();
  for (const text of ["Nice 😀", "中文"]) {
    const layer = defaultText(text, "emoji");
    assert.ok(layoutText(layer, font).missing.length);
    assert.match(textProblem(layer, font, 300) ?? "", /can’t draw/);
    await assert.rejects(renderPhotoSlide(photo([layer]), "portrait", 0), {
      status: 422,
      message: /Slide 1: The font can’t draw/,
    });
  }
  // Invisible format characters are dropped, not drawn.
  const invisible = defaultText("Zero​width ❤️‍", "zw");
  assert.deepEqual(layoutText(invisible, font).missing, ["❤"]);
  const clean = defaultText("Café — “quoted” it’s fine…­", "ok");
  assert.deepEqual(layoutText(clean, font).missing, []);
  assert.equal(textProblem(clean, font, 300), null);
});

test("R05/R06 gap A: cached JPEGs cannot skip render validation", async () => {
  const created = (await create("tiktok-photo")).body as Post;
  const content = store.contentOf(created);
  const emoji = { ...defaultText("Nice 😀", "emoji"), y: 120, height: 40 };
  content.slides[0] = { ...content.slides[0], textLayers: [emoji] };
  const saved = await action({
    action: "save",
    id: created.id,
    expected: created.revision,
    data: content,
  });
  assert.equal(saved.status, 200, saved.body.error);
  const post = saved.body as Post;
  // What the unchecked baseline renderer cached: the emoji drawn as the
  // font's missing-glyph shape, stored under both renderer versions.
  const font = await photoFont();
  const height = canvasHeight(post.aspect);
  const cached = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${post.aspect === "story" ? 1920 : 1350}" viewBox="0 0 240 ${height}"><rect width="240" height="${height}"/>${photoTextSvg(emoji, font)}</svg>`,
    ),
  )
    .jpeg()
    .toBuffer();
  mkdirSync(path.join(folder, "files", "local", "renders"), {
    recursive: true,
  });
  for (const version of [3, PHOTO_RENDER_VERSION])
    writeFileSync(
      path.join(
        folder,
        "files",
        "local",
        "renders",
        `${post.id}-${post.revision}-0-photo-v${version}.jpg`,
      ),
      cached,
    );
  await assert.rejects(renderSlide(post.id, post.revision, 0), {
    status: 422,
    message: /Slide 1: The font can’t draw “😀”/,
  });
  const approval = await action({
    action: "approve",
    id: post.id,
    revision: post.revision,
  });
  assert.equal(approval.status, 422);
  assert.equal((await store.get<Post>("post", post.id)).status, "needs_review");
  // An approval recorded from the cached bytes before validation existed
  // cannot be exported either.
  const others = await Promise.all(
    post.slides
      .slice(1)
      .map((_, i) => renderSlide(post.id, post.revision, i + 1)),
  );
  await store.approvePost(
    post.id,
    post.revision,
    [cached, ...others].map(store.digest),
  );
  const exported = await exportAt(post.id, post.revision);
  assert.equal(exported.status, 422);
  assert.match((await exported.json()).error, /can’t draw/);
  // Valid revisions keep rendering, approving and exporting from cache.
  const fixed = await action({
    action: "save",
    id: post.id,
    expected: post.revision,
    data: {
      ...store.contentOf(post),
      slides: post.slides.map((slide, i) =>
        i ? slide : { ...slide, textLayers: [{ ...emoji, text: "Nice" }] },
      ),
    },
  });
  assert.equal(fixed.status, 200, fixed.body.error);
  const valid = fixed.body as Post;
  assert.equal((await approve(valid)).status, "approved");
  const first = await renderSlide(valid.id, valid.revision, 0);
  assert.deepEqual(await renderSlide(valid.id, valid.revision, 0), first);
  assert.equal((await exportAt(valid.id, valid.revision)).status, 200);
});

test("R05 gap B: background blobs past the canvas edge are rejected", async () => {
  const font = await photoFont();
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
  assert.match(textProblem(layer, font, 300) ?? "", /past the edge/);
  await assert.rejects(renderPhotoSlide(photo([layer]), "portrait", 0), {
    status: 422,
  });
  // Left, top and bottom edges too.
  const left = { ...layer, align: "left" as const, x: 0 };
  const top = { ...layer, align: "center" as const, x: 100, y: 0 };
  // The box ends exactly at the canvas edge; its blob's padding does not.
  const bottom = { ...top, y: 300 - 28, height: 28 };
  for (const edge of [left, top, bottom])
    assert.match(textProblem(edge, font, 300) ?? "", /past the edge/);
  // The same glyph without a background, and ordinary background layers
  // away from the edges, still render.
  assert.equal(textProblem({ ...layer, style: "plain" }, font, 300), null);
  const ordinary = { ...layer, align: "center" as const, x: 100 };
  assert.equal(textProblem(ordinary, font, 300), null);
  await renderPhotoSlide(photo([ordinary]), "portrait", 0);
  const copy = defaultText("Ordinary background copy", "box");
  assert.equal(textProblem({ ...copy, style: "box" }, font, 300), null);
});

test("R07: hidden grid references cannot approve a blank slide", async () => {
  const asset = await upload("#55aa22", "Hidden");
  const post = (await create("tiktok-photo")).body as Post;
  const save = async (slide: Partial<Slide>, from: Post) => {
    const saved = await action({
      action: "save",
      id: from.id,
      expected: from.revision,
      data: {
        ...store.contentOf(from),
        slides: from.slides.map((s, i) =>
          i === 0
            ? {
                ...s,
                title: "",
                body: "",
                textLayers: [],
                assetId: null,
                ...slide,
              }
            : s,
        ),
      },
    });
    assert.equal(saved.status, 200, saved.body.error);
    return saved.body as Post;
  };
  const hidden = await save(
    { imageGrid: "none", additionalAssetIds: [asset.id] },
    post,
  );
  const rejected = await action({
    action: "approve",
    id: hidden.id,
    revision: hidden.revision,
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Slide 1 is empty/);
  // Leftovers beyond a split grid are hidden too.
  const split = await save(
    { imageGrid: "split", additionalAssetIds: ["", asset.id] },
    hidden,
  );
  const splitRejected = await action({
    action: "approve",
    id: split.id,
    revision: split.revision,
  });
  assert.equal(splitRejected.status, 400);
  // A visible image-only slide still approves.
  const visible = await save(
    { imageGrid: "split", additionalAssetIds: [asset.id] },
    split,
  );
  assert.equal((await approve(visible)).status, "approved");
});

test("R08: photo formats without role templates keep their saved colors", async () => {
  await store.put<Format>("format", {
    ...(await preset()),
    id: "red",
    color: "#ff0000",
    ink: "#000000",
  });
  const post = (await create("red")).body as Post;
  for (const slide of post.slides) {
    assert.equal(slide.background, "#ff0000");
    assert.equal(slide.textLayers?.[0].color, "#000000");
  }
  // The format preview builds slides the same way.
  const font = await photoFont();
  const preview = templateSlide(
    { ...post.slides[0], textLayers: undefined },
    await store.get<Format>("format", "red"),
    { default: font, semibold: font, regular: font },
    [],
    0,
  );
  assert.equal(preview.background, post.slides[0].background);
  assert.deepEqual(
    JSON.parse(JSON.stringify(preview.textLayers)),
    post.slides[0].textLayers,
  );
  // The preset's defaults are unchanged.
  const preset_ = (await create("tiktok-photo")).body as Post;
  assert.equal(preset_.slides[0].background, "#000000");
  assert.equal(preset_.slides[0].textLayers?.[0].color, "#ffffff");
});

test("R09: format previews never select removed images", async () => {
  const font = await photoFont();
  const base = await preset();
  const format: Format = {
    ...base,
    templates: {
      hook: { ...templateFor(base, "hook"), collection: "Mixed" },
      body: templateFor(base, "body"),
      cta: templateFor(base, "cta"),
    },
  };
  const asset = (id: string, removedAt?: string): Asset => ({
    id,
    name: id,
    collection: "Mixed",
    rights: "Mine",
    width: 10,
    height: 10,
    hash: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(removedAt && { removedAt }),
  });
  const slide = photo([]);
  const preview = templateSlide(
    slide,
    format,
    { default: font, semibold: font, regular: font },
    [asset("removed", "2026-02-01T00:00:00.000Z"), asset("active")],
    0,
  );
  assert.equal(preview.assetId, "active");
});

test("R12: unexpected failures log diagnostics without changing responses", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    const reference = logUnexpected(
      "Provider call",
      new Error("401 Incorrect API key provided: sk-proj-abcdefghijkl123", {
        cause: Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        }),
      }),
      { action: "hooks" },
    );
    assert.match(
      lines[0],
      new RegExp(`Provider call failed \\[${reference}\\]`),
    );
    assert.match(lines[0], /"action":"hooks"/);
    assert.match(lines[0], /Incorrect API key provided: \[redacted\]/);
    assert.match(lines[0], /ECONNRESET/);
    assert.match(lines[0], /"stack":/);
    assert.doesNotMatch(lines[0], /sk-proj/);

    // A corrupt image file is an unexpected render failure.
    const asset = await upload("#aa00aa", "Corrupt");
    const post = (await create("tiktok-photo", { collection: "Corrupt" }))
      .body as Post;
    writeFileSync(
      path.join(folder, "files", "local", "assets", `${asset.id}.jpg`),
      "not a jpeg",
    );
    lines.length = 0;
    const response = await renderRoute(
      new NextRequest(
        `http://localhost:3000/api/render/${post.id}/${post.revision}/0`,
        { headers },
      ),
      {
        params: Promise.resolve({
          post: post.id,
          revision: String(post.revision),
          slide: "0",
        }),
      },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "This slide could not be rendered.",
    });
    assert.match(lines.join("\n"), /Render failed/);
    assert.match(lines.join("\n"), new RegExp(post.id));
    assert.match(lines.join("\n"), /"message":"[^"]+"/);
  } finally {
    console.error = original;
  }
});
