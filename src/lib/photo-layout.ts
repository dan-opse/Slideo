import type { Font, PathCommand } from "opentype.js";
import type { PhotoText, Slide, PostContent } from "./schema";

export const FONT_FILES = {
  default: "TikTokSans16pt-Bold.ttf",
  semibold: "TikTokSans16pt-SemiBold.ttf",
  regular: "TikTokSans16pt-Regular.ttf",
} as const;
// Bump when photo pixels change so disk and browser caches use the same renderer.
// v4: invisible format characters are no longer drawn as missing glyphs.
export const PHOTO_RENDER_VERSION = 4;
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

// Format characters (zero-width joiners and spaces, soft hyphens), emoji
// variation selectors and non-whitespace control characters have no shape.
// Drawing them would show the font's missing-glyph box, so layout drops them.
const INVISIBLE = /[\p{Cf}︀-️]|(?!\s)\p{Cc}/gu;

// A single layout implementation generates glyph paths for browser and JPEG.
// No system font substitution or browser-specific text wrapping on export.
export function layoutText(layer: PhotoText, font: Font) {
  const available = layer.width - 4;
  const measure = (value: string) =>
    font.getAdvanceWidth(value, layer.size, { kerning: true });
  const text = layer.text.replace(INVISIBLE, "");
  // Characters the bundled font cannot draw; never substituted silently.
  const missing = [
    ...new Set(
      [...text].filter(
        (character) =>
          !/\s/.test(character) && font.charToGlyphIndex(character) === 0,
      ),
    ),
  ];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
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
  const paths = rows.map(({ line, x, top }) =>
    font.getPath(line, x, top + layer.size * 0.84, layer.size, {
      kerning: true,
    }),
  );
  const path = paths
    .map((glyphs) => serializeGlyphPath(glyphs.commands))
    .join(" ");
  // Drawn glyph extent, which accents and side bearings can push past the
  // nominal line box.
  const boxes = paths
    .filter((glyphs) => glyphs.commands.length)
    .map((glyphs) => glyphs.getBoundingBox());
  const ink = boxes.length
    ? {
        left: Math.min(...boxes.map((box) => box.x1)),
        top: Math.min(...boxes.map((box) => box.y1)),
        right: Math.max(...boxes.map((box) => box.x2)),
        bottom: Math.max(...boxes.map((box) => box.y2)),
      }
    : null;
  // A single character can be wider than the box; splitting cannot fix it.
  const tooWide = rows.some((row) => row.width > available + 0.01);
  return {
    path,
    lines,
    rows,
    ink,
    missing,
    requiredHeight,
    tooWide,
    overflow: requiredHeight > layer.height + 1 || tooWide,
  };
}

// How far a background blob extends around each line of text.
const backgroundPadding = (layer: PhotoText) => ({
  padX: layer.size * 0.34,
  padY: layer.size * 0.16,
});

// Outline and shadow strokes extend the drawn glyphs beyond their outlines;
// a background blob extends past every non-blank line by its padding.
function effectBounds(
  layer: PhotoText,
  { ink, rows }: ReturnType<typeof layoutText>,
) {
  if (!ink) return null;
  if (layer.style === "box") {
    const { padX, padY } = backgroundPadding(layer);
    const lines = rows.filter((row) => row.width > 0);
    return {
      left: Math.min(ink.left, ...lines.map((row) => row.x - padX)),
      top: Math.min(ink.top, ...lines.map((row) => row.top - padY)),
      right: Math.max(
        ink.right,
        ...lines.map((row) => row.x + row.width + padX),
      ),
      bottom: Math.max(ink.bottom, ...lines.map((row) => row.bottom + padY)),
    };
  }
  if (layer.style === "outline") {
    const half = (layer.size * 0.13) / 2;
    return {
      left: ink.left - half,
      top: ink.top - half,
      right: ink.right + half,
      bottom: ink.bottom + half,
    };
  }
  if (layer.style === "shadow")
    return { ...ink, right: ink.right + 1.1, bottom: ink.bottom + 1.3 };
  return ink;
}

const quoted = (characters: string[]) =>
  characters
    .slice(0, 5)
    .map((character) => `“${character}”`)
    .join(", ") + (characters.length > 5 ? " and others" : "");

// Why a text layer cannot be rendered exactly, or null when it can. Preview,
// editor warnings and export all use this one check.
export function textProblem(layer: PhotoText, font: Font, height: number) {
  const layout = layoutText(layer, font);
  if (layout.missing.length)
    return `The font can’t draw ${quoted(layout.missing)}. Remove or replace ${layout.missing.length === 1 ? "it" : "them"}.`;
  if (
    layout.overflow ||
    layer.x + layer.width > 240.1 ||
    layer.y + layer.height > height + 0.1
  )
    return "Text does not fit its box or canvas. Increase the box size, reduce the text size, or shorten the copy.";
  const drawn = effectBounds(layer, layout);
  if (
    drawn &&
    (drawn.left < -0.1 ||
      drawn.top < -0.1 ||
      drawn.right > 240.1 ||
      drawn.bottom > height + 0.1)
  )
    return "Text is drawn past the edge of the slide. Move the box inward or reduce the text size.";
  return null;
}

export const DEFAULT_ROUNDNESS = 60;
const round2 = (value: number) => Number(value.toFixed(2));

// TikTok/Instagram background text: one blob hugging each line, with rounded
// outer corners and inward curves where a shorter line meets a longer one.
// Blank lines split the text into separate blobs.
export function backgroundPath(layer: PhotoText, font: Font) {
  const { rows } = layoutText(layer, font);
  const { padX, padY } = backgroundPadding(layer),
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
  const canvas = canvasHeight(aspect);
  const width = clamp(layer.width, 20, 240);
  let next: PhotoText = { ...layer, width, x: clamp(layer.x, 0, 240 - width) };
  // Copy too tall for the canvas, or a character wider than the box, shrinks
  // one point at a time. Text that still overflows at the minimum size keeps
  // a canvas-sized box, so rendering reports it instead of saving bad geometry.
  let layout = layoutText(next, font);
  while ((layout.requiredHeight > canvas || layout.tooWide) && next.size > 6) {
    next = { ...next, size: Math.max(6, Math.ceil(next.size) - 1) };
    layout = layoutText(next, font);
  }
  const height = clamp(Math.max(34, layout.requiredHeight), 12, canvas);
  return {
    ...next,
    height,
    y: clamp(Math.ceil((canvas - height) / 2), 0, canvas - height),
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
