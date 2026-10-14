// VM-05: packages larger than one image upload still export when hosted.
// A stand-in for Supabase Storage enforces each bucket's size and type
// limits the way the real service does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Post } from "../src/lib/schema";
import { closeTestDatabase, prepareTestDatabase } from "./database";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-exports-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
await prepareTestDatabase();
const { supabaseStore, useFiles, UPLOAD_BYTES } =
  await import("../src/lib/files");
const { POST } = await import("../src/app/api/studio/route");
const { GET: exportRoute } = await import("../src/app/api/export/[id]/route");
const { NextRequest } = await import("next/server");
after(async () => {
  useFiles(undefined);
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

type Bucket = {
  public: boolean;
  file_size_limit: number;
  allowed_mime_types: string[];
  objects: Map<string, Buffer>;
};
type Options = {
  public: boolean;
  fileSizeLimit: number;
  allowedMimeTypes: string[];
};
function fakeStorage(existing: Record<string, Omit<Bucket, "objects">> = {}) {
  const buckets = new Map<string, Bucket>(
    Object.entries(existing).map(([id, b]) => [
      id,
      { ...b, objects: new Map() },
    ]),
  );
  const changes: string[] = [];
  const set = (id: string, o: Options) =>
    buckets.set(id, {
      public: o.public,
      file_size_limit: o.fileSizeLimit,
      allowed_mime_types: o.allowedMimeTypes,
      objects: buckets.get(id)?.objects ?? new Map(),
    });
  const storage = {
    async getBucket(id: string) {
      const b = buckets.get(id);
      return b
        ? { data: { id, ...b }, error: null }
        : { data: null, error: { message: "Bucket not found" } };
    },
    async createBucket(id: string, o: Options) {
      changes.push(`create ${id}`);
      set(id, o);
      return { data: { name: id }, error: null };
    },
    async updateBucket(id: string, o: Options) {
      changes.push(`update ${id}`);
      set(id, o);
      return { data: { message: "ok" }, error: null };
    },
    from(id: string) {
      const b = buckets.get(id)!;
      return {
        async upload(key: string, data: Buffer, o: { contentType: string }) {
          if (data.byteLength > b.file_size_limit)
            return { data: null, error: new Error("Payload too large") };
          if (!b.allowed_mime_types.includes(o.contentType))
            return { data: null, error: new Error("mime type not supported") };
          b.objects.set(key, data);
          return { data: { path: key }, error: null };
        },
        async download(key: string) {
          const data = b.objects.get(key);
          return data
            ? { data: new Blob([new Uint8Array(data)]), error: null }
            : { data: null, error: new Error("Object not found") };
        },
        async remove(keys: string[]) {
          keys.forEach((key) => b.objects.delete(key));
          return { data: [], error: null };
        },
        async createSignedUploadUrl(key: string) {
          return {
            data: { signedUrl: `https://storage.test/${id}/${key}?upload` },
            error: null,
          };
        },
        async createSignedUrl(
          key: string,
          _: number,
          o: { download?: string },
        ) {
          return {
            data: {
              signedUrl: `https://storage.test/${id}/${key}?download=${o.download ?? ""}`,
            },
            error: null,
          };
        },
      };
    },
  };
  return {
    buckets,
    changes,
    files: supabaseStore(Promise.resolve({ storage } as never), {}),
  };
}

test("buckets from an earlier release are brought to the current limits", async () => {
  // The previous release made one bucket for images and ZIPs alike.
  const fake = fakeStorage({
    studio: {
      public: false,
      file_size_limit: UPLOAD_BYTES,
      allowed_mime_types: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/zip",
      ],
    },
  });
  await fake.files.read("u/assets/none.jpg");
  assert.deepEqual(fake.changes.sort(), [
    "create studio-exports",
    "update studio",
  ]);
  const images = fake.buckets.get("studio")!;
  assert.equal(images.file_size_limit, UPLOAD_BYTES);
  assert.deepEqual(images.allowed_mime_types, [
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  const exports = fake.buckets.get("studio-exports")!;
  assert.equal(exports.public, false);
  assert.equal(exports.file_size_limit, 50 * 1024 * 1024);
  assert.deepEqual(exports.allowed_mime_types, ["application/zip"]);
  // Images over 20 MB stay refused, and ZIPs never land in the image bucket.
  await assert.rejects(
    fake.files.write(
      "u/uploads/big",
      Buffer.alloc(UPLOAD_BYTES + 1),
      "image/jpeg",
    ),
    /too large/,
  );
  // Correctly configured buckets are left alone.
  const settled = fakeStorage(
    Object.fromEntries(
      [...fake.buckets].map(([id, { objects, ...b }]) => {
        void objects;
        return [id, b];
      }),
    ),
  );
  await settled.files.read("u/assets/none.jpg");
  assert.deepEqual(settled.changes, []);
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
const exportZip = (post: Post) =>
  exportRoute(
    new NextRequest(
      `http://localhost:3000/api/export/${post.id}?revision=${post.revision}`,
      { headers },
    ),
    { params: Promise.resolve({ id: post.id }) },
  );

test("an approved package over 20 MB exports through the package bucket", async () => {
  const fake = fakeStorage();
  useFiles(fake.files);
  // Random pixels barely compress: each slide renders to about 1.3 MB.
  const width = 1080,
    height = 1920;
  const noise = randomBytes(width * height * 3);
  const form = new FormData();
  form.set(
    "file",
    new Blob([
      new Uint8Array(
        await sharp(noise, { raw: { width, height, channels: 3 } })
          .jpeg({ quality: 95 })
          .toBuffer(),
      ),
    ]),
    "noise.jpg",
  );
  form.set("collection", "Noise");
  form.set("rights", "Generated for this test");
  const uploaded = await POST(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers,
      body: form,
    }),
  );
  assert.equal(uploaded.status, 200);
  const draft = (
    await action({
      action: "create",
      brandId: "demo-brand",
      formatId: "tiktok-photo",
      topic: "Big package",
      mode: "manual",
      slideCount: 2,
      collection: "Noise",
    })
  ).body as Post;
  // Legacy posts may hold up to 20 slides; 18 of these exceed 20 MB.
  const post = await store.savePost(
    {
      ...store.contentOf(draft),
      slides: Array.from({ length: 18 }, (_, i) => ({
        ...draft.slides[0],
        id: `big-${i}`,
      })),
    },
    draft.id,
    draft.revision,
  );
  const approved = await action({
    action: "approve",
    id: post.id,
    revision: post.revision,
  });
  assert.equal(approved.status, 200, approved.body.error);

  const response = await exportZip(post);
  assert.equal(response.status, 200);
  const { url } = await response.json();
  const key = `local/exports/slideshow-${post.id.slice(0, 8)}-v${post.revision}.zip`;
  assert.equal(
    url,
    `https://storage.test/studio-exports/${key}?download=${key.split("/")[2]}`,
  );
  const zip = fake.buckets.get("studio-exports")!.objects.get(key)!;
  assert.ok(zip.byteLength > UPLOAD_BYTES, `${zip.byteLength} bytes`);
  assert.equal(fake.buckets.get("studio")!.objects.has(key), false);

  // Past the configured package limit, the studio explains what to do.
  process.env.EXPORT_LIMIT_MB = "5";
  try {
    const refused = await exportZip(post);
    assert.equal(refused.status, 413);
    assert.match(
      (await refused.json()).error,
      /over the 5\.0 MB download limit/,
    );
  } finally {
    delete process.env.EXPORT_LIMIT_MB;
  }
});
