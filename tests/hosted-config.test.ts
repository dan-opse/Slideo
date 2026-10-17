// Hosted settings: three Supabase values and nothing about a database
// connection. Partial settings, an unreachable project, or a project
// without the setup SQL are refused with an operator-facing reason, never
// served from a local database or folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const folder = mkdtempSync(path.join(tmpdir(), "slideo-hosted-config-"));
process.env.STUDIO_DATA_DIR = folder;
// Nothing listens on port 9: the project is unreachable.
const settings = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};
for (const name of ["DATABASE_URL", "DATABASE_CA_CERT", "DATABASE_POOL_SIZE"])
  delete process.env[name];
const auth = await import("../src/lib/auth");
const db = await import("../src/lib/db");
const store = await import("../src/lib/store");
const { files } = await import("../src/lib/files");
const { NextRequest } = await import("next/server");
after(() => rmSync(folder, { recursive: true, force: true }));

function withSettings(values: Partial<typeof settings>) {
  for (const name of Object.keys(settings)) delete process.env[name];
  Object.assign(process.env, values);
}
const request = () =>
  new NextRequest("https://slideo.example/api/studio", {
    headers: { host: "slideo.example", origin: "https://slideo.example" },
  });

test("any Supabase setting makes the studio hosted; missing ones are named", async () => {
  for (const [name, value] of Object.entries(settings)) {
    withSettings({ [name]: value });
    assert.equal(auth.hosted(), true, name);
    const problem = auth.hostedSettingsProblem()!;
    for (const other of Object.keys(settings))
      if (other !== name) assert.match(problem, new RegExp(other));
    const refused = await auth.authorize(request());
    assert.ok(refused instanceof Response);
    assert.equal(refused.status, 503);
  }
  withSettings({});
  assert.equal(auth.hosted(), false);
  // The legacy key names still count.
  withSettings({
    NEXT_PUBLIC_SUPABASE_URL: settings.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
  } as Partial<typeof settings>);
  assert.equal(auth.hostedSettingsProblem(), null);
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test("the three Supabase settings are the whole hosted configuration", async () => {
  withSettings(settings);
  assert.equal(auth.hostedSettingsProblem(), null);
  // With a session missing, the request is refused for that reason alone.
  const response = await auth.authorize(request());
  assert.ok(response instanceof Response);
  assert.equal(response.status, 401);
});

test("an unreachable or unprovisioned project is reported, not replaced", async () => {
  withSettings(settings);
  await assert.rejects(db.backend(), (error: Error) => {
    assert.ok(error instanceof db.SetupError);
    assert.match(
      error.message,
      /Enable the Data API and run the files in supabase\/migrations/,
    );
    return true;
  });
  // A request sees the operator's setup problem as a 503.
  const failed = await store
    .withAccount({ id: "someone", email: null }, () => store.state())
    .catch((error) => error);
  assert.equal(failed.status, 503);
  assert.match(failed.message, /not fully set up/);
  // No local database or file folder was created in its place.
  assert.equal(existsSync(path.join(folder, "pglite")), false);
  assert.equal(files().remote, true);

  const missing: import("../src/lib/db").Backend = {
    call: async () => {
      throw new db.DatabaseError(
        "Could not find the function public.slideo_schema_version",
        "PGRST202",
      );
    },
    close: async () => {},
  };
  await assert.rejects(
    db.checkSchema(missing),
    /run the files in supabase\/migrations/,
  );
  const older: import("../src/lib/db").Backend = {
    call: async <T>() => 0 as T,
    close: async () => {},
  };
  await assert.rejects(
    db.checkSchema(older),
    new RegExp(`schema version 0; this release needs ${db.SCHEMA_VERSION}`),
  );
  const current: import("../src/lib/db").Backend = {
    call: async <T>() => db.SCHEMA_VERSION as T,
    close: async () => {},
  };
  await db.checkSchema(current);
});

test("the app has no direct database connection to configure", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.dependencies.postgres, undefined);
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sources(path.join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(dir, entry.name)]
          : [],
    );
  for (const file of [...sources("src"), ...sources("scripts")]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /["']postgres["']/, file);
    assert.doesNotMatch(text, /DATABASE_(URL|CA_CERT|POOL_SIZE)/, file);
  }
  const example = readFileSync(".env.example", "utf8");
  assert.doesNotMatch(example, /DATABASE_/);
  for (const name of Object.keys(settings))
    assert.match(example, new RegExp(`^# ${name}=`, "m"));
});
