// TikTok inbox delivery on a hosted studio, against the local Supabase stack
// (`npm run test:supabase`): the connect and callback routes with real
// sessions, the state cookie, and two accounts that never see or change
// each other's TikTok accounts. TikTok itself is a fake. Skipped by
// `npm test`, which has no stack to talk to.
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StudioState } from "../src/lib/schema";
import { closeTestDatabase, localStack, onSupabase, sql } from "./database";
import { fakeTikTok } from "./fake-tiktok";
import { deleteUsers, signedInUser, type User } from "./sessions";

const skip = onSupabase ? false : "needs the local Supabase stack";
const stack = onSupabase ? localStack() : undefined;
const folder = mkdtempSync(path.join(tmpdir(), "slideo-tiktok-hosted-"));
process.env.STUDIO_DATA_DIR = folder;
if (stack) {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: stack.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: stack.SECRET_KEY,
    TIKTOK_CLIENT_KEY: "client-key",
    TIKTOK_CLIENT_SECRET: "client-secret-value",
    TIKTOK_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    APP_URL: "https://studio.example",
    CRON_SECRET: "cron-secret-of-24-chars!",
  });
  await sql(
    "TRUNCATE public.entities, public.revisions, public.approvals, public.audit, public.ai_attempts, public.accounts",
  );
}
const { GET: connectRoute } =
  await import("../src/app/api/tiktok/connect/route");
const { GET: callbackRoute } =
  await import("../src/app/api/tiktok/callback/route");
const { GET: studioGet, POST: studioPost } =
  await import("../src/app/api/studio/route");
