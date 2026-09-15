import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, type Font } from "opentype.js/dist/opentype.mjs";
import sharp from "sharp";
import {
  FONT_FILES,
  canvasHeight,
  imageRect,
  layoutText,
  photoTextSvg,
} from "./photo-layout";
import type { PhotoText, PostContent, Slide } from "./schema";
import { dataDir, StudioError } from "./store";
import { imageSlots } from "./format-template";

const fonts = new Map<string, Promise<Font>>();
export function photoFont(name: PhotoText["font"] = "default") {
  if (!fonts.has(name))
    fonts.set(
      name,
      readFile(path.join(process.cwd(), "public/fonts", FONT_FILES[name])).then(
        (buffer) =>
          parse(
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ) as ArrayBuffer,
          ),
      ),
    );
  return fonts.get(name)!;
}
export async function renderPhotoSlide(
  slide: Slide,
  aspect: PostContent["aspect"],
  index: number,
) {
  const height = canvasHeight(aspect);
  let background = `<rect width="240" height="${height}" fill="${slide.background}"/>`;
  const slots = imageSlots(slide, height);
  for (const slot of slots) {
    const data = await readFile(path.join(dataDir, "assets", `${slot.id}.jpg`));
    const meta = await sharp(data).metadata();
    const rect = imageRect(
      slide,
      meta.width!,
      meta.height!,
      slot.height,
      slot.width,
    );
    background += `<svg x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" viewBox="0 0 ${slot.width} ${slot.height}" overflow="hidden"><image href="data:image/jpeg;base64,${data.toString("base64")}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" preserveAspectRatio="none"/></svg>`;
  }
  if (slots.length)
    background += `<rect width="240" height="${height}" fill="#000" opacity="${slide.overlay}"/>`;
  const texts = await Promise.all(
    (slide.textLayers ?? []).map(async (layer) => {
      const font = await photoFont(layer.font);
      if (
        layoutText(layer, font).overflow ||
        layer.x + layer.width > 240.1 ||
        layer.y + layer.height > height + 0.1
      )
        throw new StudioError(
          `Slide ${index + 1}: text does not fit its box or canvas. Increase the box height, reduce the size, or shorten the copy.`,
        );
      return photoTextSvg(layer, font);
    }),
  );
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${aspect === "story" ? 1920 : 1350}" viewBox="0 0 240 ${height}">${background}${texts.join("")}</svg>`,
    ),
  )
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}
