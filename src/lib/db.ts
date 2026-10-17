import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hosted } from "./auth";

export type Row = Record<string, unknown>;
// One connection's worth of SQL on the embedded database.
export type Runner = {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
};

// The studio reads and writes only through the slideo_* database functions
// in supabase/migrations: over HTTPS (Supabase's Data API) when hosted, and
// in-process on the embedded database otherwise. Both run the same SQL.
const ARGS = {
  slideo_schema_version: {},
  slideo_version: { p_user: "text" },
  slideo_list: { p_user: "text", p_kind: "text" },
  slideo_get: { p_user: "text", p_kind: "text", p_id: "text" },
  slideo_find: { p_user: "text", p_keys: "jsonb" },
  slideo_revision: { p_user: "text", p_post: "text", p_revision: "integer" },
  slideo_approval: { p_user: "text", p_post: "text" },
  slideo_asset_in_use: { p_user: "text", p_asset: "text" },
  slideo_ai_usage: { p_user: "text", p_since: "text" },
  slideo_state: { p_user: "text", p_since: "text" },
  slideo_commit: { p_user: "text", p_expected: "bigint", p_changes: "jsonb" },
  // The TikTok worker's only query across accounts.
  slideo_due_deliveries: { p_now: "text", p_limit: "integer" },
} as const;
export type DbFunction = keyof typeof ARGS;
export type Backend = {
  call<T>(fn: DbFunction, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
};

// The slideo_schema_version() the migrations in this release install.
export const SCHEMA_VERSION = 2;

// An error the database raised, with its SQLSTATE. The slideo functions use
// SL400, SL403, SL409 and SL413 for changes they refuse.
export class DatabaseError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
// The hosted database is missing, unreachable, or lacks the setup SQL.
export class SetupError extends Error {}

export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.env.STUDIO_DATA_DIR || "./data",
);
const migrations = path.resolve(
  /* turbopackIgnore: true */ "supabase/migrations",
);
function migrationSql() {
  return readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(path.join(migrations, name), "utf8"))
    .join("\n");
}

type PG = import("@electric-sql/pglite").PGlite;
let local: Promise<PG> | undefined;
// The local studio's embedded Postgres in the data folder. Opened on first
// use rather than at import, so `next build` never creates a database. A
// database without this release's functions gets the migrations, which only
// add what is missing.
function embedded() {
  return (local ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const folder = path.join(dataDir, "pglite");
    mkdirSync(folder, { recursive: true });
    const db = await PGlite.create(folder);
    const [found] = (
      await db.query<{ ok: boolean }>(
        "SELECT to_regproc('public.slideo_schema_version') IS NOT NULL AS ok",
      )
    ).rows;
    const version = found.ok
      ? (
          await db.query<{ v: number }>(
            "SELECT public.slideo_schema_version() AS v",
          )
        ).rows[0].v
      : null;
    if (version !== SCHEMA_VERSION)
      await db.transaction((tx) => tx.exec(migrationSql()));
    return db;
  })().catch((error) => {
    local = undefined;
    throw error;
  }));
}
// Direct SQL on the embedded database, for tests and diagnostics.
export async function driver(): Promise<Runner> {
  const db = await embedded();
  return {
    query: async (text, params = []) =>
      (await db.query(text, params)).rows as never[],
    exec: async (text) => {
      await db.exec(text);
    },
  };
}

function embeddedBackend(): Backend {
  return {
    async call<T>(fn: DbFunction, args: Record<string, unknown>) {
      const types: Record<string, string> = ARGS[fn];
      const names = Object.keys(args);
      for (const name of names)
        if (!types[name]) throw new Error(`${fn} has no argument ${name}`);
      // Every value travels as text and is cast to the argument's type.
      const list = names.map((n, i) => `${n} => $${i + 1}::text::${types[n]}`);
      const params = names.map((n) => {
        const value = args[n];
        if (value === null || value === undefined) return null;
        return types[n] === "jsonb" ? JSON.stringify(value) : String(value);
      });
      const db = await embedded();
      try {
        const { rows } = await db.query<{ result: T }>(
          `SELECT public.${fn}(${list.join(",")}) AS result`,
          params,
        );
        return rows[0].result;
      } catch (error) {
        const e = error as { message?: string; code?: string };
        throw new DatabaseError(e.message ?? String(error), e.code);
      }
    },
    close: closeEmbedded,
  };
}
async function closeEmbedded() {
  const current = local;
  local = undefined;
  if (current) await (await current.catch(() => null))?.close();
}

// The hosted backend: the Data API, called with the server's secret key.
export function supabaseBackend(client: SupabaseClient): Backend {
  return {
    async call<T>(fn: DbFunction, args: Record<string, unknown>) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new DatabaseError(error.message, error.code);
      return data as T;
    },
    close: async () => {},
  };
}
// Hosted studios never create tables at runtime: the publishable and secret
// API keys cannot run DDL, and setup is a deliberate one-time step. A
// project without the setup SQL, or with an older version of it, is
// reported instead of used.
export async function checkSchema(db: Backend) {
  let version: unknown;
  try {
    version = await db.call("slideo_schema_version", {});
  } catch (error) {
    throw new SetupError(
      `Slideo's database functions are not reachable (${error instanceof Error ? error.message : String(error)}). Enable the Data API and run the files in supabase/migrations in the Supabase SQL Editor.`,
    );
  }
  if (Number(version) !== SCHEMA_VERSION)
    throw new SetupError(
      `The Supabase project has Slideo schema version ${String(version)}; this release needs ${SCHEMA_VERSION}. Run the files in supabase/migrations in the Supabase SQL Editor.`,
    );
}

let instance: Promise<Backend> | undefined;
let override: Backend | undefined;
export function backend(): Promise<Backend> {
  if (override) return Promise.resolve(override);
  return (instance ??= (async () => {
    if (!hosted()) return embeddedBackend();
    const { serviceClient } = await import("./supabase-admin");
    const db = supabaseBackend(serviceClient());
    await checkSchema(db);
    return db;
  })().catch((error) => {
    instance = undefined;
    throw error;
  }));
}
// Tests swap in a backend; undefined restores the configured one.
export function setBackend(db: Backend | undefined) {
  override = db;
}
export async function closeDatabase() {
  instance = undefined;
  await closeEmbedded();
}
