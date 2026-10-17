"use client";
// TikTok inbox delivery in Settings: connecting accounts, and the notice
// shown when TikTok's sign-in returns to the studio.
import { Inbox, Loader2, Unplug } from "lucide-react";
import type { StudioState, TikTokAccount } from "@/lib/schema";
import { Modal } from "./studio-ui";

const accountStatus: Record<TikTokAccount["status"], string> = {
  connected: "Connected",
  reconnect_needed: "Reconnect needed",
  disconnected: "Disconnected",
};
// A full-page navigation: the route sends the browser on to TikTok.
const CONNECT = "/api/tiktok/connect";
const accountName = (account: TikTokAccount) =>
  account.username ? `@${account.username}` : account.displayName || "TikTok";

export function TikTokCard({
  tiktok,
  onDisconnect,
}: {
  tiktok: StudioState["settings"]["tiktok"];
  onDisconnect: (account: TikTokAccount) => void;
}) {
  const connected = tiktok.accounts.some((a) => a.status !== "disconnected");
  return (
    <section className="settings-card">
      <span className="stat-icon sage">
        <Inbox size={23} />
      </span>
      <h2>Your TikTok inbox.</h2>
      <p>
        {tiktok.available
          ? "Connect TikTok, and approved slideshows you choose arrive in your TikTok inbox around their planned time. You add a sound and post them in the TikTok app."
          : tiktok.reason}
      </p>
      {tiktok.accounts.length > 0 && (
        <ul className="tiktok-accounts" aria-label="TikTok accounts">
          {tiktok.accounts.map((account) => (
            <li key={account.id}>
              <div>
                <strong>{account.displayName || "TikTok account"}</strong>
                {account.username && <small>@{account.username}</small>}
              </div>
              <span className="status">
                <i />
                {accountStatus[account.status]}
              </span>
              <div className="tiktok-account-actions">
                {tiktok.available && (
                  <form method="get" action={CONNECT}>
                    <input type="hidden" name="reconnect" value="1" />
                    <button
                      type="submit"
                      className="text-button"
                      aria-label={`Reconnect ${accountName(account)}`}
                    >
                      Reconnect
                    </button>
                  </form>
                )}
                {account.status !== "disconnected" && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Disconnect ${accountName(account)}`}
                    onClick={() => onDisconnect(account)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {tiktok.available && (
        <>
          <form method="get" action={CONNECT}>
            <button type="submit" className="button primary">
              {connected ? "Connect another account" : "Connect TikTok"}
            </button>
          </form>
          <small className="tiktok-note">
            Uploads need TikTok 31.8 or later. Nothing is posted until you post
            it in TikTok.
          </small>
        </>
      )}
    </section>
  );
}

export function TikTokDisconnectModal({
  account,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  account: TikTokAccount;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={`Disconnect ${accountName(account)}?`}
      onClose={onClose}
      error={error}
    >
      <p className="form-note">
        Slideo stops using this account and asks TikTok to remove its access.
        Slideshows scheduled for it wait until you reconnect it.
      </p>
      <div className="modal-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? <Loader2 className="spin" size={16} /> : <Unplug size={16} />}
          Disconnect
        </button>
      </div>
    </Modal>
  );
}

// What each ?tiktok= outcome from the connect and callback routes says.
const outcomes: Record<string, { ok: boolean; message: string }> = {
  connected: { ok: true, message: "TikTok connected." },
  denied: {
    ok: false,
    message:
      "TikTok wasn't connected because access wasn't allowed. Choose Connect TikTok to try again.",
  },
  scope: { ok: false, message: "Allow uploads to connect TikTok." },
  expired: {
    ok: false,
    message: "That TikTok sign-in expired. Choose Connect TikTok again.",
  },
  failed: {
    ok: false,
    message: "TikTok couldn't be connected. Try again in a few minutes.",
  },
  unavailable: {
    ok: false,
    message: "TikTok isn't set up on this studio yet.",
  },
  wrong_host: {
    ok: false,
    message: "Connect TikTok from this studio's main address.",
  },
};
export function tiktokNotice(outcome: string, appUrl?: string) {
  if (!Object.hasOwn(outcomes, outcome)) return null;
  if (outcome === "wrong_host" && appUrl)
    return {
      ok: false,
      message: `Connect TikTok from ${appUrl}, this studio's main address.`,
    };
  return outcomes[outcome];
}
// Reads the outcome once and takes it out of the address bar, so reloading
// the page doesn't show the notice again.
export function takeTikTokNotice(appUrl?: string) {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("tiktok");
  if (outcome === null) return null;
  url.searchParams.delete("tiktok");
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  return tiktokNotice(outcome, appUrl);
}
