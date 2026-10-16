import type { NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { supabaseConfig } from "./auth";

type CookieList = Parameters<NonNullable<CookieMethodsServer["setAll"]>>[0];

// A Supabase client for route handlers that sign in or out. It reads the
// request's cookies, sees its own writes at once, and `send()` puts the
// writes on the response.
//
// With `held`, writes wait for `keep()`, for requests whose cookies must not
// depend on Supabase's answer (see the email link requests in the auth
// route). `keep({ firstOnly: true })` keeps each cookie as the request first
// stored it, dropping the SDK's later clean-up of the same cookie, so a
// refused request leaves the same cookies as an accepted one.
export function sessionClient(request: NextRequest, { held = false } = {}) {
  const config = supabaseConfig();
  if (!config) return null;
  const jar = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
  const pending: CookieList = [],
    out: CookieList = [];
  const client = createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list)
          if (value) jar.set(name, value);
          else jar.delete(name);
        (held ? pending : out).push(...list);
      },
    },
  });
  const keep = ({ firstOnly = false } = {}) => {
    const list = pending.splice(0);
    out.push(
      ...(firstOnly
        ? list.filter((c, i) => list.findIndex((d) => d.name === c.name) === i)
        : list),
    );
  };
  const send = (response: NextResponse) => {
    for (const { name, value, options } of out)
      response.cookies.set(name, value, options);
    return response;
  };
  return Object.assign(client, { keep, send });
}
