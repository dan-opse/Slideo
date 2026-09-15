import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  PHOTO_RENDER_VERSION,
  defaultText,
  photoSlide,
  photoTextSvg,
  layoutText,
  imageRect,
  fitText,
} from "../src/lib/photo-layout";
import { postSchema, photoTextSchema, type Post } from "../src/lib/schema";
const folder = mkdtempSync(path.join(tmpdir(), "fieldwork-photo-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
const { photoFont, renderPhotoSlide } = await import("../src/lib/photo-render");
const { renderAll } = await import("../src/lib/render");
const font = await photoFont();
const original = store.list<Post>("post")[0];
const reference = defaultText(
  "5 changes i made to detach\nfrom emotional betting:",
  "text-1",
);
const regressionCopy = [
  "A Boost Isn’t The Whole Picture\n\nPobi helps evaluate promotions alongside available markets and pricing across supported sportsbooks.",
  "Check The Vig Too\n\nComparing vig can add context when reviewing which supported market may fit a promotion.",
  "Keep Risk In The Frame\n\nBetter information does not remove betting risk. Set limits, and never chase losses.",
];
after(() => {
  store.db.close();
  rmSync(folder, { recursive: true, force: true });
});

test("TikTok preset preserves existing posts and matches the reference defaults", () => {
  assert.equal(
    store.get<{ design: string }>("format", "tiktok-photo").design,
    "photo",
  );
  assert.equal(original.slides[0].design, undefined);
  const text = fitText(reference, font, "story");
  assert.deepEqual(
    [text.size, text.width, text.height, text.x, text.y],
    [14, 208, 34, 16, 197],
  );
  assert.equal(layoutText(text, font).lines.length, 2);
  assert.equal(layoutText(text, font).overflow, false);
  assert.match(JSON.stringify(font.names), /TikTok Sans 16pt/);
});

test("shared text layout wraps long words, preserves paragraphs and flags overflow", () => {
  const text = {
    ...reference,
    text: "A useful idea\n\n" + "longword".repeat(12),
    width: 95,
  };
  const result = layoutText(text, font);
  assert.ok(result.lines.includes(""));
  assert.ok(
    result.lines.every(
      (line) =>
        font.getAdvanceWidth(line, text.size, { kerning: true }) <=
        text.width - 4,
    ),
  );
  assert.equal(result.overflow, true);
  const fitted = fitText(text, font, "story");
  assert.equal(layoutText(fitted, font).overflow, false);
  assert.ok(fitted.height > 34);
});

test("all font weights and styles produce safe vector text with no font fallback", async () => {
  for (const name of ["default", "semibold", "regular"] as const) {
    const current = await photoFont(name);
    for (const style of ["outline", "plain", "shadow", "box"] as const) {
      const svg = photoTextSvg(
        {
          ...reference,
          font: name,
          style,
          text: '<script>alert("test")</script>',
        },
        current,
      );
      assert.ok(svg.includes("<path"));
      assert.ok(!svg.includes("<script"));
      assert.ok(!svg.includes("<text"));
    }
  }
  assert.notEqual(
    photoTextSvg(reference, font),
    photoTextSvg(reference, await photoFont("regular")),
  );
});

test("text coordinates near integer boundaries never truncate the SVG path", async () => {
  for (const name of ["default", "semibold", "regular"] as const) {
    const current = await photoFont(name);
    for (const text of [
      ...regressionCopy,
      "“Quoted” words, café, don’t — stop.",
    ]) {
      for (const x of [16, 16.00000000000001, 15.99999999999999]) {
        const layer = fitText(
          { ...defaultText(text, "regression"), font: name, x },
          current,
          "story",
        );
        for (const style of ["outline", "plain", "shadow", "box"] as const) {
          assert.equal(
            /NaN|Infinity|undefined/.test(
              photoTextSvg({ ...layer, style }, current),
            ),
            false,
            `Invalid path: ${name}, ${style}, x=${x}, ${text}`,
          );
        }
      }
    }
  }
});

test("all three carousel JPEGs include every nonblank text line", async () => {
  for (const text of regressionCopy) {
    const layer = fitText(defaultText(text, "regression"), font, "story");
    const slide = {
      ...photoSlide(original.slides[0], "story", font),
      textLayers: [layer],
    };
    const data = await renderPhotoSlide(slide, "story", 0);
    const { data: pixels, info } = await sharp(data)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { lines } = layoutText(layer, font);
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      const top = Math.floor((layer.y + index * layer.size * 1.12) * 4.5);
      const bottom = Math.ceil(
        (layer.y + (index + 1) * layer.size * 1.12) * 4.5,
      );
      let brightPixels = 0;
      for (let y = top; y < bottom; y++) {
        for (
          let x = Math.floor(layer.x * 4.5);
          x < (layer.x + layer.width) * 4.5;
          x++
        ) {
          if (pixels[(y * info.width + x) * info.channels] > 200)
            brightPixels++;
        }
      }
      assert.ok(brightPixels > 100, `Missing exported line: ${line}`);
    }
  }
});

test("photo renders bypass old cached images without changing the saved content", async () => {
  const content = postSchema.parse({
    ...store.contentOf(original),
    aspect: "story",
    slides: [
      {
        ...photoSlide(original.slides[0], "story", font),
        textLayers: [reference],
      },
    ],
  });
  const post = store.savePost(content);
  const stale = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const prefix = path.join(folder, "renders", `${post.id}-${post.revision}-0`);
  mkdirSync(path.dirname(prefix), { recursive: true });
  writeFileSync(`${prefix}.jpg`, stale);
  const { buffers, hashes } = await renderAll(post.id, post.revision);
  assert.equal((await sharp(buffers[0]).metadata()).width, 1080);
  assert.notEqual(hashes[0], store.digest(stale));
  assert.deepEqual(
    readFileSync(`${prefix}-photo-v${PHOTO_RENDER_VERSION}.jpg`),
    buffers[0],
  );
  assert.deepEqual(readFileSync(`${prefix}.jpg`), stale);
  assert.deepEqual(store.revisionContent(post.id, post.revision), content);
  assert.equal(store.get<Post>("post", post.id).status, "needs_review");
});

test("image fit, crop, position and zoom use identical deterministic geometry", () => {
  const slide = photoSlide(original.slides[0], "story", font);
  assert.deepEqual(imageRect(slide, 480, 240, 400), {
    width: 800,
    height: 400,
    x: -280,
    y: 0,
  });
  assert.deepEqual(
    imageRect({ ...slide, imageFit: "contain" }, 480, 240, 400),
    { width: 240, height: 120, x: 0, y: 140 },
  );
  assert.deepEqual(
    imageRect({ ...slide, imageX: 100, imageZoom: 2 }, 480, 240, 400),
    { width: 1600, height: 800, x: -1360, y: -200 },
  );
});

test("photo settings persist across revisions, export and approval invalidation", async () => {
  const slide = {
    ...photoSlide(original.slides[0], "story", font),
    textLayers: [reference],
  };
  const content = postSchema.parse({
    ...store.contentOf(original),
    aspect: "story",
    slides: [slide],
  });
  const post = store.savePost(content);
  const { buffers, hashes } = await renderAll(post.id, post.revision);
  const metadata = await sharp(buffers[0]).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1080, 1920]);
  // Photo exports have no editorial role labels, slide numbers or accent line.
  const cornerBuffer = await sharp(buffers[0])
    .extract({ left: 90, top: 110, width: 110, height: 60 })
    .toBuffer();
  const corner = await sharp(cornerBuffer).stats();
  assert.ok(corner.channels.every((channel) => channel.max < 5));
  const approved = store.approvePost(post.id, post.revision, hashes);
  assert.deepEqual(store.assertApproval(approved), hashes);
  const edited = store.savePost(
    {
      ...content,
      slides: [
        { ...slide, textLayers: [{ ...reference, x: 10, style: "shadow" }] },
      ],
    },
    post.id,
    post.revision,
  );
  assert.equal(edited.slides[0].textLayers![0].x, 10);
  assert.equal(
    store.revisionContent(post.id, 1).slides[0].textLayers![0].x,
    16,
  );
  assert.throws(() => store.assertApproval(edited));
  assert.throws(() => photoTextSchema.parse({ ...reference, size: 0 }));
});

