import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { guard } from "@/lib/guard";
import {
  brandSchema,
  formatSchema,
  postSchema,
  type Asset,
  type Brand,
  type Format,
  type Post,
} from "@/lib/schema";
import {
  approvePost,
  assertApproval,
  audit,
  contentOf,
  dataDir,
  digest,
  get,
  list,
  now,
  put,
  savePost,
  state,
  StudioError,
  transaction,
  uid,
} from "@/lib/store";
import { renderAll } from "@/lib/render";
import { generateCopy, generateIdeas, generateHooks } from "@/lib/ai";
import { readWebsite } from "@/lib/website";
import { photoFont } from "@/lib/photo-render";
import { photoSlide } from "@/lib/photo-layout";
import { slideAssetIds, templateSlide } from "@/lib/format-template";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  return NextResponse.json(state());
}
export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      if (Number(req.headers.get("content-length") || 0) > 22 * 1024 * 1024)
        throw new StudioError("Upload limit is 20 MB.", 413);
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size > 20 * 1024 * 1024)
        throw new StudioError("Choose a JPEG, PNG, or WebP under 20 MB.");
      const input = Buffer.from(await file.arrayBuffer());
      const meta = await sharp(input, {
        limitInputPixels: 40_000_000,
      }).metadata();
      if (
        !["jpeg", "png", "webp"].includes(meta.format || "") ||
        (meta.pages || 1) > 1
      )
        throw new StudioError(
          "Only still JPEG, PNG, and WebP images are supported.",
        );
      const { data, info } = await sharp(input, {
        limitInputPixels: 40_000_000,
      })
        .rotate()
        .resize({
          width: 2400,
          height: 2400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 92 })
        .toBuffer({ resolveWithObject: true });
      const asset: Asset = {
        id: uid(),
        name: file.name.slice(0, 150),
        collection: String(form.get("collection") || "My collection").slice(
          0,
          80,
        ),
        rights: String(form.get("rights") || "").slice(0, 1000),
        width: info.width,
        height: info.height,
        hash: digest(data),
        createdAt: now(),
      };
      await mkdir(path.join(dataDir, "assets"), { recursive: true });
      await writeFile(path.join(dataDir, "assets", asset.id + ".jpg"), data);
      put("asset", asset);
      audit("asset.uploaded", asset.id);
      return NextResponse.json({ asset });
    }
    if (Number(req.headers.get("content-length") || 0) > 250000)
      throw new StudioError("Request too large.", 413);
    const input = await req.json();
    const action = z.string().parse(input.action);
    if (action === "brand") {
      const data = brandSchema.parse(input.data);
      const item = { ...data, id: data.id || uid() };
      put("brand", item);
      return NextResponse.json(item);
    }
    if (action === "format") {
      const data = formatSchema.parse(input.data);
      if (data.brandId) get<Brand>("brand", data.brandId);
      const item = { ...data, id: data.id || uid() };
      put("format", item);
      return NextResponse.json(item);
    }
    if (action === "hooks") {
      const args = z
        .object({
          brandId: z.string(),
          format: formatSchema,
          prompt: z.string().trim().max(2000).default(""),
          url: z.string().max(2000).optional(),
        })
        .parse(input);
      const brand = get<Brand>("brand", args.brandId);
      if ((args.format.hooks?.length ?? 0) > 190)
        throw new StudioError(
          "Keep at most 190 existing hooks before generating ten more.",
        );
      if (!process.env.OPENAI_API_KEY)
        throw new StudioError(
          "Add OPENAI_API_KEY in .env.local and restart to generate hooks.",
          412,
        );
      const source = args.prompt
        ? undefined
        : await readWebsite(args.url?.trim() || brand.destination);
      const hooks = await generateHooks(
        brand,
        { ...args.format, id: args.format.id || "" },
        args.prompt,
        source,
      );
      return NextResponse.json({ hooks });
    }
    if (action === "ideas") {
      const args = z
        .object({
          brandId: z.string(),
          url: z.string().trim().min(1).max(2000),
        })
        .parse(input);
      const brand = get<Brand>("brand", args.brandId);
      const source = await readWebsite(args.url);
      const ideas = await generateIdeas(brand, source);
      return NextResponse.json({
        source: { url: source.url, title: source.title },
        ideas,
      });
    }
    if (action === "save") {
      const content = postSchema.parse(input.data);
      get<Brand>("brand", content.brandId);
      get<Format>("format", content.formatId);
      content.slides.forEach((s) => {
        slideAssetIds(s).forEach((id) => get<Asset>("asset", id));
      });
      return NextResponse.json(
        savePost(
          content,
          input.id ? z.string().parse(input.id) : undefined,
          input.expected === undefined
            ? undefined
            : z.number().int().parse(input.expected),
        ),
      );
    }
    if (action === "create") {
      const args = z
        .object({
          brandId: z.string(),
          formatId: z.string(),
          topic: z.string().trim().min(1).max(2000),
          mode: z.enum(["manual", "ai"]),
          collection: z.string().optional(),
          slideCount: z.number().int().min(2).max(10).optional(),
          selectedHook: z.string().trim().min(1).max(180).optional(),
        })
        .parse(input);
      const brand = get<Brand>("brand", args.brandId),
        format = get<Format>("format", args.formatId);
      const slideCount = args.slideCount ?? Math.min(format.slideCount, 10);
      const copy =
        args.mode === "ai"
          ? await generateCopy(
              brand,
              format,
              args.topic,
              list<Post>("post")
                .slice(0, 20)
                .map((p) => p.slides[0].title),
              slideCount,
              args.selectedHook,
            )
          : {
              title: args.topic.slice(0, 160),
              caption: "",
              flags: [],
              slides: Array.from({ length: slideCount }, (_, i) => ({
                title:
                  i === 0
                    ? args.selectedHook || args.topic.slice(0, 180)
                    : i === slideCount - 1
                      ? "What will you try next?"
                      : `Your idea ${i}`,
                body: "",
              })),
            };
      const assets = args.collection
        ? list<Asset>("asset").filter((a) => a.collection === args.collection)
        : [];
      const postContent = {
        title: copy.title,
        topic: args.topic,
        brandId: brand.id,
        formatId: format.id,
        aspect: format.aspect,
        caption: copy.caption,
        flags: copy.flags,
        account: "",
        plannedAt: "",
        notes: "",
        slides: copy.slides.map((s, i) => ({
          ...s,
          id: uid(),
          role:
            i === 0 ? "hook" : i === copy.slides.length - 1 ? "cta" : "body",
          assetId: assets[i]?.id || null,
          background: format.color,
          ink: format.ink,
          accent: format.accent,
          font: format.font,
          align: "left",
          position: "center",
          fontSize: 82,
          overlay: 0.4,
        })),
      } satisfies import("@/lib/schema").PostContent;
      if (format.design === "photo" || format.font === "tiktok") {
        const [font, semibold, regular] = await Promise.all([
          photoFont(),
          photoFont("semibold"),
          photoFont("regular"),
        ]);
        const allAssets = list<Asset>("asset");
        postContent.slides = postContent.slides.map((slide, index) =>
          format.templates
            ? templateSlide(
                slide,
                format,
                { default: font, semibold, regular },
                allAssets,
                index,
                args.collection,
              )
            : photoSlide(slide, format.aspect, font),
        ) as typeof postContent.slides;
      }
      const post = savePost(postContent);
      return NextResponse.json(post);
    }
    const id = z.string().parse(input.id);
    const post = get<Post>("post", id);
    if (action === "duplicate") {
      return NextResponse.json(
        savePost({
          ...contentOf(post),
          title: post.title + " (copy)",
          plannedAt: "",
        }),
      );
    }
    if (action === "render" || action === "approve") {
      const revision = z.number().int().parse(input.revision);
      if (post.revision !== revision)
        throw new StudioError(
          "Stale revision. Save and review the current version.",
          409,
        );
      const { hashes } = await renderAll(id, revision);
      if (action === "approve")
        return NextResponse.json(approvePost(id, revision, hashes));
      return NextResponse.json({ ready: true, revision });
    }
    if (action === "archive") {
      post.status = "archived";
      put("post", post);
      audit("post.archived", id);
      return NextResponse.json(post);
    }
    if (action === "publish") {
      const url = z.url().parse(input.url);
      if (!/^https:\/\/(www\.)?tiktok\.com\//i.test(url))
        throw new StudioError(
          "Enter the HTTPS URL of your published TikTok post.",
        );
      return NextResponse.json(
        transaction(() => {
          const current = get<Post>("post", id);
          assertApproval(current);
          current.status = "published";
          current.publishedUrl = url;
          current.publishedAt = now();
          put("post", current);
          audit("publication.owner_confirmed", id);
          return current;
        }),
      );
    }
    if (action === "metrics") {
      if (post.status !== "published")
        throw new StudioError("Record a published post before adding results.");
      const metric = z.number().int().nonnegative().nullable();
      post.metrics = {
        ...z
          .object({
            views: metric,
            likes: metric,
            comments: metric,
            shares: metric,
          })
          .parse(input.data),
        measuredAt: now(),
      };
      put("post", post);
      return NextResponse.json(post);
    }
    throw new StudioError("Unknown action.");
  } catch (e) {
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof z.ZodError)
      return NextResponse.json(
        {
          error: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        { status: 400 },
      );
    console.error(
      "Studio operation failed",
      e instanceof Error ? e.name : "Unknown error",
    );
    return NextResponse.json(
      {
        error:
          "Could not complete this operation. Check the input and try again.",
      },
      { status: 500 },
    );
  }
}
