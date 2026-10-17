// A stand-in for TikTok's API, installed with useTikTok(). Every call is
// recorded. Each method answers like TikTok unless a test replaces it in
// `answer`, before or after installing the fake.
import type { TikTokApi, TokenGrant } from "../src/lib/tiktok";

export const ALL_SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "video.upload",
];
type Call = { method: keyof TikTokApi; args: unknown[] };

export function fakeTikTok(answers: Partial<TikTokApi> = {}) {
  const calls: Call[] = [];
  let issued = 0;
  // A new pair of tokens each time, as TikTok issues them.
  const grant = (openId = "open-1", scopes = ALL_SCOPES): TokenGrant => {
    issued++;
    return {
      openId,
      accessToken: `act.access-${issued}`,
      refreshToken: `rft.refresh-${issued}`,
      expiresIn: 86_400,
      refreshExpiresIn: 31_536_000,
      scopes,
    };
  };
  const defaults: TikTokApi = {
    exchangeCode: async () => grant(),
    refresh: async () => grant(),
    revoke: async () => {},
    userInfo: async (_token, fields) => ({
      openId: "open-1",
      displayName: "Ana",
      ...(fields.includes("username") && { username: "ana" }),
    }),
    initPhotoUpload: async () => {
      throw new Error("Unexpected upload.");
    },
    fetchStatus: async () => {
      throw new Error("Unexpected status check.");
    },
  };
  const answer = { ...defaults, ...answers };
  const api = Object.fromEntries(
    (Object.keys(defaults) as (keyof TikTokApi)[]).map((method) => [
      method,
      (...args: unknown[]) => {
        calls.push({ method, args });
        return (answer[method] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as TikTokApi;
  return {
    api,
    answer,
    grant,
    calls,
    // The arguments of each call to one method, in order.
    called: (method: keyof TikTokApi) =>
      calls.filter((call) => call.method === method).map((call) => call.args),
  };
}
