import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { hosted } from "@/lib/auth";
import { SlideoMark } from "@/components/studio-ui";
import { LoginNotes } from "../notes";

export const metadata: Metadata = { title: "Reset your password — Slideo" };

export default async function Forgot({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  await connection();
  if (!hosted()) redirect("/");
  const { error, message } = await searchParams;
  return (
    <main className="login">
      <form className="login-card" method="post" action="/auth/forgot">
        <SlideoMark size={32} />
        <h1>Reset your password</h1>
        <p>
          Enter your account&apos;s email. We&apos;ll send a link to choose a
          new password; your slideshows and images stay as they are.
        </p>
        <LoginNotes error={error} message={message} />
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <button className="button primary full" type="submit">
          Email me a reset link
        </button>
        <Link className="login-link" href="/login">
          Back to sign in
        </Link>
      </form>
    </main>
  );
}
