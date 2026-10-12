import type { Font, PathCommand } from "opentype.js";
import type { PhotoText, Slide, PostContent } from "./schema";

export const FONT_FILES = {
  default: "TikTokSans16pt-Bold.ttf",
  semibold: "TikTokSans16pt-SemiBold.ttf",
  regular: "TikTokSans16pt-Regular.ttf",
} as const;
// Bump when photo pixels change so disk and browser caches use the same renderer.
export const PHOTO_RENDER_VERSION = 3;
export const canvasHeight = (aspect: PostContent["aspect"]) =>
  aspect === "story" ? 1920 / 4.5 : 300;
export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));
export function defaultText(text: string, id: string): PhotoText {
  return {
    id,
    text,
    font: "default",
    size: 12,
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
  const rows = lines.map((line, index) => {
    const width = measure(line);
    const x =
      layer.x +
      (layer.align === "left"
        ? 2
        : layer.align === "right"
          ? layer.width - width - 2
          : (layer.width - width) / 2);
    const top = layer.y + 1 + index * lineHeight;
    return { line, x, width, top, bottom: top + lineHeight };
  });
  const path = rows
    .map(({ line, x, top }) =>
      serializeGlyphPath(
        font.getPath(line, x, top + layer.size * 0.84, layer.size, {
          kerning: true,
        }).commands,
      ),
    )
    .join(" ");
  return {
    path,
    lines,
    rows,
    requiredHeight,
    overflow: requiredHeight > layer.height + 1,
  };
}

export const DEFAULT_ROUNDNESS = 60;
const round2 = (value: number) => Number(value.toFixed(2));

// TikTok/Instagram background text: one blob hugging each line, with rounded
// outer corners and inward curves where a shorter line meets a longer one.
// Blank lines split the text into separate blobs.
export function backgroundPath(layer: PhotoText, font: Font) {
  const { rows } = layoutText(layer, font);
  const padX = layer.size * 0.34,
    padY = layer.size * 0.16,
    lineHeight = layer.size * 1.12;
  const radius =
    ((layer.roundness ?? DEFAULT_ROUNDNESS) / 100) * (lineHeight / 2 + padY);
  const groups: (typeof rows)[] = [[]];
  for (const row of rows)
    if (row.width > 0) groups.at(-1)!.push(row);
    else if (groups.at(-1)!.length) groups.push([]);
  return groups
    .filter((group) => group.length)
    .map((group) => {
      const left = group.map((row) => row.x - padX),
        right = group.map((row) => row.x + row.width + padX);
      // Near-equal neighbouring lines share an edge instead of a tiny notch.
      for (let pass = 0; pass < group.length; pass++)
        for (let i = 0; i < group.length - 1; i++) {
          if (Math.abs(right[i] - right[i + 1]) < padX)
            right[i] = right[i + 1] = Math.max(right[i], right[i + 1]);
          if (Math.abs(left[i] - left[i + 1]) < padX)
            left[i] = left[i + 1] = Math.min(left[i], left[i + 1]);
        }
      const top = (i: number) => group[i].top - (i === 0 ? padY : 0);
      const bottom = (i: number) =>
        group[i].bottom + (i === group.length - 1 ? padY : 0);
      // Clockwise outline: down the right edges, back up the left edges.
      const outline: [number, number][] = [
        ...group.flatMap((_, i) => [
          [right[i], top(i)] as [number, number],
          [right[i], bottom(i)] as [number, number],
        ]),
        ...group
          .map((_, i) => [
            [left[i], bottom(i)] as [number, number],
            [left[i], top(i)] as [number, number],
          ])
          .reverse()
          .flat(),
      ];
      const corners = outline.filter((point, i) => {
        const prev = outline.at(i - 1)!,
          next = outline[(i + 1) % outline.length];
        if (point[0] === prev[0] && point[1] === prev[1]) return false;
        return !(
          (prev[0] === point[0] && point[0] === next[0]) ||
          (prev[1] === point[1] && point[1] === next[1])
        );
      });
      // Each corner becomes a quarter-circle curve, limited to half of the
      // shorter neighbouring edge so short steps stay smooth.
      const k = 0.5523;
      return (
        corners
          .map((point, i) => {
            const prev = corners.at(i - 1)!,
              next = corners[(i + 1) % corners.length];
            const toPrev = Math.hypot(prev[0] - point[0], prev[1] - point[1]),
              toNext = Math.hypot(next[0] - point[0], next[1] - point[1]);
            const r = Math.min(radius, toPrev / 2, toNext / 2);
            const a = [
                point[0] + ((prev[0] - point[0]) / toPrev) * r,
                point[1] + ((prev[1] - point[1]) / toPrev) * r,
              ],
              b = [
                point[0] + ((next[0] - point[0]) / toNext) * r,
                point[1] + ((next[1] - point[1]) / toNext) * r,
              ];
            const c1 = [
                a[0] + (point[0] - a[0]) * k,
                a[1] + (point[1] - a[1]) * k,
              ],
              c2 = [b[0] + (point[0] - b[0]) * k, b[1] + (point[1] - b[1]) * k];
            return `${i ? "L" : "M"}${round2(a[0])} ${round2(a[1])} C${[...c1, ...c2, ...b].map(round2).join(" ")}`;
          })
          .join(" ") + " Z"
      );
    })
    .join(" ");
}

const WHITE = "#ffffff",
  BLACK = "#000000";
type Styled = Pick<PhotoText, "style" | "color" | "styleColor">;
// Like TikTok: turning on a background puts white text on a white blob with
// black text (and black on black with white text); turning it off restores
// white text with a black outline.
export function restyle<T extends Styled>(
  item: T,
  style: PhotoText["style"],
): T {
  if (style === item.style) return item;
  const color = item.color.toLowerCase();
  if (style === "box") {
    if (color === WHITE)
      return { ...item, style, color: BLACK, styleColor: WHITE };
    if (color === BLACK)
      return { ...item, style, color: WHITE, styleColor: BLACK };
    return { ...item, style, styleColor: item.styleColor ?? BLACK };
  }
  if (item.style === "box") {
    const next = color === BLACK ? WHITE : item.color;
    return {
      ...item,
      style,
      color: next,
      styleColor: next.toLowerCase() === BLACK ? WHITE : BLACK,
    };
  }
  return { ...item, style };
}
// Picking a background color keeps black or white text readable on it.
export function recolorStyle<T extends Styled>(item: T, styleColor: string): T {
  const color = item.color.toLowerCase();
  if (item.style !== "box" || (color !== WHITE && color !== BLACK))
    return { ...item, styleColor };
  const [r, g, b] = [1, 3, 5].map((i) =>
    parseInt(styleColor.slice(i, i + 2), 16),
  );
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 150;
  return { ...item, styleColor, color: light ? BLACK : WHITE };
}

export function photoTextSvg(layer: PhotoText, font: Font) {
  const { path } = layoutText(layer, font);
  if (!path) return "";
  const shape = `<path d="${path}" fill="${layer.color}"/>`;
  const effect = layer.styleColor ?? "#000";
  if (layer.style === "plain") return shape;
  if (layer.style === "box")
    return `<path d="${backgroundPath(layer, font)}" fill="${effect}"/>${shape}`;
  if (layer.style === "shadow")
    return `<path d="${path}" transform="translate(.8 1)" fill="${effect}" stroke="${effect}" stroke-width=".6" stroke-linejoin="round"/>${shape}`;
  return `<path d="${path}" fill="none" stroke="${effect}" stroke-width="${layer.size * 0.13}" stroke-linejoin="round"/>${shape}`;
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
