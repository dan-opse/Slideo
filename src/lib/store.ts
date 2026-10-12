import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { slideAssetIds } from "./format-template";
import type {
  Asset,
  Brand,
  Format,
  Post,
  PostContent,
  StudioState,
} from "./schema";
export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.env.STUDIO_DATA_DIR || "./data",
);
let instance: DatabaseSync | undefined;
// Opened on first use rather than at import, so `next build` (which imports
// route modules to collect page data) never creates or seeds a workspace.
export function database() {
  if (instance) return instance;
  mkdirSync(dataDir, { recursive: true });
  instance = new DatabaseSync(path.join(dataDir, "studio.sqlite"));
  // busy_timeout must come first: switching to WAL needs a lock that a
  // concurrently starting process may hold.
  instance.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS revisions(post_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(post_id,revision));
CREATE TABLE IF NOT EXISTS approvals(post_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,hash TEXT NOT NULL,render_hashes TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,entity TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_attempts(id TEXT PRIMARY KEY,at TEXT NOT NULL,status TEXT NOT NULL,usage TEXT);
`);
  // One writer seeds; concurrent first boots wait on the lock, then see the data.
  transaction(() => {
    seed();
    addPhotoPreset();
  });
  return instance;
}
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function list<T>(kind: string): T[] {
  return (
    database()
      .prepare("SELECT json FROM entities WHERE kind=? ORDER BY rowid DESC")
      .all(kind) as { json: string }[]
  ).map((r) => JSON.parse(r.json));
}
const missing: Record<string, string> = {
  brand: "That brand brief no longer exists. Reload the studio.",
  format: "That format no longer exists. Reload the studio.",
  post: "That slideshow no longer exists. Reload the studio.",
  asset: "That image is not in your library. Choose another image.",
};
export function get<T>(kind: string, id: string): T {
  const row = database()
    .prepare("SELECT json FROM entities WHERE kind=? AND id=?")
    .get(kind, id) as { json: string } | undefined;
  if (!row) throw new StudioError(missing[kind] ?? "Not found.", 404);
  return JSON.parse(row.json);
}
export function put<T extends { id: string }>(kind: string, item: T) {
  database()
    .prepare(
      "INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",
    )
    .run(kind, item.id, JSON.stringify(item));
}
export function remove(kind: string, id: string) {
  database()
    .prepare("DELETE FROM entities WHERE kind=? AND id=?")
    .run(kind, id);
}
export function audit(action: string, id: string) {
  database()
    .prepare("INSERT INTO audit VALUES(?,?,?,?)")
    .run(uid(), action, id, now());
}
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
let depth = 0;
// Nested calls join the outermost transaction; its rollback undoes everything.
export function transaction<T>(fn: () => T): T {
  if (depth > 0) return fn();
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
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
export function savePost(
  content: PostContent,
  id?: string,
  expected?: number,
): Post {
  return transaction(() => {
    const old = id ? get<Post>("post", id) : undefined;
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
    put("post", post);
    const db = database();
    db.prepare("INSERT INTO revisions VALUES(?,?,?,?)").run(
      post.id,
      post.revision,
      JSON.stringify(content),
      digest(JSON.stringify(content)),
    );
    db.prepare("DELETE FROM approvals WHERE post_id=?").run(post.id);
    audit(old ? "post.revised" : "post.created", post.id);
    return post;
  });
}
export function revisionContent(id: string, revision: number): PostContent {
  const row = database()
    .prepare("SELECT json FROM revisions WHERE post_id=? AND revision=?")
    .get(id, revision) as { json: string } | undefined;
  if (!row) throw new StudioError("Revision not found", 404);
  return JSON.parse(row.json);
}
export function approvePost(id: string, revision: number, hashes: string[]) {
  return transaction(() => {
    const post = get<Post>("post", id);
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
    post.slides.forEach((slide, index) => {
      const images = slideAssetIds(slide);
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
      if (images.some((id) => !get<Asset>("asset", id).rights.trim()))
        throw new StudioError(
          `Slide ${index + 1}: record usage rights for its images in Assets before approval.`,
        );
    });
    database()
      .prepare("INSERT OR REPLACE INTO approvals VALUES(?,?,?,?,?)")
      .run(
        id,
        revision,
        digest(JSON.stringify(contentOf(post))),
        JSON.stringify(hashes),
        now(),
      );
    post.status = "approved";
    put("post", post);
    audit("export.approved", id);
    return post;
  });
}
export function assertApproval(post: Post) {
  const a = database()
    .prepare(
      "SELECT revision,hash,render_hashes FROM approvals WHERE post_id=?",
    )
    .get(post.id) as
    { revision: number; hash: string; render_hashes: string } | undefined;
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
export function archivePost(id: string) {
  return transaction(() => {
    const post = get<Post>("post", id);
    // Published posts carry the URL and results; archiving would hide them for good.
    if (post.status === "published")
      throw new StudioError(
        "Published posts stay in Analytics and can't be deleted. Duplicate it to start a new version.",
        409,
      );
    if (post.status === "archived") return post;
    post.status = "archived";
    put("post", post);
    database().prepare("DELETE FROM approvals WHERE post_id=?").run(id);
    audit("post.archived", id);
    return post;
  });
}
export function restorePost(id: string) {
  return transaction(() => {
    const post = get<Post>("post", id);
    if (post.status !== "archived")
      throw new StudioError("Only deleted slideshows can be restored.", 409);
    post.status = "needs_review";
    put("post", post);
    audit("post.restored", id);
    return post;
  });
}
// Revisions are immutable, so an image used by any revision must keep its file.
export function assetInUse(id: string) {
  return !!database()
    .prepare("SELECT 1 FROM revisions WHERE instr(json, ?) > 0 LIMIT 1")
    .get(JSON.stringify(id));
}
export function dailyUsage() {
  return Number(
    (
      database()
        .prepare("SELECT COUNT(*) AS n FROM ai_attempts WHERE at>=?")
        .get(now().slice(0, 10)) as { n: number }
    ).n,
  );
}
export function dailyLimit() {
  const n = Number(process.env.AI_DAILY_CALL_LIMIT || 20);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
export function state(): StudioState {
  return {
    brands: list<Brand>("brand"),
    formats: list<Format>("format"),
    posts: list<Post>("post"),
    assets: list<Asset>("asset"),
    settings: {
      aiReady: !!process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      dailyLimit: dailyLimit(),
      usedToday: dailyUsage(),
      localOnly: true,
    },
  };
}
export function migrateFormatSlideCounts() {
  const existingFormats = list<Format>("format");
  existingFormats
    .filter((format) => format.slideCount > 10)
    .forEach((format) => {
      put("format", { ...format, slideCount: 10 });
      audit("format.slide_count_capped", format.id);
    });
  return existingFormats;
}
function seed() {
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

  const existingFormats = migrateFormatSlideCounts();
  if (existingFormats.length) return;
  // TikTok photo story is the only starter format; addPhotoPreset adds it.
  put("brand", brand);
}
// Add the new preset once without changing existing formats or approved posts.
function addPhotoPreset() {
  if (list<Format>("format").some((format) => format.id === "tiktok-photo"))
    return;
  put("format", {
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
  audit("format.tiktok_photo_added", "tiktok-photo");
}
