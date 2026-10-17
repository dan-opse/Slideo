import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { authorize } from "@/lib/auth";
import { readLimited } from "@/lib/body";
import { files, UPLOAD_BYTES } from "@/lib/files";
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
  digest,
  fileKey,
  get,
  list,
  nextVersion,
  now,
  put,
  remove,
  restorePost,
  savePost,
  state,
  StudioError,
  transaction,
  uid,
  withAccount,
} from "@/lib/store";
import { renderAll } from "@/lib/render";
import {
  assertAiAvailable,
  generateCopy,
  generateIdeas,
  generateHooks,
} from "@/lib/ai";
import { readWebsite } from "@/lib/website";
import { disconnect } from "@/lib/tiktok-accounts";
import { photoFont } from "@/lib/photo-render";
import { slideStructure, templateSlide } from "@/lib/format-template";
import { describeIssues } from "@/lib/errors";
import { logUnexpected } from "@/lib/log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// AI drafts wait up to 90 seconds for OpenAI, then render every slide.
export const maxDuration = 300;

const JSON_LIMIT = 250_000;
const UPLOAD_LIMIT = UPLOAD_BYTES + 2 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_METRIC_SNAPSHOTS = 200;
const TIKTOK_POST_URL = /^https:\/\/((www|m|vm|vt)\.)?tiktok\.com\//i;
const ACTIONS = new Set([
  "brand",
  "format",
  "asset",
  "removeAsset",
  "removeAssets",
  "uploadUrl",
  "importUpload",
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
  "tiktokDisconnect",
]);

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

const uploadFields = z.object({
  name: z
    .string()
    .default("image")
    .transform((s) => s.slice(0, 150)),
  rights: z
    .string()
    .default("")
    .transform((s) => s.trim().slice(0, 1000)),
  collection: z
    .string()
    .default("")
    .transform((s) => s.trim().slice(0, 80) || "My collection"),
});

// Normalizes an uploaded image and adds it to the library.
async function importImage(
  input: Buffer,
  fields: z.infer<typeof uploadFields>,
) {
  if (input.byteLength > UPLOAD_BYTES)
    throw new StudioError("Choose a JPEG, PNG, or WebP under 20 MB.");
  if (!fields.rights)
    throw new StudioError(
      "Record usage rights for these images, for example “Original photos taken by me”.",
    );
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
  const same = (asset: Asset) =>
    asset.hash === hash &&
    asset.collection === fields.collection &&
    !asset.removedAt;
  const existing = (await list<Asset>("asset")).find(same);
  if (existing) return { asset: existing, duplicate: true };
  const asset: Asset = {
    id: uid(),
    name: fields.name,
    collection: fields.collection,
    rights: fields.rights,
    width: info.width,
    height: info.height,
    hash,
    createdAt: now(),
  };
  // The file goes first, so no library record ever points at a missing one.
  const key = fileKey("assets", `${asset.id}.jpg`);
  await files().write(key, data, "image/jpeg");
  const result = await transaction(async () => {
    const twin = (await list<Asset>("asset")).find(same);
    if (twin) return { asset: twin, duplicate: true };
    await put("asset", asset);
    await audit("asset.uploaded", asset.id);
    return { asset, duplicate: false };
  });
  // The same image arrived from another upload meanwhile.
  if (result.duplicate)
    await files()
      .remove([key])
      .catch(() => {});
  return result;
}

// A multipart upload through this route (local studio and small files).
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
  if (!(file instanceof File) || file.size > UPLOAD_BYTES)
    throw new StudioError("Choose a JPEG, PNG, or WebP under 20 MB.");
  return importImage(
    Buffer.from(await file.arrayBuffer()),
    uploadFields.parse({
      name: file.name,
      rights: String(form.get("rights") || ""),
      collection: String(form.get("collection") || ""),
    }),
  );
}

// Revisions are immutable, so an image a revision uses is only taken out of
// the library; its file stays for the slideshows that use it.
async function removeAssets(ids: string[]) {
  const results = await transaction(async () => {
    const out: { asset: Asset; kept: boolean }[] = [];
    for (const id of ids) {
      const asset = await get<Asset>("asset", id);
      if (await assetInUse(id)) {
        const item = { ...asset, removedAt: now() };
        await put("asset", item);
        await audit("asset.removed", id);
        out.push({ asset: item, kept: true });
        continue;
      }
      await remove("asset", id);
      await audit("asset.deleted", id);
      out.push({ asset, kept: false });
    }
    return out;
  });
  await files()
    .remove(
      results
        .filter((r) => !r.kept)
        .map((r) => fileKey("assets", `${r.asset.id}.jpg`)),
    )
    .catch(() => {});
  return results;
}

