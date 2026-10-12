// Regression tests for the issues found in the pre-update test pass.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, Brand, Format, Post } from "../src/lib/schema";
import { seedSamplePost } from "./sample-post";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-hardening-test-"));
process.env.STUDIO_DATA_DIR = folder;
delete process.env.OPENAI_API_KEY;
const store = await import("../src/lib/store");
const { POST } = await import("../src/app/api/studio/route");
const { GET: renderRoute } =
  await import("../src/app/api/render/[post]/[revision]/[slide]/route");
const { GET: exportRoute } = await import("../src/app/api/export/[id]/route");
const { renderPhotoSlide, photoFont } = await import("../src/lib/photo-render");
const { photoSlide } = await import("../src/lib/photo-layout");
const { describeIssues } = await import("../src/lib/errors");
const { formatSchema } = await import("../src/lib/schema");
const { NextRequest } = await import("next/server");
const sample = seedSamplePost(store);
after(() => {
  store.database().close();
  rmSync(folder, { recursive: true, force: true });
});

const headers = { host: "localhost:3000", origin: "http://localhost:3000" };
const post = (body: BodyInit, extra: Record<string, string> = {}) =>
  POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers: { ...headers, ...extra },
      body,
    }),
  );
const action = async (body: Record<string, unknown>) => {
  const response = await post(JSON.stringify(body), {
    "content-type": "application/json",
  });
  return { status: response.status, body: await response.json() };
};
const upload = async (file: Buffer, fields: Record<string, string>) => {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file)]), "photo.jpg");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await post(form);
  return { status: response.status, body: await response.json() };
};
const jpeg = (color: string, width = 300, height = 400) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
const contentOf = (p: Post) => store.contentOf(p);
const photoPost = async (collection: string) =>
  (
    await action({
      action: "create",
      brandId: "demo-brand",
      formatId: "tiktok-photo",
      topic: "Hardening",
      mode: "manual",
      slideCount: 2,
      collection,
    })
  ).body as Post;
const approve = async (p: Post) =>
  (await action({ action: "approve", id: p.id, revision: p.revision }))
    .body as Post;

test("malformed, null, and unknown requests are client errors with readable messages", async () => {
  for (const body of ["{nope", "null", "[1]"]) {
    const response = await post(body, { "content-type": "application/json" });
    assert.equal(response.status, 400, body);
  }
  const unknown = await action({ action: "bogus" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown action/);
});

test("the JSON size limit counts streamed bytes, not just Content-Length", async () => {
  const big = JSON.stringify({ action: "brand", data: { x: "a".repeat(3e5) } });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  const response = await POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
  assert.equal(response.status, 413);
});

test("uploads require rights, reject unreadable files and bombs, and de-duplicate", async () => {
  const photo = await jpeg("#336699");
  const noRights = await upload(photo, { collection: "Set" });
  assert.equal(noRights.status, 400);
  assert.match(noRights.body.error, /usage rights/);
  const garbage = await upload(Buffer.from("not an image"), { rights: "Mine" });
  assert.equal(garbage.status, 400);
  assert.match(garbage.body.error, /not a readable/);
  const bomb = await sharp({
    create: { width: 8000, height: 8000, channels: 3, background: "#000" },
  })
    .png()
    .toBuffer();
  assert.equal((await upload(bomb, { rights: "Mine" })).status, 413);
  const first = await upload(photo, { collection: "Set", rights: "Mine" });
  const again = await upload(photo, { collection: "Set", rights: "Mine" });
  assert.equal(first.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.asset.id, first.body.asset.id);
});

test("validation messages are human readable and ids must exist", async () => {
  const base = store.get<Format>("format", "tiktok-photo");
  const tooFew = formatSchema.safeParse({ ...base, slideCount: 1 });
  assert.equal(tooFew.success, false);
  assert.equal(
    describeIssues(tooFew.error!.issues),
    "Slide count must be at least 2.",
  );
  const tone = await action({
    action: "brand",
    data: { ...store.get<Brand>("brand", "demo-brand"), tone: "x".repeat(301) },
  });
  assert.equal(
    tone.body.error,
    "Voice & tone must be 300 characters or fewer.",
  );
  const site = await action({
    action: "brand",
    data: {
      name: "N",
      product: "",
      audience: "",
      tone: "",
      facts: "",
      prohibited: "",
      destination: "javascript:alert(1)",
    },
  });
  assert.match(site.body.error, /full web address/);
  const ghost = await action({
    action: "brand",
    data: {
      id: "made-up",
      name: "Ghost",
      product: "",
      audience: "",
      tone: "",
      facts: "",
      prohibited: "",
      destination: "",
    },
  });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.error, /brand brief no longer exists/);
});

