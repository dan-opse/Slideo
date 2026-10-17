import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { hosted } from "./auth";

// TikTok inbox delivery: Login Kit connects an account, and the Content
// Posting API's MEDIA_UPLOAD mode puts approved slides in that account's
// TikTok inbox, where its owner adds a sound and posts. Only the server talks
// to TikTok; browsers never see a TikTok token or a signed media link.

// Everything the feature needs. On a local studio, or with any of these
// missing or invalid, it is unavailable: the routes refuse, the worker does
// nothing and the UI says why.
const SETTINGS = [
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_ENCRYPTION_KEY",
  "APP_URL",
  "CRON_SECRET",
] as const;
type Env = Record<string, string | undefined>;

export type TikTokKeys = {
  // AES-256-GCM key for stored access and refresh tokens.
  token: Buffer;
  // HMAC-SHA256 keys for media links and the OAuth state cookie.
  media: Buffer;
  state: Buffer;
};
export type TikTokConfig = {
  clientKey: string;
  clientSecret: string;
  // The studio's public origin, registered and verified with TikTok.
  appUrl: string;
  redirectUri: string;
  cronSecret: string;
  keys: TikTokKeys;
};

// One secret, a separate key for each purpose.
export function deriveKeys(secret: Buffer): TikTokKeys {
  const key = (info: string) =>
    Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
  return {
    token: key("slideo tiktok token encryption v1"),
    media: key("slideo tiktok media links v1"),
    state: key("slideo tiktok oauth state v1"),
  };
}

