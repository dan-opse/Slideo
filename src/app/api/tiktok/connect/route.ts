import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { tiktokConfig, tiktokSettingsProblem } from "@/lib/tiktok";
import { startConnect, stateCookie } from "@/lib/tiktok-accounts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Settings links here to connect a TikTok account (?reconnect=1 to choose
// again): the browser goes to TikTok's sign-in, which returns to the
// callback route with the state this sets.
export async function GET(req: NextRequest) {
  const who = await authorize(req);
  if (who instanceof NextResponse) return who;
  const config = tiktokConfig();
  if (!config) {
    const problem = tiktokSettingsProblem();
    if (problem) console.error(problem);
    return NextResponse.json(
      { error: "TikTok isn't set up on this studio yet." },
      { status: 503 },
    );
  }
  // TikTok returns people to APP_URL, so the state cookie and the session
  // must be on that host. Other hosts, such as previews, can't connect.
  const host = (req.headers.get("host") || "").toLowerCase();
  if (host !== new URL(config.appUrl).host)
    return new NextResponse(null, {
      status: 303,
      headers: { Location: "/?tiktok=wrong_host" },
    });
  const { url, cookie } = startConnect(
    config,
    who.id,
    req.nextUrl.searchParams.get("reconnect") === "1",
  );
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(stateCookie(cookie));
  return response;
}
