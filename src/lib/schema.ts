import { z } from "zod";
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const brandSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  product: z.string().max(2000),
  audience: z.string().max(1000),
  tone: z.string().max(300),
  facts: z.string().max(3000),
  prohibited: z.string().max(1000),
  destination: z.string().max(500),
});
export type Brand = z.infer<typeof brandSchema> & { id: string };
export const formatSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  instructions: z.string().max(2000),
  color,
  ink: color,
  accent: color,
  aspect: z.enum(["portrait", "story"]),
  font: z.enum(["serif", "sans"]),
  slideCount: z.number().int().min(2).max(10),
});
export type Format = z.infer<typeof formatSchema> & { id: string };
export const slideSchema = z.object({
  id: z.string(),
  role: z.enum(["hook", "body", "cta"]),
  title: z.string().max(180),
  body: z.string().max(450),
  assetId: z.string().nullable(),
  background: color,
  ink: color,
  accent: color,
  font: z.enum(["serif", "sans"]),
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
      "Invalid planned time",
    ),
  notes: z.string().max(1000),
  slides: z.array(slideSchema).min(1).max(20),
  flags: z.array(z.string().max(500)).max(20),
});
export type PostContent = z.infer<typeof postSchema>;
export type Post = PostContent & {
  id: string;
  revision: number;
  status: "needs_review" | "approved" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
  publishedUrl?: string;
  publishedAt?: string;
  metrics?: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    measuredAt: string;
  };
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
