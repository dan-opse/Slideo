import { cookies } from "next/headers";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { supabaseConfig } from "./auth";

type CookieList = Parameters<NonNullable<CookieMethodsServer["setAll"]>>[0];

// A Supabase client for route handlers that sign in or out: it writes the
// session cookies onto the response. With `held`, writes wait for `keep()`,
// for requests whose cookies depend on Supabase's answer (see the email link
// requests in the auth route).
export async function sessionClient({ held = false } = {}) {
  const config = supabaseConfig();
  if (!config) return null;
  const store = await cookies();
  const pending: CookieList = [];
  const write = (list: CookieList) =>
    list.forEach(({ name, value, options }) => store.set(name, value, options));
  const client = createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        if (held) pending.push(...list);
        else write(list);
      },
    },
  });
  // `firstOnly` keeps each cookie as the request first stored it, dropping
  // the SDK's later clean-up of the same cookie.
  const keep = ({ firstOnly = false } = {}) => {
    const list = pending.splice(0);
    write(
      firstOnly
        ? list.filter((c, i) => list.findIndex((d) => d.name === c.name) === i)
        : list,
    );
  };
  return Object.assign(client, { keep });
}
