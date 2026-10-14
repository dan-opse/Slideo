// The hosted studio against a real Supabase stack (`npm run test:supabase`):
// two signed-in accounts use the app's routes, browsers upload straight to
// Storage, and anything a browser could call directly (the Data API, RPCs
// and Storage, with its session or the publishable key) is refused.
// Skipped by `npm test`, which has no stack to talk to.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import type { Post, StudioState } from "../src/lib/schema";
import { closeTestDatabase, localStack, onSupabase, sql } from "./database";

const skip = onSupabase ? false : "needs the local Supabase stack";
const stack = onSupabase ? localStack() : undefined;
const folder = mkdtempSync(path.join(tmpdir(), "slideo-hosted-test-"));
// Only the three Supabase settings: no database URL, password or certificate.
process.env.STUDIO_DATA_DIR = folder;
if (stack) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = stack.API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = stack.PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY = stack.SECRET_KEY;
  await sql(
    "TRUNCATE public.entities, public.revisions, public.approvals, public.audit, public.ai_attempts, public.accounts",
  );
}
const { POST, GET } = await import("../src/app/api/studio/route");
const { GET: exportRoute } = await import("../src/app/api/export/[id]/route");
const { GET: mediaRoute } = await import("../src/app/api/media/[id]/route");
const { GET: renderRoute } =
  await import("../src/app/api/render/[post]/[revision]/[slide]/route");
const { PUT: uploadRoute } = await import("../src/app/api/upload/[id]/route");
const store = await import("../src/lib/store");
const { NextRequest } = await import("next/server");

