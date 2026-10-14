import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { secretKey, supabaseConfig } from "./auth";
import { SetupError } from "./db";

// The server's own Supabase client, authenticated with the secret key: the
// only credential that may call Slideo's database functions and write its
// private buckets. It never holds a user's session, so one instance serves
// every request; each call names the account the server verified. Server
// code only: the key has no NEXT_PUBLIC_ prefix, so Next.js never puts it
// in browser bundles.
let client: SupabaseClient | undefined;
export function serviceClient(): SupabaseClient {
  if (client) return client;
  const url = supabaseConfig()?.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = secretKey();
  if (!url || !key)
    throw new SetupError(
      "Hosted mode needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  return (client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }));
}
