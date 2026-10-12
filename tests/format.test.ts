import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Brand, Format, Post, Asset } from "../src/lib/schema";
import { formatSchema } from "../src/lib/schema";
import {
  templateFor,
  imageSlots,
  slideStructure,
} from "../src/lib/format-template";
import { seedSamplePost } from "./sample-post";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-format-test-"));
process.env.STUDIO_DATA_DIR = folder;
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_DAILY_CALL_LIMIT = "50";
const store = await import("../src/lib/store");
const { POST } = await import("../src/app/api/studio/route");
const { NextRequest } = await import("next/server");
const { renderAll } = await import("../src/lib/render");
const { assertNewHooks, hookWritingInput, slideshowWritingInput } =
  await import("../src/lib/ai");
const brand = store.get<Brand>("brand", "demo-brand");
const original = seedSamplePost(store);
const base = store.get<Format>("format", "tiktok-photo");
const format: Format = {
  ...base,
  id: "test-format",
  brandId: brand.id,
  hooks: ["Keep this exact hook, punctuation & all!"],
  tonePreset: "concise",
  toneInstructions: "BODY_ONLY_SENTINEL",
  templates: {
    hook: {
      ...templateFor(base, "hook"),
      collection: "test-images",
      imageGrid: "split",
      overlay: 0,
    },
    body: {
      ...templateFor(base, "body"),
      // Image-only slides: text hidden, background from the collection.
      collection: "test-images",
      font: "regular",
      color: "#ffff00",
      style: "plain",
      size: 12,
      position: "top",
      width: 80,
      displayText: false,
    },
    cta: { ...templateFor(base, "cta"), size: 16, position: "bottom" },
  },
};
// The API only updates formats that exist; start from a stored copy of the preset.
store.put<Format>("format", { ...base, id: format.id });
const request = (body: Record<string, unknown>) =>
  POST(
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
after(() => {
  store.database().close();
  rmSync(folder, { recursive: true, force: true });
});

test("format settings persist without altering existing posts or revisions", async () => {
  const response = await request({
    action: "format",
    data: format,
    expected: 0,
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).templates, format.templates);
  assert.deepEqual(store.get<Post>("post", original.id), original);
  assert.doesNotThrow(() => formatSchema.parse(base));
  assert.throws(() =>
    formatSchema.parse({ ...format, hooks: ["x".repeat(181)] }),
  );
  assert.throws(() =>
    formatSchema.parse({
      ...format,
      templates: {
        ...format.templates,
        hook: { ...format.templates!.hook, width: 0 },
      },
    }),
  );
});

test("manual creation snapshots role templates and preserves popup count and selected hook", async () => {
  mkdirSync(path.join(folder, "assets"), { recursive: true });
  for (const [index, color] of ["#ff0000", "#0000ff"].entries()) {
    const id = `format-image-${index}`;
    writeFileSync(
      path.join(folder, "assets", `${id}.jpg`),
      await sharp({
        create: { width: 200, height: 200, channels: 3, background: color },
      })
        .jpeg()
        .toBuffer(),
    );
    store.put<Asset>("asset", {
      id,
      name: id,
      collection: "test-images",
      rights: "Created for test",
      width: 200,
      height: 200,
      hash: "test",
      createdAt: store.now(),
    });
  }
  const response = await request({
    action: "create",
    brandId: brand.id,
    formatId: format.id,
    topic: "Explain the concept",
    selectedHook: format.hooks![0],
    mode: "manual",
    slideCount: 8,
  });
  assert.equal(response.status, 200);
  const post: Post = await response.json();
  assert.equal(post.slides.length, 8);
  assert.equal(post.slides[0].title, format.hooks![0]);
  assert.equal(post.slides[0].imageGrid, "split");
  assert.equal(post.slides[0].additionalAssetIds?.length, 1);
  assert.deepEqual(post.slides[1].textLayers, []);
  assert.equal(post.slides[7].textLayers![0].size, 16);
  assert.ok(post.slides[7].textLayers![0].y > 300);
  const { buffers, hashes } = await renderAll(post.id, post.revision);
  const top = await sharp(buffers[0])
    .extract({ left: 50, top: 50, width: 10, height: 10 })
    .raw()
    .toBuffer();
  const bottom = await sharp(buffers[0])
    .extract({ left: 50, top: 1800, width: 10, height: 10 })
    .raw()
    .toBuffer();
  assert.notDeepEqual(top, bottom, "Each grid slot must use its own image");
  const noRights = store.get<Asset>(
    "asset",
    post.slides[0].additionalAssetIds![0],
  );
  store.put("asset", { ...noRights, rights: "" });
  assert.throws(
    () => store.approvePost(post.id, post.revision, hashes),
    /usage rights/,
  );
  store.put("asset", noRights);
  const approved = store.approvePost(post.id, post.revision, hashes);
  await request({
    action: "format",
    data: { ...format, slideCount: 3 },
    expected: store.get<Format>("format", format.id).version,
  });
  assert.deepEqual(store.assertApproval(approved), hashes);
  assert.equal(store.get<Post>("post", post.id).slides.length, 8);
  const slots = imageSlots(
    {
      ...post.slides[0],
      imageGrid: "quad",
      additionalAssetIds: ["", "format-image-1"],
    },
    400,
  );
  assert.equal(slots[1].x, 0);
  assert.equal(slots[1].y, 200, "Empty slots must not shift later images");
});

test("hook prompts omit slideshow tone and caption instructions", () => {
  const outlined: Format = {
    ...format,
    structure: [
      { label: "Hook", role: "hook", text: "HOOK_ONLY_SENTINEL" },
      { label: "Tip", role: "body", text: "SLIDE_TWO_SENTINEL" },
    ],
  };
  const hookInput = hookWritingInput(brand, outlined, "My custom hook prompt");
  assert.equal(hookInput.prompt, "My custom hook prompt");
  assert.equal(hookInput.hookPattern, "HOOK_ONLY_SENTINEL");
  assert.doesNotMatch(JSON.stringify(hookInput), /BODY_ONLY_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(hookInput), /SLIDE_TWO_SENTINEL/);
  assert.equal(hookWritingInput(brand, format, "").hookPattern, "");
  const writingInput = slideshowWritingInput(
    brand,
    format,
    "Topic",
    format.hooks![0],
    8,
  );
  assert.equal(writingInput.openingHook, format.hooks![0]);
  assert.match(JSON.stringify(writingInput), /BODY_ONLY_SENTINEL/);
  const source = {
    url: "https://example.com/",
    title: "Example",
    content: "Website facts",
  };
  assert.deepEqual(hookWritingInput(brand, format, "", source).website, source);
  assert.throws(() => assertNewHooks({ hooks: Array(10).fill("repeat") }, []));
  assert.throws(() =>
    assertNewHooks(
      { hooks: Array.from({ length: 9 }, (_, i) => `Hook ${i}`) },
      [],
    ),
  );
});

test("OpenAI hooks use the prompt without fetching a website and record normalized usage", async () => {
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /api.openai.com/);
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.input[1].content, /Use my prompt/);
    assert.doesNotMatch(body.input[1].content, /BODY_ONLY_SENTINEL/);
    return Response.json({
      id: "resp_hooks_test",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                hooks: Array.from(
                  { length: 10 },
                  (_, i) => `Fresh hook ${i + 1}`,
                ),
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 150,
      },
    });
  };
  try {
    const before = store.dailyUsage();
    const response = await request({
      action: "hooks",
      brandId: brand.id,
      format,
      prompt: "Use my prompt",
      url: "http://127.0.0.1/should-not-be-fetched",
    });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    assert.equal((await response.json()).hooks.length, 10);
    assert.equal(calls, 1);
    assert.equal(store.dailyUsage(), before + 1);
    const row = store
      .database()
      .prepare(
        "SELECT status,usage FROM ai_attempts ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { status: string; usage: string };
    assert.equal(row.status, "complete");
    const meta = JSON.parse(row.usage);
    assert.equal(meta.operation, "format_hooks");
    assert.equal(meta.usage.cachedInputTokens, 10);
    assert.equal(meta.usage.reasoningTokens, 5);
    assert.deepEqual(
      store.get<Format>("format", format.id).hooks,
      format.hooks,
    );
    const unsafe = await request({
      action: "hooks",
      brandId: brand.id,
      format,
      prompt: "",
      url: "https://127.0.0.1/",
    });
    assert.equal(unsafe.status, 400);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("AI slideshow preserves a chosen hook even if the provider rewrites it", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const context = JSON.parse(body.input[1].content);
    assert.equal(context.openingHook, format.hooks![0]);
    assert.equal(context.customWritingStyle, "BODY_ONLY_SENTINEL");
    assert.match(body.input[0].content, /caption only/);
    return Response.json({
      id: "resp_copy_test",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                title: "AI draft",
                caption: "Concise caption",
                flags: [],
                slides: Array.from({ length: 8 }, (_, i) => ({
                  title: `Rewritten ${i}`,
                  body: "Body copy",
                })),
              }),
              annotations: [],
            },
          ],
        },
      ],
    });
  };
  try {
    const response = await request({
      action: "create",
      brandId: brand.id,
      formatId: format.id,
      topic: "Topic",
      selectedHook: format.hooks![0],
      slideCount: 8,
      mode: "ai",
    });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const post: Post = await response.json();
    assert.deepEqual(
      [post.slides[0].title, post.slides[0].body],
      [format.hooks![0], ""],
    );
    assert.equal(post.slides.length, 8);
    assert.equal(post.caption, "Concise caption");
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("failed hook requests preserve formats and count attempts; the daily limit prevents calls", async () => {
  const fetchBefore = globalThis.fetch;
  const saved = store.get<Format>("format", format.id);
  const before = store.dailyUsage();
  let calls = 0;
  try {
    for (const failure of ["invalid", "refusal", "incomplete", "quota"]) {
      globalThis.fetch = async () => {
        calls++;
        if (failure === "quota")
          return Response.json(
            {
              error: {
                message: "Quota",
                type: "insufficient_quota",
                code: "insufficient_quota",
              },
            },
            { status: 429 },
          );
        return Response.json({
          id: `resp_${failure}`,
          object: "response",
          status: failure === "incomplete" ? "incomplete" : "completed",
          output: [
            {
              type: "message",
              id: "msg_failure",
              role: "assistant",
              status: "completed",
              content:
                failure === "refusal"
                  ? [{ type: "refusal", refusal: "Declined" }]
                  : [
                      {
                        type: "output_text",
                        text: JSON.stringify({ hooks: ["Only one hook"] }),
                        annotations: [],
                      },
                    ],
            },
          ],
        });
      };
      const response = await request({
        action: "hooks",
        brandId: brand.id,
        format,
        prompt: "A prompt",
      });
      assert.ok(response.status >= 400);
      assert.deepEqual(store.get<Format>("format", format.id), saved);
    }
    assert.equal(store.dailyUsage(), before + 4);
    assert.equal(calls, 4);
    process.env.AI_DAILY_CALL_LIMIT = String(store.dailyUsage());
    const limited = await request({
      action: "hooks",
      brandId: brand.id,
      format,
      prompt: "A prompt",
    });
    assert.equal(limited.status, 429);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = fetchBefore;
    process.env.AI_DAILY_CALL_LIMIT = "50";
  }
});

test("a saved slide structure sets the order, styles, text and count of new drafts", async () => {
  const structured: Format = {
    ...format,
    id: "structured-format",
    hooks: [],
    slideCount: 9,
    structure: [
      { label: "Hook", role: "hook", text: "3 apps that fixed my sleep" },
      { label: "#3", role: "body", text: "#3 Rise" },
      { label: "Plug", role: "cta", text: "" },
      { label: "#1", role: "body", text: "" },
    ],
  };
  store.put("format", structured);
  const saved = await request({
    action: "format",
    data: structured,
    expected: 0,
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).slideCount, 4, "count follows structure");
  const response = await request({
    action: "create",
    brandId: brand.id,
    formatId: structured.id,
    topic: "Sleep apps",
    mode: "manual",
    slideCount: 8,
  });
  assert.equal(response.status, 200);
  const post: Post = await response.json();
  assert.deepEqual(
    post.slides.map((slide) => [slide.role, slide.title]),
    [
      ["hook", "3 apps that fixed my sleep"],
      ["body", "#3 Rise"],
      ["cta", "Your idea 2"],
      ["body", "What will you try next?"],
    ],
  );
  // A CTA-styled slide in the middle uses the CTA template.
  assert.equal(post.slides[2].textLayers![0].size, 16);
  const hooked = await request({
    action: "create",
    brandId: brand.id,
    formatId: structured.id,
    topic: "Sleep apps",
    selectedHook: "A hook I picked",
    mode: "manual",
  });
  assert.equal(
    ((await hooked.json()) as Post).slides[0].title,
    "A hook I picked",
  );
  const input = slideshowWritingInput(brand, structured, "Topic", "", 4);
  assert.deepEqual(input.slideStructure?.[1], {
    label: "#3",
    purpose: "Content",
    pattern: "#3 Rise",
  });
  assert.equal(
    hookWritingInput(brand, structured, "").hookPattern,
    "3 apps that fixed my sleep",
  );
  assert.equal(
    slideshowWritingInput(brand, format, "Topic", "", 4).slideStructure,
    undefined,
  );
  assert.throws(() =>
    formatSchema.parse({
      ...structured,
      structure: structured.structure!.slice(0, 1),
    }),
  );
});

test("formats without a structure keep the hook, content and CTA outline", () => {
  assert.deepEqual(
    slideStructure({ ...format, structure: undefined }, 4).map((slide) => [
      slide.role,
      slide.label,
    ]),
    [
      ["hook", "Hook"],
      ["body", "Content 1"],
      ["body", "Content 2"],
      ["cta", "CTA"],
    ],
  );
});
