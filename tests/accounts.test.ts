// Hosting: every account sees only its own studio, uploads go through
// storage, and a hosted studio refuses requests without a session.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, Brand, Format } from "../src/lib/schema";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-accounts-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
const { authorize } = await import("../src/lib/auth");
const { POST } = await import("../src/app/api/studio/route");
const { PUT: uploadRoute } = await import("../src/app/api/upload/[id]/route");
const { GET: mediaRoute } = await import("../src/app/api/media/[id]/route");
const { NextRequest } = await import("next/server");
after(async () => {
  await store.closeStore();
  rmSync(folder, { recursive: true, force: true });
});
const headers = { host: "localhost:3000", origin: "http://localhost:3000" };
const action = async (body: Record<string, unknown>) => {
  const response = await POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};
const alice = { id: "alice", email: "alice@example.com" },
  bob = { id: "bob", email: "bob@example.com" };

test("each account gets its own seeded studio and cannot read another's", async () => {
  await store.withAccount(alice, async () => {
    const brand = await store.get<Brand>("brand", "demo-brand");
    await store.put("brand", { ...brand, name: "Alice's brand" });
    await store.put<Asset>("asset", {
      id: "alice-photo",
      name: "Alice",
      collection: "Mine",
      rights: "Mine",
      width: 10,
      height: 10,
      hash: "a",
      createdAt: store.now(),
    });
  });
  await store.withAccount(bob, async () => {
    // Bob's workspace was seeded with the same starter ids, untouched.
    assert.equal(
      (await store.get<Brand>("brand", "demo-brand")).name,
      "My brand",
    );
    assert.ok(await store.get<Format>("format", "tiktok-photo"));
    await assert.rejects(
      store.get("asset", "alice-photo"),
      /not in your library/,
    );
    assert.deepEqual(await store.list("asset"), []);
    assert.equal((await store.state()).settings.email, "bob@example.com");
  });
  await store.withAccount(alice, async () => {
    assert.equal(
      (await store.get<Brand>("brand", "demo-brand")).name,
      "Alice's brand",
    );
  });
});

test("AI attempts are limited per account", async () => {
  await store.withAccount(alice, () => store.recordAiAttempt(store.uid()));
  assert.equal(await store.withAccount(alice, () => store.dailyUsage()), 1);
  assert.equal(await store.withAccount(bob, () => store.dailyUsage()), 0);
});

test("browser uploads go to storage first, then import into the library", async () => {
  const target = await action({ action: "uploadUrl" });
  assert.equal(target.status, 200);
  assert.match(target.body.url, /^\/api\/upload\/[0-9a-f-]{36}$/);
  const image = await sharp({
    create: { width: 300, height: 200, channels: 3, background: "#3366cc" },
  })
    .png()
    .toBuffer();
  const sent = await uploadRoute(
    new NextRequest(`http://localhost:3000${target.body.url}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "image/png" },
      body: new Uint8Array(image),
    }),
    { params: Promise.resolve({ id: target.body.id }) },
  );
  assert.equal(sent.status, 200);
  const upload = path.join(folder, "files", "local", "uploads", target.body.id);
  assert.ok(existsSync(upload));
  const imported = await action({
    action: "importUpload",
    id: target.body.id,
    name: "blue.png",
    collection: "Direct",
    rights: "Mine",
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.asset.name, "blue.png");
  assert.equal(imported.body.asset.width, 300);
  // The raw upload is removed; the normalized JPEG serves from the library.
  assert.ok(!existsSync(upload));
  const media = await mediaRoute(
    new NextRequest(
      `http://localhost:3000/api/media/${imported.body.asset.id}`,
      {
        headers,
      },
    ),
    { params: Promise.resolve({ id: imported.body.asset.id }) },
  );
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/jpeg");
  const again = await action({
    action: "importUpload",
    id: target.body.id,
    rights: "Mine",
  });
  assert.equal(again.status, 404);
  const forged = await action({
    action: "importUpload",
    id: "../../alice/assets/x",
    rights: "Mine",
  });
  assert.equal(forged.status, 400);
});

test("a hosted studio refuses requests without a session", async () => {
  const saved = { ...process.env };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  try {
    const request = () =>
      new NextRequest("https://slideo.example/api/studio", {
        headers: { host: "slideo.example", origin: "https://slideo.example" },
      });
    // Missing server settings fail closed instead of falling back to local.
    assert.equal(((await authorize(request())) as Response).status, 503);
    process.env.DATABASE_URL =
      "postgresql://u:p@db.example.test:6543/postgres?sslrootcert=system";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "unused";
    assert.equal(((await authorize(request())) as Response).status, 401);
    // Store calls outside a signed-in request never default to an account.
    await assert.rejects(store.list("post"), /No signed-in account/);
  } finally {
    process.env = saved;
  }
});