const store = await import("../src/lib/store");
const tiktok = await import("../src/lib/tiktok");
const { NextRequest } = await import("next/server");
after(async () => {
  tiktok.useTikTok(undefined);
  if (stack) await deleteUsers();
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const fake = fakeTikTok();
tiktok.useTikTok(fake.api);
const site = "https://studio.example";
const cookieHeader = (...cookies: (string | undefined)[]) =>
  cookies.filter(Boolean).join("; ");

// The Connect TikTok link, followed from Settings.
const connect = (user?: User, query = "", host = "studio.example") =>
  connectRoute(
    new NextRequest(`https://${host}/api/tiktok/connect${query}`, {
      headers: {
        host,
        "sec-fetch-site": "same-origin",
        cookie: cookieHeader(user?.cookie),
      },
    }),
  );
// The state cookie a response sets, and its attributes in lower case.
function stateCookie(response: Response) {
  const line = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("slideo_tiktok_oauth="));
  if (!line) return undefined;
  const [pair, ...attributes] = line.split(/;\s*/);
  return {
    value: decodeURIComponent(pair.slice(pair.indexOf("=") + 1)),
    attributes: attributes.map((attribute) => attribute.toLowerCase()),
  };
}
// TikTok's redirect back: a cross-site navigation carrying the browser's
// session and the state cookie.
const callback = (
  user: User | undefined,
  query: Record<string, string>,
  state?: string,
) =>
  callbackRoute(
    new NextRequest(
      `${site}/api/tiktok/callback?${new URLSearchParams(query)}`,
      {
        headers: {
          host: "studio.example",
          "sec-fetch-site": "cross-site",
          cookie: cookieHeader(
            user?.cookie,
            state && `slideo_tiktok_oauth=${state}`,
          ),
        },
      },
    ),
  );
// Connect TikTok from start to finish: the studio sends the browser to
// TikTok, and TikTok sends it back with a code and the state.
async function connectThrough(user: User, starter = user) {
  const started = await connect(starter);
  assert.equal(started.status, 303);
  const state = new URL(started.headers.get("location")!).searchParams.get(
    "state",
  )!;
  return callback(
    user,
    { code: "code-1", state, scopes: tiktok.SCOPES.join(",") },
    stateCookie(started)!.value,
  );
}
const load = async (user: User) => {
  const response = await studioGet(
    new NextRequest(`${site}/api/studio`, {
      headers: { host: "studio.example", cookie: user.cookie },
    }),
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  // Tokens never reach the browser.
  assert.doesNotMatch(text, /sealed|tiktok_token|act\.access|rft\.refresh/);
  return JSON.parse(text) as StudioState;
};
const studio = async (user: User, body: Record<string, unknown>) => {
  const response = await studioPost(
    new NextRequest(`${site}/api/studio`, {
      method: "POST",
      headers: {
        host: "studio.example",
        origin: site,
        cookie: user.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};
// Runs fn with one TikTok setting removed, so the feature is unavailable.
async function withoutSetting(t: TestContext, fn: () => Promise<void>) {
  const logged = t.mock.method(console, "error", () => {});
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    await fn();
  } finally {
    process.env.CRON_SECRET = saved;
  }
  // The operator's log says which setting is missing.
  assert.match(
    logged.mock.calls.map((call) => call.arguments.join(" ")).join("\n"),
    /needs CRON_SECRET/,
  );
}
const tokenRows = (user: User) =>
  sql<{ id: string; json: string }>(
    "SELECT id, json FROM entities WHERE user_id=$1 AND kind='tiktok_token'",
    [user.id],
  );

const alice = skip ? undefined : await signedInUser("tiktok-alice");
const bob = skip ? undefined : await signedInUser("tiktok-bob");

test("connecting needs a session and a TikTok setup", { skip }, async (t) => {
  const anonymous = await connect();
  assert.equal(anonymous.status, 401);
  assert.equal(stateCookie(anonymous), undefined);
  await withoutSetting(t, async () => {
    const response = await connect(alice);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "TikTok isn't set up on this studio yet.",
    });
    assert.equal(stateCookie(response), undefined);
    assert.deepEqual((await load(alice!)).settings.tiktok, {
      available: false,
      reason: "TikTok isn't set up on this studio yet.",
      accounts: [],
    });
  });
});

test(
  "connect sends a signed-in browser to TikTok with a short-lived, path-scoped state cookie",
  { skip },
  async () => {
    const response = await connect(alice);
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location")!);
    assert.equal(
      `${location.origin}${location.pathname}`,
      "https://www.tiktok.com/v2/auth/authorize/",
    );
    const query = Object.fromEntries(location.searchParams);
    assert.deepEqual(
      { ...query, state: "" },
      {
        client_key: "client-key",
        response_type: "code",
        scope: "user.info.basic,user.info.profile,video.upload",
        redirect_uri: "https://studio.example/api/tiktok/callback",
        state: "",
      },
    );
    const cookie = stateCookie(response)!;
    for (const attribute of [
      "httponly",
      "secure",
      "samesite=lax",
      "path=/api/tiktok",
      "max-age=600",
    ])
      assert.ok(cookie.attributes.includes(attribute), attribute);
    const saved = tiktok.verifyValue<{ state: string; user: string }>(
      tiktok.tiktokSettings()!.keys.state,
      cookie.value,
    )!;
    assert.equal(saved.state, query.state);
    assert.equal(saved.user, alice!.id);
    // Reconnecting lets the owner pick another TikTok account.
    const again = await connect(alice, "?reconnect=1");
    assert.equal(
      new URL(again.headers.get("location")!).searchParams.get(
        "disable_auto_auth",
      ),
      "1",
    );
    // TikTok returns people to APP_URL only, where the cookie must be.
    const preview = await connect(alice, "", "preview.studio.example");
    assert.equal(preview.status, 303);
    assert.equal(preview.headers.get("location"), "/?tiktok=wrong_host");
    assert.equal(stateCookie(preview), undefined);
  },
);

test(
  "the callback connects the signed-in user who started the sign-in",
  { skip },
  async () => {
    const response = await connectThrough(alice!);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/?tiktok=connected");
    const cleared = stateCookie(response)!;
    assert.equal(cleared.value, "");
    assert.ok(cleared.attributes.includes("max-age=0"));
    assert.ok(cleared.attributes.includes("path=/api/tiktok"));
    const { tiktok: settings } = (await load(alice!)).settings;
    assert.equal(settings.available, true);
    assert.equal(settings.appUrl, "https://studio.example");
    assert.equal(settings.accounts.length, 1);
    const [account] = settings.accounts;
    assert.equal(account.status, "connected");
    assert.equal(account.username, "ana");
    // The stored token is sealed for Alice's record of this account.
    const [row] = await tokenRows(alice!);
    assert.equal(row.id, account.id);
    const { sealed } = JSON.parse(row.json) as { sealed: string };
    const keys = tiktok.tiktokSettings()!.keys;
    assert.ok(
      tiktok.openTokens(keys, sealed, tiktok.tokenAad(alice!.id, account.id))
        .accessToken,
    );
    assert.throws(() =>
      tiktok.openTokens(keys, sealed, tiktok.tokenAad(bob!.id, account.id)),
    );
  },
);

test(
  "the callback refuses another user's sign-in and needs a session",
  { skip },
  async () => {
    const exchanged = fake.called("exchangeCode").length;
    // Bob's browser arrives with a sign-in Alice started.
    const foreign = await connectThrough(bob!, alice!);
    assert.equal(foreign.headers.get("location"), "/?tiktok=expired");
    assert.equal(stateCookie(foreign)!.value, "");
    assert.deepEqual((await load(bob!)).settings.tiktok.accounts, []);
    // Signed out: sign in first. The cookie is cleared either way.
    const started = await connect(alice);
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const signedOut = await callback(
      undefined,
      { code: "code-1", state },
      stateCookie(started)!.value,
    );
    assert.equal(signedOut.status, 303);
    assert.match(signedOut.headers.get("location")!, /^\/login\?error=/);
    assert.equal(stateCookie(signedOut)!.value, "");
    // Declined in TikTok.
    const declined = await callback(
      alice,
      { error: "access_denied", error_description: "<script>", state },
      stateCookie(started)!.value,
    );
    assert.equal(declined.headers.get("location"), "/?tiktok=denied");
    assert.equal(fake.called("exchangeCode").length, exchanged);
  },
);

test(
  "two accounts never see or change each other's TikTok accounts",
  { skip },
  async () => {
    // Bob connects the same TikTok account: a record of his own.
    const response = await connectThrough(bob!);
    assert.equal(response.headers.get("location"), "/?tiktok=connected");
    const [mine] = (await load(alice!)).settings.tiktok.accounts;
    const theirs = (await load(bob!)).settings.tiktok.accounts;
    assert.equal(theirs.length, 1);
    assert.notEqual(theirs[0].id, mine.id);
    assert.equal(theirs[0].openId, mine.openId);
    // Bob can't disconnect Alice's account.
    const refused = await studio(bob!, {
      action: "tiktokDisconnect",
      id: mine.id,
    });
    assert.equal(refused.status, 404);
    assert.equal((await tokenRows(alice!)).length, 1);
    // Alice disconnects hers; Bob's stays connected.
    const done = await studio(alice!, {
      action: "tiktokDisconnect",
      id: mine.id,
    });
    assert.equal(done.status, 200, done.body.error);
    assert.equal(done.body.status, "disconnected");
    assert.equal((await tokenRows(alice!)).length, 0);
    assert.equal((await tokenRows(bob!)).length, 1);
    assert.equal(
      (await load(bob!)).settings.tiktok.accounts[0].status,
      "connected",
    );
  },
);

test(
  "the callback reports a studio without TikTok as unavailable",
  { skip },
  async (t) => {
    const started = await connect(alice);
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    await withoutSetting(t, async () => {
      const response = await callback(
        alice,
        { code: "code-1", state },
        stateCookie(started)!.value,
      );
      assert.equal(response.headers.get("location"), "/?tiktok=unavailable");
      assert.equal(stateCookie(response)!.value, "");
    });
  },
);
