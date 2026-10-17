// A local studio's embedded database from the release before TikTok inbox
// delivery (schema version 1) upgrades in place on first use: the migrations
// add what is missing, and approved slideshows keep their approvals and still
// export. Hosted projects upgrade by running the new migration file, which
// `npm run test:supabase` covers through the stack's schema check.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Post } from "../src/lib/schema";
import { seedSamplePost } from "./sample-post";
import { closeTestDatabase, onSupabase, sql } from "./database";

const skip = onSupabase ? "upgrades the embedded database only" : false;
const folder = mkdtempSync(path.join(tmpdir(), "slideo-upgrade-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
const { driver } = await import("../src/lib/db");
const { NextRequest } = await import("next/server");
const { GET: studioGet, POST: studioPost } =
  await import("../src/app/api/studio/route");
const { GET: exportPackage } = await import("../src/app/api/export/[id]/route");
after(async () => {
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const local = { host: "localhost:3000", origin: "http://localhost:3000" };
const exportOf = (post: Post) =>
  exportPackage(
    new NextRequest(
      `http://localhost:3000/api/export/${post.id}?revision=${post.revision}`,
      { headers: local },
    ),
    { params: Promise.resolve({ id: post.id }) },
  );
const version = async () =>
  (await sql<{ v: number }>("SELECT public.slideo_schema_version() AS v"))[0].v;
const snapshot = async () =>
  (
    await sql<{ state: Record<string, unknown> }>(
      "SELECT public.slideo_state('local', '2000-01-01') AS state",
    )
  )[0].state;
const migrations = () =>
  readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) =>
      readFileSync(path.join("supabase/migrations", name), "utf8"),
    );

let post: Post;
test(
  "a version 1 database upgrades in place and keeps its approvals",
  { skip },
  async () => {
    post = await seedSamplePost(store);
    const approved = await studioPost(
      new NextRequest("http://localhost:3000/api/studio", {
        method: "POST",
        headers: { ...local, "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          id: post.id,
          revision: post.revision,
        }),
      }),
    );
    assert.equal(approved.status, 200);

    // Take the database back to the previous release: its only migration,
    // without anything version 2 added.
    const [first, ...later] = migrations();
    assert.ok(later.length, "this release adds a migration");
    const db = await driver();
    await db.exec(first);
    await db.exec(
      "DROP FUNCTION public.slideo_due_deliveries(text, integer); DROP INDEX public.entities_delivery_next_at;",
    );
    assert.equal(await version(), 1);
    assert.equal("deliveries" in (await snapshot()), false);
    await store.closeStore();

    // The first request after the upgrade finds a version 2 database with
    // every record in place.
    const response = await studioGet(
      new NextRequest("http://localhost:3000/api/studio", { headers: local }),
    );
    assert.equal(response.status, 200);
    assert.equal(await version(), 2);
    const state = await snapshot();
    assert.deepEqual(state.deliveries, []);
    assert.deepEqual(state.tiktokAccounts, []);
    assert.ok((state.posts as Post[]).some((p) => p.id === post.id));
    const [index] = await sql<{ name: string }>(
      "SELECT indexname AS name FROM pg_indexes WHERE indexname = 'entities_delivery_next_at'",
    );
    assert.equal(index?.name, "entities_delivery_next_at");
    assert.deepEqual(await store.dueDeliveries(new Date(), 25), []);
    // Approved before the upgrade, still approved and exportable after it.
    const current = await store.get<Post>("post", post.id);
    assert.equal(current.status, "approved");
    await store.assertApproval(current);
    assert.equal((await exportOf(current)).status, 200);
  },
);

test("running every migration again changes no data", { skip }, async () => {
  const rows = () =>
    sql("SELECT kind, id, json FROM entities ORDER BY kind, id");
  const history = () =>
    sql(
      "SELECT (SELECT count(*) FROM revisions) AS revisions, (SELECT count(*) FROM approvals) AS approvals, (SELECT count(*) FROM audit) AS audit",
    );
  const before = [await rows(), await history()];
  const db = await driver();
  for (let round = 0; round < 2; round++)
    for (const file of migrations()) await db.exec(file);
  assert.deepEqual([await rows(), await history()], before);
  assert.equal(await version(), 2);
  assert.equal(
    (await exportOf(await store.get<Post>("post", post.id))).status,
    200,
  );
});