test("grid gaps saved as null are accepted and image-only photo slides approve", async () => {
  const { body } = await upload(await jpeg("#aa3300"), {
    collection: "Grid",
    rights: "Mine",
  });
  const p = await photoPost("Grid");
  const slides = p.slides.map((slide, index) => ({
    ...slide,
    textLayers: index === 0 ? [] : slide.textLayers,
    imageGrid: index === 0 ? "quad" : slide.imageGrid,
    additionalAssetIds: index === 0 ? [null, null, body.asset.id] : [],
  }));
  const saved = await action({
    action: "save",
    id: p.id,
    expected: p.revision,
    data: { ...contentOf(p), slides },
  });
  assert.equal(saved.status, 200, saved.body.error);
  assert.deepEqual(saved.body.slides[0].additionalAssetIds, [
    "",
    "",
    body.asset.id,
  ]);
  assert.equal((await approve(saved.body)).status, "approved");
  const blank = await action({
    action: "save",
    id: p.id,
    expected: saved.body.revision,
    data: {
      ...contentOf(saved.body),
      slides: saved.body.slides.map((s: Post["slides"][number]) => ({
        ...s,
        assetId: null,
        additionalAssetIds: [],
        textLayers: [],
      })),
    },
  });
  const rejected = await action({
    action: "approve",
    id: p.id,
    revision: blank.body.revision,
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Slide 1 is empty/);
});

test("published posts cannot be archived; deleted posts can be restored", async () => {
  await upload(await jpeg("#118833"), { collection: "Pub", rights: "Mine" });
  const p = await approve(await photoPost("Pub"));
  const archived = await action({ action: "archive", id: p.id });
  assert.equal(archived.body.status, "archived");
  assert.throws(() => store.assertApproval(archived.body));
  const restored = await action({ action: "restore", id: p.id });
  assert.equal(restored.body.status, "needs_review");
  const again = await approve(restored.body);
  const short = await action({
    action: "publish",
    id: again.id,
    url: "https://vm.tiktok.com/ZMabc123/",
  });
  assert.equal(short.status, 200, short.body.error);
  const blocked = await action({ action: "archive", id: p.id });
  assert.equal(blocked.status, 409);
  const overwrite = await action({
    action: "publish",
    id: p.id,
    url: "https://www.tiktok.com/@me/photo/2",
  });
  assert.equal(overwrite.status, 409);
  const corrected = await action({
    action: "publish",
    id: p.id,
    url: "https://www.tiktok.com/@me/photo/2",
    replace: true,
  });
  assert.equal(
    corrected.body.publishedUrl,
    "https://www.tiktok.com/@me/photo/2",
  );
  assert.equal(corrected.body.publishedAt, short.body.publishedAt);
});

test("results keep earlier snapshots without breaking the approved export", async () => {
  await upload(await jpeg("#884411"), { collection: "Res", rights: "Mine" });
  const p = await approve(await photoPost("Res"));
  await action({
    action: "publish",
    id: p.id,
    url: "https://www.tiktok.com/@me/photo/3",
  });
  const huge = await action({
    action: "metrics",
    id: p.id,
    data: { views: 1e300, likes: null, comments: null, shares: null },
  });
  assert.equal(huge.status, 400);
  for (const views of [10, 20, 30])
    await action({
      action: "metrics",
      id: p.id,
      data: { views, likes: null, comments: null, shares: null },
    });
  const latest = store.get<Post>("post", p.id);
  assert.equal(latest.metrics?.views, 30);
  assert.deepEqual(
    latest.metricsHistory?.map((m) => m.views),
    [10, 20],
  );
  const zip = await exportRoute(
    new NextRequest(`http://localhost:3000/api/export/${p.id}`, { headers }),
    { params: Promise.resolve({ id: p.id }) },
  );
  assert.equal(zip.status, 200);
  const empty = await exportRoute(
    new NextRequest(`http://localhost:3000/api/export/${p.id}?slide=`, {
      headers,
    }),
    { params: Promise.resolve({ id: p.id }) },
  );
  assert.equal(empty.status, 404);
});

test("duplicating a maximum-length title stays within the limit", async () => {
  const p = await photoPost("Res");
  const long = await action({
    action: "save",
    id: p.id,
    expected: p.revision,
    data: { ...contentOf(p), title: "L".repeat(160) },
  });
  const copy = await action({ action: "duplicate", id: long.body.id });
  assert.equal(copy.body.title.length, 160);
  assert.ok(copy.body.title.endsWith(" (copy)"));
  const resave = await action({
    action: "save",
    id: copy.body.id,
    expected: copy.body.revision,
    data: contentOf(copy.body),
  });
  assert.equal(resave.status, 200);
});

test("assets can be edited; removal keeps files that revisions use", async () => {
  const used = (
    await upload(await jpeg("#225588"), { collection: "Keep", rights: "Mine" })
  ).body.asset as Asset;
  await photoPost("Keep");
  const spare = (
    await upload(await jpeg("#552288"), { collection: "Spare", rights: "Mine" })
  ).body.asset as Asset;
  const edited = await action({
    action: "asset",
    id: used.id,
    data: {
      name: "Renamed",
      collection: "Keep",
      rights: "Licensed from a friend",
    },
  });
  assert.equal(edited.body.rights, "Licensed from a friend");
  const kept = await action({ action: "removeAsset", id: used.id });
  assert.equal(kept.body.kept, true);
  assert.ok(store.get<Asset>("asset", used.id).removedAt);
  assert.ok(existsSync(path.join(folder, "assets", `${used.id}.jpg`)));
  const gone = await action({ action: "removeAsset", id: spare.id });
  assert.equal(gone.body.kept, false);
  assert.ok(!existsSync(path.join(folder, "assets", `${spare.id}.jpg`)));
  const fresh = await photoPost("Keep");
  assert.equal(fresh.slides[0].assetId, null, "removed images are not reused");
});

test("bulk asset removal deletes unused images and keeps used ones", async () => {
  const used = (
    await upload(await jpeg("#2266aa"), { collection: "Bulk", rights: "Mine" })
  ).body.asset as Asset;
  await photoPost("Bulk");
  const spare = (
    await upload(await jpeg("#aa6622"), { collection: "Bulk", rights: "Mine" })
  ).body.asset as Asset;
  const result = await action({
    action: "removeAssets",
    ids: [used.id, spare.id],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.deleted.map((a: Asset) => a.id),
    [spare.id],
  );
  assert.deepEqual(
    result.body.kept.map((a: Asset) => a.id),
    [used.id],
  );
  assert.ok(store.get<Asset>("asset", used.id).removedAt);
  assert.ok(existsSync(path.join(folder, "assets", `${used.id}.jpg`)));
  assert.ok(!existsSync(path.join(folder, "assets", `${spare.id}.jpg`)));
  const empty = await action({ action: "removeAssets", ids: [] });
  assert.equal(empty.status, 400);
});

test("render errors use accurate status codes and never expose server paths", async () => {
  const asset = (
    await upload(await jpeg("#993311"), { collection: "Gone", rights: "Mine" })
  ).body.asset as Asset;
  const p = await photoPost("Gone");
  const call = (slide: string) =>
    renderRoute(
      new NextRequest(`http://localhost:3000/api/render/${p.id}/1/${slide}`, {
        headers,
      }),
      {
        params: Promise.resolve({
          post: p.id,
          revision: String(p.revision),
          slide,
        }),
      },
    );
  assert.equal((await call("9")).status, 404);
  rmSync(path.join(folder, "assets", `${asset.id}.jpg`));
  const missing = await call("0");
  const text = await missing.text();
  assert.equal(missing.status, 422);
  assert.ok(!text.includes(folder), text);
  assert.match(text, /missing from your library/);
});

test("AI availability is checked before a website is fetched", async () => {
  const fetchBefore = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("should not fetch");
  }) as typeof fetch;
  try {
    const ideas = await action({
      action: "ideas",
      brandId: "demo-brand",
      url: "https://example.com",
    });
    assert.equal(ideas.status, 412);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("cropped photo slots keep the visible part of the image", async () => {
  // Left half red, right half blue; a cover crop pinned left or right shows one colour.
  const half = await sharp({
    create: { width: 400, height: 200, channels: 3, background: "#ff0000" },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 200,
            height: 200,
            channels: 3,
            background: "#0000ff",
          },
        })
          .png()
          .toBuffer(),
        left: 200,
        top: 0,
      },
    ])
    .jpeg()
    .toBuffer();
  writeFileSync(path.join(folder, "assets", "half.jpg"), half);
  const font = await photoFont();
  const base = sample.slides[0];
  for (const [imageX, channel] of [
    [0, 0],
    [100, 2],
  ] as const) {
    const slide = {
      ...photoSlide(base, "story", font),
      assetId: "half",
      textLayers: [],
      overlay: 0,
      imageX,
      imageZoom: 1.5,
    };
    const stats = await sharp(
      await renderPhotoSlide(slide, "story", 0),
    ).stats();
    assert.ok(stats.channels[channel].mean > 200, `imageX ${imageX}`);
  }
});

test("module import does not create a workspace and concurrent first boots seed once", async () => {
  const run = (dir: string, code: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        { env: { ...process.env, STUDIO_DATA_DIR: dir }, cwd: process.cwd() },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("exit", (status) =>
        status === 0
          ? resolve(out)
          : reject(new Error(`exit ${status}: ${err.slice(0, 500)}`)),
      );
    });
  const lazy = path.join(folder, "never-created");
  await run(lazy, 'await import("./src/lib/store.ts");');
  assert.equal(existsSync(lazy), false);
  const shared = path.join(folder, "concurrent");
  const boot =
    'const s = await import("./src/lib/store.ts"); s.list("post"); s.database().close();';
  await Promise.all(Array.from({ length: 6 }, () => run(shared, boot)));
  const count = await run(
    shared,
    'const s = await import("./src/lib/store.ts"); console.log(s.list("format").map((f) => f.id).join(), s.database().prepare("SELECT COUNT(*) AS n FROM audit WHERE action=?").get("format.tiktok_photo_added").n);',
  );
  assert.equal(count.trim(), "tiktok-photo 1");
});
