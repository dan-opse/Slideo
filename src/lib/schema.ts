import { z } from "zod";
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
// Photo-editor coordinates use a 240-unit canvas, scaled to 1080px on export.
export const photoTextSchema = z.object({
  id: z.string(),
  text: z.string().max(630),
  font: z.enum(["default", "semibold", "regular"]),
  size: z.number().min(6).max(48),
  color,
  style: z.enum(["outline", "plain", "shadow", "box"]),
  // Outline, shadow or background color. Unset keeps the original black.
  styleColor: color.optional(),
  // Background corner rounding, 0 (square) to 100 (pill).
  roundness: z.number().min(0).max(100).optional(),
  align: z.enum(["left", "center", "right"]),
  x: z.number().min(0).max(240),
  y: z.number().min(0).max(427),
  width: z.number().min(20).max(240),
  height: z.number().min(12).max(427),
});
export type PhotoText = z.infer<typeof photoTextSchema>;
export const assetUpdateSchema = z.object({
  name: z.string().trim().min(1).max(150),
  collection: z.string().trim().min(1).max(80),
  rights: z.string().trim().min(1).max(1000),
});
export const brandSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  product: z.string().max(2000),
  audience: z.string().max(1000),
  tone: z.string().max(300),
  facts: z.string().max(3000),
  prohibited: z.string().max(1000),
  destination: z
    .string()
    .trim()
    .max(500)
    .refine(
      (v) => v === "" || (/^https?:\/\//i.test(v) && URL.canParse(v)),
      "Website must be a full web address starting with https://",
    ),
});
export type Brand = z.infer<typeof brandSchema> & { id: string };
export const roleTemplateSchema = z.object({
  collection: z.string().max(80),
  imageGrid: z.enum(["none", "split", "quad"]),
  displayText: z.boolean(),
  overlay: z.number().min(0).max(0.85),
  font: photoTextSchema.shape.font,
  color,
  style: photoTextSchema.shape.style,
  styleColor: color.optional(),
  roundness: photoTextSchema.shape.roundness,
  size: photoTextSchema.shape.size,
  position: z.enum(["top", "center", "bottom"]),
  width: z.number().min(20).max(100),
  align: photoTextSchema.shape.align,
  imageFit: z.enum(["cover", "contain"]),
  imageZoom: z.number().min(1).max(3),
  imageX: z.number().min(0).max(100),
  imageY: z.number().min(0).max(100),
});
export type RoleTemplate = z.infer<typeof roleTemplateSchema>;
// One position in a format's slide-by-slide outline. `role` picks which
// Hook/Content/CTA visual template the slide uses.
export const structureSlideSchema = z.object({
  label: z.string().trim().max(40),
  role: z.enum(["hook", "body", "cta"]),
  text: z.string().max(180),
});
export type StructureSlide = z.infer<typeof structureSlideSchema>;
export const formatSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  instructions: z.string().max(2000),
  color,
  ink: color,
  accent: color,
  aspect: z.enum(["portrait", "story"]),
  font: z.enum(["serif", "sans", "tiktok"]),
  design: z.enum(["editorial", "photo"]).optional(),
  slideCount: z.number().int().min(2).max(10),
  // When set, it fixes the slide count and the order of slides.
  structure: z.array(structureSlideSchema).min(2).max(10).optional(),
  brandId: z.string().optional(),
  websiteUrl: z.string().max(2000).optional(),
  hooks: z.array(z.string().trim().min(1).max(180)).max(200).optional(),
  tonePreset: z
    .enum(["custom", "conversational", "educational", "story", "concise"])
    .optional(),
  toneInstructions: z.string().max(8000).optional(),
  templates: z
    .object({
      hook: roleTemplateSchema,
      body: roleTemplateSchema,
      cta: roleTemplateSchema,
    })
    .optional(),
});
export type Format = z.infer<typeof formatSchema> & { id: string };
export const slideSchema = z.object({
  id: z.string(),
  role: z.enum(["hook", "body", "cta"]),
  title: z.string().max(180),
  body: z.string().max(450),
  assetId: z.string().nullable(),
  imageGrid: z.enum(["none", "split", "quad"]).optional(),
  // Empty strings mark unused grid slots; nulls from older clients mean the same.
  additionalAssetIds: z
    .array(
      z
        .string()
        .nullable()
        .transform((id) => id ?? ""),
    )
    .max(3)
    .optional(),
  background: color,
  ink: color,
  accent: color,
  font: z.enum(["serif", "sans", "tiktok"]),
  design: z.enum(["editorial", "photo"]).optional(),
  textLayers: z.array(photoTextSchema).max(12).optional(),
  imageFit: z.enum(["cover", "contain"]).optional(),
  imageZoom: z.number().min(1).max(3).optional(),
  imageX: z.number().min(0).max(100).optional(),
  imageY: z.number().min(0).max(100).optional(),
  align: z.enum(["left", "center"]),
  position: z.enum(["top", "center", "bottom"]),
  fontSize: z.number().int().min(40).max(110),
  overlay: z.number().min(0).max(0.85),
});
export type Slide = z.infer<typeof slideSchema>;
export const postSchema = z.object({
  title: z.string().trim().min(1).max(160),
  topic: z.string().max(2000),
  brandId: z.string(),
  formatId: z.string(),
  aspect: z.enum(["portrait", "story"]),
  caption: z.string().max(2200),
  account: z.string().max(100),
  plannedAt: z
    .string()
    .refine(
      (v) => v === "" || !Number.isNaN(Date.parse(v)),
      "Planned posting time is not a valid date.",
    ),
  notes: z.string().max(1000),
  slides: z.array(slideSchema).min(1).max(20),
  flags: z.array(z.string().max(500)).max(20),
});
export type PostContent = z.infer<typeof postSchema>;
const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const metricsSchema = z.object({
  views: count,
  likes: count,
  comments: count,
  shares: count,
});
export type Metrics = z.infer<typeof metricsSchema> & { measuredAt: string };
export type Post = PostContent & {
  id: string;
  revision: number;
  status: "needs_review" | "approved" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
  publishedUrl?: string;
  publishedAt?: string;
  metrics?: Metrics;
  // Earlier snapshots, oldest first; `metrics` is always the latest.
  metricsHistory?: Metrics[];
};
export type Asset = {
  id: string;
  name: string;
  collection: string;
  rights: string;
  width: number;
  height: number;
  hash: string;
  createdAt: string;
  // Removed from the library; the file stays for revisions that still use it.
  removedAt?: string;
};
export type StudioState = {
  brands: Brand[];
  formats: Format[];
  posts: Post[];
  assets: Asset[];
  settings: {
    aiReady: boolean;
    model: string;
    dailyLimit: number;
    usedToday: number;
    localOnly: true;
  };
};
