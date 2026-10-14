import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { files } from "./files";
import { asAccount, stage, transaction, type Change } from "./store";
import { backend } from "./db";

export type ImportReport = {
  // Records added to the account, by kind (brand, format, post, asset, …).
  added: Record<string, number>;
  // Records the account already has with different contents. They were left
  // as they are; the SQLite copy of each is not imported.
  kept: string[];
  images: number;
};

type Value = string | number | null;
type Record_ = Record<string, Value>;

// Each commit carries about this many changes, so a large workspace goes
// through the Data API in requests of a bounded size.
const BATCH = 200;

// Copies a workspace from the original SQLite studio into one account. It
// only ever adds: records the account already has are never replaced, so
// running it again cannot undo work done since the first import. A post
// moves together with its revisions and approval in one commit, so a post
// the account already has keeps its own history.
export async function importSqlite(
  folder: string,
  account: string,
): Promise<ImportReport> {
  const old = new DatabaseSync(path.join(folder, "studio.sqlite"), {
    readOnly: true,
  });
  const rows = (sql: string) => old.prepare(sql).all() as Record_[];
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

  // What each post brings along when it is new to the account.
  const history = new Map<Value, Change[]>();
  const attach = (post: Value, change: Change) =>
    history.set(post, [...(history.get(post) ?? []), change]);
  for (const r of revisions)
    attach(r.post_id, {
      op: "revision",
      post: String(r.post_id),
      revision: Number(r.revision),
      json: String(r.json),
      hash: String(r.hash),
    });
  for (const r of approvals)
    attach(r.post_id, {
      op: "approve",
      post: String(r.post_id),
      revision: Number(r.revision),
      hash: String(r.hash),
      render_hashes: String(r.render_hashes),
      at: String(r.created_at),
    });

  const report: ImportReport = { added: {}, kept: [], images: images.length };
  const db = await backend();
  await asAccount(account, async () => {
    // Batches of records in their original order, each closed before it
    // grows past BATCH changes; a post never splits from its history.
    const batches: Record_[][] = [[]];
    let size = 0;
    for (const r of entities) {
      const cost = 1 + (r.kind === "post" ? (history.get(r.id)?.length ?? 0) : 0);
      if (size && size + cost > BATCH) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1)!.push(r);
      size += cost;
    }
    for (const batch of batches) {
      if (!batch.length) continue;
      // Retried from fresh reads if the account changes meanwhile.
      const outcome = await transaction(async () => {
        const found = new Map(
          (
            await db.call<{ kind: string; id: string; json: unknown }[]>(
              "slideo_find",
              {
                p_user: account,
                p_keys: batch.map((r) => [r.kind, r.id]),
              },
            )
          ).map((e) => [`${e.kind}/${e.id}`, e.json]),
        );
        const added: string[] = [],
          kept: string[] = [];
        for (const r of batch) {
          const key = `${r.kind}/${r.id}`;
          if (found.has(key)) {
            if (!sameJson(found.get(key), String(r.json)))
              kept.push(`${r.kind} ${r.id}`);
            continue;
          }
          await stage({
            op: "put",
            kind: String(r.kind),
            id: String(r.id),
            json: String(r.json),
          });
          if (r.kind === "post")
            for (const change of history.get(r.id) ?? []) await stage(change);
          added.push(String(r.kind));
        }
        return { added, kept };
      });
      for (const kind of outcome.added)
        report.added[kind] = (report.added[kind] ?? 0) + 1;
      report.kept.push(...outcome.kept);
    }
    // The audit trail and AI attempts keep their ids, so a repeat adds none.
    const trail: Change[] = [
      ...audit.map(
        (r): Change => ({
          op: "audit",
          id: String(r.id),
          action: String(r.action),
          entity: String(r.entity),
          at: String(r.at),
        }),
      ),
      ...attempts.map(
        (r): Change => ({
          op: "ai",
          id: String(r.id),
          at: String(r.at),
          status: String(r.status),
          usage: r.usage === null ? null : String(r.usage),
        }),
      ),
    ];
    for (let i = 0; i < trail.length; i += BATCH)
      await transaction(async () => {
        for (const change of trail.slice(i, i + BATCH)) await stage(change);
      });
  });
  return report;
}

// Records compare by content: the database may store the same JSON with
// different spacing.
function sameJson(stored: unknown, text: string) {
  return JSON.stringify(stored) === JSON.stringify(JSON.parse(text));
}
