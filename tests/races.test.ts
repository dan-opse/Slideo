// VM-01 and VM-02: overlapping requests for one account. Each test pauses one
// request at a chosen database step, runs the other until it finishes or
// waits for the account lock, then resumes the first. No sleeps.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, Post } from "../src/lib/schema";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-races-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
const { driver } = await import("../src/lib/db");
const { POST } = await import("../src/app/api/studio/route");
const { NextRequest } = await import("next/server");
after(async () => {
  await store.closeStore();
  rmSync(folder, { recursive: true, force: true });
});

// Which request (by name) issued a database call.
const caller = new AsyncLocalStorage<string>();
type Step = (
  who: string | undefined,
  sql: string,
  params: unknown[],
) => boolean;
// `reached` resolves when the paused request arrives; `release` resumes it.
type Pause = {
  reached: Promise<void>;
  release: () => void;
  hold: () => Promise<void>;
};
let queryPause: { step: Step; pause: Pause } | undefined;
let enterPause: { who: string; pause: Pause } | undefined;
const entered = new Map<string, () => void>();
function pause(): Pause {
  let arrive!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    hold: async () => {
      arrive();
      await released;
    },
  };
}
// Wraps the driver so a test can stop one request before a query or before
// it starts a transaction, and learn when another request tries to start one.
const db = await driver();
const { query, transaction } = db;
db.query = (async (sql: string, params: unknown[] = []) => {
  await beforeQuery(caller.getStore(), sql, params);
  return query(sql, params);
}) as typeof db.query;
db.transaction = (async (fn) => {
  const who = caller.getStore();
  if (who) entered.get(who)?.();
  if (who && enterPause?.who === who) {
    const { pause: p } = enterPause;
    enterPause = undefined;
    await p.hold();
  }
  return transaction((tx) =>
    fn({
      ...tx,
      query: (async (sql: string, params: unknown[] = []) => {
        await beforeQuery(who, sql, params);
        return tx.query(sql, params);
      }) as typeof tx.query,
    }),
  );
}) as typeof db.transaction;
async function beforeQuery(
  who: string | undefined,
  sql: string,
  params: unknown[],
) {
  if (queryPause && queryPause.step(who, sql, params)) {
    const { pause: p } = queryPause;
    queryPause = undefined;
    await p.hold();
  }
}
const pauseAtQuery = (step: Step) => {
  const p = pause();
  queryPause = { step, pause: p };
  return p;
};
const pauseAtTransaction = (who: string) => {
  const p = pause();
  enterPause = { who, pause: p };
  return p;
};
// Resolves when the named request starts a transaction (and so waits for
// the account lock if another request holds it).
const startsTransaction = (who: string) =>
  new Promise<void>((resolve) =>
    entered.set(who, () => {
      entered.delete(who);
      resolve();
    }),
  );
const writesPost =
  (name: string): Step =>
  (who, sql, params) =>
    who === name &&
    sql.startsWith("INSERT INTO entities") &&
    params[1] === "post";

const headers = { host: "localhost:3000", origin: "http://localhost:3000" };
const call = (who: string, body: Record<string, unknown>) =>
  caller.run(who, async () => {
    const response = await POST(
      new NextRequest("http://localhost:3000/api/studio", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  });
const upload = async (collection: string) => {
  const form = new FormData();
  const file = await sharp({
    create: { width: 300, height: 400, channels: 3, background: "#2266aa" },
  })
    .jpeg()
    .toBuffer();
  form.set("file", new Blob([new Uint8Array(file)]), `${collection}.jpg`);
  form.set("collection", collection);
  form.set("rights", "Mine");
  const response = await POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers,
      body: form,
    }),
  );
  return (await response.json()).asset as Asset;
};
const create = async (collection?: string) =>
  (
    await call("setup", {
      action: "create",
      brandId: "demo-brand",
      formatId: "tiktok-photo",
      topic: "Races",
      mode: "manual",
      slideCount: 2,
      ...(collection ? { collection } : {}),
    })
  ).body as Post;
const published = async (url: string) => {
  await upload("Published");
  const post = await create("Published");
  const approved = await call("setup", {
    action: "approve",
    id: post.id,
    revision: post.revision,
  });
  assert.equal(approved.status, 200);
  const done = await call("setup", {
    action: "publish",
    id: post.id,
    revision: post.revision,
    url,
  });
  assert.equal(done.status, 200);
  return done.body as Post;
};
const metrics = (views: number) => ({
  views,
  likes: 1,
  comments: 0,
  shares: 0,
});
const auditCount = async (action: string, entity: string) =>
  (
    await query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM audit WHERE action=$1 AND entity=$2",
      [action, entity],
    )
  )[0].n;

