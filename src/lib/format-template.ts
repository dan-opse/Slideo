import type { Font } from "opentype.js";
import type {
  Asset,
  Format,
  PhotoText,
  RoleTemplate,
  Slide,
  StructureSlide,
} from "./schema";
import { canvasHeight, defaultText, fitText, photoSlide } from "./photo-layout";

export const roleNames = { hook: "Hook", body: "Content", cta: "CTA" } as const;
export const tonePresets = {
  custom: "Custom",
  conversational: "Conversational",
  educational: "Educational",
  story: "Storytelling",
  concise: "Short & direct",
} as const;
export const toneGuidance = {
  custom: "Follow the custom voice and style guidance.",
  conversational:
    "Write naturally, as if explaining the idea to a friend. Use plain language and short sentences.",
  educational:
    "Teach one useful point at a time. Explain unfamiliar terms and keep advice specific and grounded.",
  story:
    "Use a clear beginning, turning point, and takeaway. Only use personal experiences or results explicitly supplied as verified facts.",
  concise:
    "Use direct language, short sentences, and one clear thought per slide. Cut filler.",
} as const;

// A format's slides in order. Formats without a saved structure get a hook,
// content slides and a CTA, sized by `count` (the creation popup's override).
export function slideStructure(
  format: Format,
  count = format.slideCount,
): StructureSlide[] {
  if (format.structure?.length) return format.structure;
  const length = Math.max(2, Math.min(10, Math.round(count || 2)));
  return Array.from({ length }, (_, index) => {
    const role = index === 0 ? "hook" : index === length - 1 ? "cta" : "body";
    return {
      label: role === "body" ? `Content ${index}` : roleNames[role],
      role,
      text: "",
    };
  });
}

export function templateFor(format: Format, role: Slide["role"]): RoleTemplate {
  return (
    format.templates?.[role] ?? {
      collection: "",
      imageGrid: "none",
      displayText: true,
      overlay: 0.25,
      font: "default",
      color: format.ink,
      style: "outline",
      size: 12,
      position: "center",
      width: 100,
      align: "center",
      imageFit: "cover",
      imageZoom: 1,
      imageX: 50,
      imageY: 50,
    }
  );
}

export function templateSlide(
  slide: Slide,
  format: Format,
  fonts: Record<PhotoText["font"], Font>,
  assets: Asset[],
  index: number,
  collectionOverride?: string,
): Slide {
  const template = templateFor(format, slide.role);
  const collection = collectionOverride || template.collection;
  // Removed images stay on disk for old revisions but are never reused.
  const available = collection
    ? assets.filter(
        (asset) => asset.collection === collection && !asset.removedAt,
      )
    : [];
  const count =
    template.imageGrid === "quad" ? 4 : template.imageGrid === "split" ? 2 : 1;
  const ids = Array.from(
    { length: Math.min(count, available.length) },
    (_, offset) => available[(index * count + offset) % available.length].id,
  );
  const width = (208 * template.width) / 100;
  const text = fitText(
    {
      ...defaultText(
        [slide.title, slide.body].filter(Boolean).join("\n\n"),
        `${slide.id}-text`,
      ),
      font: template.font,
      size: template.size,
      color: template.color,
      style: template.style,
      styleColor: template.styleColor,
      roundness: template.roundness,
      align: template.align,
      width,
      x: (240 - width) / 2,
    },
    fonts[template.font],
    format.aspect,
  );
  if (template.position === "top")
    text.y = Math.max(
      0,
      Math.min(28, canvasHeight(format.aspect) - text.height),
    );
  if (template.position === "bottom")
    text.y = Math.max(0, canvasHeight(format.aspect) - text.height - 28);
  return {
    ...photoSlide(slide, format.aspect, fonts[template.font]),
    background: format.color,
    ink: format.ink,
    assetId: ids[0] ?? null,
    additionalAssetIds: ids.slice(1),
    imageGrid: template.imageGrid,
    overlay: template.overlay,
    imageFit: template.imageFit,
    imageZoom: template.imageZoom,
    imageX: template.imageX,
    imageY: template.imageY,
    textLayers: template.displayText ? [text] : [],
  };
}

export function slideAssetIds(slide: Slide) {
  return [slide.assetId, ...(slide.additionalAssetIds ?? [])].filter(
    (id): id is string => !!id,
  );
}

// Images a render actually draws: photo slides show only the slots their grid
// selects, editorial slides only their background. Hidden leftovers from a
// larger grid are kept in the revision but are not slide content.
export function visibleAssetIds(slide: Slide) {
  return slide.design === "photo"
    ? imageSlots(slide, 1).map((slot) => slot.id)
    : slide.assetId
      ? [slide.assetId]
      : [];
}

export function imageSlots(slide: Slide, height: number) {
  const ids = [slide.assetId, ...(slide.additionalAssetIds ?? [])];
  const count =
    slide.imageGrid === "quad" ? 4 : slide.imageGrid === "split" ? 2 : 1;
  return ids.slice(0, count).flatMap((id, index) =>
    id
      ? [
          {
            id,
            x: count === 4 ? (index % 2) * 120 : 0,
            y:
              count === 4
                ? (Math.floor(index / 2) * height) / 2
                : count === 2
                  ? (index * height) / 2
                  : 0,
            width: count === 4 ? 120 : 240,
            height: count > 1 ? height / 2 : height,
          },
        ]
      : [],
  );
}
