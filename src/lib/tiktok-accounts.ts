import { randomBytes } from "node:crypto";
import type { Delivery, TikTokAccount } from "./schema";
import {
  audit,
  find,
  get,
  list,
  now,
  put,
  remove,
  transaction,
  uid,
  userId,
} from "./store";
import {
  logTikTok,
  openTokens,
  sameSecret,
  SCOPES,
  sealTokens,
  signValue,
  tiktok,
  TikTokError,
  tiktokSettings,
  tokenAad,
  verifyValue,
  type TikTokConfig,
  type TikTokKeys,
  type TikTokUser,
  type TokenGrant,
  type TokenPair,
} from "./tiktok";

// Connecting TikTok accounts and keeping their tokens usable. Only the
// server holds tokens, sealed in tiktok_token records that no list, snapshot
// or response includes.

// The tokens of one tiktok_account, sealed for that account of one user.
export type TikTokToken = {
  id: string; // the tiktok_account's id
  sealed: string; // sealTokens(): "v1.iv.tag.data"
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export const RECONNECT_NEEDED = "reconnect_needed";
const RECONNECT_MESSAGE =
  "Reconnect TikTok in Settings. This slideshow will send once you do.";
// The owner must sign in to TikTok again. Deliveries for the account wait
// (held) until they do.
export class ReconnectNeeded extends Error {
  readonly code = RECONNECT_NEEDED;
  constructor() {
    super(RECONNECT_MESSAGE);
    this.name = "ReconnectNeeded";
  }
}

// The OAuth state travels in a signed cookie, sent only to /api/tiktok. It
// must be SameSite=Lax: a Strict cookie wouldn't come back with TikTok's
// redirect.
export const STATE_COOKIE = "slideo_tiktok_oauth";
const STATE_SECONDS = 10 * 60;
export const stateCookie = (value: string, maxAge = STATE_SECONDS) => ({
  name: STATE_COOKIE,
  value,
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/tiktok",
  maxAge,
});
type State = { state: string; user: string; exp: number };

const AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
// Where to send someone to connect TikTok, and the cookie that lets the
// callback recognise them. Reconnecting turns off TikTok's automatic
// approval, so they can choose a different account.
export function startConnect(
  config: TikTokConfig,
  user: string,
  reconnect: boolean,
) {
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_key: config.clientKey,
    response_type: "code",
    scope: SCOPES.join(","),
    redirect_uri: config.redirectUri,
    state,
  });
  if (reconnect) query.set("disable_auto_auth", "1");
  const payload: State = {
    state,
    user,
    exp: Math.floor(Date.now() / 1000) + STATE_SECONDS,
  };
  return {
    url: `${AUTHORIZE}?${query}`,
    cookie: signValue(config.keys.state, payload),
  };
}

export type ConnectResult =
  "connected" | "denied" | "scope" | "expired" | "failed";
