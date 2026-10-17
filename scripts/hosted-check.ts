// Walks a running hosted studio through sign-in, upload, approval, export,
// account isolation, and sign-out over plain HTTP, as a browser would. With
// MAILPIT_URL it also resets the first account's password from the email.
//
//   node --import tsx scripts/hosted-check.ts <studio URL>
//
// Accounts come from CHECK_ACCOUNTS="a@x.com:password,b@x.com:password"
// (two confirmed accounts, for a Vercel preview), or, with MAILPIT_URL set
// (the local Supabase stack's mail catcher), are created through the
// studio's own sign-up form and confirmed from the emails. It creates
// slideshows and images in those accounts; use test accounts.
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import {
  LINK_EXPIRED,
  LINK_OTHER_BROWSER,
  LINK_SENT,
} from "../src/lib/auth-messages";

const [base] = process.argv.slice(2);
if (!base) {
  console.error("Usage: scripts/hosted-check.ts <studio URL>");
  process.exit(1);
}
const site = new URL(base).origin;

class Browser {
  cookies = new Map<string, string>();
  // One request with this browser's cookies; redirects are returned, not
  // followed, so the check can see where the studio sends people.
  async go(url: string, init: RequestInit = {}) {
    const target = new URL(url, site);
    const same = target.origin === site;
    const response = await fetch(target, {
      ...init,
      redirect: "manual",
      headers: {
        ...(same && this.cookies.size
          ? {
              cookie: [...this.cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join("; "),
            }
          : {}),
        ...(same ? { origin: site } : {}),
        ...init.headers,
      },
    });
    if (same)
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(";");
        const at = pair.indexOf("=");
        const name = pair.slice(0, at).trim(),
          value = pair.slice(at + 1).trim();
        const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
        if (!value || expired) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    return response;
  }
  form(path: string, fields: Record<string, string>) {
    return this.go(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }
  async studio(body: Record<string, unknown>) {
    const response = await this.go("/api/studio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
}

let failures = 0;
function check(ok: unknown, what: string, detail?: unknown) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("     ", detail);
  }
  return !!ok;
}
const location = (response: Response) => response.headers.get("location") ?? "";

// The Supabase link in the newest email to `email` whose subject has `subject`.
async function emailLink(mailpit: string, email: string, subject: string) {
  const query = encodeURIComponent(`to:${email} subject:"${subject}"`);
  for (let i = 0; i < 40; i++) {
    const found = await (
      await fetch(`${mailpit}/api/v1/search?query=${query}`)
    ).json();
    const id = found.messages?.[0]?.ID;
    if (id) {
      const message = await (
        await fetch(`${mailpit}/api/v1/message/${id}`)
      ).json();
      return {
        link: String(message.Text).match(/https?:\/\/\S+verify\S+/)?.[0] ?? "",
        count: Number(found.messages_count ?? found.messages.length),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { link: "", count: 0 };
}

// A new account through the sign-up form, confirmed from its email.
async function signUp(mailpit: string) {
  const email = `check-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`,
    password = `pw-${randomBytes(9).toString("hex")}`;
  const browser = new Browser();
  const sent = await browser.form("/auth/signup", { email, password });
  check(
    sent.status === 303 && location(sent).includes("Check+your+email"),
    `sign-up asks ${email} to confirm`,
    location(sent),
  );
  const early = await new Browser().form("/auth/signin", { email, password });
  check(
    location(early).startsWith("/login?error=Confirm+your+email") &&
      location(early).includes("resend=1"),
    "an unconfirmed account cannot sign in, and is offered a new link",
    location(early),
  );
  const resent = await new Browser().form("/auth/resend", { email });
  check(
    location(resent) ===
      `/login?${new URLSearchParams({ message: LINK_SENT })}`,
    "asking for the confirmation link again gets the neutral answer",
    location(resent),
  );
  // The browser that signed up keeps the newest link's proof, and Supabase
  // keeps only the newest link: wait out its per-address limit and resend.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await browser.form("/auth/resend", { email });
  const { link } = await emailLink(mailpit, email, "Confirm");
  check(link, "the confirmation email arrived");
  // Supabase verifies the link, then sends the browser to /auth/confirm.
  const verified = await fetch(link, { redirect: "manual" });
  const back = location(verified);
  check(
    back.startsWith(`${site}/auth/confirm`),
    "the link returns to the studio's /auth/confirm",
    back,
  );
  const confirmed = await browser.go(back);
  check(
    confirmed.status === 303 && location(confirmed) === "/",
    "confirming signs the new account in",
    location(confirmed),
  );
  return { email, password, browser };
}

async function signIn(email: string, password: string) {
  const browser = new Browser();
  const response = await browser.form("/auth/signin", { email, password });
  check(
    response.status === 303 && location(response) === "/",
    `${email} signs in`,
    location(response),
  );
  return { email, password, browser };
}

const visitor = new Browser();
const home = await visitor.go("/");
check(
  home.status === 307 && location(home).endsWith("/login"),
  "signed-out visitors are sent to the sign-in page",
  `${home.status} ${location(home)}`,
);
check(
  (await visitor.go("/api/studio")).status === 401,
  "the API refuses requests without a session",
);
const crossSite = await visitor.go("/auth/signin", {
  method: "POST",
  headers: { "sec-fetch-site": "cross-site" },
});
check(crossSite.status === 403, "sign-in forms from other sites are refused");

const given = (process.env.CHECK_ACCOUNTS ?? "")
  .split(",")
  .filter(Boolean)
  .map((pair) => pair.split(":"));
const mailpit = process.env.MAILPIT_URL;
if (given.length < 2 && !mailpit) {
  console.error(
    "Set CHECK_ACCOUNTS to two confirmed accounts, or MAILPIT_URL.",
  );
  process.exit(1);
}
const [alice, bob] =
  given.length >= 2
    ? [
        await signIn(given[0][0], given[0][1]),
        await signIn(given[1][0], given[1][1]),
      ]
    : [await signUp(mailpit!), await signUp(mailpit!)];

const page = await alice.browser.go("/");
check(page.status === 200, "a signed-in account opens the studio");
const state = await (await alice.browser.go("/api/studio")).json();
check(
  state.settings?.hosted === true && state.settings?.email === alice.email,
  "the studio shows the hosted account",
  state.settings,
);

// Upload: the bytes go straight to Storage through the signed URL.
const target = await alice.browser.studio({ action: "uploadUrl" });
const image = await sharp({
  create: { width: 900, height: 1600, channels: 3, background: "#2a6f97" },
})
  .jpeg()
  .toBuffer();
const put = await fetch(target.body.url, {
  method: "PUT",
  headers: { "Content-Type": "image/jpeg" },
  body: new Uint8Array(image),
});
check(put.ok, "the browser uploads to Storage directly", put.status);
const big = await fetch(
  (await alice.browser.studio({ action: "uploadUrl" })).body.url,
  {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: new Uint8Array(21 * 1024 * 1024),
  },
);
check(
  !big.ok && (big.status === 413 || (await big.json()).statusCode === "413"),
  "Storage refuses an image over 20 MB",
  big.status,
);
const imported = await alice.browser.studio({
  action: "importUpload",
  id: target.body.id,
  name: "check.jpg",
  collection: "Check",
  rights: "Generated for this check",
});
check(
  imported.status === 200,
  "the upload imports into the library",
  imported.body,
);
const asset = imported.body.asset;

const created = await alice.browser.studio({
  action: "create",
  brandId: "demo-brand",
  formatId: "tiktok-photo",
  topic: "Hosted check",
  mode: "manual",
  slideCount: 3,
  collection: "Check",
});
check(created.status === 200, "a manual draft is created", created.body);
const post = created.body;
const approved = await alice.browser.studio({
  action: "approve",
  id: post.id,
  revision: post.revision,
});
check(
  approved.status === 200,
  "the draft renders and is approved",
  approved.body,
);
const exported = await alice.browser.go(
  `/api/export/${post.id}?revision=${post.revision}`,
);
const { url } = await exported.json();
const zip = url ? await fetch(url) : undefined;
check(
  zip?.ok && (await zip.arrayBuffer()).byteLength > 1000,
  "the approved package downloads from a signed Storage link",
);

// Bob sees none of it.
const theirs = await (await bob.browser.go("/api/studio")).json();
check(
  !theirs.posts?.some((p: { id: string }) => p.id === post.id) &&
    !theirs.assets?.some((a: { id: string }) => a.id === asset?.id),
  "a second account sees none of the first one's work",
);
check(
  (await bob.browser.go(`/api/media/${asset?.id}`)).status === 404,
  "a second account cannot open the first one's image",
);
check(
  (
    await bob.browser.studio({
      action: "approve",
      id: post.id,
      revision: post.revision,
    })
  ).status === 404,
  "a second account cannot approve the first one's slideshow",
);
check(
  (await bob.browser.go(`/api/export/${post.id}?revision=${post.revision}`))
    .status === 404,
  "a second account cannot download the first one's package",
);

// CHECK_REFRESH_WAIT: seconds to wait past the access token's lifetime
// (Supabase's JWT expiry), after which the studio must refresh the session.
const wait = Number(process.env.CHECK_REFRESH_WAIT || 0);
if (wait) {
  const before = [...alice.browser.cookies].join();
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  const later = await alice.browser.go("/api/studio");
  check(
    later.status === 200 && [...alice.browser.cookies].join() !== before,
    `after ${wait}s the expired session is refreshed`,
    later.status,
  );
}

const out = await alice.browser.form("/auth/signout", {});
check(
  out.status === 303 && location(out) === "/login",
  "signing out returns to the sign-in page",
);
check(
  (await alice.browser.go("/api/studio")).status === 401,
  "after signing out, the browser's requests are refused",
);

// Password recovery, from the reset email (needs the local mail catcher).
if (mailpit) {
  const neutral = `/login/forgot?${new URLSearchParams({ message: LINK_SENT })}`;
  const stranger = await new Browser().form("/auth/forgot", {
    email: `nobody-${randomBytes(4).toString("hex")}@example.com`,
  });
  check(
    location(stranger) === neutral,
    "a reset for an unknown email gets the neutral answer",
    location(stranger),
  );
  const resetter = new Browser();
  const asked = await resetter.form("/auth/forgot", { email: alice.email });
  // Straight away again: Supabase refuses it (one per address per interval)
  // only because the account exists, so the answer must not change, and
  // the first link must keep working in this browser.
  const again = await resetter.form("/auth/forgot", { email: alice.email });
  check(
    location(asked) === neutral && location(again) === neutral,
    "a real account's reset, and a refused repeat, get the same answer",
    [location(asked), location(again)],
  );
  const reset = await emailLink(mailpit, alice.email, "Reset");
  check(
    reset.count === 1,
    "the repeat was refused, so one reset email was sent",
    reset.count,
  );
  const verified = await fetch(reset.link, { redirect: "manual" });
  const landing = location(verified);
  check(
    landing.startsWith(`${site}/auth/confirm?code=`),
    "the reset link returns to the studio's /auth/confirm",
    landing,
  );
  const opened = await resetter.go(landing);
  check(
    location(opened) === "/login/reset",
    "the reset link opens the new-password form",
    location(opened),
  );
  const formPage = await resetter.go("/login/reset");
  const html = await formPage.text();
  check(
    formPage.status === 200 &&
      html.includes("Choose a new password") &&
      html.includes(alice.email),
    "the form names the account being reset",
  );
  const newPassword = `new-${randomBytes(9).toString("hex")}`;
  const mismatch = await resetter.form("/auth/reset", {
    password: newPassword,
    confirm: `${newPassword}x`,
  });
  check(
    location(mismatch).startsWith("/login/reset?error=The+two+passwords"),
    "mismatched passwords are refused",
    location(mismatch),
  );
  const short = await resetter.form("/auth/reset", {
    password: "short",
    confirm: "short",
  });
  check(
    location(short).startsWith("/login/reset?error=Use+at+least+8"),
    "a short password is refused",
    location(short),
  );
  const saved = await resetter.form("/auth/reset", {
    password: newPassword,
    confirm: newPassword,
  });
  check(
    location(saved).startsWith("/login?message=Your+password+was+changed"),
    "the new password is saved and sends people back to sign in",
    location(saved),
  );
  check(
    (await resetter.go("/api/studio")).status === 401,
    "saving the new password signs the resetting browser out",
  );
  const reused = await fetch(reset.link, { redirect: "manual" });
  const reusedAt = await new Browser().go(location(reused));
  check(
    location(reusedAt) ===
      `/login?${new URLSearchParams({ error: LINK_EXPIRED })}`,
    "a used reset link explains that it expired",
    location(reusedAt),
  );
  const old = await new Browser().form("/auth/signin", {
    email: alice.email,
    password: alice.password,
  });
  check(
    location(old).startsWith("/login?error=That+email+and+password"),
    "the old password no longer signs in",
    location(old),
  );
  const back = await signIn(alice.email, newPassword);
  const kept = await (await back.browser.go("/api/studio")).json();
  check(
    kept.settings?.email === alice.email &&
      kept.posts?.some((p: { id: string }) => p.id === post.id) &&
      kept.assets?.some((a: { id: string }) => a.id === asset?.id),
    "with the new password the account keeps its slideshow and image",
  );

  // A link opened in another browser can't be used: half its proof is in
  // the cookies of the browser that asked.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await new Browser().form("/auth/forgot", { email: alice.email });
  const elsewhere = await fetch(
    (await emailLink(mailpit, alice.email, "Reset")).link,
    { redirect: "manual" },
  );
  const stray = await new Browser().go(location(elsewhere));
  check(
    location(stray) ===
      `/login?${new URLSearchParams({ error: LINK_OTHER_BROWSER })}`,
    "a reset link opened in another browser says to use the asking browser",
    location(stray),
  );
  const nobody = new Browser();
  const expiredPage = await nobody.go("/login/reset");
  check(
    expiredPage.status === 200 &&
      (await expiredPage.text()).includes("This link has expired"),
    "the new-password form without a reset session offers a new link",
  );
  const noSession = await nobody.form("/auth/reset", {
    password: newPassword,
    confirm: newPassword,
  });
  check(
    location(noSession).startsWith("/login/forgot?error="),
    "saving a password without a reset session is refused",
    location(noSession),
  );
}

console.log(
  failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.",
);
process.exit(failures ? 1 : 0);
