// TikTok inbox delivery, foundations: settings and the hosted-only gate, the
// derived keys, sealed tokens, signed values, the HTTP client, log redaction,
// the new optional `delivery` content field and the schema version 2 queries.
// Runs on the embedded database and, with `npm run test:supabase`, on the
// local Supabase stack's Data API.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { Delivery, Post, TikTokAccount } from "../src/lib/schema";
import { seedSamplePost } from "./sample-post";
import { closeTestDatabase, sql, prepareTestDatabase } from "./database";
const folder = mkdtempSync(path.join(tmpdir(), "slideo-tiktok-test-"));
process.env.STUDIO_DATA_DIR = folder;
const store = await import("../src/lib/store");
await prepareTestDatabase();
const tiktok = await import("../src/lib/tiktok");
const { backend } = await import("../src/lib/db");
const { postSchema } = await import("../src/lib/schema");
const { redact } = await import("../src/lib/log");
const { NextRequest } = await import("next/server");
const { GET: studioGet, POST: studioPost } =
  await import("../src/app/api/studio/route");
const { GET: exportPackage } = await import("../src/app/api/export/[id]/route");
after(async () => {
  await store.closeStore();
  await closeTestDatabase();
  rmSync(folder, { recursive: true, force: true });
});

const KEY = Buffer.alloc(32, 7).toString("base64");
const settings = {
  TIKTOK_CLIENT_KEY: "client-key",
  TIKTOK_CLIENT_SECRET: "client-secret-value",
  TIKTOK_ENCRYPTION_KEY: KEY,
  APP_URL: "https://slideo.example",
  CRON_SECRET: "cron-secret-of-24-chars!",
};
// Sets environment variables for one test and puts them back after.
async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => unknown,
) {
  const saved = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  const assign = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  assign(values);
  try {
    await fn();
  } finally {
    assign(saved);
  }
}
const local = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
};
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
const exportOf = (post: Post) =>
  exportPackage(
    new NextRequest(
      `http://localhost:3000/api/export/${post.id}?revision=${post.revision}`,
      { headers: local },
    ),
    { params: Promise.resolve({ id: post.id }) },
  );

test("TikTok settings need every variable, each valid", () => {
  const config = tiktok.tiktokSettings(settings)!;
  assert.equal(config.clientKey, "client-key");
  assert.equal(config.appUrl, "https://slideo.example");
  assert.equal(
    config.redirectUri,
    "https://slideo.example/api/tiktok/callback",
  );
  assert.equal(config.cronSecret, settings.CRON_SECRET);
  // Unset, the feature is simply off: nothing for the operator to fix.
  assert.equal(tiktok.tiktokSettings({}), null);
  assert.equal(tiktok.tiktokSettingsProblem({}), null);
  assert.equal(tiktok.tiktokSettingsProblem(settings), null);
  // Partly set, it is off and the operator's log names what's missing.
  for (const name of Object.keys(settings)) {
    const partial = { ...settings, [name]: " " };
    assert.equal(tiktok.tiktokSettings(partial), null, name);
    assert.match(tiktok.tiktokSettingsProblem(partial)!, new RegExp(name));
  }
  for (const [name, value, reason] of [
    ["TIKTOK_ENCRYPTION_KEY", Buffer.alloc(16).toString("base64"), /32/],
    ["TIKTOK_ENCRYPTION_KEY", "not base64 at all", /32/],
    ["APP_URL", "http://slideo.example", /https origin/],
    ["APP_URL", "https://slideo.example/studio", /no path/],
    ["APP_URL", "https://slideo.example/?preview=1", /no path/],
    ["APP_URL", "slideo.example", /https origin/],
    ["CRON_SECRET", "too-short", /at least 16/],
  ] as const) {
    const bad = { ...settings, [name]: value };
    assert.equal(tiktok.tiktokSettings(bad), null, `${name}=${value}`);
    assert.match(tiktok.tiktokSettingsProblem(bad)!, reason);
  }
  // A trailing slash and pasted whitespace are tolerated.
  const pasted = tiktok.tiktokSettings({
    ...settings,
    APP_URL: " https://slideo.example/\n",
    TIKTOK_CLIENT_KEY: "client-key\n",
  })!;
  assert.equal(pasted.appUrl, "https://slideo.example");
  assert.equal(pasted.clientKey, "client-key");
});

