// What the sign-in pages say for each Supabase Auth refusal. Uses the SDK's
// own error classes, so the codes and statuses match what Auth returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthApiError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
  AuthUnknownError,
} from "@supabase/supabase-js";
import {
  LINK_EXPIRED,
  LINK_OTHER_BROWSER,
  LINK_SENT,
  emailLinkFailure,
  emailLinkMessage,
  newPasswordMessage,
  passwordProblem,
  signInMessage,
  signUpMessage,
} from "../src/lib/auth-messages";

const api = (code: string, status: number, message = code) =>
  new AuthApiError(message, status, code);
const unreachable = new AuthRetryableFetchError("fetch failed", 0);
// What the SDK makes of an HTTP 5xx answer (see tests/auth-routes.test.ts
// for the same through its real HTTP handling).
const serverFault = new AuthRetryableFetchError("Bad Gateway", 502);
const unknownFault = new AuthUnknownError("bad gateway", null);
(unknownFault as { status?: number }).status = 502;

test("sign-in tells a wrong password apart from setup and service problems", () => {
  assert.equal(
    signInMessage(api("invalid_credentials", 400)),
    "That email and password don't match an account.",
  );
  assert.match(
    signInMessage(api("email_not_confirmed", 400))!,
    /^Confirm your email/,
  );
  assert.match(signInMessage(api("over_request_rate_limit", 429))!, /Wait/);
  for (const outage of [
    unreachable,
    serverFault,
    unknownFault,
    api("unexpected_failure", 500),
  ])
    assert.match(signInMessage(outage)!, /unavailable/, String(outage.status));
  // Anything else is left to the route, which logs it and shows a generic
  // problem, not "wrong password".
  assert.equal(signInMessage(api("something_new", 400)), null);
});

test("sign-up explains email limits and the default mailer's restriction", () => {
  assert.match(
    signUpMessage(
      api("over_email_send_rate_limit", 429, "email rate limit exceeded"),
    )!,
    /Wait an hour/,
  );
  assert.match(
    signUpMessage(api("email_address_not_authorized", 400))!,
    /custom SMTP/,
  );
  assert.equal(
    signUpMessage(api("weak_password", 422, "Password is known to be weak")),
    "Password is known to be weak",
  );
  assert.match(
    signUpMessage(api("user_already_exists", 422))!,
    /reset your password/,
  );
});

test("asking for a link never reveals whether the email has an account", () => {
  // Supabase answers unknown addresses with success, and refuses only known
  // ones for sending limits or mailer problems: all must read the same.
  for (const refusal of [
    api(
      "over_email_send_rate_limit",
      429,
      "For security purposes, you can only request this after 30 seconds.",
    ),
    api("over_email_send_rate_limit", 429, "email rate limit exceeded"),
    api("email_address_not_authorized", 400),
    new AuthRetryableFetchError("Error sending recovery email", 500),
    serverFault,
  ])
    assert.equal(emailLinkMessage(refusal), LINK_SENT, refusal.message);
  // These don't depend on any account.
  assert.match(
    emailLinkMessage(api("email_address_invalid", 400))!,
    /valid email/,
  );
  assert.match(emailLinkMessage(api("over_request_rate_limit", 429))!, /Wait/);
  assert.match(emailLinkMessage(unreachable)!, /can't be sent right now/);
});

test("new passwords are checked before Supabase sees them", () => {
  assert.match(passwordProblem("short", "short")!, /at least 8/);
  assert.match(passwordProblem("x".repeat(73), "x".repeat(73))!, /at most 72/);
  // bcrypt's limit is in bytes: 25 three-byte characters are 75.
  assert.match(passwordProblem("€".repeat(25))!, /at most 72/);
  assert.equal(
    passwordProblem("long enough 1", "long enough 2"),
    "The two passwords don't match.",
  );
  assert.equal(passwordProblem("long enough 1", "long enough 1"), null);
  // Sign-up has no confirmation field.
  assert.equal(passwordProblem("long enough 1"), null);
  assert.match(newPasswordMessage(api("same_password", 422))!, /different/);
  assert.match(
    newPasswordMessage(api("reauthentication_needed", 400))!,
    /new reset link/,
  );
  assert.match(newPasswordMessage(serverFault)!, /unavailable/);
});

test("unusable email links say what to do next", () => {
  for (const code of [
    "otp_expired",
    "flow_state_not_found",
    "flow_state_expired",
    "missing_code",
  ])
    assert.equal(
      emailLinkFailure(api(code, code === "flow_state_not_found" ? 404 : 400)),
      LINK_EXPIRED,
    );
  assert.equal(
    emailLinkFailure(new AuthPKCECodeVerifierMissingError()),
    LINK_OTHER_BROWSER,
  );
  assert.match(emailLinkFailure(unreachable), /unavailable/);
});