export async function GET(req: NextRequest) {
  const who = await authorize(req);
  if (who instanceof NextResponse) return who;
  try {
    return await withAccount(who, async () => NextResponse.json(await state()));
  } catch (e) {
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    logUnexpected("Studio load", e);
    return NextResponse.json(
      { error: "The studio could not load. Try again." },
      { status: 500 },
    );
  }
}
export async function POST(req: NextRequest) {
  const who = await authorize(req);
  if (who instanceof NextResponse) return who;
  let action = "upload",
    target: string | undefined;
  try {
    return await withAccount(who, async () => {
      if (req.headers.get("content-type")?.includes("multipart/form-data"))
        return NextResponse.json(await upload(req));
      const input = await readJson(req);
      action = z.string({ error: "Choose an action." }).parse(input.action);
      if (typeof input.id === "string") target = input.id;
      if (!ACTIONS.has(action)) throw new StudioError("Unknown action.");
      return await handle(action, input);
    });
  } catch (e) {
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof z.ZodError)
      return NextResponse.json(
        { error: describeIssues(e.issues) },
        { status: 400 },
      );
    logUnexpected("Studio operation", e, { action, id: target });
    return NextResponse.json(
      {
        error:
          "Could not complete this operation. Check the input and try again.",
      },
      { status: 500 },
    );
  }
}

