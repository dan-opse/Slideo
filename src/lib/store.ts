import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { slideAssetIds, visibleAssetIds } from "./format-template";
import { closeDatabase, driver, type Runner } from "./db";
import { hosted, LOCAL_USER, type Account } from "./auth";
import type {
  Asset,
  Brand,
  Format,
  Post,
  PostContent,
  StudioState,
} from "./schema";
export { dataDir } from "./db";

// Every query runs for one account. Route handlers enter its scope through
// withAccount; inside a transaction, queries also share its connection.
type Scope = { account: Account; tx?: Runner };
const scope = new AsyncLocalStorage<Scope>();
function current(): Scope {
  const active = scope.getStore();
  if (active) return active;
  // Only the single-user local studio may act without a signed-in account.
  if (hosted()) throw new Error("No signed-in account for this operation.");
  return { account: { id: LOCAL_USER, email: null } };
}
export const userId = () => current().account.id;
export const account = () => current().account;
// Every stored file lives under its account's folder.
export const fileKey = (
  area: "assets" | "renders" | "uploads" | "exports",
  name: string,
) => `${userId()}/${area}/${name}`;

const seeded = new Set<string>();
export async function withAccount<T>(
  who: Account,
  fn: () => Promise<T>,
): Promise<T> {
  return scope.run({ account: who }, async () => {
    await ensureWorkspace();
    return fn();
  });
}
async function runner() {
  return current().tx ?? (await driver());
}
async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) {
  // Outside a request (scripts, tests) the local studio seeds on first use.
  if (!scope.getStore()) await ensureWorkspace();
  return (await runner()).query<T>(text, params);
}

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export async function list<T>(kind: string): Promise<T[]> {
  return (
    await query<{ json: string }>(
      "SELECT json FROM entities WHERE user_id=$1 AND kind=$2 ORDER BY seq DESC",
      [userId(), kind],
    )
  ).map((r) => JSON.parse(r.json));
}
const missing: Record<string, string> = {
  brand: "That brand brief no longer exists. Reload the studio.",
  format: "That format no longer exists. Reload the studio.",
  post: "That slideshow no longer exists. Reload the studio.",
  asset: "That image is not in your library. Choose another image.",
};
export async function get<T>(kind: string, id: string): Promise<T> {
  const [row] = await query<{ json: string }>(
    "SELECT json FROM entities WHERE user_id=$1 AND kind=$2 AND id=$3",
    [userId(), kind, id],
  );
  if (!row) throw new StudioError(missing[kind] ?? "Not found.", 404);
  return JSON.parse(row.json);
}
export async function put<T extends { id: string }>(kind: string, item: T) {
  await query(
    "INSERT INTO entities(user_id,kind,id,json) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,kind,id) DO UPDATE SET json=excluded.json",
    [userId(), kind, item.id, JSON.stringify(item)],
  );
}
const changed: Record<string, string> = {
  brand: "This brand brief changed in another window. Reload before saving.",
  format: "This format changed in another window. Reload before saving.",
};
// Brands and formats are saved whole. An update names the version it was
// edited from; anything else would silently erase another window's changes.
// Call inside a transaction so the check and the write are atomic.
export async function nextVersion(
  kind: "brand" | "format",
  id: string | undefined,
  expected: number | undefined,
) {
  if (!id) return 1;
  const current = (await get<{ version?: number }>(kind, id)).version ?? 0;
  if (expected !== current) throw new StudioError(changed[kind], 409);
  return current + 1;
}
export async function remove(kind: string, id: string) {
  await query("DELETE FROM entities WHERE user_id=$1 AND kind=$2 AND id=$3", [
    userId(),
    kind,
    id,
  ]);
}
export async function audit(action: string, id: string) {
  await query("INSERT INTO audit VALUES($1,$2,$3,$4,$5)", [
    uid(),
    userId(),
    action,
    id,
    now(),
  ]);
}
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
// Nested calls join the outermost transaction; its rollback undoes everything.
// Each account's writes are serialized, as a single SQLite writer once did.
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const active = current();
  if (active.tx) return fn();
  return (await driver()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      active.account.id,
    ]);
    return scope.run({ ...active, tx }, fn);
  });
}
export function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function contentOf(post: Post): PostContent {
  const {
    id,
    revision,
    status,
    createdAt,
    updatedAt,
    publishedUrl,
    publishedAt,
    metrics,
    metricsHistory,
    ...content
  } = post;
  void [
    id,
    revision,
    status,
    createdAt,
    updatedAt,
    publishedUrl,
    publishedAt,
    metrics,
    metricsHistory,
  ];
  return content;
}
export async function savePost(
  content: PostContent,
  id?: string,
  expected?: number,
): Promise<Post> {
  return transaction(async () => {
    // References are checked under the lock that image removal also takes,
    // so a revision can never point at an image deleted a moment earlier.
    await get<Brand>("brand", content.brandId);
    await get<Format>("format", content.formatId);
    for (const slide of content.slides)
      for (const asset of slideAssetIds(slide))
        await get<Asset>("asset", asset);
    const old = id ? await get<Post>("post", id) : undefined;
    if (old && old.revision !== expected)
      throw new StudioError(
        "This post changed in another window. Reload before saving.",
        409,
      );
    if (old?.status === "published")
      throw new StudioError(
        "Published posts are immutable. Duplicate this post to edit it.",
        409,
      );
    const post: Post = {
      ...content,
      id: old?.id || uid(),
      revision: (old?.revision || 0) + 1,
      status: "needs_review",
      createdAt: old?.createdAt || now(),
      updatedAt: now(),
    };
    await put("post", post);
    await query("INSERT INTO revisions VALUES($1,$2,$3,$4,$5)", [
      userId(),
      post.id,
      post.revision,
      JSON.stringify(content),
      digest(JSON.stringify(content)),
    ]);
    await query("DELETE FROM approvals WHERE user_id=$1 AND post_id=$2", [
      userId(),
      post.id,
    ]);
    await audit(old ? "post.revised" : "post.created", post.id);
    return post;
  });
}
export async function revisionContent(
  id: string,
  revision: number,
): Promise<PostContent> {
  const [row] = await query<{ json: string }>(
    "SELECT json FROM revisions WHERE user_id=$1 AND post_id=$2 AND revision=$3",
    [userId(), id, revision],
  );
  if (!row) throw new StudioError("Revision not found", 404);
  return JSON.parse(row.json);
}
export async function approvePost(
  id: string,
  revision: number,
  hashes: string[],
) {
  return transaction(async () => {
    const post = await get<Post>("post", id);
    if (
      post.revision !== revision ||
      post.status === "archived" ||
      post.status === "published"
    )
      throw new StudioError(
        "The post changed. Review its current version.",
        409,
      );
    if (hashes.length !== post.slides.length)
      throw new StudioError("Render every slide before approval.");
    for (const [index, slide] of post.slides.entries()) {
      const images = visibleAssetIds(slide);
      // Photo slides may be image-only; editorial slides are built around a heading.
      const empty =
        slide.design === "photo"
          ? !images.length &&
            !(slide.textLayers ?? []).some((layer) => layer.text.trim())
          : !slide.title.trim();
      if (empty)
        throw new StudioError(
          slide.design === "photo"
            ? `Slide ${index + 1} is empty. Add text or a background image before approval.`
            : `Slide ${index + 1} needs a heading before approval.`,
        );
      for (const image of images)
        if (!(await get<Asset>("asset", image)).rights.trim())
          throw new StudioError(
            `Slide ${index + 1}: record usage rights for its images in Assets before approval.`,
          );
    }
    await query(
      "INSERT INTO approvals VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,post_id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,render_hashes=excluded.render_hashes,created_at=excluded.created_at",
      [
        userId(),
        id,
        revision,
        digest(JSON.stringify(contentOf(post))),
        JSON.stringify(hashes),
        now(),
      ],
    );
    post.status = "approved";
    await put("post", post);
    await audit("export.approved", id);
    return post;
  });
}
export async function assertApproval(post: Post) {
  const [a] = await query<{
    revision: number;
    hash: string;
    render_hashes: string;
  }>(
    "SELECT revision,hash,render_hashes FROM approvals WHERE user_id=$1 AND post_id=$2",
    [userId(), post.id],
  );
  if (
    !a ||
    !["approved", "published"].includes(post.status) ||
    a.revision !== post.revision ||
    a.hash !== digest(JSON.stringify(contentOf(post)))
  )
    throw new StudioError(
      "Approve this exact revision before downloading.",
      403,
    );
  return JSON.parse(a.render_hashes) as string[];
}
export async function archivePost(id: string) {
  return transaction(async () => {
    const post = await get<Post>("post", id);
    // Published posts carry the URL and results; archiving would hide them for good.
    if (post.status === "published")
      throw new StudioError(
        "Published posts stay in Analytics and can't be deleted. Duplicate it to start a new version.",
        409,
      );
    if (post.status === "archived") return post;
    post.status = "archived";
    await put("post", post);
    await query("DELETE FROM approvals WHERE user_id=$1 AND post_id=$2", [
      userId(),
      id,
    ]);
    await audit("post.archived", id);
    return post;
  });
}
export async function restorePost(id: string) {
  return transaction(async () => {
    const post = await get<Post>("post", id);
    if (post.status !== "archived")
      throw new StudioError("Only deleted slideshows can be restored.", 409);
    post.status = "needs_review";
    await put("post", post);
    await audit("post.restored", id);
    return post;
  });
}
// Revisions are immutable, so an image used by any revision must keep its file.
export async function assetInUse(id: string) {
  return (
    (
      await query(
        "SELECT 1 FROM revisions WHERE user_id=$1 AND strpos(json,$2) > 0 LIMIT 1",
        [userId(), JSON.stringify(id)],
      )
    ).length > 0
  );
}
export async function dailyUsage() {
  const [row] = await query<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM ai_attempts WHERE user_id=$1 AND at>=$2",
    [userId(), now().slice(0, 10)],
  );
  return Number(row?.n ?? 0);
}
// AI calls are counted per account, per UTC day.
export function dailyLimit() {
  const n = Number(process.env.AI_DAILY_CALL_LIMIT || 20);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
export async function recordAiAttempt(id: string) {
  await query("INSERT INTO ai_attempts VALUES($1,$2,$3,$4,NULL)", [
    id,
    userId(),
    now(),
    "reserved",
  ]);
}
export async function updateAiAttempt(
  id: string,
  status: string,
  usage: string,
) {
  await query(
    "UPDATE ai_attempts SET status=$1,usage=$2 WHERE id=$3 AND user_id=$4",
    [status, usage, id, userId()],
  );
}
export async function state(): Promise<StudioState> {
  const [brands, formats, posts, assets, usedToday] = await Promise.all([
    list<Brand>("brand"),
    list<Format>("format"),
    list<Post>("post"),
    list<Asset>("asset"),
    dailyUsage(),
  ]);
  return {
    brands,
    formats,
    posts,
    assets,
    settings: {
      aiReady: !!process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      dailyLimit: dailyLimit(),
      usedToday,
      hosted: hosted(),
      email: account().email,
    },
  };
}
export async function migrateFormatSlideCounts() {
  const existingFormats = await list<Format>("format");
  for (const format of existingFormats.filter((f) => f.slideCount > 10)) {
    await put("format", {
      ...format,
      slideCount: 10,
      version: (format.version ?? 0) + 1,
    });
    await audit("format.slide_count_capped", format.id);
  }
  return existingFormats;
}
// A new account gets the starter brand and format on its first request.
// One writer seeds; concurrent first requests wait on the lock, then see it.
export async function ensureWorkspace() {
  const id = userId();
  if (seeded.has(id)) return;
  await transaction(async () => {
    await seed();
    await addPhotoPreset();
  });
  seeded.add(id);
}
export async function closeStore() {
  seeded.clear();
  await closeDatabase();
}
async function seed() {
  const brand: Brand = {
    // Keep this stable ID so existing template posts retain their brand link.
    id: "demo-brand",
    name: "My brand",
    product: "",
    audience: "",
    tone: "",
    facts: "",
    prohibited: "",
    destination: "",
  };

  const existingFormats = await migrateFormatSlideCounts();
  if (existingFormats.length) return;
  // TikTok photo story is the only starter format; addPhotoPreset adds it.
  await put("brand", brand);
}
// Add the new preset once without changing existing formats or approved posts.
async function addPhotoPreset() {
  if ((await list<Format>("format")).some((f) => f.id === "tiktok-photo"))
    return;
  await put("format", {
    id: "tiktok-photo",
    name: "TikTok photo story",
    description:
      "Full-height photos with centered, white TikTok text and a black outline.",
    instructions:
      "Write a concise hook and one short thought per slide. Use 8–20 words per slide, with at most two short paragraphs. Keep body copy empty when the heading tells the whole story. Use only verified brand facts, never invented personal results.",
    color: "#000000",
    ink: "#ffffff",
    accent: "#ffffff",
    aspect: "story",
    font: "tiktok",
    design: "photo",
    slideCount: 6,
  } satisfies Format);
  await audit("format.tiktok_photo_added", "tiktok-photo");
}
