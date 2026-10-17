import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { hosted, sessionAccount } from "@/lib/auth";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/auth-messages";
import { SlideoMark } from "@/components/studio-ui";
import { LoginNotes } from "../notes";

export const metadata: Metadata = { title: "Choose a new password — Slideo" };

// Reached from a password reset email, whose link signs the account in.
export default async function Reset({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await connection();
  if (!hosted()) redirect("/");
  const { error } = await searchParams;
  const account = await sessionAccount((await cookies()).getAll());
  if (!account)
    return (
      <main className="login">
        <div className="login-card">
          <SlideoMark size={32} />
          <h1>This link has expired</h1>
          <p>
            Reset links work once, for an hour, in the browser that asked for
            them. Ask for a new one to choose your password.
          </p>
          <Link className="button primary full" href="/login/forgot">
            Ask for a new link
          </Link>
          <Link className="login-link" href="/login">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  return (
    <main className="login">
      <form className="login-card" method="post" action="/auth/reset">
        <SlideoMark size={32} />
        <h1>Choose a new password</h1>
        <p>
          For {account.email ?? "your account"}. Afterwards you&apos;ll sign in
          with it again; other devices are signed out within the hour.
        </p>
        <LoginNotes error={error} />
        {/* Lets password managers save the new password for this account. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={account.email ?? ""}
          readOnly
          hidden
        />
        <label className="field">
          <span>New password</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            required
          />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            required
          />
        </label>
        <button className="button primary full" type="submit">
          Save new password
        </button>
      </form>
    </main>
  );
}