test("photo export rejects overflowing or off-canvas text", async () => {
  const slide = photoSlide(original.slides[0], "story", font);
  for (const text of [
    { ...reference, height: 12 },
    { ...reference, y: 420 },
    { ...reference, x: 100 },
  ]) {
    await assert.rejects(
      renderPhotoSlide({ ...slide, textLayers: [text] }, "story", 0),
      /does not fit/,
    );
  }
});

test("photo rendering includes images, letterboxing and darkening", async () => {
  mkdirSync(path.join(folder, "assets"), { recursive: true });
  writeFileSync(
    path.join(folder, "assets", "test-photo.jpg"),
    await sharp({
      create: { width: 400, height: 200, channels: 3, background: "#e04020" },
    })
      .jpeg()
      .toBuffer(),
  );
  const slide = {
    ...photoSlide(original.slides[0], "story", font),
    assetId: "test-photo",
    textLayers: [],
    imageFit: "contain" as const,
    overlay: 0.5,
  };
  const data = await renderPhotoSlide(slide, "story", 0);
  const centerBuffer = await sharp(data)
    .extract({ left: 530, top: 950, width: 20, height: 20 })
    .toBuffer();
  const center = await sharp(centerBuffer).stats();
  const topBuffer = await sharp(data)
    .extract({ left: 530, top: 20, width: 20, height: 20 })
    .toBuffer();
  const top = await sharp(topBuffer).stats();
  assert.ok(center.channels[0].mean > 100 && center.channels[0].mean < 120);
  assert.ok(top.channels.every((channel) => channel.max < 5));
});
