// VM-03: importing an original SQLite workspace, then importing it again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, Brand, Post } from "../src/lib/schema";
import { seedSamplePost } from "./sample-post";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-import-test-"));
process.env.STUDIO_DATA_DIR = path.join(folder, "studio");
const store = await import("../src/lib/store");
const { driver } = await import("../src/lib/db");
const { files } = await import("../src/lib/files");
const { importSqlite } = await import("../src/lib/import-sqlite");
after(async () => {
  await store.closeStore();
  rmSync(folder, { recursive: true, force: true });
});

const as = <T>(id: string, fn: () => Promise<T>) =>
  store.withAccount({ id, email: null }, fn);
const hashes = (post: Post) => post.slides.map((_, i) => `render-${i}`);
const db = await driver();

// Writes the "legacy" account's records into a database shaped like the
// original SQLite studio, with its images in assets/.
async function legacyFolder(name: string) {
  const dir = path.join(folder, name);
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  const old = new DatabaseSync(path.join(dir, "studio.sqlite"));
  old.exec(`CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE revisions(post_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(post_id,revision));
CREATE TABLE approvals(post_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,hash TEXT NOT NULL,render_hashes TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,entity TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE ai_attempts(id TEXT PRIMARY KEY,at TEXT NOT NULL,status TEXT NOT NULL,usage TEXT);`);
  const copy = async (sql: string, insert: string) => {
    for (const row of await db.query<Record<string, string | number | null>>(
      sql,
      ["legacy"],
    ))
      old.prepare(insert).run(...Object.values(row));
  };
  await copy(
    "SELECT kind,id,json FROM entities WHERE user_id=$1 ORDER BY seq",
    "INSERT INTO entities VALUES(?,?,?)",
  );
  await copy(
    "SELECT post_id,revision,json,hash FROM revisions WHERE user_id=$1",
    "INSERT INTO revisions VALUES(?,?,?,?)",
  );
  await copy(
    "SELECT post_id,revision,hash,render_hashes,created_at FROM approvals WHERE user_id=$1",
    "INSERT INTO approvals VALUES(?,?,?,?,?)",
  );
  await copy(
    "SELECT id,action,entity,at FROM audit WHERE user_id=$1",
    "INSERT INTO audit VALUES(?,?,?,?)",
  );
  old.close();
  for (const asset of await as("legacy", () => store.list<Asset>("asset")))
    writeFileSync(
      path.join(dir, "assets", `${asset.id}.jpg`),
      (await files().read(`legacy/assets/${asset.id}.jpg`))!,
    );
  return dir;
}

// The legacy studio: an edited brief, an image, and an approved post.
const image = await sharp({
  create: { width: 40, height: 60, channels: 3, background: "#cc3300" },
})
  .jpeg()
  .toBuffer();
const legacy = await as("legacy", async () => {
  const brand = await store.get<Brand>("brand", "demo-brand");
  await store.put("brand", { ...brand, name: "Original SQLite brief" });
  const asset: Asset = {
    id: "legacy-photo",
    name: "Legacy",
    collection: "Old",
    rights: "Mine",
    width: 40,
    height: 60,
    hash: "h",
    createdAt: store.now(),
  };
  await files().write(`legacy/assets/${asset.id}.jpg`, image, "image/jpeg");
  await store.put("asset", asset);
  const post = await seedSamplePost(store);
  return store.approvePost(post.id, post.revision, hashes(post));
});
const first = await legacyFolder("first");

test("a first import brings over records, history, approvals and images", async () => {
  const report = await importSqlite(first, "dest");
  assert.deepEqual(report.kept, []);
  assert.equal(report.added.post, 1);
  assert.equal(report.images, 1);
  await as("dest", async () => {
    assert.equal(
      (await store.get<Brand>("brand", "demo-brand")).name,
      "Original SQLite brief",
    );
    const post = await store.get<Post>("post", legacy.id);
    assert.equal(post.status, "approved");
    assert.deepEqual(await store.assertApproval(post), hashes(post));
    assert.ok(await store.get<Asset>("asset", "legacy-photo"));
  });
  assert.deepEqual(await files().read("dest/assets/legacy-photo.jpg"), image);
});

test("importing again keeps everything done in the new studio since", async () => {
  // Work in the new studio: edit the brief, revise, approve and publish.
  const published = await as("dest", async () => {
    const brand = await store.get<Brand>("brand", "demo-brand");
    await store.put("brand", {
      ...brand,
      name: "Edited in the new studio",
      facts: "New verified facts",
      version: 1,
    });
    const post = await store.get<Post>("post", legacy.id);
    const revised = await store.savePost(
      { ...store.contentOf(post), caption: "Rewritten caption" },
      post.id,
      post.revision,
    );
    const approved = await store.approvePost(
      revised.id,
      revised.revision,
      hashes(revised),
    );
    const done: Post = {
      ...approved,
      status: "published",
      publishedUrl: "https://www.tiktok.com/@me/photo/9",
      publishedAt: store.now(),
      metrics: { views: 50, likes: 2, comments: 0, shares: 0, measuredAt: "x" },
    };
    await store.put("post", done);
    return done;
  });
  // Meanwhile the old studio gained a second post.
  await as("legacy", () => seedSamplePost(store));
  const again = await legacyFolder("again");

  const report = await importSqlite(again, "dest");
  assert.equal(report.added.post, 1);
  assert.ok(report.kept.includes("brand demo-brand"));
  assert.ok(report.kept.includes(`post ${legacy.id}`));
  await as("dest", async () => {
    const brand = await store.get<Brand>("brand", "demo-brand");
    assert.equal(brand.name, "Edited in the new studio");
    assert.equal(brand.facts, "New verified facts");
    assert.equal(brand.version, 1);
    const post = await store.get<Post>("post", legacy.id);
    assert.deepEqual(post, published);
    // History and approval still match the current post.
    assert.deepEqual(await store.assertApproval(post), hashes(post));
    assert.equal(
      (await store.revisionContent(post.id, 2)).caption,
      "Rewritten caption",
    );
    const [{ n }] = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM revisions WHERE user_id='dest' AND post_id=$1",
      [post.id],
    );
    assert.equal(n, 2);
    assert.equal((await store.list<Post>("post")).length, 2);
  });
});

test("an import interrupted while copying images can be retried", async () => {
  const store_ = files();
  const write = store_.write;
  store_.write = async () => {
    throw new Error("storage unavailable");
  };
  try {
    await assert.rejects(importSqlite(first, "retry"), /storage unavailable/);
  } finally {
    store_.write = write;
  }
  // Nothing points at the missing image yet.
  const [{ n }] = await db.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM entities WHERE user_id='retry'",
  );
  assert.equal(n, 0);
  const report = await importSqlite(first, "retry");
  assert.equal(report.added.asset, 1);
  assert.ok(
    existsSync(
      path.join(
        folder,
        "studio",
        "files",
        "retry",
        "assets",
        "legacy-photo.jpg",
      ),
    ),
  );
});
