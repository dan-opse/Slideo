import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseConfig } from "./auth";

// A Supabase client for route handlers that sign in or out: it writes the
// session cookies onto the response.
export async function sessionClient() {
  const config = supabaseConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) =>
        list.forEach(({ name, value, options }) =>
          store.set(name, value, options),
        ),
    },
  });
}
