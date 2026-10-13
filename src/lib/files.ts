import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dataDir } from "./db";

// Keys are "<user>/<area>/<name>" (areas: assets, renders, uploads, exports).
export type FileStore = {
  // Remote stores can hand the browser links instead of file bytes.
  remote: boolean;
  read(key: string): Promise<Buffer | null>;
  write(key: string, data: Buffer, contentType: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
  // Where the browser sends an upload's bytes with a PUT request.
  uploadUrl(key: string): Promise<string>;
  // A short-lived link to the file, or null when the server must send it.
  signedUrl(key: string, download?: string): Promise<string | null>;
};

export const UPLOAD_BYTES = 20 * 1024 * 1024;
const KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/;
function checked(key: string) {
  if (!KEY.test(key) || key.split("/").some((part) => part.startsWith(".")))
    throw new Error(`Invalid storage key: ${key}`);
  return key;
}

function localStore(): FileStore {
  const file = (key: string) => path.join(dataDir, "files", checked(key));
  return {
    remote: false,
    read: (key) => readFile(file(key)).catch(() => null),
    async write(key, data) {
      await mkdir(path.dirname(file(key)), { recursive: true });
      await writeFile(file(key), data);
    },
    async remove(keys) {
      await Promise.all(keys.map((key) => unlink(file(key)).catch(() => {})));
    },
    // The upload route stores the bytes under the signed-in user's folder.
    uploadUrl: async (key) => `/api/upload/${checked(key).split("/").pop()}`,
    signedUrl: async () => null,
  };
}

// Approved packages can be far larger than one image: a legacy 20-slide post
// of detailed photos makes a ZIP of about 30 MB. 50 MB is the largest file
// Supabase's free plan accepts; paid plans can raise EXPORT_LIMIT_MB.
export function exportBytes() {
  const mb = Number(process.env.EXPORT_LIMIT_MB || 50);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024);
}

type Storage = SupabaseClient["storage"];
type BucketConfig = {
  public: false;
  fileSizeLimit: number;
  allowedMimeTypes: string[];
};
// Two private buckets: images (uploads, library, renders) keep the 20 MB
// upload limit, which also bounds what a signed upload URL accepts; ZIP
// packages get their own bucket and limit.
export function bucketsFor(env: Record<string, string | undefined>) {
  return {
    images: env.STORAGE_BUCKET || "studio",
    exports: env.STORAGE_EXPORT_BUCKET || "studio-exports",
  };
}
const configs = (): Record<"images" | "exports", BucketConfig> => ({
  images: {
    public: false,
    fileSizeLimit: UPLOAD_BYTES,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  exports: {
    public: false,
    fileSizeLimit: exportBytes(),
    allowedMimeTypes: ["application/zip"],
  },
});
// Creates a bucket, or brings an existing one to the expected settings: a
// bucket made by an earlier release keeps its old limits otherwise.
async function ensureBucket(storage: Storage, id: string, want: BucketConfig) {
  const { data } = await storage.getBucket(id);
  if (!data) {
    const { error } = await storage.createBucket(id, want);
    if (!error || /already exists/i.test(error.message)) return;
    throw error;
  }
  const types = [...(data.allowed_mime_types ?? [])].sort().join();
  if (
    data.public === want.public &&
    Number(data.file_size_limit) === want.fileSizeLimit &&
    types === [...want.allowedMimeTypes].sort().join()
  )
    return;
  const { error } = await storage.updateBucket(id, want);
  if (error) throw error;
}

export function supabaseStore(
  client: Promise<{ storage: Storage }>,
  env: Record<string, string | undefined> = process.env,
): FileStore {
  const names = bucketsFor(env);
  let ready: Promise<void> | undefined;
  const bucket = async (key: string) => {
    const { storage } = await client;
    ready ??= Promise.all(
      (["images", "exports"] as const).map((kind) =>
        ensureBucket(storage, names[kind], configs()[kind]),
      ),
    )
      .then(() => {})
      .catch((error) => {
        ready = undefined;
        throw error;
      });
    await ready;
    const area = checked(key).split("/")[1];
    return storage.from(area === "exports" ? names.exports : names.images);
  };
  return {
    remote: true,
    async read(key) {
      const { data, error } = await (await bucket(key)).download(key);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async write(key, data, contentType) {
      const { error } = await (
        await bucket(key)
      ).upload(key, data, { contentType, upsert: true });
      if (error) throw error;
    },
    async remove(keys) {
      // One call per bucket; exports and images never share one.
      const all = keys.map(checked);
      const exports = all.filter((key) => key.split("/")[1] === "exports");
      const images = all.filter((key) => !exports.includes(key));
      for (const group of [images, exports])
        if (group.length) await (await bucket(group[0])).remove(group);
    },
    async uploadUrl(key) {
      const { data, error } = await (
        await bucket(key)
      ).createSignedUploadUrl(key);
      if (error || !data) throw error ?? new Error("No upload URL");
      return data.signedUrl;
    },
    async signedUrl(key, download) {
      const { data, error } = await (
        await bucket(key)
      ).createSignedUrl(key, 3600, download ? { download } : {});
      if (error || !data) throw error ?? new Error("No signed URL");
      return data.signedUrl;
    },
  };
}

let instance: FileStore | undefined;
export function files() {
  if (instance) return instance;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  instance =
    url && key
      ? supabaseStore(
          import("@supabase/supabase-js").then(({ createClient }) =>
            createClient(url, key, {
              auth: { persistSession: false, autoRefreshToken: false },
            }),
          ),
        )
      : localStore();
  return instance;
}
// Tests swap in a store; undefined restores the configured one.
export function useFiles(store: FileStore | undefined) {
  instance = store;
}