async function handle(action: string, input: Record<string, unknown>) {
  if (action === "brand" || action === "format") {
    // An id means "update this record"; it must exist at `expected`.
    const expected =
      input.expected === undefined
        ? undefined
        : z.number().int().parse(input.expected);
    if (action === "brand") {
      const data = brandSchema.parse(input.data);
      return NextResponse.json(
        await transaction(async () => {
          const item: Brand = {
            ...data,
            id: data.id || uid(),
            version: await nextVersion("brand", data.id, expected),
          };
          await put("brand", item);
          return item;
        }),
      );
    }
    const data = formatSchema.parse(input.data);
    return NextResponse.json(
      await transaction(async () => {
        const version = await nextVersion("format", data.id, expected);
        if (data.brandId) await get<Brand>("brand", data.brandId);
        const item: Format = {
          ...data,
          slideCount: data.structure?.length ?? data.slideCount,
          id: data.id || uid(),
          version,
        };
        await put("format", item);
        return item;
      }),
    );
  }
  if (action === "asset") {
    const id = z.string().parse(input.id);
    const data = assetUpdateSchema.parse(input.data);
    // Read and written together, so an edit can't bring back an image that
    // was deleted a moment earlier.
    return NextResponse.json(
      await transaction(async () => {
        const item = { ...(await get<Asset>("asset", id)), ...data };
        await put("asset", item);
        await audit("asset.updated", id);
        return item;
      }),
    );
  }
  if (action === "removeAsset") {
    const id = z.string().parse(input.id);
    const [result] = await removeAssets([id]);
    return NextResponse.json(result);
  }
  if (action === "removeAssets") {
    const ids = z
      .array(z.string(), { error: "Choose the images to delete." })
      .min(1, { error: "Choose the images to delete." })
      .max(5000)
      .parse(input.ids);
    const results = await removeAssets([...new Set(ids)]);
    return NextResponse.json({
      deleted: results.filter((r) => !r.kept).map((r) => r.asset),
      kept: results.filter((r) => r.kept).map((r) => r.asset),
    });
  }
  // Browsers send image bytes straight to storage, which keeps them clear
  // of the hosting platform's request size limit, then ask for the import.
  if (action === "uploadUrl") {
    const id = uid();
    return NextResponse.json({
      id,
      url: await files().uploadUrl(fileKey("uploads", id)),
    });
  }
  if (action === "importUpload") {
    const id = z.uuid({ error: "Upload the image again." }).parse(input.id);
    const key = fileKey("uploads", id);
    const bytes = await files().read(key);
    if (!bytes)
      throw new StudioError("The upload did not arrive. Try again.", 404);
    try {
      return NextResponse.json(
        await importImage(bytes, uploadFields.parse(input)),
      );
    } finally {
      await files()
        .remove([key])
        .catch(() => {});
    }
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
    const brand = await get<Brand>("brand", args.brandId);
    if ((args.format.hooks?.length ?? 0) > 190)
      throw new StudioError(
        "Keep at most 190 existing hooks before generating ten more.",
      );
    await assertAiAvailable();
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
    const brand = await get<Brand>("brand", args.brandId);
    await assertAiAvailable();
    const source = await readWebsite(args.url);
    const ideas = await generateIdeas(brand, source);
    return NextResponse.json({
      source: { url: source.url, title: source.title },
      ideas,
    });
  }
  if (action === "save") {
    const content = postSchema.parse(input.data);
    return NextResponse.json(
      await savePost(
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
    const brand = await get<Brand>("brand", args.brandId),
      format = await get<Format>("format", args.formatId);
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
            (await list<Post>("post"))
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
    // Removed images stay in storage for old revisions but are never reused.
    const library = (await list<Asset>("asset")).filter((a) => !a.removedAt);
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
      // Formats without role templates use the template fallback, which
      // honors their saved colors, exactly as the format preview does.
      postContent.slides = postContent.slides.map((slide, index) =>
        templateSlide(
          slide,
          format,
          { default: font, semibold, regular },
          library,
          index,
          args.collection,
        ),
      ) as typeof postContent.slides;
    }
    // Layout derives geometry from the copy; never persist a post that
    // ordinary saves and rendering would then reject.
    const checked = postSchema.safeParse(postContent);
    if (!checked.success)
      throw new StudioError(
        `This format produced a slide that doesn't fit: ${describeIssues(checked.error.issues)} Adjust the format's text settings and try again.`,
        422,
      );
    const post = await savePost(checked.data);
    return NextResponse.json(post);
  }
  // Actions that change a post read it inside the account transaction; a
  // copy read earlier could overwrite a change made in between.
  const id = z.string().parse(input.id);
  if (action === "duplicate") {
    const post = await get<Post>("post", id);
    const suffix = " (copy)";
    return NextResponse.json(
      await savePost({
        ...contentOf(post),
        title: post.title.slice(0, 160 - suffix.length) + suffix,
        plannedAt: "",
      }),
    );
  }
  if (action === "render" || action === "approve") {
    const revision = z.number().int().parse(input.revision);
    // approvePost checks the revision again under the lock.
    if ((await get<Post>("post", id)).revision !== revision)
      throw new StudioError(
        "Stale revision. Save and review the current version.",
        409,
      );
    const { hashes } = await renderAll(id, revision);
    if (action === "approve")
      return NextResponse.json(await approvePost(id, revision, hashes));
    return NextResponse.json({ ready: true, revision });
  }
  if (action === "archive") return NextResponse.json(await archivePost(id));
  if (action === "restore") return NextResponse.json(await restorePost(id));
  if (action === "publish") {
    const url = z.url().parse(input.url);
    if (!TIKTOK_POST_URL.test(url))
      throw new StudioError(
        "Enter the HTTPS link of your published TikTok post (tiktok.com or vm.tiktok.com).",
      );
    const replace = input.replace === true;
    const revision = z
      .number({ error: "Reload the studio, then record the link again." })
      .int()
      .parse(input.revision);
    return NextResponse.json(
      await transaction(async () => {
        const current = await get<Post>("post", id);
        // Only the revision the owner reviewed and exported may be marked
        // published; a newer approval from another window must not be.
        if (current.revision !== revision)
          throw new StudioError(
            "This slideshow changed in another window. Reload to review the current version before recording its link.",
            409,
          );
        await assertApproval(current);
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
        await put("post", current);
        await audit(
          corrected
            ? "publication.url_corrected"
            : "publication.owner_confirmed",
          id,
        );
        return current;
      }),
    );
  }
  if (action === "tiktokDisconnect")
    return NextResponse.json(await disconnect(id));
  if (action === "metrics") {
    const data = metricsSchema.parse(input.data);
    return NextResponse.json(
      await transaction(async () => {
        const post = await get<Post>("post", id);
        if (post.status !== "published")
          throw new StudioError(
            "Record a published post before adding results.",
          );
        // Keep earlier snapshots so results can be compared over time.
        post.metricsHistory = [
          ...(post.metricsHistory ?? []),
          ...(post.metrics ? [post.metrics] : []),
        ].slice(-MAX_METRIC_SNAPSHOTS);
        post.metrics = { ...data, measuredAt: now() };
        await put("post", post);
        await audit("results.recorded", id);
        return post;
      }),
    );
  }
  throw new StudioError("Unknown action.");
}
