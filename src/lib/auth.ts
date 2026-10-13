import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Without Supabase settings the studio is a single-user app on this computer.
export const LOCAL_USER = "local";
export type Account = { id: string; email: string | null };

export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}
export const hosted = () => !!supabaseConfig();

const missingHostedSettings = () =>
  ["DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !process.env[name],
  );

const deny = (error: string, status: number) =>
  NextResponse.json({ error }, { status });

// Mutating requests from another site must never ride on the user's cookies.
function crossSite(request: NextRequest) {
  const host = request.headers.get("host") || "";
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`)
    return deny("Cross-origin requests are not allowed.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return deny("Cross-site requests are not allowed.", 403);
  return null;
}

// The signed-in account, verified from the session cookie, or null.
export async function sessionAccount(
  cookies: { name: string; value: string }[],
): Promise<Account | null> {
  const config = supabaseConfig();
  if (!config) return null;
  const supabase = createServerClient(config.url, config.key, {
    cookies: { getAll: () => cookies, setAll: () => {} },
  });
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
  };
}

// Every API route starts here: it returns the account the request acts for,
// or the response that refuses it.
export async function authorize(
  request: NextRequest,
): Promise<Account | NextResponse> {
  if (!hosted()) {
    const host = request.headers.get("host") || "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))
      return deny(
        "This studio is available on this computer only. Configure Supabase to host it.",
        403,
      );
    return crossSite(request) ?? { id: LOCAL_USER, email: null };
  }
  const missing = missingHostedSettings();
  if (missing.length) {
    console.error(`Hosted mode needs ${missing.join(" and ")}.`);
    return deny("The studio is not fully configured yet.", 503);
  }
  const refused = crossSite(request);
  if (refused) return refused;
  const account = await sessionAccount(request.cookies.getAll());
  return account ?? deny("Sign in to continue.", 401);
}