test("the feature is available only on a hosted studio with every setting", async () => {
  await withEnv(settings, async () => {
    // This test process is a local studio.
    assert.equal(tiktok.tiktokConfig(), null);
    assert.deepEqual(tiktok.tiktokAvailability(), {
      available: false,
      reason: "Available when the studio is hosted.",
    });
    await withEnv(
      { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" },
      async () => {
        assert.equal(tiktok.tiktokConfig()?.appUrl, "https://slideo.example");
        assert.deepEqual(tiktok.tiktokAvailability(), {
          available: true,
          appUrl: "https://slideo.example",
        });
        await withEnv({ CRON_SECRET: undefined }, () => {
          assert.equal(tiktok.tiktokConfig(), null);
          assert.deepEqual(tiktok.tiktokAvailability(), {
            available: false,
            reason: "TikTok isn't set up on this studio yet.",
          });
        });
      },
    );
  });
});

test("one encryption key gives a separate key for each purpose", () => {
  const keys = tiktok.deriveKeys(Buffer.alloc(32, 1));
  assert.deepEqual(tiktok.deriveKeys(Buffer.alloc(32, 1)), keys);
  const all = [keys.token, keys.media, keys.state];
  assert.ok(all.every((key) => key.length === 32));
  assert.equal(new Set(all.map((key) => key.toString("hex"))).size, 3);
  assert.notDeepEqual(tiktok.deriveKeys(Buffer.alloc(32, 2)).token, keys.token);
});

test("sealed tokens open only with their key, user and account", () => {
  const keys = tiktok.deriveKeys(Buffer.alloc(32, 3));
  const pair = {
    accessToken: "act.secret-access-token",
    refreshToken: "rft.secret-refresh-token",
  };
  const aad = tiktok.tokenAad("user-1", "account-1");
  const sealed = tiktok.sealTokens(keys, pair, aad);
  assert.match(
    sealed,
    /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/,
  );
  assert.ok(!sealed.includes("secret"));
  assert.deepEqual(tiktok.openTokens(keys, sealed, aad), pair);
  // A fresh IV every time.
  assert.notEqual(tiktok.sealTokens(keys, pair, aad), sealed);
  // Copied to another account or user, or opened with another key: refused.
  for (const [key, other] of [
    [keys.token, tiktok.tokenAad("user-1", "account-2")],
    [keys.token, tiktok.tokenAad("user-2", "account-1")],
    [tiktok.deriveKeys(Buffer.alloc(32, 4)).token, aad],
    [keys.media, aad],
  ] as const)
    assert.throws(() => tiktok.unseal(key, sealed, other));
  const [version, iv, tag, data] = sealed.split(".");
  const flip = (part: string) => {
    const bytes = Buffer.from(part, "base64");
    bytes[0] ^= 1;
    return bytes.toString("base64");
  };
  for (const forged of [
    [version, flip(iv), tag, data],
    [version, iv, flip(tag), data],
    [version, iv, tag, flip(data)],
    [version, iv, tag.slice(0, 8), data],
    ["v2", iv, tag, data],
    [version, iv, tag],
    [version, iv, tag, data, data],
  ])
    assert.throws(() => tiktok.openTokens(keys, forged.join("."), aad));
});

test("signed values verify only as issued", () => {
  const keys = tiktok.deriveKeys(Buffer.alloc(32, 5));
  const payload = { u: "user-1", d: "post-1-r2", e: 1_900_000_000 };
  const token = tiktok.signValue(keys.media, payload);
  // Safe in a URL path segment.
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(tiktok.verifyValue(keys.media, token), payload);
  const [body, mac] = token.split(".");
  const forgedBody = Buffer.from(
    JSON.stringify({ ...payload, u: "user-2" }),
  ).toString("base64url");
  for (const forged of [
    `${forgedBody}.${mac}`,
    `${body}.${mac.slice(0, -2)}`,
    `${body}.${mac}x`,
    `${body}.`,
    `${token}.extra`,
    body,
    "",
  ])
    assert.equal(tiktok.verifyValue(keys.media, forged), null, forged);
  // Another purpose's key can't vouch for it.
  assert.equal(tiktok.verifyValue(keys.state, token), null);
  assert.equal(tiktok.sameSecret("same", "same"), true);
  assert.equal(tiktok.sameSecret("same", "sane"), false);
  assert.equal(tiktok.sameSecret("same", "same-but-longer"), false);
});

type Sent = { url: string; init: RequestInit };
function fakeFetch(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    sent.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const answered = (data: unknown) =>
  json({ data, error: { code: "ok", message: "", log_id: "log-ok" } });
const headersOf = (sent: Sent) => sent.init.headers as Record<string, string>;
const formOf = (sent: Sent) =>
  Object.fromEntries(new URLSearchParams(String(sent.init.body)));
const upload = {
  photoUrls: [
    "https://slideo.example/api/tiktok/media/t/0.jpg",
    "https://slideo.example/api/tiktok/media/t/1.jpg",
  ],
  coverIndex: 0,
  description: "Two slides #test",
};

test("the TikTok client sends the documented requests", async () => {
  const { fetch, sent } = fakeFetch(({ url }) => {
    if (url.endsWith("/v2/oauth/token/"))
      return json({
        access_token: "act.access-1",
        refresh_token: "rft.refresh-1",
        open_id: "open-1",
        expires_in: 86400,
        refresh_expires_in: 31536000,
        scope: "user.info.basic,video.upload",
        token_type: "Bearer",
      });
    if (url.endsWith("/v2/oauth/revoke/"))
      return new Response(null, { status: 200 });
    if (url.includes("/v2/user/info/"))
      return answered({
        user: { open_id: "open-1", display_name: "Ana", username: "ana" },
      });
    if (url.endsWith("/v2/post/publish/content/init/"))
      return answered({ publish_id: "p_pub_url~v2.1" });
    if (url.endsWith("/v2/post/publish/status/fetch/"))
      // A 64-bit post id, written as TikTok sends it: a bare number.
      return new Response(
        '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7234567890123456789]},"error":{"code":"ok","message":"","log_id":"log-3"}}',
      );
    return new Response("Not found", { status: 404 });
  });
  const client = tiktok.tiktokClient("client-key", "client-secret", {
    fetch,
  });
  const grant = await client.exchangeCode(
    "code-1",
    "https://slideo.example/api/tiktok/callback",
  );
  assert.deepEqual(grant, {
    openId: "open-1",
    accessToken: "act.access-1",
    refreshToken: "rft.refresh-1",
    expiresIn: 86400,
    refreshExpiresIn: 31536000,
    scopes: ["user.info.basic", "video.upload"],
  });
  assert.equal(sent[0].url, "https://open.tiktokapis.com/v2/oauth/token/");
  assert.equal(sent[0].init.method, "POST");
  assert.equal(
    headersOf(sent[0])["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.deepEqual(formOf(sent[0]), {
    client_key: "client-key",
    client_secret: "client-secret",
    code: "code-1",
    grant_type: "authorization_code",
    redirect_uri: "https://slideo.example/api/tiktok/callback",
  });

  await client.refresh("rft.refresh-1");
  assert.deepEqual(formOf(sent[1]), {
    client_key: "client-key",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "rft.refresh-1",
  });
  await client.revoke("act.access-1");
  assert.equal(sent[2].url, "https://open.tiktokapis.com/v2/oauth/revoke/");
  assert.equal(formOf(sent[2]).token, "act.access-1");

  assert.deepEqual(
    await client.userInfo("act.access-1", [
      "open_id",
      "display_name",
      "username",
    ]),
    { openId: "open-1", displayName: "Ana", username: "ana" },
  );
  assert.equal(
    sent[3].url,
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username",
  );
  assert.equal(sent[3].init.method, "GET");
  assert.equal(headersOf(sent[3]).Authorization, "Bearer act.access-1");

  assert.equal(
    await client.initPhotoUpload("act.access-1", upload),
    "p_pub_url~v2.1",
  );
  assert.equal(
    sent[4].url,
    "https://open.tiktokapis.com/v2/post/publish/content/init/",
  );
  assert.equal(
    headersOf(sent[4])["Content-Type"],
    "application/json; charset=UTF-8",
  );
  // An inbox upload: none of Direct Post's fields, no title.
  assert.deepEqual(JSON.parse(String(sent[4].init.body)), {
    media_type: "PHOTO",
    post_mode: "MEDIA_UPLOAD",
    post_info: { description: "Two slides #test" },
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: upload.photoUrls,
    },
  });

  assert.deepEqual(await client.fetchStatus("act.access-1", "p_pub_url~v2.1"), {
    status: "PUBLISH_COMPLETE",
    failReason: undefined,
    postIds: ["7234567890123456789"],
  });
  assert.deepEqual(JSON.parse(String(sent[5].init.body)), {
    publish_id: "p_pub_url~v2.1",
  });
  // An empty caption sends no description at all.
  await client.initPhotoUpload("act.access-1", { ...upload, description: "" });
  assert.deepEqual(JSON.parse(String(sent[6].init.body)).post_info, {});
  // Nothing follows a redirect, and every request has a deadline.
  for (const call of sent) {
    assert.equal(call.init.redirect, "manual");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test("TikTok errors say whether a request certainly did nothing", async () => {
  type Expected = {
    code: string;
    definite: boolean;
    httpStatus?: number;
    logId?: string;
  };
  const cases: [
    string,
    (sent: Sent) => Response | Promise<Response>,
    Expected,
  ][] = [
    [
      "an error answer",
      () =>
        json(
          {
            data: {},
            error: {
              code: "spam_risk_too_many_pending_share",
              message: "Too many pending shares",
              log_id: "log-1",
            },
          },
          403,
        ),
      {
        code: "spam_risk_too_many_pending_share",
        definite: true,
        httpStatus: 403,
        logId: "log-1",
      },
    ],
    [
      "a 5xx error answer",
      () =>
        json(
          { error: { code: "internal_error", message: "", log_id: "l2" } },
          500,
        ),
      { code: "internal_error", definite: true, httpStatus: 500 },
    ],
    [
      "a bodiless 5xx",
      () => new Response("", { status: 503 }),
      { code: "http_503", definite: false, httpStatus: 503 },
    ],
    [
      "a bodiless 4xx",
      () => new Response("", { status: 404 }),
      { code: "http_404", definite: true, httpStatus: 404 },
    ],
    [
      "an unreadable success",
      () => new Response("<html>OK</html>", { status: 200 }),
      { code: "bad_response", definite: false, httpStatus: 200 },
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
      { code: "network_error", definite: false },
    ],
    [
      "a timeout",
      // AbortSignal.timeout() doesn't keep Node's event loop alive, so the
      // fake holds it open the way a real socket would until the abort.
      ({ init }) =>
        new Promise((_, reject) => {
          const socket = setInterval(() => {}, 1000);
          init.signal!.addEventListener("abort", () => {
            clearInterval(socket);
            reject(init.signal!.reason);
          });
        }),
      { code: "timeout", definite: false },
    ],
  ];
  for (const [what, answer, expected] of cases) {
    const { fetch } = fakeFetch(answer);
    const client = tiktok.tiktokClient("k", "s", { fetch, timeoutMs: 20 });
    await assert.rejects(
      client.initPhotoUpload("act.access", upload),
      (error: InstanceType<typeof tiktok.TikTokError>) => {
        assert.ok(error instanceof tiktok.TikTokError, what);
        assert.equal(error.code, expected.code, what);
        assert.equal(error.definite, expected.definite, what);
        if (expected.httpStatus)
          assert.equal(error.httpStatus, expected.httpStatus, what);
        if (expected.logId) assert.equal(error.logId, expected.logId, what);
        return true;
      },
    );
  }
  // OAuth refusals use their own shape.
  const { fetch } = fakeFetch(() =>
    json(
      {
        error: "invalid_grant",
        error_description: "Refresh token is invalid or expired.",
        log_id: "log-oauth",
      },
      400,
    ),
  );
  await assert.rejects(
    tiktok.tiktokClient("k", "s", { fetch }).refresh("rft.old"),
    (error: InstanceType<typeof tiktok.TikTokError>) =>
      error.code === "invalid_grant" &&
      error.definite &&
      error.logId === "log-oauth" &&
      error.httpStatus === 400,
  );
});

test("tests can stand in for TikTok", async () => {
  const fake = {} as import("../src/lib/tiktok").TikTokApi;
  tiktok.useTikTok(fake);
  assert.equal(tiktok.tiktok(), fake);
  tiktok.useTikTok(undefined);
  assert.throws(() => tiktok.tiktok(), /not configured/);
  await withEnv(settings, () => assert.notEqual(tiktok.tiktok(), fake));
});

test("logs never carry TikTok tokens, secrets or signed media links", async () => {
  await withEnv(settings, () => {
    const text = redact(
      `refresh rft.abcdefghijk!1234.x access act.ZYXWVUTSRQPO.ab link https://slideo.example/api/tiktok/media/eyJ1IjoidXNlciJ9.c2lnbmF0dXJl/0.jpg client ${settings.TIKTOK_CLIENT_SECRET} key ${KEY} cron ${settings.CRON_SECRET}`,
    );
    for (const leaked of [
      "rft.abcdefghijk",
      "act.ZYXWVUTSRQPO",
      "eyJ1IjoidXNlciJ9",
      settings.TIKTOK_CLIENT_SECRET,
      KEY,
      settings.CRON_SECRET,
    ])
      assert.ok(!text.includes(leaked), leaked);
    assert.match(text, /\/api\/tiktok\/media\/\[redacted\]\/0\.jpg/);
  });
});

test("posts without a delivery keep their content and approval hashes and still export", async () => {
  const seeded = await seedSamplePost(store);
  // Saved through the studio API, as the editor saves: the schema parses it.
  const saved = await studio({
    action: "save",
    id: seeded.id,
    expected: seeded.revision,
    data: store.contentOf(seeded),
  });
  assert.equal(saved.status, 200, saved.body.error);
  const post = saved.body as Post;
  const [revision] = await sql<{ json: string; hash: string }>(
    "SELECT json, hash FROM revisions WHERE post_id=$1 AND revision=$2",
    [post.id, post.revision],
  );
  assert.doesNotMatch(revision.json, /delivery/);
  // The schema adds no key to content saved without one, so the stored
  // revision, its hash and any approval of it are unchanged.
  assert.equal(
    JSON.stringify(postSchema.parse(JSON.parse(revision.json))),
    revision.json,
  );
  assert.equal(JSON.stringify(store.contentOf(post)), revision.json);
  const approved = await studio({
    action: "approve",
    id: post.id,
    revision: post.revision,
  });
  assert.equal(approved.status, 200, approved.body.error);
  const [approval] = await sql<{ hash: string }>(
    "SELECT hash FROM approvals WHERE post_id=$1",
    [post.id],
  );
  assert.equal(approval.hash, revision.hash);
  const response = await exportOf(post);
  assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.delivery, "manual-export");
});

test("an inbox delivery is part of a post's content", async () => {
  const post = await seedSamplePost(store);
  const content = store.contentOf(post);
  const inbox = {
    ...content,
    delivery: { mode: "tiktok_inbox" as const, accountId: "account-1" },
  };
  assert.deepEqual(postSchema.parse(inbox).delivery, inbox.delivery);
  for (const delivery of [
    { mode: "direct_post", accountId: "account-1" },
    { mode: "tiktok_inbox", accountId: "" },
    { mode: "tiktok_inbox", accountId: "x".repeat(101) },
    { mode: "tiktok_inbox" },
    null,
  ])
    assert.equal(
      postSchema.safeParse({ ...content, delivery }).success,
      false,
      JSON.stringify(delivery),
    );
  const saved = await studio({
    action: "save",
    id: post.id,
    expected: post.revision,
    data: inbox,
  });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.status, "needs_review");
  const [revision] = await sql<{ json: string }>(
    "SELECT json FROM revisions WHERE post_id=$1 AND revision=$2",
    [post.id, saved.body.revision],
  );
  assert.match(
    revision.json,
    /"delivery":\{"mode":"tiktok_inbox","accountId":"account-1"\}/,
  );
  const missing = await studio({
    action: "save",
    id: post.id,
    expected: saved.body.revision,
    data: { ...content, delivery: { mode: "tiktok_inbox", accountId: "" } },
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /TikTok account/);
});

const at = new Date("2026-10-17T12:00:00.000Z");
const minutes = (n: number) =>
  new Date(at.getTime() + n * 60_000).toISOString();
const delivery = (id: string, nextAt: string | null): Delivery => ({
  id,
  postId: "post-1",
  revision: 1,
  accountId: "account-1",
  state: nextAt ? "scheduled" : "cancelled",
  dueAt: minutes(0),
  nextAt,
  attempts: 0,
  createdAt: minutes(-60),
  updatedAt: minutes(-60),
});

test("slideo_due_deliveries lists due deliveries in every account, oldest first", async () => {
  await store.put("delivery", delivery("late", minutes(-30)));
  await store.put("delivery", delivery("future", minutes(30)));
  await store.put("delivery", delivery("idle", null));
  await store.put("delivery", delivery("exact", minutes(0)));
  // Other kinds never count, even with a nextAt.
  await store.put("reminder", { id: "reminder", nextAt: minutes(-60) });
  await store.asAccount("someone-else", () =>
    store.put("delivery", delivery("theirs", minutes(-10))),
  );
  assert.deepEqual(await store.dueDeliveries(at, 25), [
    { user_id: "local", id: "late" },
    { user_id: "someone-else", id: "theirs" },
    { user_id: "local", id: "exact" },
  ]);
  assert.deepEqual(await store.dueDeliveries(at, 1), [
    { user_id: "local", id: "late" },
  ]);
  // At least one and at most 200 per call.
  assert.equal((await store.dueDeliveries(at, 0)).length, 1);
  await store.asAccount("busy", () =>
    store.transaction(async () => {
      for (let i = 0; i < 201; i++)
        await store.put("delivery", delivery(`busy-${i}`, minutes(-120)));
    }),
  );
  assert.equal((await store.dueDeliveries(at, 500)).length, 200);
});

test("the studio snapshot lists deliveries and TikTok accounts, never tokens", async () => {
  const account: TikTokAccount = {
    id: "account-1",
    openId: "open-1",
    displayName: "Ana",
    username: "ana",
    status: "connected",
    scopes: tiktok.SCOPES,
    connectedAt: minutes(0),
    updatedAt: minutes(0),
  };
  await store.put("tiktok_account", account);
  await store.put("tiktok_token", {
    id: account.id,
    sealed: "v1.c2VhbGVk.c2VhbGVk.c2VhbGVk",
    accessExpiresAt: minutes(60),
    refreshExpiresAt: minutes(60 * 24 * 365),
  });
  const snapshot = await (
    await backend()
  ).call<Record<string, unknown[]>>("slideo_state", {
    p_user: "local",
    p_since: "2026-01-01",
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "assets",
    "brands",
    "deliveries",
    "formats",
    "posts",
    "tiktokAccounts",
    "usedToday",
  ]);
  assert.deepEqual(snapshot.tiktokAccounts, [account]);
  assert.ok((snapshot.deliveries as Delivery[]).some((d) => d.id === "late"));
  assert.doesNotMatch(JSON.stringify(snapshot), /c2VhbGVk|sealed/);
  const response = await studioGet(
    new NextRequest("http://localhost:3000/api/studio", { headers: local }),
  );
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /c2VhbGVk|sealed|tiktok_token/);
});