const admin = stack
  ? createClient(stack.API_URL, stack.SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : undefined;
type User = {
  id: string;
  email: string;
  cookie: string;
  // What a browser holding this session could call directly.
  client: SupabaseClient;
};
const users: User[] = [];
after(async () => {
  for (const user of users) await admin!.auth.admin.deleteUser(user.id);
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

// A confirmed account, signed in the way the studio's sign-in route does:
// the session lands in cookies that later requests carry.
async function account(name: string): Promise<User> {
  const email = `${name}-${Date.now()}@example.com`,
    password = `pw-${randomBytes(9).toString("hex")}`;
  const created = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  const jar = new Map<string, string>();
  const session = createServerClient(stack!.API_URL, stack!.PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) =>
        list.forEach(({ name, value }) =>
          value ? jar.set(name, value) : jar.delete(name),
        ),
    },
  });
  const { data, error } = await session.auth.signInWithPassword({
    email,
    password,
  });
  assert.ifError(error);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(jar.size, "the sign-in set session cookies");
  const client = createClient(stack!.API_URL, stack!.PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${data.session!.access_token}` },
    },
  });
  const user = {
    id: data.user!.id,
    email,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    client,
  };
  users.push(user);
  return user;
}

const site = "http://localhost:3000";
const headersFor = (user?: User) => ({
  host: "localhost:3000",
  origin: site,
  ...(user ? { cookie: user.cookie } : {}),
});
const studio = async (
  user: User | undefined,
  body: Record<string, unknown>,
) => {
  const response = await POST(
    new NextRequest(`${site}/api/studio`, {
      method: "POST",
      headers: { ...headersFor(user), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};
const load = async (user: User) => {
  const response = await GET(
    new NextRequest(`${site}/api/studio`, { headers: headersFor(user) }),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as StudioState;
};
// The browser's half of an upload: a PUT straight to the signed URL.
const put = (url: string, body: Buffer, type = "image/jpeg") =>
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": type },
    body: new Uint8Array(body),
  });
async function upload(user: User, image: Buffer, collection: string) {
  const target = await studio(user, { action: "uploadUrl" });
  assert.equal(target.status, 200);
  assert.ok(target.body.url.startsWith(`${stack!.API_URL}/storage/v1/`));
  const sent = await put(target.body.url, image);
  assert.equal(sent.status, 200, await sent.clone().text());
  const imported = await studio(user, {
    action: "importUpload",
    id: target.body.id,
    name: `${collection}.jpg`,
    collection,
    rights: "Mine",
  });
  assert.equal(imported.status, 200, imported.body.error);
  return { ...imported.body.asset, uploadUrl: target.body.url as string };
}
const exportOf = (user: User, post: Post) =>
  exportRoute(
    new NextRequest(`${site}/api/export/${post.id}?revision=${post.revision}`, {
      headers: headersFor(user),
    }),
    { params: Promise.resolve({ id: post.id }) },
  );
const photo = (color: string) =>
  sharp({
    create: { width: 600, height: 900, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();

const alice = skip ? undefined : await account("alice");
const bob = skip ? undefined : await account("bob");

test(
  "a hosted studio refuses requests without a session",
  { skip },
  async () => {
    const response = await GET(
      new NextRequest(`${site}/api/studio`, { headers: headersFor() }),
    );
    assert.equal(response.status, 401);
    assert.equal(
      (await studio(undefined, { action: "uploadUrl" })).status,
      401,
    );
    // The local upload stand-in does not exist when hosted.
    const local = await uploadRoute(
      new NextRequest(`${site}/api/upload/x`, {
        method: "PUT",
        headers: headersFor(alice),
      }),
      { params: Promise.resolve({ id: "x" }) },
    );
    assert.equal(local.status, 404);
  },
);

test(
  "each account gets its own studio through the Data API",
  { skip },
  async () => {
    const a = await load(alice!);
    assert.equal(a.settings.hosted, true);
    assert.equal(a.settings.email, alice!.email);
    assert.deepEqual(
      a.formats.map((f) => f.id),
      ["tiktok-photo"],
    );
    const brand = a.brands.find((b) => b.id === "demo-brand")!;
    const saved = await studio(alice!, {
      action: "brand",
      expected: brand.version ?? 0,
      // A forged owner in the payload changes nothing.
      data: { ...brand, name: "Alice's brand", user_id: bob!.id },
    });
    assert.equal(saved.status, 200, saved.body.error);
    const b = await load(bob!);
    assert.equal(b.brands.find((x) => x.id === "demo-brand")!.name, "My brand");
    assert.equal(
      (await load(alice!)).brands.find((x) => x.id === "demo-brand")!.name,
      "Alice's brand",
    );
    const owners = await sql<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM entities ORDER BY user_id",
    );
    assert.deepEqual(
      owners.map((o) => o.user_id),
      [alice!.id, bob!.id].sort(),
    );
  },
);

test(
  "browsers upload straight to Storage through one-file signed URLs",
  { skip },
  async () => {
    const asset = await upload(alice!, await photo("#3366cc"), "Mine");
    // The library image is served from Storage through a short-lived link.
    const media = await mediaRoute(
      new NextRequest(`${site}/api/media/${asset.id}`, {
        headers: headersFor(alice),
      }),
      { params: Promise.resolve({ id: asset.id }) },
    );
    assert.equal(media.status, 307);
    const link = media.headers.get("location")!;
    assert.ok(link.includes(`/object/sign/studio/${alice!.id}/assets/`));
    const bytes = Buffer.from(await (await fetch(link)).arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).format, "jpeg");
    // Bob cannot open Alice's image through the studio.
    const theirs = await mediaRoute(
      new NextRequest(`${site}/api/media/${asset.id}`, {
        headers: headersFor(bob),
      }),
      { params: Promise.resolve({ id: asset.id }) },
    );
    assert.equal(theirs.status, 404);

    const target = await studio(alice!, { action: "uploadUrl" });
    // The bucket refuses files over 20 MB and anything but images.
    // Storage answers 400 with the real status in the body, which the
    // browser's uploadImage reads to show the size limit.
    const big = await put(target.body.url, Buffer.alloc(21 * 1024 * 1024));
    assert.equal(big.status, 400);
    assert.equal((await big.json()).statusCode, "413");
    const html = await put(
      target.body.url,
      Buffer.from("<p>hi</p>"),
      "text/html",
    );
    assert.ok(html.status >= 400, `${html.status}`);
    // A used upload link cannot replace the file it created...
    const first = await put(target.body.url, await photo("#111111"));
    assert.equal(first.status, 200);
    const again = await put(target.body.url, await photo("#222222"));
    assert.ok(again.status >= 400, `${again.status}`);
    // ...and a link cannot be pointed at another file, such as a rendered slide.
    const forged = target.body.url.replace(
      `/${alice!.id}/uploads/`,
      `/${alice!.id}/renders/`,
    );
    assert.notEqual(forged, target.body.url);
    assert.ok((await put(forged, await photo("#333333"))).status >= 400);
  },
);

test(
  "a full hosted workflow, including a package over 20 MB",
  { skip },
  async () => {
    // Random pixels barely compress: each slide renders to about 1.3 MB.
    const width = 1080,
      height = 1920;
    const noise = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    await upload(alice!, noise, "Noise");
    const draft = (
      await studio(alice!, {
        action: "create",
        brandId: "demo-brand",
        formatId: "tiktok-photo",
        topic: "Big package",
        mode: "manual",
        slideCount: 2,
        collection: "Noise",
      })
    ).body as Post;
    assert.equal(draft.status, "needs_review");
    const saved = await studio(alice!, {
      action: "save",
      id: draft.id,
      expected: draft.revision,
      data: {
        ...store.contentOf(draft),
        slides: Array.from({ length: 18 }, (_, i) => ({
          ...draft.slides[0],
          id: `big-${i}`,
        })),
      },
    });
    assert.equal(saved.status, 200, saved.body.error);
    const post = saved.body as Post;
    // Bob can neither see, change, approve nor render Alice's slideshow.
    assert.ok(!(await load(bob!)).posts.some((p) => p.id === post.id));
    for (const body of [
      { action: "approve", id: post.id, revision: post.revision },
      { action: "archive", id: post.id },
      { action: "duplicate", id: post.id },
      {
        action: "save",
        id: post.id,
        expected: post.revision,
        data: store.contentOf(post),
      },
    ])
      assert.equal((await studio(bob!, body)).status, 404, body.action);
    const render = await renderRoute(
      new NextRequest(`${site}/api/render/${post.id}/${post.revision}/0`, {
        headers: headersFor(bob),
      }),
      {
        params: Promise.resolve({
          post: post.id,
          revision: String(post.revision),
          slide: "0",
        }),
      },
    );
    assert.equal(render.status, 404);
    assert.equal((await exportOf(bob!, post)).status, 404);

    const approved = await studio(alice!, {
      action: "approve",
      id: post.id,
      revision: post.revision,
    });
    assert.equal(approved.status, 200, approved.body.error);
    const response = await exportOf(alice!, post);
    assert.equal(response.status, 200);
    const { url } = await response.json();
    assert.ok(url.includes("/object/sign/studio-exports/"));
    const zip = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.ok(zip.byteLength > 20 * 1024 * 1024, `${zip.byteLength} bytes`);
    const files = Object.keys((await JSZip.loadAsync(zip)).files);
    assert.equal(files.filter((name) => name.endsWith(".jpg")).length, 18);

    const published = await studio(alice!, {
      action: "publish",
      id: post.id,
      revision: post.revision,
      url: "https://www.tiktok.com/@alice/photo/1",
    });
    assert.equal(published.status, 200, published.body.error);
    const results = await studio(alice!, {
      action: "metrics",
      id: post.id,
      data: { views: 10, likes: 1, comments: 0, shares: 0 },
    });
    assert.equal(results.status, 200, results.body.error);
    // A published slideshow can't be edited, even with the right revision.
    const edit = await studio(alice!, {
      action: "save",
      id: post.id,
      expected: post.revision,
      data: { ...store.contentOf(post), title: "Changed later" },
    });
    assert.equal(edit.status, 409);
    const audit = await sql<{ action: string }>(
      "SELECT action FROM audit WHERE user_id=$1 AND entity=$2 ORDER BY at",
      [alice!.id, post.id],
    );
    assert.deepEqual(
      audit.map((a) => a.action),
      [
        "post.created",
        "post.revised",
        "export.approved",
        "export.downloaded",
        "publication.owner_confirmed",
        "results.recorded",
      ],
    );
  },
);

test(
  "a browser cannot reach the tables, functions or buckets directly",
  { skip },
  async () => {
    const visitor = createClient(stack!.API_URL, stack!.PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const refused = (
      result: { error: { code?: string } | null },
      what: string,
    ) => assert.equal(result.error?.code, "42501", what);
    for (const [who, db] of [
      ["signed-in", alice!.client],
      ["visitor", visitor],
    ] as const) {
      for (const table of [
        "entities",
        "revisions",
        "approvals",
        "audit",
        "ai_attempts",
        "accounts",
      ])
        refused(
          await db.from(table).select("*").limit(1),
          `${who} reads ${table}`,
        );
      refused(
        await db.from("entities").insert({
          user_id: alice!.id,
          kind: "brand",
          id: "forged",
          json: '{"id":"forged"}',
        }),
        `${who} inserts`,
      );
      refused(
        await db
          .from("entities")
          .update({ user_id: bob!.id })
          .eq("user_id", alice!.id),
        `${who} changes an owner`,
      );
      refused(
        await db.from("audit").delete().eq("user_id", alice!.id),
        `${who} deletes audit history`,
      );
      // Not even for the caller's own account: every function is server-only.
      for (const [fn, args] of [
        ["slideo_state", { p_user: alice!.id, p_since: "2000-01-01" }],
        ["slideo_list", { p_user: bob!.id, p_kind: "post" }],
        ["slideo_ai_usage", { p_user: alice!.id, p_since: "2000-01-01" }],
        [
          "slideo_commit",
          {
            p_user: alice!.id,
            p_expected: null,
            p_changes: [
              {
                op: "approve",
                post: "x",
                revision: 1,
                hash: "forged",
                render_hashes: "[]",
                at: "now",
              },
            ],
          },
        ],
      ] as const)
        refused(await db.rpc(fn, args), `${who} calls ${fn}`);

      const images = db.storage.from("studio");
      const listed = await images.list(alice!.id);
      assert.deepEqual(listed.data ?? [], [], `${who} lists files`);
      for (const key of [
        `${alice!.id}/renders/forged.jpg`,
        `${alice!.id}/assets/forged.jpg`,
        `${bob!.id}/uploads/forged`,
      ]) {
        const write = await images.upload(key, await photo("#444444"), {
          contentType: "image/jpeg",
          upsert: true,
        });
        assert.ok(write.error, `${who} writes ${key}`);
      }
      const asset = (await load(alice!)).assets[0];
      const read = await images.download(`${alice!.id}/assets/${asset.id}.jpg`);
      assert.ok(read.error, `${who} downloads an image`);
      const sign = await images.createSignedUrl(
        `${alice!.id}/assets/${asset.id}.jpg`,
        60,
      );
      assert.ok(sign.error, `${who} signs a link`);
      const zips = await db.storage.from("studio-exports").list(alice!.id);
      assert.deepEqual(zips.data ?? [], [], `${who} lists packages`);
      const removed = await images.remove([
        `${alice!.id}/assets/${asset.id}.jpg`,
      ]);
      assert.deepEqual(removed.data ?? [], [], `${who} deletes an image`);
      assert.ok(
        (await db.storage.createBucket("mine")).error,
        `${who} creates a bucket`,
      );
      assert.ok(
        (await db.storage.updateBucket("studio", { public: true })).error,
        `${who} makes the bucket public`,
      );
    }
    // The buckets kept their settings, and the image is still there.
    const { data: bucket } = await admin!.storage.getBucket("studio");
    assert.equal(bucket?.public, false);
    const asset = (await load(alice!)).assets[0];
    const kept = await admin!.storage
      .from("studio")
      .download(`${alice!.id}/assets/${asset.id}.jpg`);
    assert.ifError(kept.error);
  },
);
