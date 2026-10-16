// The sign-in route's reset and resend requests, through the real Supabase
// SDK with only `fetch` replaced: Auth's HTTP answers go through the SDK's
// own error handling (which reports HTTP 5xx as a retryable fetch error).
// Supabase only tries to email, and so only fails or rate-limits, for
// addresses that have an account; whatever it answers, a requester must see
// the same redirect and the same cookies as for an unknown address.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://auth.test";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
const { POST } = await import("../src/app/auth/[action]/route");
const { NextRequest } = await import("next/server");

// What Supabase Auth answers each address, as its HTTP response.
const MEMBER = "member@example.com";
type Answer = { status: number; body: object } | "unreachable";
let answer: Answer = { status: 200, body: {} };
const sent: { path: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const body = JSON.parse(String(init?.body ?? "{}"));
  sent.push({ path: url.pathname, body });
  if (url.origin !== "http://auth.test") throw new Error(`unexpected ${url}`);
  // Unknown addresses always get a plain success.
  const reply = body.email === MEMBER ? answer : { status: 200, body: {} };
  if (reply === "unreachable") throw new TypeError("fetch failed");
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const ACCOUNT_DEPENDENT: Record<string, Answer> = {
  "the email could not be sent (HTTP 500)": {
    status: 500,
    body: {
      code: 500,
      error_code: "unexpected_failure",
      msg: "Error sending recovery email",
    },
  },
  "a gateway timed out while sending (HTTP 504)": {
    status: 504,
    body: { message: "Gateway Timeout" },
  },
  "the default mailer refuses the address": {
    status: 400,
    body: {
      code: 400,
      error_code: "email_address_not_authorized",
      msg: `Email address "${MEMBER}" cannot be used as it is not authorized`,
    },
  },
  "the address asked too recently": {
    status: 429,
    body: {
      code: 429,
      error_code: "over_email_send_rate_limit",
      msg: "For security purposes, you can only request this after 42 seconds.",
    },
  },
  "the hourly email allowance is used up": {
    status: 429,
    body: {
      code: 429,
      error_code: "over_email_send_rate_limit",
      msg: "email rate limit exceeded",
    },
  },
};

async function ask(action: "forgot" | "resend", email: string) {
  const response = await POST(
    new NextRequest(`http://localhost:3000/auth/${action}`, {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      body: new URLSearchParams({ email }),
    }),
    { params: Promise.resolve({ action }) },
  );
  const cookies = response.headers.getSetCookie();
  return {
    status: response.status,
    location: response.headers.get("location"),
    cookies,
    // Everything an observer could compare, with what is random (values,
    // the flow id in one name) or time-dependent masked.
    shape: cookies
      .map((line) =>
        line
          .replace(/=[^;]*/, "=…")
          .replace(/-flow-[0-9a-f]+-/, "-flow-…-")
          .replace(/Expires=[^;]*/, "Expires=…"),
      )
      .sort(),
  };
}

// The verifier a cookie holds, as @supabase/ssr encodes it.
function verifier(cookies: string[]) {
  const line = cookies.find((c) => /auth-token-code-verifier=/.test(c));
  const value = line?.match(/=([^;]*)/)?.[1] ?? "";
  const json = Buffer.from(value.replace(/^base64-/, ""), "base64url");
  return String(JSON.parse(json.toString())).split("/")[0];
}

for (const action of ["forgot", "resend"] as const) {
  test(`${action}: every account-dependent answer looks like an unknown address`, async () => {
    answer = { status: 200, body: {} };
    const unknown = await ask(action, "nobody@example.com");
    assert.equal(unknown.status, 303);
    assert.match(unknown.location!, /\?message=If\+an\+account\+uses/);
    // The neutral answer carries the new link's verifier.
    assert.ok(unknown.cookies.length > 0);
    assert.equal(
      (await ask(action, MEMBER)).shape.join("\n"),
      unknown.shape.join("\n"),
      "a sent email",
    );
    for (const [what, reply] of Object.entries(ACCOUNT_DEPENDENT)) {
      answer = reply;
      const member = await ask(action, MEMBER);
      assert.equal(member.status, unknown.status, what);
      assert.equal(member.location, unknown.location, what);
      assert.equal(member.shape.join("\n"), unknown.shape.join("\n"), what);
    }
  });
}

test("a refused repeat keeps the verifier that matches its request", async () => {
  // Supabase matches the emailed link to the address's newest request, even
  // one refused as too soon: the cookie must be that request's verifier.
  answer = ACCOUNT_DEPENDENT["the address asked too recently"];
  sent.length = 0;
  const repeat = await ask("forgot", MEMBER);
  const challenge = sent.find((r) => r.path === "/auth/v1/recover")?.body
    .code_challenge;
  assert.equal(
    createHash("sha256").update(verifier(repeat.cookies)).digest("base64url"),
    challenge,
  );
});

test("only answers that can't depend on the address are told apart", async () => {
  // Auth never answered: it never saw the address.
  answer = "unreachable";
  const down = await ask("forgot", MEMBER);
  assert.match(down.location!, /\?error=Email\+can%27t\+be\+sent/);
  // The browser keeps the proof of the link it already has.
  assert.equal(down.cookies.length, 0);
  // Checked before Supabase looks the address up, for every address.
  answer = {
    status: 400,
    body: { code: 400, error_code: "email_address_invalid", msg: "invalid" },
  };
  assert.match(
    (await ask("forgot", MEMBER)).location!,
    /\?error=Enter\+a\+valid\+email/,
  );
  const empty = await ask("forgot", "");
  assert.match(empty.location!, /\?error=Enter\+your\+email/);
});
