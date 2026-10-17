import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { sessionClient } from "@/lib/supabase-server";
import {
  type AuthFailure,
  LINK_SENT,
  emailLinkFailure,
  emailLinkMessage,
  newPasswordMessage,
  passwordProblem,
  signInMessage,
  signUpMessage,
} from "@/lib/auth-messages";

// Form posts from the sign-in pages and the sidebar, plus the links in the
// sign-up and password reset emails. Each answers with a redirect. Relative
// locations keep the browser on the host it used, where the session cookies
// were just set.
const back = (path: string, params = {}) => {
  const query = new URLSearchParams(params).toString();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: query ? `${path}?${query}` : path },
  });
};
// The address people reached the studio at, for links in emails. Supabase
// only sends people back to addresses in its redirect allow list.
const confirmUrl = (request: NextRequest) => {
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ||
    request.nextUrl.protocol.replace(":", "");
  return `${host ? `${proto}://${host}` : request.nextUrl.origin}/auth/confirm`;
};
// Every refusal goes to the server log with Supabase's reason, including the
// ones the page words vaguely so it doesn't reveal which emails have accounts.
const refused = (action: string, error: AuthFailure, shown: string | null) =>
  console.warn(
    `Supabase Auth refused ${action}:`,
    JSON.stringify({
      code: error.code,
      status: error.status,
      name: error.name,
      ...((!shown || shown === LINK_SENT) && { message: error.message }),
    }),
  );
const SERVICE_PROBLEM = "Something went wrong. Try again in a few minutes.";

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
  const supabase = sessionClient(request, {
    held: action === "forgot" || action === "resend",
  });
  if (!supabase) return back("/");
  return supabase.send(await act(action, request, supabase));
}

type Session = NonNullable<ReturnType<typeof sessionClient>>;

async function act(action: string, request: NextRequest, supabase: Session) {
  if (action === "signout") {
    await supabase.auth.signOut();
    return back("/login");
  }
  const form = await request.formData().catch(() => null);
  const field = (name: string) => String(form?.get(name) ?? "");
  const email = field("email").trim(),
    password = field("password");

  // Emails a link without saying whether the address has an account.
  if (action === "forgot" || action === "resend") {
    const page = action === "forgot" ? "/login/forgot" : "/login";
    if (!email) return back(page, { error: "Enter your email address." });
    const { error } =
      action === "forgot"
        ? await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: confirmUrl(request),
          })
        : await supabase.auth.resend({
            type: "signup",
            email,
            options: { emailRedirectTo: confirmUrl(request) },
          });
    const shown = error ? emailLinkMessage(error) : LINK_SENT;
    if (error) refused(action, error, shown);
    if (shown !== LINK_SENT) return back(page, { error: shown });
    // Each request stores half of its link's proof (a PKCE verifier) in a
    // cookie, and Supabase matches a link to the address's newest request,
    // even one it refused for sending too soon. Whenever the answer is the
    // neutral one, the response carries the cookies as the request stored
    // them, whatever Supabase said, so they can't tell a sent email from a
    // refused one either. (Refusals with their own message happen before
    // Supabase looks up the address, and keep the browser's previous proof.)
    supabase.keep({ firstOnly: true });
    return back(page, { message: LINK_SENT });
  }

  // The new password, set from the session a reset link signed in.
  if (action === "reset") {
    const { data } = await supabase.auth.getClaims();
    if (!data?.claims?.sub)
      return back("/login/forgot", {
        error: "Your reset link has expired. Ask for a new one.",
      });
    const problem = passwordProblem(password, field("confirm"));
    if (problem) return back("/login/reset", { error: problem });
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      const shown = newPasswordMessage(error);
      refused(action, error, shown);
      return back("/login/reset", { error: shown ?? SERVICE_PROBLEM });
    }
    // Other devices (anyone who had the old password) lose their sessions
    // too, once their current access token expires.
    await supabase.auth.signOut({ scope: "global" });
    return back("/login", {
      message: "Your password was changed. Sign in with your new password.",
    });
  }

  if (!email || !password)
    return back("/login", { error: "Enter your email and password." });
  if (action === "signin") {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      const shown = signInMessage(error);
      refused(action, error, shown);
      return back("/login", {
        error: shown ?? SERVICE_PROBLEM,
        ...(error.code === "email_not_confirmed" && { resend: "1" }),
      });
    }
    return back("/");
  }
  if (action === "signup") {
    const problem = passwordProblem(password);
    if (problem) return back("/login", { error: problem });
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: confirmUrl(request) },
    });
    if (error) {
      const shown = signUpMessage(error);
      refused(action, error, shown);
      return back("/login", { error: shown ?? SERVICE_PROBLEM });
    }
    // With email confirmation off, Supabase signs the new account in at once.
    if (data.session) return back("/");
    return back("/login", {
      message: "Check your email for a link to finish creating your account.",
    });
  }
  return new NextResponse("Not found", { status: 404 });
}

// Where the links in Supabase's emails land: sign-up confirmations sign the
// new account in; password reset links sign in and ask for a new password.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  if (action !== "confirm")
    return new NextResponse("Not found", { status: 404 });
  const supabase = sessionClient(request);
  if (!supabase) return back("/");
  const query = request.nextUrl.searchParams;
  const code = query.get("code"),
    tokenHash = query.get("token_hash"),
    type = query.get("type") as EmailOtpType | null;
  // Links Supabase couldn't verify arrive with its reason instead of a code.
  // (Some arrive with nothing at all: the reason is in the URL fragment,
  // which browsers never send.)
  const linkError: AuthFailure = {
    code: query.get("error_code") ?? "missing_code",
    status: 400,
  };
  let recovery = type === "recovery",
    error: AuthFailure | null = linkError;
  if (code) {
    const exchanged = await supabase.auth.exchangeCodeForSession(code);
    error = exchanged.error;
    // The browser that asked for a reset link remembers that it did. (The
    // SDK returns this but leaves it out of its types.)
    const { redirectType } = exchanged.data as { redirectType?: string | null };
    recovery ||= redirectType === "recovery";
  } else if (tokenHash && type)
    ({ error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    }));
  if (error) {
    const shown = emailLinkFailure(error);
    refused("an email link", error, shown);
    return supabase.send(
      back(recovery ? "/login/forgot" : "/login", { error: shown }),
    );
  }
  return supabase.send(back(recovery ? "/login/reset" : "/"));
}
