// TikTok inbox delivery in Settings: why it's unavailable, connecting and
// reconnecting accounts, the disconnect confirmation, and the notices shown
// when TikTok's sign-in returns to the studio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudioState, TikTokAccount } from "../src/lib/schema";
const { SettingsView } = await import("../src/components/studio-views");
const { TikTokDisconnectModal, tiktokNotice } =
  await import("../src/components/tiktok-settings");

type TikTok = StudioState["settings"]["tiktok"];
const settings = (tiktok: TikTok, hosted = true): StudioState["settings"] => ({
  aiReady: false,
  model: "gpt-test",
  dailyLimit: 20,
  usedToday: 0,
  hosted,
  email: hosted ? "ana@example.com" : null,
  tiktok,
});
const markup = (tiktok: TikTok, hosted = true) =>
  renderToStaticMarkup(
    createElement(SettingsView, {
      settings: settings(tiktok, hosted),
      onDisconnectTikTok: () => {},
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;/g, "’")
    .replace(/\s+/g, " ");
const account = (
  id: string,
  status: TikTokAccount["status"],
  more: Partial<TikTokAccount> = {},
): TikTokAccount => ({
  id,
  openId: `open-${id}`,
  displayName: "Ana",
  username: "ana",
  status,
  scopes: ["user.info.basic", "user.info.profile", "video.upload"],
  connectedAt: "2026-10-17T12:00:00.000Z",
  updatedAt: "2026-10-17T12:00:00.000Z",
  ...more,
});
const connectForms = (html: string) =>
  html.match(
    /<form (?=[^>]*action="\/api\/tiktok\/connect")(?=[^>]*method="get")[^>]*>/g,
  ) ?? [];

test("Settings says why TikTok is unavailable and keeps today's copy", () => {
  for (const [hosted, reason] of [
    [false, "Available when the studio is hosted."],
    [true, "TikTok isn’t set up on this studio yet."],
  ] as const) {
    const html = markup(
      { available: false, reason: reason.replace("’", "'"), accounts: [] },
      hosted,
    );
    const page = text(html);
    assert.match(page, /Your TikTok inbox\./);
    assert.ok(page.includes(reason), reason);
    assert.deepEqual(connectForms(html), []);
    assert.doesNotMatch(page, /Connect TikTok|Reconnect|Disconnect/);
    // The rest of the page reads as it did before TikTok delivery.
    assert.match(page, /Publishing Manual export, with approval/);
    assert.match(page, /publishing-provider integration are upcoming/);
  }
});

test("an available studio offers Connect TikTok", () => {
  const html = markup({
    available: true,
    appUrl: "https://slideo.example",
    accounts: [],
  });
  assert.equal(connectForms(html).length, 1);
  const page = text(html);
  assert.match(page, /Connect TikTok/);
  assert.match(page, /arrive in your TikTok inbox around their planned time/);
  assert.match(page, /TikTok 31\.8 or later/);
  assert.doesNotMatch(page, /Reconnect|Disconnect/);
});

test("each account shows its status, with Reconnect and Disconnect", () => {
  const html = markup({
    available: true,
    appUrl: "https://slideo.example",
    accounts: [
      account("a", "connected"),
      account("b", "reconnect_needed", { username: "bea", displayName: "Bea" }),
      account("c", "disconnected", {
        username: undefined,
        displayName: "Cy",
      }),
    ],
  });
  const page = text(html);
  assert.match(page, /Ana @ana Connected Reconnect Disconnect/);
  assert.match(page, /Bea @bea Reconnect needed Reconnect Disconnect/);
  // A disconnected account can be reconnected, not disconnected again.
  assert.match(page, /Cy Disconnected Reconnect (?!Disconnect)/);
  assert.match(page, /Connect another account/);
  // Reconnecting asks TikTok to let the owner choose an account again.
  assert.equal(connectForms(html).length, 4);
  assert.equal(
    html.match(/<input type="hidden" name="reconnect" value="1"\/>/g)?.length,
    3,
  );
  assert.match(html, /aria-label="Disconnect @ana"/);
  assert.match(html, /aria-label="Reconnect @bea"/);
});

test("accounts stay listed, and can be disconnected, after TikTok is switched off", () => {
  const html = markup({
    available: false,
    reason: "TikTok isn't set up on this studio yet.",
    accounts: [account("a", "connected")],
  });
  const page = text(html);
  assert.match(page, /Ana @ana Connected Disconnect/);
  assert.deepEqual(connectForms(html), []);
  assert.doesNotMatch(page, /Reconnect/);
});

test("disconnecting asks first", () => {
  const page = text(
    renderToStaticMarkup(
      createElement(TikTokDisconnectModal, {
        account: account("a", "connected"),
        busy: false,
        error: "",
        onClose: () => {},
        onConfirm: () => {},
      }),
    ),
  );
  assert.match(page, /Disconnect @ana\?/);
  assert.match(page, /wait until you reconnect it/);
  assert.match(page, /Cancel Disconnect/);
});

test("TikTok's sign-in outcomes become a toast or a readable error", () => {
  assert.deepEqual(tiktokNotice("connected"), {
    ok: true,
    message: "TikTok connected.",
  });
  for (const [outcome, message] of [
    ["denied", /access wasn't allowed/],
    ["scope", /^Allow uploads to connect TikTok\.$/],
    ["expired", /expired/],
    ["failed", /couldn't be connected/],
    ["unavailable", /isn't set up/],
    ["wrong_host", /^Connect TikTok from this studio's main address\.$/],
  ] as const) {
    const notice = tiktokNotice(outcome)!;
    assert.equal(notice.ok, false, outcome);
    assert.match(notice.message, message, outcome);
  }
  assert.equal(
    tiktokNotice("wrong_host", "https://slideo.example")!.message,
    "Connect TikTok from https://slideo.example, this studio's main address.",
  );
  // Anything else in the link shows nothing.
  for (const outcome of [
    "",
    "connected ",
    "<b>hi</b>",
    "constructor",
    "__proto__",
  ])
    assert.equal(tiktokNotice(outcome), null, outcome);
});
