"use client";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  Folder,
  Loader2,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import Image from "next/image";
import type { Asset } from "@/lib/schema";
import { collectionsOf, plural } from "@/lib/defaults";
import { FileUpload } from "./ui/file-upload";
import { uploadImage } from "./request";
import { Field, Modal } from "./studio-ui";

export type AssetDeletion = { ids: string[]; title: string; detail: string };

const listNames = (all: string[]) => {
  const names = all.slice(0, 3);
  const more = all.length - names.length;
  if (more) return `${names.join(", ")} and ${more} more`;
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : names[0];
};
export function deletionMessage({
  deleted,
  kept,
}: {
  deleted: Asset[];
  kept: Asset[];
}) {
  const done = deleted.length
    ? `Deleted ${plural(deleted.length, "image")}.`
    : "";
  if (!kept.length) return done;
  const one = kept.length === 1;
  return `${done} Kept ${listNames(kept.map((asset) => asset.name))}: ${one ? "a slideshow uses it" : "slideshows use them"}, so ${one ? "it stays" : "they stay"} with ${one ? "that slideshow" : "those slideshows"} and ${one ? "leaves" : "leave"} your library.`.trim();
}

export function AssetLibrary({
  library,
  onEdit,
  onDelete,
}: {
  library: Asset[];
  onEdit: (asset: Asset) => void;
  onDelete: (request: AssetDeletion) => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const folders = collectionsOf(library).map((name) => ({
    name,
    images: library.filter((asset) => asset.collection === name),
  }));
  // A folder emptied by a delete or a rename falls back to the folder list.
  const open = folders.find((item) => item.name === folder);
  const keys = open
    ? open.images.map((asset) => asset.id)
    : folders.map((item) => item.name);
  // Deleted items drop out of the selection because they are no longer shown.
  const selected = keys.filter((key) => picked.has(key));
  const go = (name: string | null) => {
    setFolder(name);
    setPicked(new Set());
  };
  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const remove = () => {
    if (open) {
      onDelete({
        ids: selected,
        title: `Delete ${plural(selected.length, "image")}?`,
        detail: `This deletes ${selected.length === 1 ? "this image" : `these ${selected.length} images`} from ${open.name}.`,
      });
      return;
    }
    const chosen = folders.filter((item) => picked.has(item.name));
    const images = chosen.flatMap((item) => item.images);
    onDelete({
      ids: images.map((asset) => asset.id),
      title: `Delete ${plural(chosen.length, "folder")}?`,
      detail: `This deletes ${chosen.length === 1 ? "the folder" : "the folders"} ${listNames(chosen.map((item) => item.name))}, along with the ${plural(images.length, "image")} ${chosen.length === 1 ? "in it" : "in them"}.`,
    });
  };
  const check = (key: string, label: string) => (
    <label className="asset-check" title={label}>
      <input
        type="checkbox"
        aria-label={label}
        checked={picked.has(key)}
        onChange={() => toggle(key)}
      />
    </label>
  );
  return (
    <>
      <div className="section-heading asset-heading">
        {open ? (
          <div className="asset-folder-title">
            <button className="text-button" onClick={() => go(null)}>
              <ChevronLeft size={15} /> All folders
            </button>
            <h2>
              {open.name} <span>· {plural(open.images.length, "image")}</span>
            </h2>
          </div>
        ) : (
          <h2>
            {plural(folders.length, "folder")}{" "}
            <span>· {plural(library.length, "image")}</span>
          </h2>
        )}
        <div className="asset-toolbar">
          {selected.length ? (
            <>
              <span>{selected.length} selected</span>
              <button
                className="text-button"
                onClick={() => setPicked(new Set())}
              >
                Clear
              </button>
              <button className="button secondary" onClick={remove}>
                <Trash2 size={15} />
                Delete
              </button>
            </>
          ) : (
            <button
              className="text-button"
              onClick={() => setPicked(new Set(keys))}
            >
              Select all
            </button>
          )}
        </div>
      </div>
      <div className="asset-grid">
        {open
          ? open.images.map((a) => (
              <article
                key={a.id}
                className={`asset-card ${picked.has(a.id) ? "selected" : ""}`}
              >
                <div className="asset-image">
                  <Image
                    unoptimized
                    fill
                    sizes="300px"
                    src={`/api/media/${a.id}`}
                    alt={a.name}
                    style={{ objectFit: "cover" }}
                  />
                  {check(a.id, `Select ${a.name}`)}
                </div>
                <div>
                  <strong>{a.name}</strong>
                  <small>
                    {a.collection} · {a.width} × {a.height}
                  </small>
                  <span className={a.rights ? "rights" : "rights missing"}>
                    {a.rights ? <Check size={13} /> : <AlertCircle size={13} />}{" "}
                    {a.rights || "Rights not recorded: add them to approve"}
                  </span>
                  <button
                    className="text-button asset-edit"
                    aria-label={`Edit ${a.name}`}
                    onClick={() => onEdit(a)}
                  >
                    <Pencil size={13} /> Edit details
                  </button>
                </div>
              </article>
            ))
          : folders.map(({ name, images }) => (
              <article
                key={name}
                className={`asset-card asset-folder ${picked.has(name) ? "selected" : ""}`}
              >
                <button
                  className="asset-folder-open"
                  aria-label={`Open ${name}, ${plural(images.length, "image")}`}
                  onClick={() => go(name)}
                >
                  <span
                    className="asset-image asset-folder-cover"
                    data-count={Math.min(images.length, 4)}
                  >
                    {images.slice(0, 4).map((a) => (
                      <span key={a.id}>
                        <Image
                          unoptimized
                          fill
                          sizes="150px"
                          src={`/api/media/${a.id}`}
                          alt=""
                          style={{ objectFit: "cover" }}
                        />
                      </span>
                    ))}
                  </span>
                  <span className="asset-folder-info">
                    <strong>
                      <Folder size={13} /> <span>{name}</span>
                    </strong>
                    <small>{plural(images.length, "image")}</small>
                  </span>
                </button>
                {check(name, `Select folder ${name}`)}
              </article>
            ))}
      </div>
    </>
  );
}
export function AssetModal({
  asset,
  busy,
  error,
  onClose,
  onSave,
  onRemove,
}: {
  asset: Asset;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (data: { name: string; collection: string; rights: string }) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Modal
      title="Image details."
      subtitle="Rights recorded here are checked again when you approve."
      onClose={onClose}
      error={error}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          onSave({
            name: String(f.get("name")),
            collection: String(f.get("collection")),
            rights: String(f.get("rights")),
          });
        }}
      >
        <Field label="Name">
          <input
            name="name"
            required
            maxLength={150}
            defaultValue={asset.name}
          />
        </Field>
        <Field label="Collection name">
          <input
            name="collection"
            required
            maxLength={80}
            defaultValue={asset.collection}
          />
        </Field>
        <Field
          label="Usage rights"
          hint="Record ownership or the license that allows you to use this image."
        >
          <textarea
            name="rights"
            required
            maxLength={1000}
            rows={2}
            defaultValue={asset.rights}
          />
        </Field>
        <div className="modal-actions">
          {confirming ? (
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={onRemove}
            >
              Confirm removal
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Remove from library
            </button>
          )}
          <button className="button primary" disabled={busy}>
            Save details
          </button>
        </div>
        {confirming && (
          <p className="form-note">
            Slideshows that already use this image keep it. It will no longer
            appear in pickers or collections.
          </p>
        )}
      </form>
    </Modal>
  );
}

