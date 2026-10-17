// TikTok inbox delivery, connecting accounts: the sign-in's signed state,
// the callback's checks, sealed tokens and their refresh, and disconnecting.
// Runs on the embedded database and, with `npm run test:supabase`, on the
// local Supabase stack's Data API, with a fake TikTok. Each test acts for
// its own user, so their accounts never meet. tests/tiktok-hosted.test.ts
// covers the routes with real sessions.
import { test, after, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Delivery, TikTokAccount } from "../src/lib/schema";
import type { TikTokToken } from "../src/lib/tiktok-accounts";
import { closeTestDatabase, prepareTestDatabase, sql } from "./database";
import { fakeTikTok } from "./fake-tiktok";

const folder = mkdtempSync(path.join(tmpdir(), "slideo-tiktok-accounts-"));
process.env.STUDIO_DATA_DIR = folder;
// Every TikTok setting, on a local studio: the library works, and only the
// routes and the UI require a hosted studio.
Object.assign(process.env, {
  TIKTOK_CLIENT_KEY: "client-key",
  TIKTOK_CLIENT_SECRET: "client-secret-value",
  TIKTOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  APP_URL: "https://slideo.example",
  CRON_SECRET: "cron-secret-of-24-chars!",
});
const store = await import("../src/lib/store");
await prepareTestDatabase();
const tiktok = await import("../src/lib/tiktok");
const accounts = await import("../src/lib/tiktok-accounts");
const { NextRequest } = await import("next/server");
const { GET: studioGet, POST: studioPost } =
  await import("../src/app/api/studio/route");
