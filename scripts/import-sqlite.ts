// Copies a workspace from the original SQLite studio into the configured
// database and file storage, under one account. Safe to run again.
//
//   node --import tsx scripts/import-sqlite.ts <old data folder> [account id]
//
// Without Supabase settings the target is the local studio. To fill a hosted
// account, load the hosted settings and pass the account's Supabase user id:
//
//   node --env-file=.env.production.local --import tsx \
//     scripts/import-sqlite.ts ./data 2f1c…-user-uuid
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { closeDatabase, driver } from "../src/lib/db";
import { files } from "../src/lib/files";
import { hosted, LOCAL_USER } from "../src/lib/auth";

const [folder, accountArg] = process.argv.slice(2);
if (!folder) {
  console.error(
    "Usage: scripts/import-sqlite.ts <old data folder> [account id]",
  );
  process.exit(1);
}
const account = accountArg || (hosted() ? "" : LOCAL_USER);
if (!/^[A-Za-z0-9_-]+$/.test(account)) {
  console.error("Pass the Supabase user id of the account to import into.");
  process.exit(1);
}

const old = new DatabaseSync(path.join(folder, "studio.sqlite"), {
  readOnly: true,
});
const rows = (sql: string) =>
  old.prepare(sql).all() as Record<string, string | number | null>[];
const db = await driver();
// Oldest first, so the studio lists records in their original order.
const entities = rows("SELECT kind,id,json FROM entities ORDER BY rowid ASC");
const revisions = rows("SELECT post_id,revision,json,hash FROM revisions");
const approvals = rows(
  "SELECT post_id,revision,hash,render_hashes,created_at FROM approvals",
);
const audit = rows("SELECT id,action,entity,at FROM audit");
const attempts = rows("SELECT id,at,status,usage FROM ai_attempts");

await db.transaction(async (tx) => {
  for (const r of entities)
    await tx.query(
      "INSERT INTO entities(user_id,kind,id,json) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,kind,id) DO UPDATE SET json=excluded.json",
      [account, r.kind, r.id, r.json],
    );
  for (const r of revisions)
    await tx.query(
      "INSERT INTO revisions VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [account, r.post_id, r.revision, r.json, r.hash],
    );
  for (const r of approvals)
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
old.close();

// Renders are rebuilt on demand; only the uploaded images need copying.
const assets = path.join(folder, "assets");
const images = existsSync(assets)
  ? readdirSync(assets).filter((name) => name.endsWith(".jpg"))
  : [];
let copied = 0;
for (const name of images) {
  await files().write(
    `${account}/assets/${name}`,
    readFileSync(path.join(assets, name)),
    "image/jpeg",
  );
  copied++;
}
await closeDatabase();
console.log(
  `Imported ${entities.length} records, ${revisions.length} revisions and ${copied} images into account "${account}".`,
);