// TikTok's redirect back, for the signed-in user in scope. The state check
// is what stops forged callbacks: the signed cookie must be current, name
// this user and carry the state TikTok returned. TikTok's error_description
// is never shown, because it is text anyone can put in the link.
export async function finishConnect(
  config: TikTokConfig,
  query: URLSearchParams,
  cookie: string | undefined,
): Promise<ConnectResult> {
  const saved = cookie
    ? verifyValue<Partial<State>>(config.keys.state, cookie)
    : null;
  const state = query.get("state");
  if (
    typeof saved?.state !== "string" ||
    saved.user !== userId() ||
    typeof saved.exp !== "number" ||
    saved.exp * 1000 <= Date.now() ||
    !state ||
    !sameSecret(saved.state, state)
  )
    return "expired";
  const error = query.get("error");
  if (error) return error === "access_denied" ? "denied" : "failed";
  const code = query.get("code");
  if (!code) return "failed";

  const issued = Date.now();
  let grant: TokenGrant;
  try {
    grant = await tiktok().exchangeCode(code, config.redirectUri);
  } catch (e) {
    logTikTok("TikTok connect", e);
    return "failed";
  }
  if (!grant.scopes.includes("video.upload")) {
    await discard(grant);
    return "scope";
  }
  let profile: TikTokUser;
  try {
    // The username needs user.info.profile; without it, links to posts
    // aren't known, and everything else works.
    profile = await tiktok().userInfo(
      grant.accessToken,
      grant.scopes.includes("user.info.profile")
        ? ["open_id", "display_name", "username"]
        : ["open_id", "display_name"],
    );
  } catch (e) {
    logTikTok("TikTok connect", e);
    await discard(grant);
    return "failed";
  }
  try {
    await transaction(async () => {
      const stamp = now();
      // One record per TikTok account: reconnecting keeps its id, and with
      // it the deliveries that name it.
      const existing = (await list<TikTokAccount>("tiktok_account")).find(
        (account) => account.openId === grant.openId,
      );
      const id = existing?.id ?? uid();
      await put<TikTokAccount>("tiktok_account", {
        id,
        openId: grant.openId,
        displayName: profile.displayName,
        ...(profile.username && { username: profile.username }),
        status: "connected",
        scopes: grant.scopes,
        connectedAt: stamp,
        updatedAt: stamp,
      });
      await put("tiktok_token", tokenRecord(config.keys, id, grant, issued));
      await audit("tiktok.connected", id);
      // Deliveries that waited for this account go when due, or now if
      // their time has passed.
      for (const delivery of await list<Delivery>("delivery"))
        if (
          delivery.accountId === id &&
          delivery.state === "held" &&
          delivery.error?.code === RECONNECT_NEEDED
        ) {
          await put<Delivery>("delivery", {
            ...delivery,
            state: "scheduled",
            nextAt: delivery.dueAt > stamp ? delivery.dueAt : stamp,
            error: undefined,
            updatedAt: stamp,
          });
          await audit("delivery.resumed", delivery.id);
        }
    });
  } catch (e) {
    // The caller logs this failure, not one from tidying up after it.
    await discard(grant).catch(() => {});
    throw e;
  }
  return "connected";
}

function tokenRecord(
  keys: TikTokKeys,
  id: string,
  grant: TokenGrant,
  // When the request went out: the lifetimes count from about then.
  issued: number,
): TikTokToken {
  return {
    id,
    sealed: sealTokens(keys, grant, tokenAad(userId(), id)),
    accessExpiresAt: new Date(issued + grant.expiresIn * 1000).toISOString(),
    refreshExpiresAt: new Date(
      issued + grant.refreshExpiresIn * 1000,
    ).toISOString(),
  };
}

// Revokes tokens TikTok issued that Slideo won't keep. Not when this studio
// already has the same TikTok account connected: a revoke may end TikTok's
// whole authorization for Slideo, and that connection with it.
async function discard(grant: TokenGrant) {
  const connected = (await list<TikTokAccount>("tiktok_account")).some(
    (account) =>
      account.openId === grant.openId && account.status === "connected",
  );
  if (connected) return;
  try {
    await tiktok().revoke(grant.accessToken);
  } catch (e) {
    logTikTok("TikTok revoke", e);
  }
}

function configured() {
  const config = tiktokSettings();
  if (!config) throw new Error("TikTok is not configured on this studio.");
  return config;
}
// Marks an account as needing a new TikTok sign-in, once, and returns the
// error that callers turn into held deliveries.
async function needsReconnect(accountId: string) {
  await transaction(async () => {
    const account = await find<TikTokAccount>("tiktok_account", accountId);
    if (account?.status !== "connected") return;
    await put<TikTokAccount>("tiktok_account", {
      ...account,
      status: "reconnect_needed",
      updatedAt: now(),
    });
    await audit("tiktok.reconnect_needed", accountId);
  });
  return new ReconnectNeeded();
}

