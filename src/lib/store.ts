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
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, "studio.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS revisions(post_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(post_id,revision));
CREATE TABLE IF NOT EXISTS approvals(post_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,hash TEXT NOT NULL,render_hashes TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,entity TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_attempts(id TEXT PRIMARY KEY,at TEXT NOT NULL,status TEXT NOT NULL,usage TEXT);
`);
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function list<T>(kind: string): T[] {
  return (
    db
      .prepare("SELECT json FROM entities WHERE kind=? ORDER BY rowid DESC")
      .all(kind) as { json: string }[]
  ).map((r) => JSON.parse(r.json));
}
export function get<T>(kind: string, id: string): T {
  const row = db
    .prepare("SELECT json FROM entities WHERE kind=? AND id=?")
    .get(kind, id) as { json: string } | undefined;
  if (!row) throw new StudioError("Not found", 404);
  return JSON.parse(row.json);
}
export function put<T extends { id: string }>(kind: string, item: T) {
  db.prepare(
    "INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",
  ).run(kind, item.id, JSON.stringify(item));
}
export function audit(action: string, id: string) {
  db.prepare("INSERT INTO audit VALUES(?,?,?,?)").run(uid(), action, id, now());
}
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
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
  const row = db
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
    for (const slide of post.slides) {
      if (!slide.title.trim())
        throw new StudioError("Every slide needs a heading before approval.");
      if (
        slideAssetIds(slide).some(
          (id) => !get<Asset>("asset", id).rights.trim(),
        )
      )
        throw new StudioError(
          "Record usage rights for every background before approval.",
        );
    }
    db.prepare("INSERT OR REPLACE INTO approvals VALUES(?,?,?,?,?)").run(
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
  const a = db
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
export function dailyUsage() {
  return Number(
    (
      db
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
    name: "Pobi",
    product:
      "Pobi is an AI-powered sports-betting tool that helps users evaluate sportsbook promotions. It reads profit boosts, ranks opportunities by expected value, searches supported sportsbooks for favorable markets and lower vig, builds suggested parlays, and tracks what bets actually paid.",
    audience:
      "Adults 21+ in North America who already use supported sportsbooks and want a faster, more analytical way to assess promotions, compare markets, and track betting results.",
    tone: "Confident, analytical, concise, and transparent. Explain the reasoning behind an edge in plain language. Sound like a sharp, disciplined friend: direct and energetic, never reckless, boastful, or pushy.",
    facts:
      "Verified from pobi.bet on September 11, 2026: Pobi supports major North American sportsbooks; users can add sportsbook boosts, compare props and vig, build suggested parlays, and track payouts/results. The site offers a 7-day free trial, followed by $9.99 monthly or $89.99 yearly, with unlimited use across supported books and cancellation at any time. Pobi states that it is not affiliated with any sportsbook. Recheck pricing, availability, supported books, and performance figures before publishing time-sensitive content.",
    prohibited:
      "Never promise wins, profit, guaranteed returns, risk-free betting, or a specific hit rate. Never present founder-account results, demonstrations, or historical performance as typical customer outcomes. Do not invent edges, odds, sportsbook support, testimonials, statistics, or product capabilities. Do not target or depict anyone under 21. Do not encourage chasing losses, oversized wagers, urgency, debt, or betting as income. Keep responsible-gambling language visible where appropriate and never imply that AI removes betting risk.",
    destination: "https://www.pobi.bet",
  };

  // Upgrade an untouched installation from the original placeholder brief.
  const existingBrand = list<Brand>("brand").find(
    (item) => item.id === brand.id,
  );
  if (existingBrand?.name === "The Sunday Studio") {
    put("brand", brand);
    audit("brand.template_migrated_to_pobi", brand.id);
  }

  const existingFormats = migrateFormatSlideCounts();
  if (existingFormats.length) return;
  const formats: Format[] = [
    {
      id: "field-notes",
      name: "Field notes",
      description: "Thoughtful lists, one useful idea at a time.",
      instructions:
        "A strong hook, four practical insights, and a gentle call to action. Be specific and avoid hype.",
      color: "#e9eddf",
      ink: "#243d2e",
      accent: "#8ca17a",
      aspect: "portrait",
      font: "serif",
      slideCount: 6,
    },
    {
      id: "hard-truths",
      name: "The reality check",
      description: "Common mistakes. Better ways forward.",
      instructions:
        "Open with a common mistake, explain four concrete fixes, close with an actionable next step.",
      color: "#232e2a",
      ink: "#f6f1e7",
      accent: "#d6ef80",
      aspect: "portrait",
      font: "sans",
      slideCount: 6,
    },
    {
      id: "daily-practice",
      name: "In practice",
      description: "A simple, repeatable product story.",
      instructions:
        "Start with a real problem, show four useful applications supported by brand facts, end with a helpful CTA.",
      color: "#f5e4d6",
      ink: "#57392d",
      accent: "#c8754c",
      aspect: "story",
      font: "serif",
      slideCount: 6,
    },
  ];
  formats.forEach((f) => put("format", f));
  put("brand", brand);
  const f = formats[0];
  const titles = [
    "Make room for your next good idea.",
    "Start before you feel ready.",
    "Keep one small promise.",
    "Collect what catches your eye.",
    "Leave a little unfinished.",
    "Your practice. Your pace.",
  ];
  const bodies = [
    "A small field guide to a more intentional creative practice.",
    "Set aside ten minutes. Open a page. Give yourself permission to make something imperfect.",
    "Choose a routine that fits the day you actually have, rather than the one you wish you had.",
    "A sentence, a texture, an unexpected color. Give your ideas somewhere to land.",
    "Write down your next step before you stop. Make it easy to come back tomorrow.",
    "Save this for the next time you need a fresh start.",
  ];
  savePost({
    title: "Make room for your next good idea",
    topic: "A sustainable creative practice",
    brandId: brand.id,
    formatId: f.id,
    aspect: f.aspect,
    caption:
      "A few small ways to make space for your creative practice. What helps you come back to your work?\n\n#creativepractice #fieldnotes",
    account: "",
    plannedAt: "",
    notes: "Example content — review and adapt to your own brand.",
    flags: [],
    slides: titles.map((title, i) => ({
      id: uid(),
      role: i === 0 ? "hook" : i === 5 ? "cta" : "body",
      title,
      body: bodies[i],
      assetId: null,
      background: i === 5 ? "#243d2e" : f.color,
      ink: i === 5 ? "#f6f1e7" : f.ink,
      accent: f.accent,
      font: f.font,
      align: "left",
      position: "center",
      fontSize: 82,
      overlay: 0.35,
    })),
  });
}
seed();
// Add the new preset once without changing existing formats or approved posts.
if (!list<Format>("format").some((format) => format.id === "tiktok-photo")) {
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
