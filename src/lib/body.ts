import type { NextRequest } from "next/server";
import { StudioError } from "./store";

// Counts the bytes actually received, so a chunked request without a
// Content-Length header cannot exceed the limit either.
export async function readLimited(
  req: NextRequest,
  limit: number,
  message: string,
) {
  if (Number(req.headers.get("content-length") || 0) > limit)
    throw new StudioError(message, 413);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new StudioError(message, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
