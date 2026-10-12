import type { Post, StudioState } from "@/lib/schema";

// Every studio request reports failures the same way: the server's
// user-facing message, or a generic one when the response isn't JSON.
async function read(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

const GENERIC = "The studio did not respond correctly. Try again.";

// The studio's JSON actions (save, approve, publish, …).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function studioAction<T = any>(
  action: string,
  data: Record<string, unknown> = {},
  fallback = GENERIC,
): Promise<T> {
  return read(
    await fetch("/api/studio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    }),
    fallback,
  );
}

export async function loadStudio(): Promise<StudioState> {
  return read(await fetch("/api/studio"), GENERIC);
}

export async function uploadImage(
  form: FormData,
): Promise<{ duplicate: boolean }> {
  return read(
    await fetch("/api/studio", { method: "POST", body: form }),
    "Upload failed.",
  );
}

// The approved package for exactly the revision on screen.
export async function exportPackage(post: Pick<Post, "id" | "revision">) {
  const response = await fetch(
    `/api/export/${post.id}?revision=${post.revision}`,
  );
  if (!response.ok) await read(response, "The export could not be created.");
  return response.blob();
}