const REFRESH_WITHIN_MS = 10 * 60_000;
// A usable access token for a connected account. One that expires within 10
// minutes is refreshed first. Call it outside transaction(), because it may
// call TikTok. Throws ReconnectNeeded when the owner must sign in again.
export async function accessToken(accountId: string): Promise<string> {
  const config = configured();
  const aad = tokenAad(userId(), accountId);
  const account = await find<TikTokAccount>("tiktok_account", accountId);
  const token = await find<TikTokToken>("tiktok_token", accountId);
  if (account?.status !== "connected" || !token)
    throw await needsReconnect(accountId);
  let pair: TokenPair;
  try {
    pair = openTokens(config.keys, token.sealed, aad);
  } catch {
    // Sealed with another TIKTOK_ENCRYPTION_KEY, or for another record.
    throw await needsReconnect(accountId);
  }
  const issued = Date.now();
  if (Date.parse(token.accessExpiresAt) - issued > REFRESH_WITHIN_MS)
    return pair.accessToken;
  if (Date.parse(token.refreshExpiresAt) <= issued)
    throw await needsReconnect(accountId);

  let grant: TokenGrant;
  try {
    grant = await tiktok().refresh(pair.refreshToken);
  } catch (error) {
    // TikTok can replace the refresh token on every refresh, so another
    // request's refresh may have used this one up and saved a newer pair.
    const current = await find<TikTokToken>("tiktok_token", accountId);
    if (current && current.sealed !== token.sealed)
      return openTokens(config.keys, current.sealed, aad).accessToken;
    if (error instanceof TikTokError && error.code === "invalid_grant")
      throw await needsReconnect(accountId);
    logTikTok("TikTok token refresh", error, { account: accountId });
    // Without a definite answer, the current token works until it expires.
    if (
      !(error instanceof TikTokError && error.definite) &&
      Date.parse(token.accessExpiresAt) > Date.now()
    )
      return pair.accessToken;
    throw error;
  }
  // Store the pair TikTok returned, its new refresh token included, unless
  // another request refreshed first: then the stored pair is the one to use.
  return transaction(async () => {
    const current = await find<TikTokToken>("tiktok_token", accountId);
    if (!current) throw new ReconnectNeeded();
    if (current.sealed !== token.sealed)
      return openTokens(config.keys, current.sealed, aad).accessToken;
    await put(
      "tiktok_token",
      tokenRecord(config.keys, accountId, grant, issued),
    );
    return grant.accessToken;
  });
}

// Asks TikTok to revoke a stored token, refreshing an expired access token
// first. Best effort: TikTok's answer doesn't change what Slideo forgets.
async function revokeStored(config: TikTokConfig, token: TikTokToken) {
  try {
    const pair = openTokens(
      config.keys,
      token.sealed,
      tokenAad(userId(), token.id),
    );
    let live = pair.accessToken;
    if (Date.parse(token.accessExpiresAt) <= Date.now()) {
      if (Date.parse(token.refreshExpiresAt) <= Date.now()) return;
      live = (await tiktok().refresh(pair.refreshToken)).accessToken;
    }
    await tiktok().revoke(live);
  } catch (error) {
    logTikTok("TikTok disconnect", error, { account: token.id });
  }
}

// Disconnects an account: TikTok revokes its token, Slideo forgets it, and
// scheduled deliveries for the account wait until it is reconnected.
export async function disconnect(accountId: string): Promise<TikTokAccount> {
  await get<TikTokAccount>("tiktok_account", accountId);
  const token = await find<TikTokToken>("tiktok_token", accountId);
  const config = tiktokSettings();
  if (token && config) await revokeStored(config, token);
  return transaction(async () => {
    const account = await get<TikTokAccount>("tiktok_account", accountId);
    const stamp = now();
    const updated: TikTokAccount = {
      ...account,
      status: "disconnected",
      updatedAt: stamp,
    };
    await remove("tiktok_token", accountId);
    await put("tiktok_account", updated);
    for (const delivery of await list<Delivery>("delivery"))
      if (delivery.accountId === accountId && delivery.state === "scheduled") {
        await put<Delivery>("delivery", {
          ...delivery,
          state: "held",
          nextAt: null,
          error: {
            code: RECONNECT_NEEDED,
            message: RECONNECT_MESSAGE,
            retryable: true,
          },
          updatedAt: stamp,
        });
        await audit("delivery.held", delivery.id);
      }
    await audit("tiktok.disconnected", accountId);
    return updated;
  });
}
