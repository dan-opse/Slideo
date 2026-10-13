import { mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;
// One connection's worth of SQL: `query` takes a single statement with $n
// parameters; `exec` runs a parameterless script of several statements.
export type Runner = {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
};
export type Driver = Runner & {
  transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.env.STUDIO_DATA_DIR || "./data",
);

// Hosted deployments connect to Postgres (Supabase's transaction pooler on
// Vercel). Without DATABASE_URL the studio runs an embedded Postgres in the
// data folder, so local use and tests need no database server.
async function postgresDriver(url: string): Promise<Driver> {
  const { default: postgres } = await import("postgres");
  // The transaction pooler cannot keep prepared statements between calls.
  const sql = postgres(url, {
    prepare: false,
    max: Number(process.env.DATABASE_POOL_SIZE || 3),
    idle_timeout: 20,
    onnotice: () => {},
  });
  type Sql = typeof sql;
  const runner = (s: Sql): Runner => ({
    query: (text, params = []) =>
      s.unsafe(text, params as never[]) as unknown as Promise<never[]>,
    exec: async (text) => {
      await s.unsafe(text);
    },
  });
  return {
    ...runner(sql),
    transaction: (fn) =>
      sql.begin((tx) => fn(runner(tx as unknown as Sql))) as Promise<never>,
    close: () => sql.end(),
  };
}

async function embeddedDriver(): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const folder = path.join(dataDir, "pglite");
  mkdirSync(folder, { recursive: true });
  const db = await PGlite.create(folder);
  type Q = Pick<typeof db, "query" | "exec">;
  const runner = (q: Q): Runner => ({
    query: async (text, params = []) =>
      (await q.query(text, params)).rows as never[],
    exec: async (text) => {
      await q.exec(text);
    },
  });
  return {
    ...runner(db),
    transaction: (fn) => db.transaction((tx) => fn(runner(tx))),
    close: () => db.close(),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities(user_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,seq BIGSERIAL,PRIMARY KEY(user_id,kind,id));
CREATE TABLE IF NOT EXISTS revisions(user_id TEXT NOT NULL,post_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(user_id,post_id,revision));
CREATE TABLE IF NOT EXISTS approvals(user_id TEXT NOT NULL,post_id TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,render_hashes TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,post_id));
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,usage TEXT);
CREATE INDEX IF NOT EXISTS ai_attempts_user_at ON ai_attempts(user_id,at);
CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id);
-- The server connects as the database owner and scopes every query to the
-- signed-in user. With RLS on and no policies, Supabase's public REST API
-- (anon and authenticated keys) can read none of these tables.
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_attempts ENABLE ROW LEVEL SECURITY;
`;

// The schema script runs in one transaction, so tables with RLS on mean
// every statement in it has applied.
const TABLES = ["entities", "revisions", "approvals", "audit", "ai_attempts"];
async function schemaReady(db: Runner) {
  const [row] = await db.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=current_schema() AND c.relname=ANY($1) AND c.relrowsecurity",
    [TABLES],
  );
  return row.n === TABLES.length;
}

let instance: Promise<Driver> | undefined;
// Opened on first use rather than at import, so `next build` (which imports
// route modules to collect page data) never connects or creates a database.
export function driver() {
  return (instance ??= (async () => {
    const url = process.env.DATABASE_URL;
    const db = url ? await postgresDriver(url) : await embeddedDriver();
    // Concurrent cold starts take turns creating the schema. A later one must
    // not run the script again: its ALTER TABLE locks would deadlock with
    // requests already writing rows.
    if (!(await schemaReady(db)))
      await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(7243001)");
        if (!(await schemaReady(tx))) await tx.exec(SCHEMA);
      });
    return db;
  })().catch((error) => {
    instance = undefined;
    throw error;
  }));
}
export async function closeDatabase() {
  const current = instance;
  instance = undefined;
  if (current) await (await current).close();
}
