// Copies a workspace from the original SQLite studio into the configured
// database and file storage, under one account.
//
//   node --import tsx scripts/import-sqlite.ts <old data folder> [account id]
//
// Without Supabase settings the target is the local studio. To fill a hosted
// account, load the hosted settings (NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and the server-only
// SUPABASE_SECRET_KEY; no database password) and pass the account's
// Supabase user id, from Authentication → Users:
//
//   node --env-file=.env.production.local --import tsx \
//     scripts/import-sqlite.ts ./data 2f1c…-user-uuid
//
// Only someone holding the secret key can run it; a signed-in user cannot
// import into any account. The import only adds records. Anything the
// account already has is left as it is and listed, so running it again
// never undoes later work, and a run that stopped partway can be repeated.
import { closeDatabase } from "../src/lib/db";
import { hosted, LOCAL_USER } from "../src/lib/auth";
import { importSqlite } from "../src/lib/import-sqlite";

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

try {
  const report = await importSqlite(folder, account);
  const added = Object.entries(report.added)
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`)
    .join(", ");
  console.log(
    `Imported into account "${account}": ${added || "no new records"}; ${report.images} images copied.`,
  );
  if (report.kept.length)
    console.log(
      `Kept ${report.kept.length} records the account already has, which differ from the SQLite copy:\n  ${report.kept.join("\n  ")}`,
    );
} finally {
  await closeDatabase();
}
