import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { slideAssetIds, visibleAssetIds } from "./format-template";
import {
  backend,
  closeDatabase,
  DatabaseError,
  SetupError,
  type DbFunction,
} from "./db";
import { hosted, LOCAL_USER, type Account } from "./auth";
import { tiktokAvailability } from "./tiktok";
import type {
  Asset,
  Brand,
  Delivery,
  Format,
  Post,
  PostContent,
  StudioState,
  TikTokAccount,
} from "./schema";
export { dataDir } from "./db";

// One change in an account's commit; see slideo_commit in supabase/migrations.
export type Change =
  | { op: "put"; kind: string; id: string; json: string }
  | { op: "delete"; kind: string; id: string }
  | {
      op: "revision";
      post: string;
      revision: number;
      json: string;
      hash: string;
    }
  | {
      op: "approve";
      post: string;
      revision: number;
      hash: string;
      render_hashes: string;
      at: string;
    }
  | { op: "unapprove"; post: string }
  | { op: "audit"; id: string; action: string; entity: string; at: string }
  | {
      op: "ai";
      id: string;
      at: string;
      status: string;
      usage?: string | null;
    }
  | { op: "ai_update"; id: string; status: string; usage: string };
type Approval = { revision: number; hash: string; render_hashes: string };
// A transaction's changes wait here until it commits. Its own reads see
// them, as they would inside a database transaction.
type Tx = {
  changes: Change[];
  entities: Map<string, string | null>;
  revisions: Map<string, string>;
  approvals: Map<string, Approval | null>;
  aiAttempts: number;
};

// Every read and write is for one account. Route handlers enter its scope
// through withAccount; a transaction adds its pending changes to the scope.
type Scope = { account: Account; tx?: Tx };
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
// Acts for an account without preparing its workspace (operator imports).
export function asAccount<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ account: { id, email: null } }, fn);
}

export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
// Changes the database refuses become the studio's own errors; a missing
// hosted setup is reported to the operator's log and as a 503.
const refused: Record<string, number> = {
  SL400: 400,
  SL403: 403,
  SL409: 409,
  SL413: 413,
};
function translate(error: unknown): unknown {
  if (error instanceof SetupError) {
    console.error(error.message);
    return new StudioError(
      "The studio is not fully set up yet. Its operator needs to finish the Supabase setup.",
      503,
    );
  }
  if (error instanceof DatabaseError && error.code && refused[error.code]) {
    const text = error.message.replace(/^slideo: /, "");
    return new StudioError(
      `${text.charAt(0).toUpperCase()}${text.slice(1)}.`,
      refused[error.code],
    );
  }
  return error;
}
async function rpc<T>(fn: DbFunction, args: Record<string, unknown>) {
  try {
    return await (await backend()).call<T>(fn, args);
  } catch (error) {
    throw translate(error);
  }
}
async function call<T>(fn: DbFunction, args: Record<string, unknown> = {}) {
  // Outside a request (scripts, tests) the local studio seeds on first use.
  if (!scope.getStore()) await ensureWorkspace();
  return rpc<T>(fn, { p_user: userId(), ...args });
}
// Inside a transaction a change waits for its commit; outside, it commits
// on its own.
async function write(change: Change) {
  const tx = current().tx;
  if (!tx) {
    if (!scope.getStore()) await ensureWorkspace();
    await rpc("slideo_commit", {
      p_user: userId(),
      p_expected: null,
      p_changes: [change],
    });
    return;
  }
  tx.changes.push(change);
  if (change.op === "put")
    tx.entities.set(`${change.kind}/${change.id}`, change.json);
  if (change.op === "delete")
    tx.entities.set(`${change.kind}/${change.id}`, null);
  if (change.op === "revision")
    tx.revisions.set(`${change.post}/${change.revision}`, change.json);
  if (change.op === "approve") tx.approvals.set(change.post, change);
  if (change.op === "unapprove") tx.approvals.set(change.post, null);
  if (change.op === "ai") tx.aiAttempts++;
}
// Operator imports add history rows with their original ids and times.
export const stage = write;

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export async function list<T>(kind: string): Promise<T[]> {
  const rows = await call<T[]>("slideo_list", { p_kind: kind });
  const tx = current().tx;
  const prefix = `${kind}/`;
  const pending = new Map(
    [...(tx?.entities ?? [])]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, json]) => [key.slice(prefix.length), json]),
  );
  if (!pending.size) return rows;
  const kept = rows.flatMap((row) => {
    const id = (row as { id: string }).id;
    if (!pending.has(id)) return [row];
    const json = pending.get(id);
    pending.delete(id);
    return json === null ? [] : [JSON.parse(json!) as T];
  });
  // Records this transaction adds are the newest.
  const added = [...pending.values()]
    .filter((json): json is string => json !== null)
    .map((json) => JSON.parse(json) as T)
    .reverse();
  return [...added, ...kept];
}
const missing: Record<string, string> = {
  brand: "That brand brief no longer exists. Reload the studio.",
  format: "That format no longer exists. Reload the studio.",
  post: "That slideshow no longer exists. Reload the studio.",
  asset: "That image is not in your library. Choose another image.",
  tiktok_account:
    "That TikTok account isn't in this studio. Reload the studio.",
  delivery: "That TikTok delivery no longer exists. Reload the studio.",
};
// A record, or null when there is none.
export async function find<T>(kind: string, id: string): Promise<T | null> {
  const tx = current().tx,
    key = `${kind}/${id}`;
  if (tx?.entities.has(key)) {
    const json = tx.entities.get(key);
    return json ? (JSON.parse(json) as T) : null;
  }
  return (
    (await call<T | null>("slideo_get", { p_kind: kind, p_id: id })) ?? null
  );
}
export async function get<T>(kind: string, id: string): Promise<T> {
  const found = await find<T>(kind, id);
  if (!found) throw new StudioError(missing[kind] ?? "Not found.", 404);
  return found;
}
export async function put<T extends { id: string }>(kind: string, item: T) {
  await write({ op: "put", kind, id: item.id, json: JSON.stringify(item) });
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
  await write({ op: "delete", kind, id });
}
export async function audit(action: string, id: string) {
  await write({ op: "audit", id: uid(), action, entity: id, at: now() });
}

