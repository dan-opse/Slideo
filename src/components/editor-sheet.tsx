"use client";
// The editor's confirmation and publishing sheets. They only present
// choices; the editor owns every change they trigger.
import { Download, X } from "lucide-react";
import type { Post } from "@/lib/schema";
import { Control } from "./editor-controls";

export type Sheet = "discard" | "delete" | "queue" | "publish";

// datetime-local input value in the viewer's time zone.
export const localDate = (date: string) =>
  date
    ? new Date(
        new Date(date).getTime() - new Date(date).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";

export function ActionSheet({
  sheet,
  saved,
  plannedAt,
  busy,
  error,
  onDismiss,
  onDiscard,
  onSaveChanges,
  onDelete,
  onQueue,
  onDownload,
  onPublish,
}: {
  sheet: Sheet;
  saved: Post;
  // The planned time currently in the editor, which may be unsaved.
  plannedAt: string;
  busy: boolean;
  error: string;
  onDismiss: () => void;
  onDiscard: () => void;
  onSaveChanges: () => void;
  onDelete: () => void;
  onQueue: (plannedAt: string, reapprove: boolean) => void;
  onDownload: () => void;
  onPublish: (url: string) => void;
}) {
  return (
    <div className="photo-sheet-backdrop">
      <div
        className="photo-sheet"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={
          sheet === "discard"
            ? "Unsaved changes"
            : sheet === "queue"
              ? "Add to queue"
              : sheet === "publish"
                ? "Publish to TikTok"
                : "Delete slideshow"
        }
      >
        <button
          className="photo-tool sheet-close"
          aria-label="Close action"
          onClick={onDismiss}
        >
          <X size={17} />
        </button>
        {sheet === "discard" ? (
          <>
            <h2>Keep your changes?</h2>
            <p>Your slideshow has unsaved edits.</p>
            <div className="photo-sheet-buttons">
              <button className="photo-action" onClick={onDiscard}>
                Discard changes
              </button>
              <button
                className="photo-action orange"
                disabled={busy}
                onClick={onSaveChanges}
              >
                Save changes
              </button>
            </div>
          </>
        ) : sheet === "delete" ? (
          <>
            <h2>Delete this slideshow?</h2>
            <p>
              It will be removed from your gallery. Its revisions remain stored
              locally.
            </p>
            <button
              className="photo-action danger"
              disabled={busy}
              onClick={onDelete}
            >
              Delete slideshow
            </button>
          </>
        ) : sheet === "queue" ? (
          <>
            <h2>Add to your queue</h2>
            <p>
              Choose a planned posting time. You’ll publish manually after
              approval.
            </p>
            {saved.status === "approved" && (
              <p className="photo-sheet-warning" role="note">
                The posting time is part of your approval, so scheduling creates
                a new revision that needs approving again before you can
                download it.
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const value = form.get("plannedAt") as string;
                // Re-approval only happens when the owner explicitly asks.
                const reapprove =
                  (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
                    "value",
                  ) === "approve";
                onQueue(new Date(value).toISOString(), reapprove);
              }}
            >
              <Control label="Planned posting time">
                <input
                  name="plannedAt"
                  type="datetime-local"
                  required
                  defaultValue={localDate(plannedAt)}
                />
              </Control>
              <button
                className={`photo-action ${saved.status === "approved" ? "" : "orange"}`}
                disabled={busy}
                value="queue"
              >
                Save to queue
              </button>
              {saved.status === "approved" && (
                <button
                  className="photo-action orange"
                  disabled={busy}
                  value="approve"
                >
                  Save and approve again
                </button>
              )}
            </form>
          </>
        ) : (
          <>
            <h2>
              {saved.status === "published"
                ? "Correct the TikTok link"
                : "Publish to TikTok"}
            </h2>
            <p>
              {saved.status === "published"
                ? `Recorded as ${saved.publishedUrl}. Replace it only if that link is wrong.`
                : "Download the approved images, upload them in TikTok, then record the published link here."}
            </p>
            <button
              className="photo-action blue"
              disabled={busy}
              onClick={onDownload}
            >
              <Download size={16} />
              Download images
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const url = new FormData(event.currentTarget).get("url");
                onPublish(String(url));
              }}
            >
              <Control label="TikTok post URL">
                <input
                  name="url"
                  type="url"
                  required
                  defaultValue={saved.publishedUrl ?? ""}
                  placeholder="https://www.tiktok.com/@you/photo/… or https://vm.tiktok.com/…"
                />
              </Control>
              <button className="photo-action orange" disabled={busy}>
                {saved.status === "published"
                  ? "Save corrected link"
                  : "Record published post"}
              </button>
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="photo-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
