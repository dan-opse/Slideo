import type { Asset, Format, StudioState } from "./schema";

// Brands and posts arrive newest first. Prefer the brand the format already
// uses, then the brand of the latest slideshow, then the original brief, so a
// newly added brief never silently becomes the default.
export function defaultBrandId(
  state: Pick<StudioState, "brands" | "posts">,
  format?: Pick<Format, "id" | "brandId">,
) {
  const exists = (id?: string): id is string =>
    !!id && state.brands.some((brand) => brand.id === id);
  if (exists(format?.brandId)) return format.brandId;
  const recent =
    state.posts.find(
      (post) =>
        post.status !== "archived" &&
        (!format?.id || post.formatId === format.id) &&
        exists(post.brandId),
    ) ?? state.posts.find((post) => exists(post.brandId));
  return recent?.brandId ?? state.brands.at(-1)?.id ?? "";
}

// Removed images keep their files for old revisions but leave every picker.
export const libraryAssets = (assets: Asset[]) =>
  assets.filter((asset) => !asset.removedAt);

export const collectionsOf = (assets: Asset[]) => [
  ...new Set(libraryAssets(assets).map((asset) => asset.collection)),
];

// A clean starting point instead of a copy of whichever format is newest.
export function blankFormat(brandId: string): Format {
  return {
    id: "",
    name: "My new format",
    description: "",
    instructions:
      "Write a concise hook, one clear idea per slide, and a helpful call to action. Use only verified brand facts.",
    color: "#000000",
    ink: "#ffffff",
    accent: "#ffffff",
    aspect: "story",
    font: "tiktok",
    design: "photo",
    slideCount: 6,
    brandId,
    hooks: [],
    tonePreset: "custom",
    toneInstructions: "",
  };
}

export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