export function UploadModal({
  busy,
  error,
  onClose,
  onClearError,
  onUpload,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onClearError: () => void;
  // Runs the upload; the task resolves to the confirmation message.
  onUpload: (task: () => Promise<string>) => Promise<boolean>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  return (
    <Modal
      title="Gather your images."
      subtitle="JPEG, PNG, or WebP. Up to 20 MB per image."
      onClose={onClose}
      error={message || error}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!files.length) {
            setMessage("Choose at least one image to upload.");
            return;
          }
          const data = new FormData(e.currentTarget);
          void onUpload(async () => {
            let added = 0,
              duplicates = 0;
            for (const file of files) {
              const fd = new FormData();
              fd.set("file", file);
              fd.set("collection", String(data.get("collection")));
              fd.set("rights", String(data.get("rights")));
              const body = await uploadImage(fd).catch((e: Error) => {
                throw new Error(
                  `${added ? `${plural(added, "image")} added. ` : ""}${file.name}: ${e.message}`,
                );
              });
              if (body.duplicate) duplicates++;
              else added++;
            }
            return (
              `${plural(added, "image")} added to your library.` +
              (duplicates
                ? ` ${plural(duplicates, "image")} already in that collection.`
                : "")
            );
          });
        }}
      >
        <FileUpload
          files={files}
          onFilesChange={(next) => {
            setFiles(next);
            setMessage("");
            onClearError();
          }}
          accept="image/jpeg,image/png,image/webp"
          maxSize={20 * 1024 * 1024}
          disabled={busy}
          label="Drop images here or click to browse"
          hint="JPEG, PNG or WebP • Up to 20 MB each"
        />
        <Field label="Collection name">
          <input
            name="collection"
            defaultValue="My collection"
            required
            maxLength={80}
          />
        </Field>
        <Field
          label="Usage rights"
          hint="Record ownership or the license that allows you to use these images."
        >
          <textarea
            name="rights"
            required
            placeholder="e.g. Original photos taken by me"
            maxLength={1000}
            rows={2}
          />
        </Field>
        <div className="modal-actions">
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <Upload size={17} />
            )}
            Upload images
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AssetDeleteModal({
  request,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  request: AssetDeletion;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={request.title} onClose={onClose} error={error}>
      <p>
        {request.detail} Images that a slideshow uses can’t be deleted: those
        slideshows keep them, and they leave your library.
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
          {busy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
          Delete
        </button>
      </div>
    </Modal>
  );
}
