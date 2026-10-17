import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { hosted } from "@/lib/auth";
import { PASSWORD_MIN } from "@/lib/auth-messages";
import { SlideoMark } from "@/components/studio-ui";
import { LoginNotes } from "./notes";

export const metadata: Metadata = { title: "Sign in — Slideo" };

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; resend?: string }>;
}) {
  // Decided per request: the build may not see the deployment's settings.
  await connection();
  // The local studio has no accounts.
  if (!hosted()) redirect("/");
  const { error, message, resend } = await searchParams;
  return (
    <main className="login">
      <form className="login-card" method="post" action="/auth/signin">
        <SlideoMark size={32} />
        <h1>Sign in to Slideo</h1>
        <p>Create slideshows, approve every post, and export for TikTok.</p>
        <LoginNotes error={error} message={message} />
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={PASSWORD_MIN}
            required
          />
        </label>
        <button className="button primary full" type="submit">
          Sign in
        </button>
        <button
          className="button secondary full"
          type="submit"
          formAction="/auth/signup"
        >
          Create account
        </button>
        {resend && (
          // Needs only the email, so the password may be left empty.
          <button
            className="button secondary full"
            type="submit"
            formAction="/auth/resend"
            formNoValidate
          >
            Send the confirmation link again
          </button>
        )}
        <Link className="login-link" href="/login/forgot">
          Forgot your password?
        </Link>
      </form>
    </main>
  );
}