test("VM-01: overlapping metrics writes keep both snapshots", async () => {
  const post = await published("https://www.tiktok.com/@me/photo/1");
  const first = pauseAtQuery(writesPost("m1"));
  const m1 = call("m1", { action: "metrics", id: post.id, data: metrics(100) });
  await first.reached;
  const m2 = call("m2", { action: "metrics", id: post.id, data: metrics(200) });
  await Promise.race([m2, startsTransaction("m2")]);
  first.release();
  assert.deepEqual(
    (await Promise.all([m1, m2])).map((r) => r.status),
    [200, 200],
  );
  const stored = await store.get<Post>("post", post.id);
  const views = [...(stored.metricsHistory ?? []), stored.metrics!].map(
    (m) => m.views,
  );
  assert.deepEqual(views.sort(), [100, 200]);
  assert.equal(await auditCount("results.recorded", post.id), 2);
});

test("VM-01: metrics overlapping a link correction keep the corrected link", async () => {
  const post = await published("https://www.tiktok.com/@me/photo/1");
  const first = pauseAtQuery(writesPost("m"));
  const m = call("m", { action: "metrics", id: post.id, data: metrics(300) });
  await first.reached;
  const fix = call("fix", {
    action: "publish",
    id: post.id,
    revision: post.revision,
    url: "https://www.tiktok.com/@me/photo/2",
    replace: true,
  });
  await Promise.race([fix, startsTransaction("fix")]);
  first.release();
  assert.deepEqual(
    (await Promise.all([m, fix])).map((r) => r.status),
    [200, 200],
  );
  const stored = await store.get<Post>("post", post.id);
  assert.equal(stored.publishedUrl, "https://www.tiktok.com/@me/photo/2");
  assert.equal(stored.publishedAt, post.publishedAt);
  assert.equal(stored.revision, post.revision);
  assert.equal(stored.status, "published");
  assert.equal(stored.metrics?.views, 300);
  await store.assertApproval(stored);
});

test("VM-01: a rejected metrics update writes nothing", async () => {
  const draft = await create();
  const rejected = await call("m", {
    action: "metrics",
    id: draft.id,
    data: metrics(5),
  });
  assert.equal(rejected.status, 400);
  assert.equal(await auditCount("results.recorded", draft.id), 0);
  assert.equal((await store.get<Post>("post", draft.id)).metrics, undefined);
});

const withImage = (post: Post, asset: Asset) => ({
  ...store.contentOf(post),
  slides: post.slides.map((slide, i) =>
    i === 0 ? { ...slide, assetId: asset.id } : slide,
  ),
});
const revisions = async (id: string) =>
  (
    await query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM revisions WHERE post_id=$1",
      [id],
    )
  )[0].n;

test("VM-02: removal that wins the lock makes the overlapping save fail cleanly", async () => {
  const asset = await upload("Spare one");
  const draft = await create();
  const saving = pauseAtTransaction("save");
  const save = call("save", {
    action: "save",
    id: draft.id,
    expected: draft.revision,
    data: withImage(draft, asset),
  });
  await saving.reached;
  const removed = await call("remove", { action: "removeAsset", id: asset.id });
  assert.equal(removed.body.kept, false);
  saving.release();
  const saved = await save;
  assert.equal(saved.status, 404);
  assert.match(saved.body.error, /not in your library/);
  const stored = await store.get<Post>("post", draft.id);
  assert.equal(stored.revision, draft.revision);
  assert.equal(stored.slides[0].assetId, draft.slides[0].assetId);
  assert.equal(await revisions(draft.id), 1);
  assert.equal(await auditCount("post.revised", draft.id), 0);
});

test("VM-02: a save that wins the lock keeps its image through removal", async () => {
  const asset = await upload("Spare two");
  const draft = await create();
  const saving = pauseAtQuery(writesPost("save"));
  const save = call("save", {
    action: "save",
    id: draft.id,
    expected: draft.revision,
    data: withImage(draft, asset),
  });
  await saving.reached;
  const remove = call("remove", { action: "removeAsset", id: asset.id });
  await Promise.race([remove, startsTransaction("remove")]);
  saving.release();
  const [saved, removed] = await Promise.all([save, remove]);
  assert.equal(saved.status, 200);
  assert.equal(removed.body.kept, true);
  assert.ok(
    existsSync(
      path.join(folder, "files", "local", "assets", `${asset.id}.jpg`),
    ),
  );
  const post = saved.body as Post;
  const approved = await call("setup", {
    action: "approve",
    id: post.id,
    revision: post.revision,
  });
  assert.equal(approved.status, 200, approved.body.error);
});
