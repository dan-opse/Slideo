// VM-01 and VM-02: overlapping requests for one account. Each test pauses
// one request just before it commits (or as its transaction starts), runs
// the other to completion, then resumes the first. The resumed commit finds
// the account changed, writes nothing, and runs again on the newer data. No
// sleeps. With `npm run test:supabase` every database call here is a real
// HTTP request to the local stack's Data API.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, Post } from "../src/lib/schema";
import { closeTestDatabase, sql, prepareTestDatabase } from "./database";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-races-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
const { backend, setBackend } = await import("../src/lib/db");
const { POST } = await import("../src/app/api/studio/route");
const { visibleAssetIds } = await import("../src/lib/format-template");
const { NextRequest } = await import("next/server");
await prepareTestDatabase();
after(async () => {
  setBackend(undefined);
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

// Which request (by name) made a database call.
const caller = new AsyncLocalStorage<string>();
type Pause = {
  reached: Promise<void>;
  release: () => void;
  hold: () => Promise<void>;
};
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
// Wraps the backend so a test can stop one request before a database call,
// and count each request's commits.
const pauses = new Map<string, { fn: string; pause: Pause }>();
const commits = new Map<string, boolean[]>();
const real = await backend();
setBackend({
  ...real,
  async call<T>(
    fn: Parameters<typeof real.call>[0],
    args: Record<string, unknown>,
  ) {
    const who = caller.getStore();
    const stop = who ? pauses.get(who) : undefined;
    if (stop && stop.fn === fn) {
      pauses.delete(who!);
      await stop.pause.hold();
    }
    const result = await real.call<T>(fn, args);
    if (who && fn === "slideo_commit")
      commits.set(who, [
        ...(commits.get(who) ?? []),
        (result as { ok: boolean }).ok,
      ]);
    return result;
  },
});
const pauseBefore = (who: string, fn: "slideo_commit" | "slideo_version") => {
  const p = pause();
  pauses.set(who, { fn, pause: p });
  commits.delete(who);
  return p;
};

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
    await sql<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM audit WHERE action=$1 AND entity=$2",
      [action, entity],
    )
  )[0].n;

test("VM-01: overlapping metrics writes keep both snapshots", async () => {
  const post = await published("https://www.tiktok.com/@me/photo/1");
  const first = pauseBefore("m1", "slideo_commit");
  const m1 = call("m1", { action: "metrics", id: post.id, data: metrics(100) });
  await first.reached;
  const m2 = await call("m2", {
    action: "metrics",
    id: post.id,
    data: metrics(200),
  });
  first.release();
  assert.deepEqual([(await m1).status, m2.status], [200, 200]);
  // m1's first commit was refused, then it ran again on m2's result.
  assert.deepEqual(commits.get("m1"), [false, true]);
  const stored = await store.get<Post>("post", post.id);
  const views = [...(stored.metricsHistory ?? []), stored.metrics!].map(
    (m) => m.views,
  );
  assert.deepEqual(views, [200, 100]);
  assert.equal(await auditCount("results.recorded", post.id), 2);
});

test("VM-01: metrics overlapping a link correction keep the corrected link", async () => {
  const post = await published("https://www.tiktok.com/@me/photo/1");
  const first = pauseBefore("m", "slideo_commit");
  const m = call("m", { action: "metrics", id: post.id, data: metrics(300) });
  await first.reached;
  const fix = await call("fix", {
    action: "publish",
    id: post.id,
    revision: post.revision,
    url: "https://www.tiktok.com/@me/photo/2",
    replace: true,
  });
  first.release();
  assert.deepEqual([(await m).status, fix.status], [200, 200]);
  assert.deepEqual(commits.get("m"), [false, true]);
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
    await sql<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM revisions WHERE post_id=$1",
      [id],
    )
  )[0].n;