function read(env: Env): TikTokConfig | string {
  const value = (name: (typeof SETTINGS)[number]) => env[name]?.trim() ?? "";
  const missing = SETTINGS.filter((name) => !value(name));
  if (missing.length)
    return `TikTok inbox delivery needs ${missing.join(", ")}.`;
  const secret = Buffer.from(value("TIKTOK_ENCRYPTION_KEY"), "base64");
  if (secret.length !== 32)
    return "TIKTOK_ENCRYPTION_KEY must be 32 random bytes in base64 (openssl rand -base64 32).";
  const url = URL.canParse(value("APP_URL")) ? new URL(value("APP_URL")) : null;
  if (
    url?.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return "APP_URL must be the studio's https origin with no path, such as https://slideo.example.com.";
  if (value("CRON_SECRET").length < 16)
    return "CRON_SECRET must be at least 16 characters.";
  return {
    clientKey: value("TIKTOK_CLIENT_KEY"),
    clientSecret: value("TIKTOK_CLIENT_SECRET"),
    appUrl: url.origin,
    redirectUri: `${url.origin}/api/tiktok/callback`,
    cronSecret: value("CRON_SECRET"),
    keys: deriveKeys(secret),
  };
}
// The settings, whether or not this studio may use them: the worker reads
// its keys here. Routes and the UI check tiktokConfig() instead.
export function tiktokSettings(env: Env = process.env): TikTokConfig | null {
  const result = read(env);
  return typeof result === "string" ? null : result;
}
// Why the settings can't be used, for the operator's log. Null when they can,
// or when none is set and the feature is simply off.
export function tiktokSettingsProblem(env: Env = process.env) {
  if (!SETTINGS.some((name) => env[name]?.trim())) return null;
  const result = read(env);
  return typeof result === "string" ? result : null;
}
// Available only on a hosted studio with every setting; fails closed, like
// hostedSettingsProblem().
export function tiktokConfig(): TikTokConfig | null {
  return hosted() ? tiktokSettings() : null;
}
export function tiktokAvailability(): { available: boolean; reason?: string } {
  if (!hosted())
    return { available: false, reason: "Available when the studio is hosted." };
  if (!tiktokSettings())
    return {
      available: false,
      reason: "TikTok isn't set up on this studio yet.",
    };
  return { available: true };
}

const b64 = (data: Buffer) => data.toString("base64");
// AES-256-GCM, as "v1.iv.tag.data" in base64. The additional data binds the
// sealed value to one record: copied anywhere else, it fails to open.
export function seal(key: Buffer, text: string, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(data)].join(".");
}
export function unseal(key: Buffer, sealed: string, aad: string) {
  const [version, iv, tag, data, ...rest] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined || rest.length)
    throw new Error("Unreadable sealed value.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export type TokenPair = { accessToken: string; refreshToken: string };
// A tiktok_token is sealed for one account of one Slideo user.
export const tokenAad = (userId: string, accountId: string) =>
  `${userId}:${accountId}`;
export const sealTokens = (keys: TikTokKeys, pair: TokenPair, aad: string) =>
  seal(
    keys.token,
    JSON.stringify({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    }),
    aad,
  );
export function openTokens(
  keys: TikTokKeys,
  sealed: string,
  aad: string,
): TokenPair {
  const pair = JSON.parse(unseal(keys.token, sealed, aad)) as TokenPair;
  if (
    typeof pair?.accessToken !== "string" ||
    typeof pair?.refreshToken !== "string"
  )
    throw new Error("Unreadable sealed value.");
  return pair;
}

// A value anyone can read but only this server can make: base64url JSON and
// its HMAC-SHA256. Media links and the OAuth state cookie use it.
export function signValue(key: Buffer, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
export function verifyValue<T>(key: Buffer, token: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const given = Buffer.from(mac, "base64url");
  const expected = createHmac("sha256", key).update(body).digest();
  if (
    given.toString("base64url") !== mac ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  )
    return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
// Compares secrets in constant time, whatever their lengths.
export function sameSecret(a: string, b: string) {
  const hash = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(hash(a), hash(b));
}

// What TikTok answered, or why there is no answer.
export class TikTokError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly logId?: string;
  // True when TikTok answered with an error, so the request did nothing.
  // False after a timeout, a network failure, a bodiless 5xx or an answer
  // Slideo can't read: an upload may or may not have reached TikTok then.
  readonly definite: boolean;
  constructor(
    code: string,
    message: string,
    detail: {
      httpStatus?: number;
      logId?: string;
      definite?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: detail.cause });
    this.name = "TikTokError";
    this.code = code;
    this.httpStatus = detail.httpStatus ?? 0;
    this.logId = detail.logId;
    this.definite = detail.definite ?? true;
  }
}

// user.info.profile supplies the username for post links and is optional;
// connecting needs video.upload.
export const SCOPES = ["user.info.basic", "user.info.profile", "video.upload"];
export type TokenGrant = {
  openId: string;
  accessToken: string;
  refreshToken: string;
  // Lifetimes in seconds: about a day and a year.
  expiresIn: number;
  refreshExpiresIn: number;
  scopes: string[];
};
export type TikTokUser = {
  openId: string;
  displayName: string;
  username?: string;
};
export type PhotoUpload = {
  // Public HTTPS links TikTok downloads, in slide order.
  photoUrls: string[];
  coverIndex: number;
  description: string;
};
export type PublishStatus = {
  // PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE or FAILED.
  status: string;
  failReason?: string;
  // Public post ids, once the post is public and has passed moderation.
  postIds: string[];
};
export interface TikTokApi {
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>;
  refresh(refreshToken: string): Promise<TokenGrant>;
  revoke(accessToken: string): Promise<void>;
  userInfo(accessToken: string, fields: string[]): Promise<TikTokUser>;
  // Sends the photos to the user's inbox and returns the publish_id.
  initPhotoUpload(accessToken: string, upload: PhotoUpload): Promise<string>;
  fetchStatus(accessToken: string, publishId: string): Promise<PublishStatus>;
}

type Json = Record<string, unknown>;
const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const string = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
// TikTok post ids are 64-bit integers, past what a JavaScript number holds
// exactly: keep any such number as its digits.
function keepBigIntegers(
  _key: string,
  value: unknown,
  context?: { source?: string },
) {
  return typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    /^\d+$/.test(context?.source ?? "")
    ? context!.source
    : value;
}
const unreadable = (what: string, httpStatus: number, logId?: string) =>
  new TikTokError("bad_response", `TikTok's ${what} could not be read.`, {
    httpStatus,
    logId,
    definite: false,
  });

const API = "https://open.tiktokapis.com";
// The real client. Every request gives up after timeoutMs.
export function tiktokClient(
  clientKey: string,
  clientSecret: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): TikTokApi {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const send =
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
  async function call(path: string, init: RequestInit, oauth: boolean) {
    let httpStatus = 0,
      text: string;
    try {
      const response = await send(`${API}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = response.status;
      text = await response.text();
    } catch (error) {
      const late =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TikTokError(
        late ? "timeout" : "network_error",
        late
          ? "TikTok did not answer in time."
          : "TikTok could not be reached.",
        { httpStatus, definite: false, cause: error },
      );
    }
    let body: Json | undefined;
    try {
      body = object(text ? JSON.parse(text, keepBigIntegers) : undefined);
    } catch {
      body = undefined;
    }
    // The Content Posting and user APIs answer { data, error: { code,
    // message, log_id } }, with code "ok" on success. OAuth answers
    // { error, error_description, log_id } when it refuses.
    const failure = oauth ? body : object(body?.error);
    const code = oauth ? string(body?.error) : string(failure?.code);
    const logId = string(failure?.log_id);
    if (code && code !== "ok")
      throw new TikTokError(
        code,
        string(oauth ? failure?.error_description : failure?.message) ??
          `TikTok refused the request (${code}).`,
        { httpStatus, logId, definite: true },
      );
    if (httpStatus < 200 || httpStatus > 299)
      throw new TikTokError(
        `http_${httpStatus}`,
        `TikTok answered HTTP ${httpStatus}.`,
        { httpStatus, logId, definite: httpStatus < 500 },
      );
    return { body, httpStatus, logId };
  }
  const oauth = (path: string, fields: Record<string, string>) =>
    call(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          ...fields,
        }).toString(),
      },
      true,
    );
  const api = (path: string, accessToken: string, payload?: Json) =>
    call(
      path,
      {
        method: payload ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(payload && {
            "Content-Type": "application/json; charset=UTF-8",
          }),
        },
        ...(payload && { body: JSON.stringify(payload) }),
      },
      false,
    );
  async function grant(fields: Record<string, string>): Promise<TokenGrant> {
    const { body, httpStatus, logId } = await oauth("/v2/oauth/token/", fields);
    const openId = string(body?.open_id),
      accessToken = string(body?.access_token),
      refreshToken = string(body?.refresh_token);
    if (!openId || !accessToken || !refreshToken)
      throw unreadable("token answer", httpStatus, logId);
    return {
      openId,
      accessToken,
      refreshToken,
      expiresIn: Number(body?.expires_in) || 86_400,
      refreshExpiresIn: Number(body?.refresh_expires_in) || 31_536_000,
      scopes: (string(body?.scope) ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    };
  }
  return {
    exchangeCode: (code, redirectUri) =>
      grant({
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    refresh: (refreshToken) =>
      grant({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async revoke(accessToken) {
      await oauth("/v2/oauth/revoke/", { token: accessToken });
    },
    async userInfo(accessToken, fields) {
      const { body, httpStatus, logId } = await api(
        `/v2/user/info/?fields=${fields.map(encodeURIComponent).join(",")}`,
        accessToken,
      );
      const user = object(object(body?.data)?.user);
      const openId = string(user?.open_id);
      if (!openId) throw unreadable("account details", httpStatus, logId);
      return {
        openId,
        displayName: string(user?.display_name) ?? "",
        username: string(user?.username),
      };
    },
    async initPhotoUpload(accessToken, upload) {
      // Inbox uploads send none of Direct Post's fields (privacy_level,
      // disable_comment, auto_add_music, brand toggles).
      const { body, httpStatus, logId } = await api(
        "/v2/post/publish/content/init/",
        accessToken,
        {
          media_type: "PHOTO",
          post_mode: "MEDIA_UPLOAD",
          post_info: upload.description
            ? { description: upload.description }
            : {},
          source_info: {
            source: "PULL_FROM_URL",
            photo_cover_index: upload.coverIndex,
            photo_images: upload.photoUrls,
          },
        },
      );
      const publishId = string(object(body?.data)?.publish_id);
      if (!publishId) throw unreadable("upload answer", httpStatus, logId);
      return publishId;
    },
    async fetchStatus(accessToken, publishId) {
      const { body, httpStatus, logId } = await api(
        "/v2/post/publish/status/fetch/",
        accessToken,
        { publish_id: publishId },
      );
      const data = object(body?.data);
      const status = string(data?.status);
      if (!status) throw unreadable("upload status", httpStatus, logId);
      // Sic: TikTok spells the field "publicaly".
      const ids = data?.publicaly_available_post_id;
      return {
        status,
        failReason: string(data?.fail_reason),
        postIds: (Array.isArray(ids) ? ids : [])
          .filter((id) => typeof id === "string" || typeof id === "number")
          .map(String),
      };
    },
  };
}

let installed: TikTokApi | undefined;
// The client for this studio's TikTok app.
export function tiktok(): TikTokApi {
  if (installed) return installed;
  const config = tiktokSettings();
  if (!config) throw new Error("TikTok is not configured on this studio.");
  return tiktokClient(config.clientKey, config.clientSecret);
}
// Tests install a fake client; undefined restores the real one.
export function useTikTok(api: TikTokApi | undefined) {
  installed = api;
}
