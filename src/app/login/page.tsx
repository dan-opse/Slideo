import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { hosted } from "@/lib/auth";
import { SlideoMark } from "@/components/studio-ui";

export const metadata: Metadata = { title: "Sign in — Slideo" };

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  // Decided per request: the build may not see the deployment's settings.
  await connection();
  // The local studio has no accounts.
  if (!hosted()) redirect("/");
  const { error, message } = await searchParams;
  return (
    <main className="login">
      <form className="login-card" method="post" action="/auth/signin">
        <SlideoMark size={32} />
        <h1>Sign in to Slideo</h1>
        <p>Create slideshows, approve every post, and export for TikTok.</p>
        {error && (
          <p className="login-note error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="login-note" role="status">
            {message}
          </p>
        )}
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
            minLength={8}
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
      </form>
    </main>
  );
}
