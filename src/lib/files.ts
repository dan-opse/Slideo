import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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

function supabaseStore(url: string, serviceKey: string): FileStore {
  const bucket = process.env.STORAGE_BUCKET || "studio";
  let ready: Promise<void> | undefined;
  const client = (async () => {
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  })();
  // The private bucket is created on first use; the size and type limits
  // also bound what a signed upload URL accepts.
  const storage = async () => {
    const supabase = await client;
    ready ??= (async () => {
      const { data } = await supabase.storage.getBucket(bucket);
      if (data) return;
      const { error } = await supabase.storage.createBucket(bucket, {
        public: false,
        fileSizeLimit: UPLOAD_BYTES,
        allowedMimeTypes: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "application/zip",
        ],
      });
      if (error && !/already exists/i.test(error.message)) throw error;
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return supabase.storage.from(bucket);
  };
  return {
    remote: true,
    async read(key) {
      const { data, error } = await (await storage()).download(checked(key));
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async write(key, data, contentType) {
      const { error } = await (
        await storage()
      ).upload(checked(key), data, {
        contentType,
        upsert: true,
      });
      if (error) throw error;
    },
    async remove(keys) {
      if (keys.length) await (await storage()).remove(keys.map(checked));
    },
    async uploadUrl(key) {
      const { data, error } = await (
        await storage()
      ).createSignedUploadUrl(checked(key));
      if (error || !data) throw error ?? new Error("No upload URL");
      return data.signedUrl;
    },
    async signedUrl(key, download) {
      const { data, error } = await (
        await storage()
      ).createSignedUrl(checked(key), 3600, download ? { download } : {});
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
  instance = url && key ? supabaseStore(url, key) : localStore();
  return instance;
}
