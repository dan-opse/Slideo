import sharp, { type OverlayOptions } from "sharp";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dataDir, digest, get, revisionContent, StudioError } from "./store";
import type { Asset } from "./schema";
import { renderPhotoSlide } from "./photo-render";
import { PHOTO_RENDER_VERSION } from "./photo-layout";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function renderSlide(
  postId: string,
  revision: number,
  index: number,
) {
  const content = revisionContent(postId, revision);
  const s = content.slides[index];
  if (!s) throw new StudioError("Slide not found", 404);
  const file = path.join(
    dataDir,
    "renders",
    `${postId}-${revision}-${index}${s.design === "photo" ? `-photo-v${PHOTO_RENDER_VERSION}` : ""}.jpg`,
  );
  try {
    return await readFile(file);
  } catch {}
  if (s.design === "photo") {
    const buffer = await renderPhotoSlide(s, content.aspect, index);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buffer);
    return buffer;
  }
  const width = 1080,
    height = content.aspect === "portrait" ? 1350 : 1920;
  let base: Buffer;
  if (s.assetId) {
    get<Asset>("asset", s.assetId);
    const source = path.join(dataDir, "assets", `${s.assetId}.jpg`);
    await access(source).catch(() => {
      throw new StudioError(
        `Slide ${index + 1}: its background image is missing from your library. Choose another image.`,
        422,
      );
    });
    base = await sharp(source)
      .resize(width, height, { fit: "cover", position: "attention" })
      .jpeg()
      .toBuffer();
  } else {
    base = await sharp({
      create: { width, height, channels: 3, background: s.background },
    })
      .jpeg()
      .toBuffer();
  }
  const font = s.font === "serif" ? "Georgia" : "Helvetica";
  async function textImage(text: string, size: number, maxHeight: number) {
    if (!text.trim()) return null;
    const { data, info } = await sharp({
      text: {
        text: `<span foreground="${s.ink}">${escape(text)}</span>`,
        font: `${font} ${size}`,
        width: 864,
        align: s.align === "center" ? "centre" : "left",
        rgba: true,
        spacing: 12,
        wrap: "word-char",
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (info.height > maxHeight)
      throw new StudioError(
        `Slide ${index + 1}: text is too tall. Shorten the copy or reduce heading size.`,
        422,
      );
    return { input: data, info };
  }
  const title = await textImage(s.title, s.fontSize, Math.round(height * 0.4));
  const body = await textImage(s.body, 38, Math.round(height * 0.24));
  const total = (title?.info.height || 0) + (body ? 40 + body.info.height : 0);
  const top =
    s.position === "top"
      ? 240
      : s.position === "bottom"
        ? height - 200 - total
        : Math.round((height - total) / 2);
  const layers: OverlayOptions[] = [];
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="1080" height="${height}" fill="#000000" opacity="${s.assetId ? s.overlay : 0}"/><path d="M108 144 H184" stroke="${s.accent}" stroke-width="8"/><text x="108" y="${height - 90}" fill="${s.ink}" font-family="Helvetica" font-size="23" letter-spacing="3">${escape(s.role.toUpperCase())}</text><text x="972" y="${height - 90}" fill="${s.ink}" text-anchor="end" font-family="Helvetica" font-size="25">${String(index + 1).padStart(2, "0")} / ${String(content.slides.length).padStart(2, "0")}</text></svg>`,
  );
  layers.push({ input: svg, top: 0, left: 0 });
  if (title)
    layers.push({
      input: title.input,
      top,
      left:
        s.align === "center" ? Math.round((width - title.info.width) / 2) : 108,
    });
  if (body)
    layers.push({
      input: body.input,
      top: top + (title?.info.height || 0) + 40,
      left:
        s.align === "center" ? Math.round((width - body.info.width) / 2) : 108,
    });
  const buffer = await sharp(base)
    .composite(layers)
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  return buffer;
}
export async function renderAll(id: string, revision: number) {
  const c = revisionContent(id, revision);
  const buffers: Buffer[] = [];
  for (let i = 0; i < c.slides.length; i++)
    buffers.push(await renderSlide(id, revision, i));
  return { buffers, hashes: buffers.map(digest) };
}
