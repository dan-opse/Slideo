import type { Font, PathCommand } from "opentype.js";
import type { PhotoText, Slide, PostContent } from "./schema";

export const FONT_FILES = {
  default: "TikTokSans16pt-Bold.ttf",
  semibold: "TikTokSans16pt-SemiBold.ttf",
  regular: "TikTokSans16pt-Regular.ttf",
} as const;
// Bump when photo pixels change so disk and browser caches use the same renderer.
export const PHOTO_RENDER_VERSION = 2;
export const canvasHeight = (aspect: PostContent["aspect"]) =>
  aspect === "story" ? 1920 / 4.5 : 300;
export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));
export function defaultText(text: string, id: string): PhotoText {
  return {
    id,
    text,
    font: "default",
    size: 14,
    color: "#ffffff",
    style: "outline",
    align: "center",
    x: 16,
    y: 197,
    width: 208,
    height: 34,
  };
}

function serializeGlyphPath(commands: PathCommand[]) {
  const coordinates = (...values: number[]) =>
    values
      .map((value) => {
        if (!Number.isFinite(value))
          throw new Error("Invalid text drawing coordinate.");
        return Number(value.toFixed(2)).toString();
      })
      .join(" ");

  // OpenType 2's toPathData rounds via exponent strings. Floating-point tails
  // such as 113.00000000000001 become "1.4e-14e+2", producing NaN and causing
  // SVG readers to discard the rest of the text. Serialize the finite glyph
  // coordinates directly, preserving curves, closed contours and canvas Y.
  return commands
    .map((command) => {
      switch (command.type) {
        case "M":
        case "L":
          return command.type + coordinates(command.x, command.y);
        case "Q":
          return (
            "Q" + coordinates(command.x1, command.y1, command.x, command.y)
          );
        case "C":
          return (
            "C" +
            coordinates(
              command.x1,
              command.y1,
              command.x2,
              command.y2,
              command.x,
              command.y,
            )
          );
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}

// A single layout implementation generates glyph paths for browser and JPEG.
// No system font substitution or browser-specific text wrapping on export.
export function layoutText(layer: PhotoText, font: Font) {
  const available = layer.width - 4;
  const measure = (value: string) =>
    font.getAdvanceWidth(value, layer.size, { kerning: true });
  const lines: string[] = [];
  for (const paragraph of layer.text.split("\n")) {
    let line = "";
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= available) {
        line = next;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      // Break long URLs/words too, rather than rendering beyond the box.
      for (const character of word) {
        if (line && measure(line + character) > available) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line);
  }
  const lineHeight = layer.size * 1.12;
  const requiredHeight = Math.ceil(lines.length * lineHeight + 2);
  const path = lines
    .map((line, index) => {
      const width = measure(line);
      const x =
        layer.x +
        (layer.align === "left"
          ? 2
          : layer.align === "right"
            ? layer.width - width - 2
            : (layer.width - width) / 2);
      const baseline = layer.y + 1 + layer.size * 0.84 + index * lineHeight;
      return serializeGlyphPath(
        font.getPath(line, x, baseline, layer.size, { kerning: true }).commands,
      );
    })
    .join(" ");
  return {
    path,
    lines,
    requiredHeight,
    overflow: requiredHeight > layer.height + 1,
  };
}

export function photoTextSvg(layer: PhotoText, font: Font) {
  const { path } = layoutText(layer, font);
  if (!path) return "";
  const shape = `<path d="${path}" fill="${layer.color}"/>`;
  if (layer.style === "plain") return shape;
  if (layer.style === "box")
    return `<rect x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" rx="3" fill="#000" fill-opacity=".8"/>${shape}`;
  if (layer.style === "shadow")
    return `<path d="${path}" transform="translate(.8 1)" fill="#000" stroke="#000" stroke-width=".6" stroke-linejoin="round"/>${shape}`;
  return `<path d="${path}" fill="none" stroke="#000" stroke-width="${layer.size * 0.13}" stroke-linejoin="round"/>${shape}`;
}

export function fitText(
  layer: PhotoText,
  font: Font,
  aspect: PostContent["aspect"],
): PhotoText {
  const height = Math.max(34, layoutText(layer, font).requiredHeight);
  return {
    ...layer,
    height,
    y: Math.ceil((canvasHeight(aspect) - height) / 2),
  };
}

export function photoSlide(
  slide: Slide,
  aspect: PostContent["aspect"],
  font: Font,
): Slide {
  const text = [slide.title, slide.body].filter(Boolean).join("\n\n");
  return {
    ...slide,
    design: "photo",
    font: "tiktok",
    ink: "#ffffff",
    background: "#000000",
    align: "center",
    overlay: 0.25,
    imageFit: "cover",
    imageZoom: 1,
    imageX: 50,
    imageY: 50,
    textLayers: [fitText(defaultText(text, `${slide.id}-text`), font, aspect)],
  };
}

export function imageRect(
  slide: Slide,
  imageWidth: number,
  imageHeight: number,
  height: number,
  canvasWidth = 240,
) {
  const fit = slide.imageFit === "contain" ? Math.min : Math.max;
  const scale =
    fit(canvasWidth / imageWidth, height / imageHeight) *
    (slide.imageZoom ?? 1);
  const width = imageWidth * scale,
    h = imageHeight * scale;
  return {
    width,
    height: h,
    x: ((canvasWidth - width) * (slide.imageX ?? 50)) / 100,
    y: ((height - h) * (slide.imageY ?? 50)) / 100,
  };
}
