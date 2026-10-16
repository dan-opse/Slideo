// What the sign-in pages tell people when Supabase Auth refuses something.
// Known refusals get a message that says what to do next; anything else is
// logged for the operator and shown as a service problem, never as a wrong
// password. Pure, so the wording is tested without an Auth server.

// The part of a Supabase AuthError this file reads.
export type AuthFailure = {
  code?: string;
  status?: number;
  message?: string;
  name?: string;
};

// Supabase hashes passwords with bcrypt, which ignores bytes after the 72nd.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

export function passwordProblem(password: string, confirm?: string) {
  if (password.length < PASSWORD_MIN)
    return `Use at least ${PASSWORD_MIN} characters for your password.`;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX)
    return `Use at most ${PASSWORD_MAX} characters for your password.`;
  if (confirm !== undefined && password !== confirm)
    return "The two passwords don't match.";
  return null;
}

const UNAVAILABLE =
  "Sign-in is unavailable right now. Try again in a few minutes.";
const TOO_MANY = "Too many attempts. Wait a few minutes, then try again.";
const EMAIL_LIMIT =
  "The studio has sent as many emails as it can for now. Wait an hour, then try again.";

// No answer from Auth at all (unreachable, timed out) or a server fault.
const outage = (error: AuthFailure) =>
  !error.status ||
  error.status >= 500 ||
  error.name === "AuthRetryableFetchError";

export function signInMessage(error: AuthFailure) {
  switch (error.code) {
    case "invalid_credentials":
      return "That email and password don't match an account.";
    case "email_not_confirmed":
      return "Confirm your email first: open the link we sent when you created your account.";
    case "over_request_rate_limit":
      return TOO_MANY;
    case "user_banned":
      return "This account can't sign in. Contact the studio's owner.";
  }
  return outage(error) ? UNAVAILABLE : null;
}

export function signUpMessage(error: AuthFailure) {
  switch (error.code) {
    case "weak_password":
      return error.message || "Choose a stronger password.";
    case "email_address_invalid":
      return "Enter a valid email address.";
    case "user_already_exists":
    case "email_exists":
      return "That email already has an account. Sign in, or reset your password.";
    case "signup_disabled":
    case "email_provider_disabled":
      return "This studio isn't accepting new accounts.";
    case "over_email_send_rate_limit":
      return EMAIL_LIMIT;
    case "over_request_rate_limit":
      return TOO_MANY;
    case "email_address_not_authorized":
      return "This studio can't email that address yet. Its owner needs to set up email sending (custom SMTP).";
  }
  return outage(error) ? UNAVAILABLE : null;
}

// After asking for a reset or a new confirmation link. Supabase only sends
// (and only rate-limits) for addresses that have an account, so every outcome
// that depends on the account gets this same answer; the real reason goes to
// the server log.
export const LINK_SENT =
  "If an account uses that address, we've emailed it a link. Nothing after a few minutes? Check spam; email is limited to a few messages an hour, so wait an hour before asking again.";

export function emailLinkMessage(error: AuthFailure) {
  if (error.code === "email_address_invalid")
    return "Enter a valid email address.";
  if (error.code === "over_request_rate_limit") return TOO_MANY;
  // Unreachable before any account lookup: safe to say so.
  if (!error.status || error.name === "AuthRetryableFetchError")
    return "Email can't be sent right now. Try again in a few minutes.";
  return LINK_SENT;
}

export function newPasswordMessage(error: AuthFailure) {
  switch (error.code) {
    case "same_password":
      return "Choose a password different from your current one.";
    // Projects with "secure password change" on want a recent sign-in.
    case "reauthentication_needed":
      return "For your security, ask for a new reset link and set your password from it.";
    case "weak_password":
      return error.message || "Choose a stronger password.";
    case "over_request_rate_limit":
      return TOO_MANY;
  }
  return outage(error) ? UNAVAILABLE : null;
}

// A link from an email that can't be used. The two causes people can act on
// differently: an old or used link, and one opened in another browser (the
// studio keeps half of each link's proof in the browser that asked for it).
export const LINK_EXPIRED =
  "That email link has expired or was already used. Sign in, or ask for a new link.";
export const LINK_OTHER_BROWSER =
  "Open the link in the same browser where you asked for it, or ask for a new one.";

export function emailLinkFailure(error: AuthFailure) {
  if (
    error.code === "pkce_code_verifier_not_found" ||
    error.code === "bad_code_verifier"
  )
    return LINK_OTHER_BROWSER;
  return outage(error) ? UNAVAILABLE : LINK_EXPIRED;
}
