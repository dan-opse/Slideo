import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { driver } from "./db";
import { files } from "./files";

export type ImportReport = {
  // Records added to the account, by kind (brand, format, post, asset, …).
  added: Record<string, number>;
  // Records the account already has with different contents. They were left
  // as they are; the SQLite copy of each is not imported.
  kept: string[];
  images: number;
};

type Value = string | number | null;

// Copies a workspace from the original SQLite studio into one account. It
// only ever adds: records the account already has are never replaced, so
// running it again cannot undo work done since the first import. A post
// moves together with its revisions and approval, so a post the account
// already has keeps its own history.
export async function importSqlite(
  folder: string,
  account: string,
): Promise<ImportReport> {
  const old = new DatabaseSync(path.join(folder, "studio.sqlite"), {
    readOnly: true,
  });
  const rows = (sql: string) =>
    old.prepare(sql).all() as Record<string, Value>[];
  // Oldest first, so the studio lists new records in their original order.
  const entities = rows("SELECT kind,id,json FROM entities ORDER BY rowid ASC");
  const revisions = rows("SELECT post_id,revision,json,hash FROM revisions");
  const approvals = rows(
    "SELECT post_id,revision,hash,render_hashes,created_at FROM approvals",
  );
  const audit = rows("SELECT id,action,entity,at FROM audit");
  const attempts = rows("SELECT id,at,status,usage FROM ai_attempts");
  old.close();

  // Images first: if copying stops partway, no record yet points at a
  // missing file, and a retry copies them again. A file's bytes never
  // change for its id, so copying one twice is harmless.
  const assets = path.join(folder, "assets");
  const images = existsSync(assets)
    ? readdirSync(assets).filter((name) => name.endsWith(".jpg"))
    : [];
  for (const name of images)
    await files().write(
      `${account}/assets/${name}`,
      readFileSync(path.join(assets, name)),
      "image/jpeg",
    );

  const report: ImportReport = { added: {}, kept: [], images: images.length };
  const db = await driver();
  await db.transaction(async (tx) => {
    // The same per-account lock the studio's own writes take.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [account]);
    const newPosts = new Set<Value>();
    for (const r of entities) {
      const [existing] = await tx.query<{ json: string }>(
        "SELECT json FROM entities WHERE user_id=$1 AND kind=$2 AND id=$3",
        [account, r.kind, r.id],
      );
      if (existing) {
        if (existing.json !== r.json) report.kept.push(`${r.kind} ${r.id}`);
        continue;
      }
      await tx.query(
        "INSERT INTO entities(user_id,kind,id,json) VALUES($1,$2,$3,$4)",
        [account, r.kind, r.id, r.json],
      );
      report.added[String(r.kind)] = (report.added[String(r.kind)] ?? 0) + 1;
      if (r.kind === "post") newPosts.add(r.id);
    }
    for (const r of revisions.filter((r) => newPosts.has(r.post_id)))
      await tx.query(
        "INSERT INTO revisions VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [account, r.post_id, r.revision, r.json, r.hash],
      );
    for (const r of approvals.filter((r) => newPosts.has(r.post_id)))
      await tx.query(
        "INSERT INTO approvals VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [account, r.post_id, r.revision, r.hash, r.render_hashes, r.created_at],
      );
    for (const r of audit)
      await tx.query(
        "INSERT INTO audit VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [r.id, account, r.action, r.entity, r.at],
      );
    for (const r of attempts)
      await tx.query(
        "INSERT INTO ai_attempts VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [r.id, account, r.at, r.status, r.usage],
      );
  });
  return report;
}
