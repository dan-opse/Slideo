import { randomUUID } from "node:crypto";

// Provider keys and credentials can appear in SDK error messages.
export function redact(text: string) {
  let clean = text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    // TikTok access, refresh and client tokens, and signed media links.
    .replace(/\b(act|rft|clt)\.[A-Za-z0-9_.!*~-]{8,}/g, "[redacted]")
    .replace(/(\/api\/tiktok\/media\/)[^/\s"']+/g, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s"',]+/gi, "$1 [redacted]")
    .replace(
      /\b(api[-_]?key|authorization|password|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1$2[redacted]",
    );
  for (const value of [
    process.env.OPENAI_API_KEY,
    process.env.TIKTOK_CLIENT_SECRET,
    process.env.TIKTOK_ENCRYPTION_KEY,
    process.env.CRON_SECRET,
  ])
    if (value && value.length >= 8)
      clean = clean.split(value).join("[redacted]");
  return clean;
}

function describe(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: redact(String(error)) };
  const { code, errno, syscall } = error as NodeJS.ErrnoException;
  return {
    name: error.name,
    message: redact(error.message),
    ...(code !== undefined && { code }),
    ...(errno !== undefined && { errno }),
    ...(syscall && { syscall }),
    ...(error.stack && { stack: redact(error.stack) }),
    ...(error.cause !== undefined &&
      depth < 3 && { cause: describe(error.cause, depth + 1) }),
  };
}

// Logs an unexpected failure with enough detail to diagnose it from the
// server console. HTTP responses stay generic; this never reaches a client.
export function logUnexpected(
  operation: string,
  error: unknown,
  context: Record<string, string | number | undefined> = {},
) {
  const reference = randomUUID().slice(0, 8);
  console.error(
    `${operation} failed [${reference}]`,
    JSON.stringify({ operation, ...context, error: describe(error) }),
  );
  return reference;
}
