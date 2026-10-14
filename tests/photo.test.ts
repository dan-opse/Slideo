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
  recolorStyle,
  restyle,
} from "../src/lib/photo-layout";
import { postSchema, photoTextSchema, type Post } from "../src/lib/schema";
import { seedSamplePost } from "./sample-post";
import { closeTestDatabase, sql, useTestDatabase } from "./database";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-photo-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
await useTestDatabase();
const { photoFont, renderPhotoSlide } = await import("../src/lib/photo-render");
const { renderAll } = await import("../src/lib/render");
const font = await photoFont();
const original = await seedSamplePost(store);
const reference = defaultText(
  "5 changes i made to detach\nfrom emotional betting:",
  "text-1",
);
const regressionCopy = [
  "A Boost Isn’t The Whole Picture\n\nThis app helps evaluate promotions alongside available markets and pricing across supported sportsbooks.",
  "Check The Vig Too\n\nComparing vig can add context when reviewing which supported market may fit a promotion.",
  "Keep Risk In The Frame\n\nBetter information does not remove betting risk. Set limits, and never chase losses.",
];
after(async () => {
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

test("TikTok preset preserves existing posts and matches the reference defaults", async () => {
  assert.equal(
    (await store.get<{ design: string }>("format", "tiktok-photo")).design,
    "photo",
  );
  assert.equal(original.slides[0].design, undefined);
  const text = fitText(reference, font, "story");
  assert.deepEqual(
    [text.size, text.width, text.height, text.x, text.y],
    [12, 208, 34, 16, 197],
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
  const post = await store.savePost(content);
  const stale = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const prefix = path.join(
    folder,
    "files",
    "local",
    "renders",
    `${post.id}-${post.revision}-0`,
  );
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
  assert.deepEqual(
    await store.revisionContent(post.id, post.revision),
    content,
  );
  assert.equal((await store.get<Post>("post", post.id)).status, "needs_review");
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
  const post = await store.savePost(content);
  const { buffers, hashes } = await renderAll(post.id, post.revision);
  const metadata = await sharp(buffers[0]).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1080, 1920]);
  // Photo exports have no editorial role labels, slide numbers or accent line.
  const cornerBuffer = await sharp(buffers[0])
    .extract({ left: 90, top: 110, width: 110, height: 60 })
    .toBuffer();
  const corner = await sharp(cornerBuffer).stats();
  assert.ok(corner.channels.every((channel) => channel.max < 5));
  const approved = await store.approvePost(post.id, post.revision, hashes);
  assert.deepEqual(await store.assertApproval(approved), hashes);
  const edited = await store.savePost(
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
    (await store.revisionContent(post.id, 1)).slides[0].textLayers![0].x,
    16,
  );
  await assert.rejects(() => store.assertApproval(edited));
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
  mkdirSync(path.join(folder, "files", "local", "assets"), { recursive: true });
  writeFileSync(
    path.join(folder, "files", "local", "assets", "test-photo.jpg"),
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

test("text styles draw in the chosen style color, defaulting to black", () => {
  const text = { ...reference, style: "box" as const };
  assert.match(photoTextSvg(text, font), /Z" fill="#000"/);
  assert.match(
    photoTextSvg({ ...text, styleColor: "#ffffff" }, font),
    /Z" fill="#ffffff"/,
  );
  assert.match(
    photoTextSvg({ ...reference, styleColor: "#ff0000" }, font),
    /stroke="#ff0000"/,
  );
  assert.match(
    photoTextSvg(
      { ...reference, style: "shadow", styleColor: "#00ff00" },
      font,
    ),
    /fill="#00ff00" stroke="#00ff00"/,
  );
  assert.doesNotThrow(() =>
    photoTextSchema.parse({ ...reference, styleColor: "#123abc" }),
  );
  assert.throws(() =>
    photoTextSchema.parse({ ...reference, styleColor: "red" }),
  );
});

test("background style hugs each line, splits at blank lines and rounds its corners", async () => {
  const layer = {
    ...reference,
    text: "Hi\nA much longer second line",
    style: "box" as const,
    color: "#000000",
    styleColor: "#ffffff",
  };
  const pixels = async (svg: string) =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="427"><rect width="240" height="427" fill="#000"/>${svg}</svg>`,
      ),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
  const { data, info } = await pixels(photoTextSvg(layer, font));
  const at = (x: number, y: number) =>
    data[(y * info.width + x) * info.channels];
  const [first, second] = layoutText(layer, font).rows;
  const middle = (row: { top: number; bottom: number }) =>
    Math.round((row.top + row.bottom) / 2);
  // Left of the short first line is empty; the longer line below is covered.
  // In the padding just left of the long line's first letter.
  const x = Math.round(second.x - 2);
  assert.ok(x < first.x - 10);
  assert.ok(at(x, middle(first)) < 40, "no background beside the short line");
  assert.ok(at(x, middle(second)) > 200, "background behind the long line");
  // The blob does not fill the whole text box any more.
  assert.ok(at(reference.x + 1, middle(first)) < 40);
  assert.equal(
    photoTextSvg({ ...layer, text: "One\n\nTwo" }, font).match(/Z/g)?.length,
    2,
    "a blank line splits the background",
  );
  assert.notEqual(
    photoTextSvg({ ...layer, roundness: 0 }, font),
    photoTextSvg({ ...layer, roundness: 100 }, font),
  );
  assert.throws(() => photoTextSchema.parse({ ...layer, roundness: 101 }));
});

test("switching to a background swaps white and black text like TikTok", () => {
  const white = { style: "outline" as const, color: "#ffffff" };
  const boxed = restyle(white, "box");
  assert.deepEqual(boxed, {
    style: "box",
    color: "#000000",
    styleColor: "#ffffff",
  });
  assert.deepEqual(restyle(boxed, "outline"), {
    style: "outline",
    color: "#ffffff",
    styleColor: "#000000",
  });
  assert.deepEqual(restyle({ style: "plain", color: "#000000" }, "box"), {
    style: "box",
    color: "#ffffff",
    styleColor: "#000000",
  });
  assert.equal(
    restyle({ style: "plain", color: "#ffe44d" }, "box").color,
    "#ffe44d",
  );
  assert.equal(recolorStyle(boxed, "#000000").color, "#ffffff");
  assert.equal(recolorStyle(boxed, "#ffe44d").color, "#000000");
  assert.equal(
    recolorStyle({ style: "outline" as const, color: "#ffffff" }, "#ff0000")
      .color,
    "#ffffff",
  );
});