const ATTEMPTS = 8;
// Runs fn as one atomic change to the account. Its reads go to the
// database; its writes are held until fn finishes, then committed together
// with the account version read before fn started. Another change committed
// in the meantime makes the commit fail without writing anything, and fn
// runs again on the newer data, so an account's changes apply one at a time
// as if each held a lock. An error thrown by fn writes nothing. fn may run
// more than once: keep slow work and side effects (provider calls, image
// processing, file deletion) outside it, and check their results inside.
// Nested calls join the outermost transaction.
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const active = current();
  if (active.tx) return fn();
  const user = active.account.id;
  for (let attempt = 1; ; attempt++) {
    const version = Number(await rpc("slideo_version", { p_user: user }));
    const tx: Tx = {
      changes: [],
      entities: new Map(),
      revisions: new Map(),
      approvals: new Map(),
      aiAttempts: 0,
    };
    const result = await scope.run({ ...active, tx }, fn);
    if (!tx.changes.length) return result;
    const done = await rpc<{ ok: boolean }>("slideo_commit", {
      p_user: user,
      p_expected: version,
      p_changes: tx.changes,
    });
    if (done.ok) return result;
    if (attempt === ATTEMPTS)
      throw new StudioError(
        "Your studio was busy saving other changes. Try again.",
        409,
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * 15 * attempt),
    );
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
export async function savePost(
  content: PostContent,
  id?: string,
  expected?: number,
): Promise<Post> {
  return transaction(async () => {
    // References are checked in the same transaction that image removal
    // commits through, so a revision can never point at an image deleted a
    // moment earlier.
    await get<Brand>("brand", content.brandId);
    await get<Format>("format", content.formatId);
    await Promise.all(
      content.slides.flatMap((slide) =>
        slideAssetIds(slide).map((asset) => get<Asset>("asset", asset)),
      ),
    );
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
    const json = JSON.stringify(content);
    await write({
      op: "revision",
      post: post.id,
      revision: post.revision,
      json,
      hash: digest(json),
    });
    await write({ op: "unapprove", post: post.id });
    await audit(old ? "post.revised" : "post.created", post.id);
    return post;
  });
}
export async function revisionContent(
  id: string,
  revision: number,
): Promise<PostContent> {
  const pending = current().tx?.revisions.get(`${id}/${revision}`);
  const content = pending
    ? (JSON.parse(pending) as PostContent)
    : await call<PostContent | null>("slideo_revision", {
        p_post: id,
        p_revision: revision,
      });
  if (!content) throw new StudioError("Revision not found", 404);
  return content;
}
async function approval(id: string) {
  const tx = current().tx;
  if (tx?.approvals.has(id)) return tx.approvals.get(id) ?? null;
  return call<Approval | null>("slideo_approval", { p_post: id });
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
    await write({
      op: "approve",
      post: id,
      revision,
      hash: digest(JSON.stringify(contentOf(post))),
      render_hashes: JSON.stringify(hashes),
      at: now(),
    });
    post.status = "approved";
    await put("post", post);
    await audit("export.approved", id);
    return post;
  });
}
export async function assertApproval(post: Post) {
  const a = await approval(post.id);
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
    await write({ op: "unapprove", post: id });
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
  const quoted = JSON.stringify(id);
  for (const json of current().tx?.revisions.values() ?? [])
    if (json.includes(quoted)) return true;
  return call<boolean>("slideo_asset_in_use", { p_asset: id });
}
// Deliveries due by `at` in every account, oldest first: the TikTok worker's
// only query that isn't scoped to one account.
export async function dueDeliveries(at: Date, limit: number) {
  return rpc<{ user_id: string; id: string }[]>("slideo_due_deliveries", {
    p_now: at.toISOString(),
    p_limit: limit,
  });
}
export async function dailyUsage() {
  const used = await call<number>("slideo_ai_usage", {
    p_since: now().slice(0, 10),
  });
  return Number(used) + (current().tx?.aiAttempts ?? 0);
}
// AI calls are counted per account, per UTC day.
export function dailyLimit() {
  const n = Number(process.env.AI_DAILY_CALL_LIMIT || 20);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
export async function recordAiAttempt(id: string) {
  await write({ op: "ai", id, at: now(), status: "reserved" });
}
export async function updateAiAttempt(
  id: string,
  status: string,
  usage: string,
) {
  await write({ op: "ai_update", id, status, usage });
}
export async function state(): Promise<StudioState> {
  const {
    brands,
    formats,
    posts,
    assets,
    deliveries,
    tiktokAccounts,
    usedToday,
  } = await call<{
    brands: Brand[];
    formats: Format[];
    posts: Post[];
    assets: Asset[];
    deliveries: Delivery[];
    tiktokAccounts: TikTokAccount[];
    usedToday: number;
  }>("slideo_state", { p_since: now().slice(0, 10) });
  return {
    brands,
    formats,
    posts,
    assets,
    deliveries,
    settings: {
      aiReady: !!process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      dailyLimit: dailyLimit(),
      usedToday: Number(usedToday),
      hosted: hosted(),
      email: account().email,
      tiktok: { ...tiktokAvailability(), accounts: tiktokAccounts },
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
// Concurrent first requests both try; one commits, the other retries, finds
// the workspace seeded, and changes nothing.
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
