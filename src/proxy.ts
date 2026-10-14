import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseConfig } from "@/lib/auth";

// Hosted studios keep the Supabase session fresh on every request and send
// signed-out visitors to the sign-in page. Local studios pass straight through.
export async function proxy(request: NextRequest) {
  const config = supabaseConfig();
  if (!config) return NextResponse.next();
  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookies, headers) {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookies.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        Object.entries(headers ?? {}).forEach(([key, value]) =>
          response.headers.set(key, value),
        );
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const signedIn = !!data?.claims?.sub;
  const path = request.nextUrl.pathname;
  // API routes answer 401 themselves; the sign-in flow must stay reachable.
  const open =
    path.startsWith("/api/") || path.startsWith("/auth/") || path === "/login";
  if (!signedIn && !open)
    return NextResponse.redirect(new URL("/login", request.url));
  if (signedIn && path === "/login")
    return NextResponse.redirect(new URL("/", request.url));
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|fonts/|icon.svg|.*\\.(?:svg|png|jpg|jpeg|webp|ttf|txt)$).*)",
  ],
};
