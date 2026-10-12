import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { guard } from "@/lib/guard";
import {
  assetUpdateSchema,
  brandSchema,
  formatSchema,
  metricsSchema,
  postSchema,
  type Asset,
  type Brand,
  type Format,
  type Post,
} from "@/lib/schema";
import {
  approvePost,
  archivePost,
  assertApproval,
  assetInUse,
  audit,
  contentOf,
  dataDir,
  digest,
  get,
  list,
  now,
  put,
  remove,
  restorePost,
  savePost,
  state,
  StudioError,
  transaction,
  uid,
} from "@/lib/store";
import { renderAll } from "@/lib/render";
import {
  assertAiAvailable,
  generateCopy,
  generateIdeas,
  generateHooks,
} from "@/lib/ai";
import { readWebsite } from "@/lib/website";
import { photoFont } from "@/lib/photo-render";
import { photoSlide } from "@/lib/photo-layout";
import {
  slideAssetIds,
  slideStructure,
  templateSlide,
} from "@/lib/format-template";
import { describeIssues } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_LIMIT = 250_000;
const UPLOAD_LIMIT = 22 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_METRIC_SNAPSHOTS = 200;
const TIKTOK_POST_URL = /^https:\/\/((www|m|vm|vt)\.)?tiktok\.com\//i;
const ACTIONS = new Set([
  "brand",
  "format",
  "asset",
  "removeAsset",
  "hooks",
  "ideas",
  "save",
  "create",
  "duplicate",
  "render",
  "approve",
  "archive",
  "restore",
  "publish",
  "metrics",
]);

