// Which database a test file runs against. By default each file gets a fresh
// embedded database. `npm run test:supabase` runs the same files, one at a
// time, against the Data API of the local Supabase stack (`supabase start`),
// emptied before each file: the studio then calls the slideo_* functions
// over HTTP with the stack's secret key, exactly as a hosted studio does.
import { execFileSync } from "node:child_process";

export const onSupabase = process.env.SLIDEO_TEST_SUPABASE === "1";
const realFetch = globalThis.fetch.bind(globalThis);

export type Stack = {
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SECRET_KEY: string;
  DB_URL: string;
  MAILPIT_URL: string;
};
let stack: Stack | undefined;
export function localStack(): Stack {
  return (stack ??= JSON.parse(
    execFileSync("supabase", ["status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  ));
}

// Direct SQL, for checking what was stored. On Supabase this is a test-only
// connection to the local stack's database; the studio itself never opens one.
type Sql = { unsafe(text: string, params?: unknown[]): Promise<unknown[]> };
let pg: (Sql & { end(): Promise<void> }) | undefined;
export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!onSupabase) {
    const { driver } = await import("../src/lib/db");
    return (await driver()).query<T>(text, params);
  }
  if (!pg) {
    const { default: postgres } = await import("postgres");
    pg = postgres(localStack().DB_URL, { max: 1, onnotice: () => {} });
  }
  return (await pg.unsafe(text, params as never[])) as T[];
}

// Call after importing the store, before using it.
export async function prepareTestDatabase() {
  if (!onSupabase) return;
  await sql(
    "TRUNCATE public.entities, public.revisions, public.approvals, public.audit, public.ai_attempts, public.accounts",
  );
  const { setBackend, supabaseBackend } = await import("../src/lib/db");
  const { createClient } = await import("@supabase/supabase-js");
  const { API_URL, SECRET_KEY } = localStack();
  setBackend(
    supabaseBackend(
      createClient(API_URL, SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        // Some tests stand in for OpenAI by replacing the global fetch.
        global: { fetch: realFetch },
      }),
    ),
  );
}
export async function closeTestDatabase() {
  await pg?.end();
  pg = undefined;
}
