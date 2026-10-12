"use client";
import { BarChart3, Download } from "lucide-react";
import { useState } from "react";
import type { Post } from "@/lib/schema";
import { plural } from "@/lib/defaults";
import { Field, Modal } from "./studio-ui";

export function Results({
  posts,
  busy,
  error,
  onClearError,
  onSave,
}: {
  posts: Post[];
  busy: boolean;
  error: string;
  onClearError: () => void;
  onSave: (id: string, data: Record<string, number | null>) => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<Post | null>(null);
  const close = () => {
    setEdit(null);
    onClearError();
  };
  const csv = () => {
    // One row per snapshot, so growth over time survives the export.
    const rows = [
      ["Post", "URL", "Views", "Likes", "Comments", "Shares", "Measured at"],
      ...posts.flatMap((p) => {
        const snapshots = [...(p.metricsHistory ?? []), p.metrics].filter(
          (m) => !!m,
        );
        return (snapshots.length ? snapshots : [undefined]).map((m) => [
          p.title,
          p.publishedUrl || "",
          m?.views ?? "",
          m?.likes ?? "",
          m?.comments ?? "",
          m?.shares ?? "",
          m?.measuredAt || "",
        ]);
      }),
    ];
    const data = rows
      .map((row) =>
        row
          .map(
            (c) =>
              '"' +
              String(c)
                .replace(/^[=+\-@]/, "'$&")
                .replace(/"/g, '""') +
              '"',
          )
          .join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "slideo-results.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!posts.length)
    return (
      <div className="empty-state">
        <BarChart3 size={42} strokeWidth={1} />
        <h2>A fresh page for your results.</h2>
        <p>
          After publishing, record the TikTok post URL from the editor.
          <br />
          Then add views, likes, comments, and shares here.
        </p>
      </div>
    );
  return (
    <>
      <div className="section-heading">
        <h2>{plural(posts.length, "published post")}</h2>
        <button className="button secondary" onClick={csv}>
          <Download size={16} />
          Export CSV
        </button>
      </div>
      <div className="results-table">
        <table>
          <thead>
            <tr>
              {[
                "Post",
                "Views",
                "Likes",
                "Comments",
                "Shares",
                "Measured",
                "",
              ].map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={p.publishedUrl} target="_blank" rel="noreferrer">
                    {p.title} ↗
                  </a>
                  <small>Owner-confirmed</small>
                </td>
                {(["views", "likes", "comments", "shares"] as const).map(
                  (k) => (
                    <td key={k}>{p.metrics?.[k]?.toLocaleString() ?? "—"}</td>
                  ),
                )}
                <td>
                  {p.metrics
                    ? new Date(p.metrics.measuredAt).toLocaleDateString()
                    : "Not recorded"}
                  {!!p.metricsHistory?.length && (
                    <small>
                      {plural(p.metricsHistory.length, "earlier snapshot")}
                    </small>
                  )}
                </td>
                <td>
                  <button className="text-button" onClick={() => setEdit(p)}>
                    {p.metrics ? "Record new snapshot" : "Add results"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal
          title="Record a snapshot."
          subtitle="Leave unknown values empty. Earlier snapshots are kept for comparison."
          onClose={close}
          error={error}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const saved = await onSave(
                edit.id,
                Object.fromEntries(
                  [...f.entries()].map(([k, v]) => [
                    k,
                    v === "" ? null : Number(v),
                  ]),
                ),
              );
              if (saved) setEdit(null);
            }}
          >
            {(["views", "likes", "comments", "shares"] as const).map((k) => (
              <Field key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
                <input
                  type="number"
                  name={k}
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  defaultValue={edit.metrics?.[k] ?? ""}
                />
              </Field>
            ))}
            <div className="modal-actions">
              <button className="button primary" disabled={busy}>
                Save snapshot
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
