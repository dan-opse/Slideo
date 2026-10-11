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
// Output pixels per canvas unit (240 units -> 1080 px) for both aspects.
const PIXELS_PER_UNIT = 1080 / 240;

// Crops each photo to the part visible in its slot and resizes it to the
// slot's output pixels before embedding. Embedding full-resolution originals
// made librsvg decode up to four 2400 px images per slide and drove server
// memory to several GB.
async function slotImage(
  slide: Slide,
  slot: ReturnType<typeof imageSlots>[number],
  index: number,
) {
  const data = await readFile(
    path.join(dataDir, "assets", `${slot.id}.jpg`),
  ).catch(() => {
    throw new StudioError(
      `Slide ${index + 1}: one of its images is missing from your library. Choose another image.`,
      422,
    );
  });
  const meta = await sharp(data).metadata();
  const width = meta.width!,
    height = meta.height!;
  const rect = imageRect(slide, width, height, slot.height, slot.width);
  const left = Math.max(0, rect.x),
    top = Math.max(0, rect.y),
    right = Math.min(slot.width, rect.x + rect.width),
    bottom = Math.min(slot.height, rect.y + rect.height);
  if (right <= left || bottom <= top) return "";
  const sx = Math.max(0, Math.floor(((left - rect.x) / rect.width) * width)),
    sy = Math.max(0, Math.floor(((top - rect.y) / rect.height) * height));
  const crop = {
    left: sx,
    top: sy,
    width: Math.max(
      1,
      Math.min(width - sx, Math.round(((right - left) / rect.width) * width)),
    ),
    height: Math.max(
      1,
      Math.min(
        height - sy,
        Math.round(((bottom - top) / rect.height) * height),
      ),
    ),
  };
  const pixels = await sharp(data)
    .extract(crop)
    .resize(
      Math.max(1, Math.round((right - left) * PIXELS_PER_UNIT)),
      Math.max(1, Math.round((bottom - top) * PIXELS_PER_UNIT)),
      { fit: "fill" },
    )
    .jpeg({ quality: 95 })
    .toBuffer();
  return `<image href="data:image/jpeg;base64,${pixels.toString("base64")}" x="${slot.x + left}" y="${slot.y + top}" width="${right - left}" height="${bottom - top}" preserveAspectRatio="none"/>`;
}

export async function renderPhotoSlide(
  slide: Slide,
  aspect: PostContent["aspect"],
  index: number,
) {
  const height = canvasHeight(aspect);
  let background = `<rect width="240" height="${height}" fill="${slide.background}"/>`;
  const slots = imageSlots(slide, height);
  for (const slot of slots) background += await slotImage(slide, slot, index);
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
          422,
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
