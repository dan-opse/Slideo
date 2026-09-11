import { NextRequest, NextResponse } from "next/server";
// This release is intentionally loopback-only. No remote deployment without authentication.
export function guard(request: NextRequest) {
  const host = request.headers.get("host") || "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))
    return NextResponse.json(
      { error: "This studio is available on this computer only." },
      { status: 403 },
    );
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`)
    return NextResponse.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site")
    return NextResponse.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403 },
    );
  return null;
}
