import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { seedSamplePost } from "./sample-post";
import { closeTestDatabase, sql, useTestDatabase } from "./database";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
await useTestDatabase();
const { renderAll, renderSlide } = await import("../src/lib/render");
const { authorize } = await import("../src/lib/auth");
const { NextRequest } = await import("next/server");
const { GET: exportPackage } = await import("../src/app/api/export/[id]/route");
const { POST: studioPost } = await import("../src/app/api/studio/route");
const { formatSchema, postSchema } = await import("../src/lib/schema");
const { assertExactSlideCount, ideasSchema } = await import("../src/lib/ai");
const { assertPublicWebsiteUrl, readWebsite } =
  await import("../src/lib/website");
const original = await seedSamplePost(store);
after(async () => {
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});
test("fresh workspaces start with a blank brand brief", async () => {
  const brand = await store.get<import("../src/lib/schema").Brand>(
    "brand",
    "demo-brand",
  );
  assert.equal(brand.name, "My brand");
  assert.equal(brand.product, "");
  assert.equal(brand.facts, "");
  assert.equal(brand.destination, "");
});
test("new formats are capped at 10 while legacy posts can retain more slides", async () => {
  const [format] =
    await store.list<import("../src/lib/schema").Format>("format");
  assert.throws(() => formatSchema.parse({ ...format, slideCount: 11 }));
  assert.doesNotThrow(() =>
    postSchema.parse({
      ...store.contentOf(original),
      slides: Array.from({ length: 11 }, (_, index) => ({
        ...original.slides[0],
        id: `legacy-${index}`,
      })),
    }),
  );
});
test("legacy format defaults above 10 migrate and record an audit event", async () => {
  const [format] =
    await store.list<import("../src/lib/schema").Format>("format");
  await store.put("format", { ...format, slideCount: 14 });
  await store.migrateFormatSlideCounts();
  assert.equal(
    (await store.get<import("../src/lib/schema").Format>("format", format.id))
      .slideCount,
    10,
  );
  const [audit] = await sql<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM audit WHERE action=$1 AND entity=$2",
    ["format.slide_count_capped", format.id],
  );
  assert.equal(audit.count, 1);
  await store.put("format", format);
});
test("manual create uses the modal count and preserves a legacy fallback", async () => {
  const format = await store.get<import("../src/lib/schema").Format>(
    "format",
    "tiktok-photo",
  );
  const base = {
    action: "create",
    brandId: "demo-brand",
    formatId: format.id,
    topic: "Count override",
    mode: "manual",
  };
  const create = async (body: Record<string, unknown>) =>
    studioPost(
      new NextRequest("http://localhost:3000/api/studio", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  const eight = await create({ ...base, slideCount: 8 });
  assert.equal(eight.status, 200);
  const eightPost = await eight.json();
  assert.equal(eightPost.slides.length, 8);
  assert.equal(eightPost.slides[0].role, "hook");
  assert.equal(eightPost.slides[7].role, "cta");
  assert.ok(
    eightPost.slides
      .slice(1, -1)
      .every((slide: { role: string }) => slide.role === "body"),
  );

  const legacy = await create(base);
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).slides.length, format.slideCount);

  for (const invalid of [1, 11, 2.5, "8", null]) {
    const response = await create({ ...base, slideCount: invalid });
    assert.equal(response.status, 400);
  }
});
test("wrong OpenAI slide counts are rejected before a post can be saved", () => {
  const copy = {
    title: "Wrong count",
    caption: "",
    flags: [],
    slides: Array.from({ length: 6 }, (_, index) => ({
      title: `Slide ${index + 1}`,
      body: "",
    })),
  };
  assert.throws(() => assertExactSlideCount(copy, 8), /wrong slide count/);
});
test("website ideation accepts exactly five bounded ideas", () => {
  const five = {
    ideas: Array.from({ length: 5 }, (_, index) => ({
      topic: `Topic ${index + 1}`,
      angle: "A useful, specific angle.",
    })),
  };
  assert.doesNotThrow(() => ideasSchema.parse(five));
  assert.throws(() => ideasSchema.parse({ ideas: five.ideas.slice(0, 4) }));
  assert.throws(() =>
    ideasSchema.parse({
      ideas: [
        { topic: "x".repeat(141), angle: "Valid" },
        ...five.ideas.slice(1),
      ],
    }),
  );
});
test("website reader rejects unsafe destinations and extracts readable HTML", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(
    () => assertPublicWebsiteUrl("http://example.com", publicLookup),
    /HTTPS/,
  );
  await assert.rejects(
    () => assertPublicWebsiteUrl("https://127.0.0.1", publicLookup),
    /not public/,
  );
  await assert.rejects(
    () =>
      assertPublicWebsiteUrl("https://example.com", async () => [
        { address: "10.0.0.4", family: 4 },
      ]),
    /non-public/,
  );

  const source = await readWebsite("https://example.com/product", {
    lookup: publicLookup,
    transport: async () =>
      new Response(
        "<html><head><title>Useful product</title><meta name='description' content='A clear description'></head><body><nav>Skip me</nav><main><h1>Make better work</h1><p>Useful product details.</p><script>ignore()</script></main></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  });
  assert.equal(source.title, "Useful product");
  assert.match(source.content, /Make better work/);
  assert.doesNotMatch(source.content, /Skip me|ignore/);
});
test("website reader validates redirect targets, content types, and size", async () => {
  const lookup = async (hostname: string) => [
    {
      address:
        hostname === "internal.example" ? "192.168.1.2" : "93.184.216.34",
      family: 4,
    },
  ];
  await assert.rejects(
    () =>
      readWebsite("https://example.com", {
        lookup,
        transport: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://internal.example/private" },
          }),
      }),
    /non-public/,
  );
  await assert.rejects(
    () =>
      readWebsite("https://example.com/file", {
        lookup,
        transport: async () =>
          new Response("{}", {
            headers: { "content-type": "application/json" },
          }),
      }),
    /only supports HTML/,
  );
  await assert.rejects(
    () =>
      readWebsite("https://example.com/large", {
        lookup,
        transport: async () =>
          new Response("<html></html>", {
            headers: {
              "content-type": "text/html",
              "content-length": String(1024 * 1024 + 1),
            },
          }),
      }),
    /larger than 1 MB/,
  );
});
test("unapproved export is denied and exact renders authorize it", async () => {
  const post = await store.savePost({
    ...store.contentOf(original),
    title: "Approval test",
  });
  await assert.rejects(
    () => store.assertApproval(post),
    /Approve this exact revision/,
  );
  const { buffers, hashes } = await renderAll(post.id, post.revision);
  assert.equal(buffers.length, 6);
  const meta = await sharp(buffers[0]).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
  assert.equal(meta.format, "jpeg");
  const approved = await store.approvePost(post.id, post.revision, hashes);
  assert.deepEqual(await store.assertApproval(approved), hashes);
  assert.deepEqual(await renderSlide(post.id, post.revision, 0), buffers[0]);
  const revised = await store.savePost(
    { ...store.contentOf(approved), caption: "Changed after approval" },
    post.id,
    post.revision,
  );
  assert.equal(revised.status, "needs_review");
  await assert.rejects(() => store.assertApproval(revised));
  assert.equal(
    (await store.revisionContent(post.id, 1)).caption,
    original.caption,
  );
  await assert.rejects(() => store.approvePost(post.id, 1, hashes), /changed/);
});
test("stale edits cannot overwrite a saved revision", async () => {
  const p = await store.savePost({
    ...store.contentOf(original),
    title: "Concurrency",
  });
  await store.savePost({ ...store.contentOf(p), title: "First edit" }, p.id, 1);
  await assert.rejects(
    () =>
      store.savePost({ ...store.contentOf(p), title: "Stale edit" }, p.id, 1),
    /another window/,
  );
  assert.equal(
    (await store.get<import("../src/lib/schema").Post>("post", p.id)).title,
    "First edit",
  );
});
test("unknown asset rights block approval", async () => {
  const asset = {
    id: store.uid(),
    name: "Unlicensed",
    collection: "Test",
    rights: "",
    width: 1080,
    height: 1350,
    hash: "x",
    createdAt: store.now(),
  };
  await store.put("asset", asset);
  const p = await store.savePost({
    ...store.contentOf(original),
    slides: [{ ...original.slides[0], assetId: asset.id }],
  });
  await assert.rejects(
    () => store.approvePost(p.id, 1, ["fake"]),
    /usage rights/,
  );
});
test("text overflow fails explicitly instead of clipping", async () => {
  const p = await store.savePost({
    ...store.contentOf(original),
    slides: [
      {
        ...original.slides[0],
        title: "Very long heading ".repeat(10),
        fontSize: 110,
      },
    ],
  });
  await assert.rejects(renderAll(p.id, 1), /too tall/);
});
test("story canvas renders at the documented size and escapes markup", async () => {
  const p = await store.savePost({
    ...store.contentOf(original),
    aspect: "story",
    slides: [
      {
        ...original.slides[0],
        title: "<b>Literal & original</b>",
        body: '"A quote"\nA new line',
        align: "center",
        position: "bottom",
      },
    ],
  });
  const { buffers } = await renderAll(p.id, 1);
  const meta = await sharp(buffers[0]).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
});
test("local access guard rejects foreign hosts and origins", async () => {
  const outcome = async (headers: Record<string, string>) => {
    const result = await authorize(
      new NextRequest("http://localhost:3000/api/studio", { headers }),
    );
    return result instanceof Response ? result.status : result.id;
  };
  assert.equal(
    await outcome({ host: "localhost:3000", origin: "http://localhost:3000" }),
    "local",
  );
  assert.equal(await outcome({ host: "evil.example" }), 403);
  assert.equal(
    await outcome({ host: "localhost:3000", origin: "https://evil.example" }),
    403,
  );
});
test("export route returns a ZIP only for the approved revision", async () => {
  const post = await store.savePost({
    ...store.contentOf(original),
    title: "Route export test",
  });
  const request = new NextRequest(
    `http://localhost:3000/api/export/${post.id}?revision=${post.revision}`,
    { headers: { host: "localhost:3000" } },
  );
  const denied = await exportPackage(request, {
    params: Promise.resolve({ id: post.id }),
  });
  assert.equal(denied.status, 403);
  const { hashes } = await renderAll(post.id, post.revision);
  await store.approvePost(post.id, post.revision, hashes);
  const response = await exportPackage(request, {
    params: Promise.resolve({ id: post.id }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.ok((await response.arrayBuffer()).byteLength > 10_000);
});
