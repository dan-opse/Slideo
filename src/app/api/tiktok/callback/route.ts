import { NextRequest, NextResponse } from "next/server";
import { hostedSettingsProblem, sessionAccount } from "@/lib/auth";
import { withAccount } from "@/lib/store";
import { tiktokConfig, tiktokSettingsProblem } from "@/lib/tiktok";
import {
  finishConnect,
  STATE_COOKIE,
  stateCookie,
} from "@/lib/tiktok-accounts";
import { logUnexpected } from "@/lib/log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TikTok's sign-in returns here. Its redirect is a cross-site navigation,
// which authorize() refuses, so this route checks the session itself; the
// signed state cookie is what proves the request continues a sign-in this
// user started. Every outcome clears that cookie and goes back to the
// studio, which shows it as a notice.
export async function GET(req: NextRequest) {
  const done = (location: string) => {
    const response = new NextResponse(null, {
      status: 303,
      headers: { Location: location },
    });
    response.cookies.set(stateCookie("", 0));
    return response;
  };
  const config = tiktokConfig();
  const problem = config ? hostedSettingsProblem() : tiktokSettingsProblem();
  if (!config || problem) {
    if (problem) console.error(problem);
    return done("/?tiktok=unavailable");
  }
  const who = await sessionAccount(req.cookies.getAll());
  if (!who)
    return done(
      `/login?${new URLSearchParams({ error: "Sign in, then connect TikTok again from Settings." })}`,
    );
  try {
    const result = await withAccount(who, () =>
      finishConnect(
        config,
        req.nextUrl.searchParams,
        req.cookies.get(STATE_COOKIE)?.value,
      ),
    );
    return done(`/?tiktok=${result}`);
  } catch (error) {
    logUnexpected("TikTok connect", error);
    return done("/?tiktok=failed");
  }
}