for (const step of ["slideo_version", "slideo_commit"] as const)
  test(`VM-02: removal committed while a save waits at ${step} makes the save fail cleanly`, async () => {
    const asset = await upload(`Spare ${step}`);
    const draft = await create();
    const saving = pauseBefore("save", step);
    const save = call("save", {
      action: "save",
      id: draft.id,
      expected: draft.revision,
      data: withImage(draft, asset),
    });
    await saving.reached;
    const removed = await call("remove", {
      action: "removeAsset",
      id: asset.id,
    });
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

test("VM-02: a save committed while removal waits keeps its image", async () => {
  const asset = await upload("Spare two");
  const draft = await create();
  // The removal has decided the image is unused and is about to delete it.
  const removing = pauseBefore("remove", "slideo_commit");
  const remove = call("remove", { action: "removeAsset", id: asset.id });
  await removing.reached;
  const saved = await call("save", {
    action: "save",
    id: draft.id,
    expected: draft.revision,
    data: withImage(draft, asset),
  });
  removing.release();
  const removed = await remove;
  assert.equal(saved.status, 200);
  assert.equal(removed.body.kept, true);
  assert.deepEqual(commits.get("remove"), [false, true]);
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

test("two requests for the last AI attempt of the day let exactly one through", async () => {
  const { reserveAttempt } = await import("../src/lib/ai");
  process.env.AI_DAILY_CALL_LIMIT = String((await store.dailyUsage()) + 1);
  try {
    const first = pauseBefore("r1", "slideo_commit");
    const r1 = caller.run("r1", () => reserveAttempt()).catch((e) => e);
    await first.reached;
    const r2 = await caller.run("r2", () => reserveAttempt());
    first.release();
    const refused = await r1;
    assert.equal(typeof r2, "string");
    assert.equal(refused.status, 429);
    assert.deepEqual(commits.get("r1"), [false]);
    assert.equal(
      await store.dailyUsage(),
      Number(process.env.AI_DAILY_CALL_LIMIT),
    );
  } finally {
    delete process.env.AI_DAILY_CALL_LIMIT;
  }
});

// Rollback: a refused or failed change leaves no partial state.

test("a refused approval writes no approval, status change, or audit entry", async () => {
  await upload("No rights yet");
  const draft = await create("No rights yet");
  const [image] = draft.slides.flatMap(visibleAssetIds);
  assert.ok(image, "the draft uses the uploaded image");
  await store.put("asset", {
    ...(await store.get<Asset>("asset", image)),
    rights: " ",
  });
  const refused = await call("approve", {
    action: "approve",
    id: draft.id,
    revision: draft.revision,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /usage rights/);
  assert.equal(
    (await store.get<Post>("post", draft.id)).status,
    "needs_review",
  );
  assert.equal(
    (await sql("SELECT 1 FROM approvals WHERE post_id=$1", [draft.id])).length,
    0,
  );
  assert.equal(await auditCount("export.approved", draft.id), 0);
});

test("a commit the database refuses applies none of its changes", async () => {
  const draft = await create();
  const before = Number(
    (await sql<{ v: string }>("SELECT version AS v FROM accounts"))[0].v,
  );
  await assert.rejects(
    store.transaction(async () => {
      await store.put("post", { ...draft, title: "Half-saved" });
      await store.audit("post.revised", draft.id);
      // A revision whose hash doesn't match its content is refused.
      await store.stage({
        op: "revision",
        post: draft.id,
        revision: draft.revision + 1,
        json: "{}",
        hash: "not-the-hash",
      });
    }),
    (error: Error & { status?: number }) => error.status === 400,
  );
  assert.equal((await store.get<Post>("post", draft.id)).title, draft.title);
  assert.equal(await revisions(draft.id), 1);
  assert.equal(await auditCount("post.revised", draft.id), 0);
  assert.equal(
    Number(
      (await sql<{ v: string }>("SELECT version AS v FROM accounts"))[0].v,
    ),
    before,
  );
});

test("history and published content are protected in the database itself", async () => {
  const post = await published("https://www.tiktok.com/@me/photo/9");
  // Even the server's own commits cannot change a published slideshow...
  await assert.rejects(
    store.put("post", { ...post, title: "Rewritten after publishing" }),
    (error: Error & { status?: number }) =>
      error.status === 409 && /published/i.test(error.message),
  );
  await assert.rejects(
    store.remove("post", post.id),
    (error: Error & { status?: number }) => error.status === 409,
  );
  // ...or rewrite its revisions or the audit trail, by any route.
  await assert.rejects(
    sql("UPDATE revisions SET json='{}' WHERE post_id=$1", [post.id]),
    /cannot be changed/,
  );
  await assert.rejects(
    sql("DELETE FROM audit WHERE entity=$1", [post.id]),
    /cannot be changed/,
  );
  await assert.rejects(
    sql("UPDATE entities SET user_id='someone-else' WHERE id=$1", [post.id]),
    /cannot change account/,
  );
  const stored = await store.get<Post>("post", post.id);
  assert.equal(stored.title, post.title);
  await store.assertApproval(stored);
});
