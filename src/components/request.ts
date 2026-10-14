import type { Post, StudioState } from "@/lib/schema";

// Every studio request reports failures the same way: the server's
// user-facing message, or a generic one when the response isn't JSON.
async function read(response: Response, fallback: string) {
  // A hosted session that expired goes back to the sign-in page.
  if (response.status === 401) window.location.assign("/login");
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

// The bytes go straight to storage (a signed URL when hosted), then the
// studio imports them into the library.
export async function uploadImage(
  file: File,
  fields: { collection: string; rights: string },
): Promise<{ duplicate: boolean }> {
  const target = await studioAction<{ id: string; url: string }>(
    "uploadUrl",
    {},
    "Upload failed.",
  );
  const sent = await fetch(target.url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  }).catch(() => null);
  if (!sent?.ok) {
    // Supabase Storage answers 400 and names the real status in the body.
    const detail = (await sent?.json().catch(() => null)) as {
      statusCode?: string;
    } | null;
    throw new Error(
      sent?.status === 413 || detail?.statusCode === "413"
        ? "Choose a JPEG, PNG, or WebP under 20 MB."
        : "The upload did not finish. Check your connection and try again.",
    );
  }
  return studioAction(
    "importUpload",
    { id: target.id, name: file.name, ...fields },
    "Upload failed.",
  );
}

// A link to the approved package for exactly the revision on screen: a
// storage link when hosted, or a local object URL the caller must revoke.
export async function exportPackage(
  post: Pick<Post, "id" | "revision">,
): Promise<{ url: string; local: boolean }> {
  const response = await fetch(
    `/api/export/${post.id}?revision=${post.revision}`,
  );
  if (!response.ok) await read(response, "The export could not be created.");
  if (response.headers.get("content-type")?.includes("application/json"))
    return { url: (await read(response, GENERIC)).url, local: false };
  return { url: URL.createObjectURL(await response.blob()), local: true };
}