// Counts the bytes actually received, so a chunked request without a
// Content-Length header cannot exceed the limit either.
async function readLimited(req: NextRequest, limit: number, message: string) {
  if (Number(req.headers.get("content-length") || 0) > limit)
    throw new StudioError(message, 413);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new StudioError(message, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readJson(req: NextRequest) {
  const text = new TextDecoder().decode(
    await readLimited(req, JSON_LIMIT, "Request too large."),
  );
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new StudioError("The request body is not valid JSON.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new StudioError("The request body must be a JSON object.");
  return input as Record<string, unknown>;
}
const unreadable = () =>
  new StudioError("This file is not a readable JPEG, PNG, or WebP image.");

async function upload(req: NextRequest) {
  const bytes = await readLimited(req, UPLOAD_LIMIT, "Upload limit is 20 MB.");
  const form = await new Response(bytes, {
    headers: { "content-type": req.headers.get("content-type") || "" },
  })
    .formData()
    .catch(() => {
      throw new StudioError("The upload could not be read. Try again.");
    });
  const file = form.get("file");
  if (!(file instanceof File) || file.size > 20 * 1024 * 1024)
    throw new StudioError("Choose a JPEG, PNG, or WebP under 20 MB.");
  const rights = String(form.get("rights") || "")
    .trim()
    .slice(0, 1000);
  if (!rights)
    throw new StudioError(
      "Record usage rights for these images, for example “Original photos taken by me”.",
    );
  const collection =
    String(form.get("collection") || "")
      .trim()
      .slice(0, 80) || "My collection";
  const input = Buffer.from(await file.arrayBuffer());
  const meta = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw unreadable();
    });
  if (
    !["jpeg", "png", "webp"].includes(meta.format || "") ||
    (meta.pages || 1) > 1
  )
    throw new StudioError(
      "Only still JPEG, PNG, and WebP images are supported.",
    );
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS)
    throw new StudioError(
      "This image is larger than 40 megapixels. Resize it and upload again.",
      413,
    );
  const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({
      width: 2400,
      height: 2400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw unreadable();
    });
  const hash = digest(data);
  const existing = list<Asset>("asset").find(
    (asset) =>
      asset.hash === hash &&
      asset.collection === collection &&
      !asset.removedAt,
  );
  if (existing) return { asset: existing, duplicate: true };
  const asset: Asset = {
    id: uid(),
    name: file.name.slice(0, 150),
    collection,
    rights,
    width: info.width,
    height: info.height,
    hash,
    createdAt: now(),
  };
  await mkdir(path.join(dataDir, "assets"), { recursive: true });
  await writeFile(path.join(dataDir, "assets", asset.id + ".jpg"), data);
  put("asset", asset);
  audit("asset.uploaded", asset.id);
  return { asset, duplicate: false };
}

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  return NextResponse.json(state());
}
export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    if (req.headers.get("content-type")?.includes("multipart/form-data"))
      return NextResponse.json(await upload(req));
    const input = await readJson(req);
    const action = z.string({ error: "Choose an action." }).parse(input.action);
    if (!ACTIONS.has(action)) throw new StudioError("Unknown action.");
    if (action === "brand") {
      const data = brandSchema.parse(input.data);
      // An id means "update this brief"; it must already exist.
      if (data.id) get<Brand>("brand", data.id);
      const item = { ...data, id: data.id || uid() };
      put("brand", item);
      return NextResponse.json(item);
    }
    if (action === "format") {
      const data = formatSchema.parse(input.data);
      if (data.id) get<Format>("format", data.id);
      if (data.brandId) get<Brand>("brand", data.brandId);
      const item = {
        ...data,
        slideCount: data.structure?.length ?? data.slideCount,
        id: data.id || uid(),
      };
      put("format", item);
      return NextResponse.json(item);
    }
    if (action === "asset") {
      const id = z.string().parse(input.id);
      const asset = get<Asset>("asset", id);
      const data = assetUpdateSchema.parse(input.data);
      const item = { ...asset, ...data };
      put("asset", item);
      audit("asset.updated", id);
      return NextResponse.json(item);
    }
    if (action === "removeAsset") {
      const id = z.string().parse(input.id);
      const asset = get<Asset>("asset", id);
      if (assetInUse(id)) {
        // Revisions are immutable, so keep the file for slideshows that use it.
        const item = { ...asset, removedAt: now() };
        put("asset", item);
        audit("asset.removed", id);
        return NextResponse.json({ asset: item, kept: true });
      }
      remove("asset", id);
      await unlink(path.join(dataDir, "assets", `${id}.jpg`)).catch(() => {});
      audit("asset.deleted", id);
      return NextResponse.json({ asset, kept: false });
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
      assertAiAvailable();
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
      assertAiAvailable();
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
      // A saved structure fixes the slides; otherwise the popup's count applies.
      const structure = slideStructure(
        format,
        args.slideCount ?? Math.min(format.slideCount, 10),
      );
      const slideCount = structure.length;
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
              slides: structure.map((slide, i) => ({
                title:
                  (i === 0 && args.selectedHook) ||
                  slide.text ||
                  (i === 0
                    ? args.topic.slice(0, 180)
                    : i === slideCount - 1
                      ? "What will you try next?"
                      : `Your idea ${i}`),
                body: "",
              })),
            };
      // Removed images stay on disk for old revisions but are never reused.
      const library = list<Asset>("asset").filter((a) => !a.removedAt);
      const assets = args.collection
        ? library.filter((a) => a.collection === args.collection)
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
          role: structure[i].role,
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
        postContent.slides = postContent.slides.map((slide, index) =>
          format.templates
            ? templateSlide(
                slide,
                format,
                { default: font, semibold, regular },
                library,
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
      const suffix = " (copy)";
      return NextResponse.json(
        savePost({
          ...contentOf(post),
          title: post.title.slice(0, 160 - suffix.length) + suffix,
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
    if (action === "archive") return NextResponse.json(archivePost(id));
    if (action === "restore") return NextResponse.json(restorePost(id));
    if (action === "publish") {
      const url = z.url().parse(input.url);
      if (!TIKTOK_POST_URL.test(url))
        throw new StudioError(
          "Enter the HTTPS link of your published TikTok post (tiktok.com or vm.tiktok.com).",
        );
      const replace = input.replace === true;
      return NextResponse.json(
        transaction(() => {
          const current = get<Post>("post", id);
          assertApproval(current);
          // Changing a recorded link must be deliberate, never a silent overwrite.
          if (current.status === "published" && !replace)
            throw new StudioError(
              "This post is already recorded as published. Use “Correct link” to change its URL.",
              409,
            );
          const corrected = current.status === "published";
          current.status = "published";
          current.publishedUrl = url;
          if (!corrected) current.publishedAt = now();
          put("post", current);
          audit(
            corrected
              ? "publication.url_corrected"
              : "publication.owner_confirmed",
            id,
          );
          return current;
        }),
      );
    }
    if (action === "metrics") {
      if (post.status !== "published")
        throw new StudioError("Record a published post before adding results.");
      const snapshot = {
        ...metricsSchema.parse(input.data),
        measuredAt: now(),
      };
      // Keep earlier snapshots so results can be compared over time.
      post.metricsHistory = [
        ...(post.metricsHistory ?? []),
        ...(post.metrics ? [post.metrics] : []),
      ].slice(-MAX_METRIC_SNAPSHOTS);
      post.metrics = snapshot;
      put("post", post);
      audit("results.recorded", id);
      return NextResponse.json(post);
    }
    throw new StudioError("Unknown action.");
  } catch (e) {
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof z.ZodError)
      return NextResponse.json(
        { error: describeIssues(e.issues) },
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
