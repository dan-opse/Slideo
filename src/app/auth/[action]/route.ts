import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { sessionClient } from "@/lib/supabase-server";

// Form posts from the sign-in page and the sidebar, plus the link in the
// sign-up email. Each answers with a redirect. Relative locations keep the
// browser on the host it used, where the session cookies were just set.
const back = (path: string, params = {}) => {
  const query = new URLSearchParams(params).toString();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: query ? `${path}?${query}` : path },
  });
};
// The address people reached the studio at, for links in emails.
const siteOrigin = (request: NextRequest) => {
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ||
    request.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : request.nextUrl.origin;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  // A form on another site must not sign anyone in or out.
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return new NextResponse("Cross-site requests are not allowed.", {
      status: 403,
    });
  const supabase = await sessionClient();
  if (!supabase) return back("/");
  if (action === "signout") {
    await supabase.auth.signOut();
    return back("/login");
  }
  const form = await request.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim(),
    password = String(form?.get("password") ?? "");
  if (!email || !password)
    return back("/login", { error: "Enter your email and password." });
  if (action === "signin") {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error)
      return back("/login", {
        error: "That email and password don't match an account.",
      });
    return back("/");
  }
  if (action === "signup") {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${siteOrigin(request)}/auth/confirm` },
    });
    if (error) return back("/login", { error: error.message });
    // With email confirmation off, Supabase signs the new account in at once.
    if (data.session) return back("/");
    return back("/login", {
      message: "Check your email for a link to finish creating your account.",
    });
  }
  return new NextResponse("Not found", { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  if (action !== "confirm")
    return new NextResponse("Not found", { status: 404 });
  const supabase = await sessionClient();
  if (!supabase) return back("/");
  const query = request.nextUrl.searchParams;
  const code = query.get("code"),
    tokenHash = query.get("token_hash"),
    type = query.get("type") as EmailOtpType | null;
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("Missing code") };
  if (error)
    return back("/login", {
      error:
        "That link has expired or was already used. Sign in, or create your account again.",
    });
  return back("/");
}