after(async () => {
  tiktok.useTikTok(undefined);
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const config = tiktok.tiktokSettings()!;
let fake = fakeTikTok();
beforeEach(() => {
  fake = fakeTikTok();
  tiktok.useTikTok(fake.api);
});

const as = <T>(user: string, fn: () => Promise<T>) => store.asAccount(user, fn);
// Failures are logged for the operator. The log never carries a token or
// TikTok's authorization code.
function logs(t: TestContext) {
  const logged = t.mock.method(console, "error", () => {});
  return () => {
    const text = logged.mock.calls
      .map((call) => call.arguments.join(" "))
      .join("\n");
    assert.doesNotMatch(text, /act\.access|rft\.refresh|code-1/);
    return text;
  };
}
// A sign-in started by the user in scope, and what TikTok's redirect back
// would carry.
function signIn(reconnect = false) {
  const { url, cookie } = accounts.startConnect(
    config,
    store.userId(),
    reconnect,
  );
  return { url, cookie, state: new URL(url).searchParams.get("state")! };
}
async function connect(query: Record<string, string> = {}) {
  const { cookie, state } = signIn();
  return accounts.finishConnect(
    config,
    new URLSearchParams({ code: "code-1", state, ...query }),
    cookie,
  );
}
const connected = async () => {
  const list = await store.list<TikTokAccount>("tiktok_account");
  assert.equal(list.length, 1);
  return list[0];
};
const tokenOf = (id: string) =>
  store.find<TikTokToken>("tiktok_token", id) as Promise<TikTokToken>;
const pairOf = (token: TikTokToken) =>
  tiktok.openTokens(
    config.keys,
    token.sealed,
    tiktok.tokenAad(store.userId(), token.id),
  );
const audits = async () =>
  (
    await sql<{ action: string; entity: string }>(
      "SELECT action, entity FROM audit WHERE user_id=$1",
      [store.userId()],
    )
  ).map((row) => `${row.action} ${row.entity}`);
const inMinutes = (n: number) =>
  new Date(Date.now() + n * 60_000).toISOString();
function delivery(
  id: string,
  accountId: string,
  more: Partial<Delivery> = {},
): Delivery {
  const stamp = new Date().toISOString();
  return {
    id,
    postId: `post-${id}`,
    revision: 1,
    accountId,
    state: "scheduled",
    dueAt: stamp,
    nextAt: stamp,
    attempts: 0,
    createdAt: stamp,
    updatedAt: stamp,
    ...more,
  };
}
const reconnectHold = (more: Partial<Delivery> = {}): Partial<Delivery> => ({
  state: "held",
  nextAt: null,
  error: {
    code: "reconnect_needed",
    message:
      "Reconnect TikTok in Settings. This slideshow will send once you do.",
    retryable: true,
  },
  ...more,
});

test("connecting starts at TikTok's sign-in with a signed state that expires", () => {
  const { url, cookie, state } = signIn();
  const sent = new URL(url);
  assert.equal(
    `${sent.origin}${sent.pathname}`,
    "https://www.tiktok.com/v2/auth/authorize/",
  );
  assert.deepEqual(Object.fromEntries(sent.searchParams), {
    client_key: "client-key",
    response_type: "code",
    scope: "user.info.basic,user.info.profile,video.upload",
    redirect_uri: "https://slideo.example/api/tiktok/callback",
    state,
  });
  // 32 random bytes.
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(signIn().state, state);
  const saved = tiktok.verifyValue<{
    state: string;
    user: string;
    exp: number;
  }>(config.keys.state, cookie)!;
  assert.equal(saved.state, state);
  assert.equal(saved.user, "local");
  const left = saved.exp - Date.now() / 1000;
  assert.ok(left > 590 && left <= 600, `${left} seconds`);
  // Only the state key vouches for it.
  assert.equal(tiktok.verifyValue(config.keys.media, cookie), null);
  // Reconnecting lets the owner choose another TikTok account.
  assert.equal(
    new URL(signIn(true).url).searchParams.get("disable_auto_auth"),
    "1",
  );
  assert.deepEqual(accounts.stateCookie(cookie), {
    name: "slideo_tiktok_oauth",
    value: cookie,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/tiktok",
    maxAge: 600,
  });
});

test("a callback that matches its sign-in connects the account and seals its tokens", () =>
  as("connects", async () => {
    const before = Date.now();
    assert.equal(await connect(), "connected");
    assert.deepEqual(fake.called("exchangeCode"), [
      ["code-1", "https://slideo.example/api/tiktok/callback"],
    ]);
    assert.deepEqual(fake.called("userInfo"), [
      ["act.access-1", ["open_id", "display_name", "username"]],
    ]);
    assert.deepEqual(fake.called("revoke"), []);
    const account = await connected();
    assert.deepEqual(
      { ...account, id: "", connectedAt: "", updatedAt: "" },
      {
        id: "",
        openId: "open-1",
        displayName: "Ana",
        username: "ana",
        status: "connected",
        scopes: ["user.info.basic", "user.info.profile", "video.upload"],
        connectedAt: "",
        updatedAt: "",
      },
    );
    const token = await tokenOf(account.id);
    assert.deepEqual(pairOf(token), {
      accessToken: "act.access-1",
      refreshToken: "rft.refresh-1",
    });
    assert.doesNotMatch(token.sealed, /act\.access|rft\.refresh/);
    // Sealed for this user's account: copied anywhere else, it won't open.
    assert.throws(() =>
      tiktok.openTokens(
        config.keys,
        token.sealed,
        tiktok.tokenAad("someone-else", account.id),
      ),
    );
    const day = Date.parse(token.accessExpiresAt) - before;
    assert.ok(day >= 86_400_000 && day < 86_460_000, `${day} ms`);
    const year = Date.parse(token.refreshExpiresAt) - before;
    assert.ok(year >= 31_536_000_000 && year < 31_536_060_000, `${year} ms`);
    assert.deepEqual(await audits(), [`tiktok.connected ${account.id}`]);
    // The studio snapshot shows the account and never its tokens.
    const state = await store.state();
    assert.deepEqual(state.settings.tiktok, {
      available: false,
      reason: "Available when the studio is hosted.",
      accounts: [account],
    });
    assert.doesNotMatch(
      JSON.stringify(state),
      /sealed|act\.access|rft\.refresh/,
    );
  }));

test("the callback refuses a forged, stale or foreign state and calls TikTok for none", () =>
  as("refuses", async () => {
    const { cookie, state } = signIn();
    const [body, mac] = cookie.split(".");
    const tampered = `${body.slice(0, -1)}${body.endsWith("A") ? "B" : "A"}.${mac}`;
    const payload = (user: string, exp: number) => ({ state, user, exp });
    const now = Math.floor(Date.now() / 1000);
    const otherKeys = tiktok.deriveKeys(Buffer.alloc(32, 1));
    for (const [what, sent, saved] of [
      ["no cookie", { state }, undefined],
      ["a tampered cookie", { state }, tampered],
      ["another state", { state: signIn().state }, cookie],
      ["no state", {}, cookie],
      [
        "another user's sign-in",
        { state },
        tiktok.signValue(config.keys.state, payload("someone-else", now + 600)),
      ],
      [
        "an expired sign-in",
        { state },
        tiktok.signValue(config.keys.state, payload("refuses", now - 1)),
      ],
      [
        "a media key's signature",
        { state },
        tiktok.signValue(config.keys.media, payload("refuses", now + 600)),
      ],
      [
        "another studio's key",
        { state },
        tiktok.signValue(otherKeys.state, payload("refuses", now + 600)),
      ],
    ] as const) {
      const result = await accounts.finishConnect(
        config,
        new URLSearchParams({ code: "code-1", ...sent }),
        saved,
      );
      assert.equal(result, "expired", what);
    }
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(await store.list("tiktok_account"), []);
    // The real sign-in still works afterwards.
    assert.equal(
      await accounts.finishConnect(
        config,
        new URLSearchParams({ code: "code-1", state }),
        cookie,
      ),
      "connected",
    );
  }));

test("TikTok's refusals and failures connect nothing", (t) => {
  const logged = logs(t);
  return as("refusals", async () => {
    // The owner declined, or TikTok reported a problem: no code to exchange.
    assert.equal(
      await connect({ error: "access_denied", error_description: "<b>no</b>" }),
      "denied",
    );
    assert.equal(await connect({ error: "server_error" }), "failed");
    const { cookie, state } = signIn();
    assert.equal(
      await accounts.finishConnect(
        config,
        new URLSearchParams({ state }),
        cookie,
      ),
      "failed",
    );
    assert.deepEqual(fake.calls, []);
    // The code exchange fails: there are no tokens to revoke.
    fake.answer.exchangeCode = async () => {
      throw new tiktok.TikTokError("invalid_request", "Code expired.", {
        httpStatus: 400,
      });
    };
    assert.equal(await connect(), "failed");
    assert.deepEqual(fake.called("revoke"), []);
    // The account details fail: the new tokens are revoked, not kept.
    fake.answer.exchangeCode = async () => fake.grant();
    fake.answer.userInfo = async () => {
      throw new tiktok.TikTokError("timeout", "Too slow.", { definite: false });
    };
    assert.equal(await connect(), "failed");
    assert.deepEqual(fake.called("revoke"), [["act.access-1"]]);
    assert.deepEqual(await store.list("tiktok_account"), []);
    assert.deepEqual(await store.list("tiktok_token"), []);
    assert.match(logged(), /TikTok connect failed.*"tiktokCode":"timeout"/);
  });
});

test("connecting needs permission to upload, and works without the profile", () =>
  as("scopes", async () => {
    fake.answer.exchangeCode = async () =>
      fake.grant("open-1", ["user.info.basic", "user.info.profile"]);
    assert.equal(await connect(), "scope");
    assert.deepEqual(fake.called("userInfo"), []);
    assert.deepEqual(fake.called("revoke"), [["act.access-1"]]);
    assert.deepEqual(await store.list("tiktok_account"), []);
    // Without user.info.profile there is no username, and nothing else
    // changes.
    fake.answer.exchangeCode = async () =>
      fake.grant("open-1", ["user.info.basic", "video.upload"]);
    assert.equal(await connect(), "connected");
    assert.deepEqual(fake.called("userInfo").at(-1), [
      "act.access-2",
      ["open_id", "display_name"],
    ]);
    const account = await connected();
    assert.equal(account.username, undefined);
    assert.deepEqual(account.scopes, ["user.info.basic", "video.upload"]);
  }));

test("reconnecting the same TikTok account keeps its id and resumes its held deliveries", () =>
  as("reconnects", async () => {
    assert.equal(await connect(), "connected");
    const { id } = await connected();
    const hour = inMinutes(60);
    const capped = {
      code: "spam_risk_too_many_pending_share",
      message: "TikTok holds at most 5 unposted uploads a day.",
      retryable: true,
    };
    await store.transaction(async () => {
      for (const item of [
        delivery("overdue", id, reconnectHold({ dueAt: inMinutes(-30) })),
        delivery("later", id, reconnectHold({ dueAt: inMinutes(90) })),
        delivery("capped", id, {
          state: "held",
          nextAt: inMinutes(600),
          error: capped,
        }),
        delivery("other-account", "another-id", reconnectHold()),
        delivery("waiting", id, { dueAt: hour, nextAt: hour }),
      ])
        await store.put("delivery", item);
    });
    await store.put("tiktok_account", {
      ...(await connected()),
      status: "reconnect_needed",
    });

    const started = new Date().toISOString();
    assert.equal(await connect(), "connected");
    const account = await connected();
    assert.equal(account.id, id);
    assert.equal(account.status, "connected");
    assert.deepEqual(pairOf(await tokenOf(id)), {
      accessToken: "act.access-2",
      refreshToken: "rft.refresh-2",
    });
    // The replaced tokens aren't revoked: a revoke may end the authorization
    // the new tokens belong to.
    assert.deepEqual(fake.called("revoke"), []);
    const deliveries = new Map(
      (await store.list<Delivery>("delivery")).map((d) => [d.id, d]),
    );
    // Overdue: it goes on the next run. Not yet due: it waits for its time.
    const overdue = deliveries.get("overdue")!;
    assert.equal(overdue.state, "scheduled");
    assert.ok(overdue.nextAt! >= started, overdue.nextAt!);
    assert.equal(overdue.error, undefined);
    const later = deliveries.get("later")!;
    assert.equal(later.state, "scheduled");
    assert.equal(later.nextAt, later.dueAt);
    // Held for another reason, or for another account: unchanged.
    assert.deepEqual(deliveries.get("capped")!.error, capped);
    assert.equal(deliveries.get("other-account")!.state, "held");
    assert.equal(deliveries.get("waiting")!.nextAt, hour);
    const trail = await audits();
    assert.deepEqual(
      trail.filter((entry) => entry.startsWith("delivery.")).sort(),
      ["delivery.resumed later", "delivery.resumed overdue"],
    );
    assert.equal(
      trail.filter((entry) => entry === `tiktok.connected ${id}`).length,
      2,
    );
    // Another TikTok account gets a record of its own.
    fake.answer.exchangeCode = async () => fake.grant("open-2");
    fake.answer.userInfo = async () => ({
      openId: "open-2",
      displayName: "Bea",
    });
    assert.equal(await connect(), "connected");
    const all = await store.list<TikTokAccount>("tiktok_account");
    assert.equal(all.length, 2);
    assert.notEqual(all.find((a) => a.openId === "open-2")!.id, id);
  }));

test("a token is refreshed shortly before it expires, and TikTok's new refresh token is kept", () =>
  as("refreshes", async () => {
    await connect();
    const { id } = await connected();
    const token = await tokenOf(id);
    // Half an hour left: used as it is.
    await store.put("tiktok_token", {
      ...token,
      accessExpiresAt: inMinutes(30),
    });
    assert.equal(await accounts.accessToken(id), "act.access-1");
    assert.deepEqual(fake.called("refresh"), []);
    // Five minutes left: refreshed first.
    await store.put("tiktok_token", {
      ...token,
      accessExpiresAt: inMinutes(5),
    });
    const before = Date.now();
    assert.equal(await accounts.accessToken(id), "act.access-2");
    assert.deepEqual(fake.called("refresh"), [["rft.refresh-1"]]);
    const stored = await tokenOf(id);
    assert.deepEqual(pairOf(stored), {
      accessToken: "act.access-2",
      refreshToken: "rft.refresh-2",
    });
    const day = Date.parse(stored.accessExpiresAt) - before;
    assert.ok(day >= 86_400_000 && day < 86_460_000, `${day} ms`);
    assert.equal(await accounts.accessToken(id), "act.access-2");
    assert.equal(fake.called("refresh").length, 1);
    assert.equal((await connected()).status, "connected");
  }));

test("a refresh that another request beat uses the pair that request saved", () =>
  as("races", async () => {
    await connect();
    const { id } = await connected();
    const soon = { ...(await tokenOf(id)), accessExpiresAt: inMinutes(5) };
    const theirs = (n: number): TikTokToken => ({
      id,
      sealed: tiktok.sealTokens(
        config.keys,
        { accessToken: `act.theirs-${n}`, refreshToken: `rft.theirs-${n}` },
        tiktok.tokenAad("races", id),
      ),
      accessExpiresAt: inMinutes(24 * 60),
      refreshExpiresAt: inMinutes(365 * 24 * 60),
    });
    // Another request saves its refreshed pair while this one waits.
    await store.put("tiktok_token", soon);
    fake.answer.refresh = async () => {
      await store.put("tiktok_token", theirs(1));
      return fake.grant();
    };
    assert.equal(await accounts.accessToken(id), "act.theirs-1");
    assert.equal(pairOf(await tokenOf(id)).accessToken, "act.theirs-1");
    // Its refresh used up the refresh token this one sent.
    await store.put("tiktok_token", soon);
    fake.answer.refresh = async () => {
      await store.put("tiktok_token", theirs(2));
      throw new tiktok.TikTokError(
        "invalid_grant",
        "Refresh token is invalid.",
      );
    };
    assert.equal(await accounts.accessToken(id), "act.theirs-2");
    assert.equal((await connected()).status, "connected");
  }));

test("invalid_grant, an expired refresh token or an unreadable seal mean reconnecting", () =>
  as("expires", async () => {
    await connect();
    const { id } = await connected();
    const token = await tokenOf(id);
    const expectReconnect = async (what: string) => {
      await assert.rejects(accounts.accessToken(id), (error: Error) => {
        assert.ok(error instanceof accounts.ReconnectNeeded, what);
        assert.equal(
          error.message,
          "Reconnect TikTok in Settings. This slideshow will send once you do.",
        );
        return true;
      });
      assert.equal((await connected()).status, "reconnect_needed", what);
    };
    const reset = async (changes: Partial<TikTokToken>) => {
      await store.put("tiktok_token", { ...token, ...changes });
      await store.put("tiktok_account", {
        ...(await connected()),
        status: "connected",
      });
    };

    fake.answer.refresh = async () => {
      throw new tiktok.TikTokError(
        "invalid_grant",
        "Refresh token is invalid.",
        {
          httpStatus: 400,
        },
      );
    };
    await reset({ accessExpiresAt: inMinutes(5) });
    await expectReconnect("invalid_grant");
    assert.equal(fake.called("refresh").length, 1);
    // Marked once: later calls don't ask TikTok again.
    await assert.rejects(accounts.accessToken(id), accounts.ReconnectNeeded);
    assert.equal(fake.called("refresh").length, 1);
    assert.deepEqual(
      (await audits()).filter((entry) => entry.startsWith("tiktok.reconnect")),
      [`tiktok.reconnect_needed ${id}`],
    );

    await reset({
      accessExpiresAt: inMinutes(5),
      refreshExpiresAt: inMinutes(-1),
    });
    await expectReconnect("an expired refresh token");
    assert.equal(fake.called("refresh").length, 1);

    // Sealed for another user, as if copied to this record.
    await reset({
      sealed: tiktok.sealTokens(
        config.keys,
        pairOf(token),
        tiktok.tokenAad("someone-else", id),
      ),
    });
    await expectReconnect("an unreadable seal");

    await store.remove("tiktok_token", id);
    await store.put("tiktok_account", {
      ...(await connected()),
      status: "connected",
    });
    await expectReconnect("no token at all");
  }));

test("a refresh without a definite answer keeps using a token that still works", (t) => {
  const logged = logs(t);
  return as("unsure", async () => {
    await connect();
    const { id } = await connected();
    const token = { ...(await tokenOf(id)), accessExpiresAt: inMinutes(5) };
    await store.put("tiktok_token", token);
    fake.answer.refresh = async () => {
      throw new tiktok.TikTokError("timeout", "Too slow.", { definite: false });
    };
    assert.equal(await accounts.accessToken(id), "act.access-1");
    assert.deepEqual(await tokenOf(id), token);
    // A definite refusal other than invalid_grant is the caller's to handle.
    fake.answer.refresh = async () => {
      throw new tiktok.TikTokError("invalid_client", "Bad client.", {
        httpStatus: 401,
      });
    };
    await assert.rejects(accounts.accessToken(id), { code: "invalid_client" });
    // Without an answer and with nothing left of the token: no token to use.
    fake.answer.refresh = async () => {
      throw new tiktok.TikTokError("timeout", "Too slow.", { definite: false });
    };
    await store.put("tiktok_token", {
      ...token,
      accessExpiresAt: inMinutes(-1),
    });
    await assert.rejects(accounts.accessToken(id), { code: "timeout" });
    assert.equal((await connected()).status, "connected");
    assert.match(logged(), /TikTok token refresh failed/);
  });
});

const local = { host: "localhost:3000", origin: "http://localhost:3000" };
const studio = async (body: Record<string, unknown>) => {
  const response = await studioPost(
    new NextRequest("http://localhost:3000/api/studio", {
      method: "POST",
      headers: { ...local, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};

test("disconnecting revokes the token, forgets it and holds scheduled deliveries", async (t) => {
  const logged = logs(t);
  // The local studio's own user, through the studio's API.
  assert.equal(await connect(), "connected");
  const { id } = await connected();
  for (const item of [
    delivery("scheduled", id),
    delivery("in-inbox", id, { state: "in_inbox", nextAt: inMinutes(5) }),
    delivery("someone-elses", "another-id"),
  ])
    await store.put("delivery", item);

  const response = await studio({ action: "tiktokDisconnect", id });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.status, "disconnected");
  assert.equal(response.body.id, id);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /sealed|act\.access|rft\.refresh/,
  );
  assert.deepEqual(fake.called("revoke"), [["act.access-1"]]);
  assert.equal(await store.find("tiktok_token", id), null);
  assert.equal((await connected()).status, "disconnected");
  const deliveries = new Map(
    (await store.list<Delivery>("delivery")).map((d) => [d.id, d]),
  );
  const held = deliveries.get("scheduled")!;
  assert.equal(held.state, "held");
  assert.equal(held.nextAt, null);
  assert.deepEqual(held.error, reconnectHold().error);
  assert.equal(deliveries.get("in-inbox")!.state, "in_inbox");
  assert.equal(deliveries.get("someone-elses")!.state, "scheduled");
  const trail = await audits();
  assert.ok(trail.includes(`tiktok.disconnected ${id}`));
  assert.ok(trail.includes("delivery.held scheduled"));
  // Nothing to use until it is reconnected; it stays disconnected.
  await assert.rejects(accounts.accessToken(id), accounts.ReconnectNeeded);
  assert.equal((await connected()).status, "disconnected");
  const state = (await (
    await studioGet(
      new NextRequest("http://localhost:3000/api/studio", { headers: local }),
    )
  ).json()) as import("../src/lib/schema").StudioState;
  assert.equal(state.settings.tiktok.accounts[0].status, "disconnected");
  assert.equal(
    state.deliveries.find((d) => d.id === "scheduled")?.state,
    "held",
  );

  // Reconnected, then disconnected while TikTok is down: Slideo still
  // forgets the token. An expired access token is refreshed to revoke it.
  assert.equal(await connect(), "connected");
  await store.put("tiktok_token", {
    ...(await tokenOf(id)),
    accessExpiresAt: inMinutes(-1),
  });
  fake.answer.revoke = async () => {
    throw new tiktok.TikTokError("timeout", "Too slow.", { definite: false });
  };
  const again = await studio({ action: "tiktokDisconnect", id });
  assert.equal(again.status, 200, again.body.error);
  assert.deepEqual(fake.called("refresh"), [["rft.refresh-2"]]);
  assert.deepEqual(fake.called("revoke").at(-1), ["act.access-3"]);
  assert.equal(await store.find("tiktok_token", id), null);

  const unknown = await studio({ action: "tiktokDisconnect", id: "nope" });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /TikTok account/);
  assert.match(logged(), /TikTok disconnect failed/);
});

test("TikTok failures are logged with TikTok's code, status and log id", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  tiktok.logTikTok(
    "TikTok connect",
    new tiktok.TikTokError("scope_not_authorized", "Missing scope.", {
      httpStatus: 401,
      logId: "log-9",
    }),
    { account: "account-1" },
  );
  const [title, detail] = logged.mock.calls[0].arguments as [string, string];
  assert.match(title, /^TikTok connect failed \[[0-9a-f]{8}\]$/);
  assert.deepEqual(
    (({ operation, account, tiktokCode, httpStatus, logId }) => ({
      operation,
      account,
      tiktokCode,
      httpStatus,
      logId,
    }))(JSON.parse(detail)),
    {
      operation: "TikTok connect",
      account: "account-1",
      tiktokCode: "scope_not_authorized",
      httpStatus: 401,
      logId: "log-9",
    },
  );
});
