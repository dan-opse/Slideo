"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
const SlideshowEditor = dynamic(() => import("./slideshow-editor"), {
  ssr: false,
});
const FormatDashboard = dynamic(() => import("./format-dashboard"), {
  ssr: false,
});
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Folder,
  FolderOpen,
  ImagePlus,
  Layers3,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  AlertCircle,
} from "lucide-react";
import type { Asset, Brand, Format, Post, StudioState } from "@/lib/schema";
import { PHOTO_RENDER_VERSION } from "@/lib/photo-layout";
import {
  blankFormat,
  collectionsOf,
  defaultBrandId,
  libraryAssets,
  plural,
} from "@/lib/defaults";
import { RenderFallback } from "./render-fallback";
import { Dropdown } from "./ui/dropdown";
import { FileUpload } from "./ui/file-upload";
type View =
  | "Overview"
  | "Review queue"
  | "Formats"
  | "Assets"
  | "Brands"
  | "Calendar"
  | "Analytics"
  | "Settings";
const views: { name: View; icon: typeof LayoutDashboard }[] = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Review queue", icon: CheckCheck },
  { name: "Formats", icon: Layers3 },
  { name: "Assets", icon: FolderOpen },
  { name: "Brands", icon: FileText },
  { name: "Calendar", icon: CalendarDays },
  { name: "Analytics", icon: BarChart3 },
];
const statusLabel = {
  needs_review: "Needs review",
  approved: "Approved",
  published: "Published",
  archived: "Deleted",
};
const imgUrl = (p: Post, i = 0) =>
  `/api/render/${p.id}/${p.revision}/${i}${p.slides[i]?.design === "photo" ? `?v=${PHOTO_RENDER_VERSION}` : ""}`;
const blankBrand = {
  name: "",
  product: "",
  audience: "",
  tone: "Warm, practical, specific",
  facts: "",
  prohibited: "No invented results, testimonials, or statistics.",
  destination: "",
};
async function api(action: string, data: Record<string, unknown> = {}) {
  const r = await fetch("/api/studio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      body.error || "The studio did not respond correctly. Try again.",
    );
  return body;
}
function SlideoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="8.5"
        y="2.5"
        width="11"
        height="15"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="4.5"
        y="6.5"
        width="11"
        height="15"
        rx="2.5"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
function IconButton({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
  error,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline handlers; reading the latest one through a ref keeps
  // the focus effect from re-running (and stealing focus) on every render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>("input,button,select,textarea")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = Array.from(
          el?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,select,textarea,a[href]",
          ) || [],
        );
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {error && (
          <div className="alert modal-alert" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

type WebsiteIdea = { topic: string; angle: string };

function CreateSlideshowModal({
  state,
  initialFormat,
  initialHook,
  busy,
  error,
  onClose,
  onCreate,
  onOpenSettings,
}: {
  state: StudioState;
  initialFormat?: Format;
  initialHook?: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onCreate: (data: Record<string, unknown>) => Promise<unknown>;
  onOpenSettings: () => void;
}) {
  const firstFormat =
    initialFormat ??
    state.formats.find((format) => format.design === "photo") ??
    state.formats[0];
  const firstBrand = state.brands.find(
    (brand) => brand.id === defaultBrandId(state, firstFormat),
  );
  const clampCount = (count: number) =>
    Math.max(2, Math.min(10, Math.round(count || 2)));
  const [brandId, setBrandId] = useState(firstBrand?.id || "");
  const [formatId, setFormatId] = useState(firstFormat?.id || "");
  const [topic, setTopic] = useState(initialHook || "");
  const [selectedHook, setSelectedHook] = useState(initialHook || "");
  const [sourceUrl, setSourceUrl] = useState(firstBrand?.destination || "");
  const [slideCount, setSlideCount] = useState(
    clampCount(firstFormat?.slideCount || 6),
  );
  const [mode, setMode] = useState<"manual" | "ai">(
    state.settings.aiReady ? "ai" : "manual",
  );
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [ideas, setIdeas] = useState<WebsiteIdea[]>([]);
  const [ideaLoading, setIdeaLoading] = useState(false);
  const [ideaError, setIdeaError] = useState("");
  const canCreate = Boolean(brandId && formatId && topic.trim());
  // A format with a saved structure fixes its own slide count.
  const structured = state.formats.find(
    (format) => format.id === formatId,
  )?.structure;
  const count = structured?.length ?? slideCount;

  const generateWebsiteIdeas = async () => {
    setIdeaLoading(true);
    setIdeaError("");
    setIdeas([]);
    try {
      const result = (await api("ideas", {
        brandId,
        url: sourceUrl,
      })) as { ideas: WebsiteIdea[] };
      setIdeas(result.ideas);
    } catch (error) {
      setIdeaError(
        error instanceof Error ? error.message : "Could not generate ideas.",
      );
    } finally {
      setIdeaLoading(false);
    }
  };

  return (
    <Modal
      title="Plant a new idea."
      subtitle="Choose your brief and format. Make it your own."
      onClose={onClose}
      error={error}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            brandId,
            formatId,
            topic,
            mode,
            slideCount,
            selectedHook: selectedHook || undefined,
          });
        }}
      >
        <Field label="What’s the idea?">
          <textarea
            required
            maxLength={2000}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. Five small habits for a more creative week"
            rows={3}
          />
        </Field>

        <button
          type="button"
          className="idea-trigger"
          disabled={!state.settings.aiReady}
          aria-expanded={ideasOpen}
          onClick={() => setIdeasOpen((open) => !open)}
        >
          <span className="idea-trigger-icon">
            <Sparkles size={16} />
          </span>
          <span>
            <strong>Generate ideas from a website</strong>
            <small>
              {state.settings.aiReady
                ? "Turn a product page into five starting points."
                : "Add an OpenAI API key in Settings to use this tool."}
            </small>
          </span>
          <ChevronDown
            size={17}
            className={ideasOpen ? "idea-chevron open" : "idea-chevron"}
          />
        </button>
        {!state.settings.aiReady && (
          <button
            type="button"
            className="settings-link"
            onClick={onOpenSettings}
          >
            Open Settings
          </button>
        )}
        {ideasOpen && state.settings.aiReady && (
          <section className="idea-panel" aria-label="Website idea generator">
            <Field
              label="Website URL"
              hint="Public HTTPS pages only. The page is read on this computer and is not saved."
            >
              <input
                type="url"
                inputMode="url"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder="https://example.com"
              />
            </Field>
            <button
              type="button"
              className="button secondary generate-ideas"
              disabled={ideaLoading || !sourceUrl.trim()}
              onClick={() => void generateWebsiteIdeas()}
            >
              {ideaLoading ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              {ideaLoading ? "Reading the website…" : "Generate 5 ideas"}
            </button>
            {ideaError && (
              <div className="idea-error" role="alert">
                <AlertCircle size={16} />
                <span>{ideaError}</span>
                <button
                  type="button"
                  disabled={ideaLoading}
                  onClick={() => void generateWebsiteIdeas()}
                >
                  Retry
                </button>
              </div>
            )}
            {ideas.length > 0 && (
              <div className="ideas-list" aria-label="Generated ideas">
                {ideas.map((idea, index) => (
                  <button
                    type="button"
                    className="idea-card"
                    key={`${idea.topic}-${index}`}
                    onClick={() => setTopic(`${idea.topic}\n\n${idea.angle}`)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{idea.topic}</strong>
                      <p>{idea.angle}</p>
                    </div>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <div className="form-row">
          <Field label="Brand brief">
            <Dropdown
              label="Brand brief"
              placeholder="Choose a brand"
              value={brandId}
              items={state.brands.map((brand) => ({
                value: brand.id,
                label: brand.name,
              }))}
              onChange={(nextId) => {
                setBrandId(nextId);
                setSourceUrl(
                  state.brands.find((brand) => brand.id === nextId)
                    ?.destination || "",
                );
                setIdeas([]);
                setIdeaError("");
              }}
            />
          </Field>
          <Field label="Format">
            <Dropdown
              label="Format"
              placeholder="Choose a format"
              value={formatId}
              items={state.formats.map((format) => ({
                value: format.id,
                label: format.name,
                hint: `${format.slideCount} slides`,
              }))}
              onChange={(nextId) => {
                setFormatId(nextId);
                setSelectedHook("");
                const next = state.formats.find(
                  (format) => format.id === nextId,
                );
                if (next) setSlideCount(clampCount(next.slideCount));
                // Follow the brand the chosen format is set up for.
                if (next?.brandId && next.brandId !== brandId) {
                  setBrandId(next.brandId);
                  setSourceUrl(
                    state.brands.find((brand) => brand.id === next.brandId)
                      ?.destination || "",
                  );
                  setIdeas([]);
                }
              }}
            />
          </Field>
          <Field
            label="Number of slides"
            hint={
              structured
                ? undefined
                : "Changing the format resets this to its default."
            }
          >
            <input
              type="number"
              min={2}
              max={10}
              step={1}
              required
              disabled={!!structured}
              value={count}
              onChange={(event) => setSlideCount(Number(event.target.value))}
              onBlur={() => setSlideCount(clampCount(slideCount))}
            />
          </Field>
        </div>
        {!!state.formats.find((format) => format.id === formatId)?.hooks
          ?.length && (
          <Field
            label="Opening hook"
            hint="A selected hook is kept exactly as written. Tone & Style applies to the other slides and caption."
          >
            <Dropdown
              label="Opening hook"
              value={selectedHook}
              items={[
                { value: "", label: "Create a hook from the idea" },
                ...(
                  state.formats.find((format) => format.id === formatId)
                    ?.hooks ?? []
                ).map((hook) => ({ value: hook, label: hook })),
              ]}
              onChange={(hook) => {
                setSelectedHook(hook);
                if (!topic || topic === selectedHook) setTopic(hook);
              }}
            />
          </Field>
        )}
        <p className="slide-count-note">
          <Layers3 size={15} />
          This slideshow will contain <strong>{count} slides</strong>
          {structured && ", set by the format’s slide structure"}.
        </p>
        <Field label="Writing mode">
          <Dropdown
            label="Writing mode"
            value={mode}
            items={[
              {
                value: "manual",
                label: "Manual — start with an editable outline",
              },
              {
                value: "ai",
                label: state.settings.aiReady
                  ? "AI writing — use my OpenAI key"
                  : "AI writing — add credentials in Settings",
                disabled: !state.settings.aiReady,
              },
            ]}
            onChange={setMode}
          />
        </Field>
        <p className="form-note">
          Every draft starts in Needs review. Nothing is published
          automatically.
        </p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !canCreate || count < 2 || count > 10}
          >
            {busy ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <Sparkles size={17} />
            )}
            Create draft
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SlideImage({
  post,
  index = 0,
  className = "",
  eager = false,
}: {
  post: Post;
  index?: number;
  className?: string;
  // Above-the-fold covers load immediately; they are the page's largest paint.
  eager?: boolean;
}) {
  const src = imgUrl(post, index);
  // Remember which render failed so a new revision gets a fresh attempt.
  const [failed, setFailed] = useState("");
  const slide = post.slides[index];
  return (
    <div
      className={`slide-image ${className}`}
      style={{
        aspectRatio: post.aspect === "portrait" ? "4 / 5" : "9 / 16",
        background: slide?.background,
      }}
    >
      {failed === src ? (
        <RenderFallback />
      ) : (
        <Image
          unoptimized
          src={src}
          alt={`Slide ${index + 1}${slide?.title ? `: ${slide.title}` : ""}`}
          fill
          sizes="(max-width: 800px) 90vw, 400px"
          loading={eager ? "eager" : "lazy"}
          style={{ objectFit: "contain" }}
          onError={() => setFailed(src)}
        />
      )}
    </div>
  );
}
type AssetDeletion = { ids: string[]; title: string; detail: string };

const listNames = (all: string[]) => {
  const names = all.slice(0, 3);
  const more = all.length - names.length;
  if (more) return `${names.join(", ")} and ${more} more`;
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : names[0];
};
function deletionMessage({
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

function AssetLibrary({
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

export default function Studio() {
  const [state, setState] = useState<StudioState | null>(null),
    [view, setView] = useState<View>("Overview"),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [create, setCreate] = useState(false),
    [createContext, setCreateContext] = useState<{
      format: Format;
      hook?: string;
    } | null>(null),
    [editing, setEditing] = useState<Post | null>(null),
    [editDirectly, setEditDirectly] = useState(false),
    [editorTab, setEditorTab] = useState<"text" | "post">("text"),
    [brandEdit, setBrandEdit] = useState<Partial<Brand> | null>(null),
    [formatEdit, setFormatEdit] = useState<Format | null>(null),
    [upload, setUpload] = useState(false),
    [uploadFiles, setUploadFiles] = useState<File[]>([]),
    [assetEdit, setAssetEdit] = useState<Asset | null>(null),
    [assetDelete, setAssetDelete] = useState<AssetDeletion | null>(null);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/studio");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    setState(data);
  }, []);
  useEffect(() => {
    let alive = true;
    fetch("/api/studio")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (alive) setState(data);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  // Resolves to false on failure so forms can stay open with their message.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!state)
    return (
      <main className="loading">
        <SlideoMark size={40} />
        <h1>Opening Slideo</h1>
        {error ? <p role="alert">{error}</p> : <Loader2 className="spin" />}
      </main>
    );
  const visible = state.posts.filter((p) => p.status !== "archived");
  const deleted = state.posts.filter((p) => p.status === "archived");
  const review = visible.filter((p) => p.status === "needs_review");
  const published = visible.filter((p) => p.status === "published");
  const library = libraryAssets(state.assets);
  const posts = (filter === "archived" ? deleted : visible).filter(
    (p) =>
      (view !== "Review queue" || p.status === "needs_review") &&
      (filter === "all" || p.status === filter) &&
      `${p.title} ${p.topic}`.toLowerCase().includes(search.toLowerCase()),
  );
  // Errors from a form are shown inside its dialog, not behind the backdrop.
  const pageModalOpen =
    create || !!brandEdit || upload || !!assetEdit || !!assetDelete;
  const navigate = (v: View) => {
    setView(v);
    setFilter("all");
    setSearch("");
    setError("");
  };
  const closeCreate = () => {
    setCreate(false);
    setCreateContext(null);
    setError("");
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Link className="wordmark" href="/" aria-label="Slideo home">
          <span className="brand-icon">
            <SlideoMark size={16} />
          </span>
          Slideo
        </Link>
        <div className="workspace">
          <span className="workspace-avatar">D</span>
          <div>
            <strong>Personal studio</strong>
            <small>Local workspace</small>
          </div>
          <span className="local-dot" title="Local workspace" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {views.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={view === name ? "active" : ""}
              title={name}
              aria-current={view === name ? "page" : undefined}
              onClick={() => navigate(name)}
            >
              <Icon size={18} />
              <span>{name}</span>
              {name === "Review queue" && review.length > 0 && (
                <b>{review.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="approval-note">
            <ShieldCheck size={19} />
            <strong>Human-approved.</strong>
            <p>Every post waits for your approval before export.</p>
          </div>
          <button
            className={view === "Settings" ? "settings active" : "settings"}
            title="Settings"
            aria-current={view === "Settings" ? "page" : undefined}
            onClick={() => navigate("Settings")}
          >
            <Settings2 size={18} />
            Settings
          </button>
          <div className="profile">
            <span className="profile-avatar">D</span>
            <div>
              <strong>Daniel’s workspace</strong>
              <small>
                <i /> Local & private
              </small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{view}</strong>
          </div>
          <span className="topbar-note">
            <span className="local-dot" /> All work stays on this computer
          </span>
          <button
            className="small-avatar"
            onClick={() => navigate("Settings")}
            aria-label="Open workspace settings"
          >
            D
          </button>
        </header>
        <main className="content" id="main" tabIndex={-1}>
          {error && !pageModalOpen && (
            <div className="alert" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <IconButton label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">SLIDEO / {view.toUpperCase()}</div>
              <h1>
                {view === "Overview"
                  ? "Your slideshows."
                  : view === "Review queue"
                    ? "Ready for review."
                    : view === "Formats"
                      ? "Your formats."
                      : view === "Assets"
                        ? "Your assets."
                        : view === "Brands"
                          ? "Your brands."
                          : view === "Calendar"
                            ? "Your calendar."
                            : view === "Analytics"
                              ? "Your analytics."
                              : "Settings."}
              </h1>
              <p>
                {view === "Overview"
                  ? "Turn a good idea into your next great post."
                  : view === "Review queue"
                    ? "A final look before anything ships."
                    : view === "Formats"
                      ? "Reusable layouts and writing directions. Consistency, without repetition."
                      : view === "Assets"
                        ? "Your own images, collected and ready to use."
                        : view === "Brands"
                          ? "The facts, audience, and tone behind every draft."
                          : view === "Calendar"
                            ? "Your planned posting dates. Publishing stays in your hands."
                            : view === "Analytics"
                              ? "Owner-recorded results from your published posts."
                              : "A private, local workspace built around your process."}
              </p>
            </div>
            {(view === "Overview" || view === "Review queue") && (
              <button
                className="button primary"
                onClick={() => setCreate(true)}
              >
                <Plus size={18} />
                Create slideshow
              </button>
            )}
            {view === "Assets" && (
              <button
                className="button primary"
                onClick={() => setUpload(true)}
              >
                <Upload size={17} />
                Upload images
              </button>
            )}
            {view === "Brands" && (
              <button
                className="button primary"
                onClick={() => setBrandEdit(blankBrand)}
              >
                <Plus size={18} />
                New brand
              </button>
            )}
            {view === "Formats" && (
              <button
                className="button primary"
                onClick={() =>
                  setFormatEdit(blankFormat(defaultBrandId(state)))
                }
              >
                <Plus size={18} />
                New format
              </button>
            )}
          </div>
          {(view === "Overview" || view === "Review queue") && (
            <section className="posts-section">
              <div className="section-heading">
                <h2>
                  {view === "Overview" ? "Slideshows" : "The review queue"}{" "}
                  <span>({posts.length})</span>
                </h2>
                <div className="search-box">
                  <Search size={15} />
                  <input
                    aria-label="Search posts"
                    placeholder="Find a slideshow…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              {view === "Overview" && (
                <div className="tabs">
                  {[
                    ["all", "All posts"],
                    ["needs_review", "Needs review"],
                    ["approved", "Approved"],
                    ["published", "Published"],
                    ...(deleted.length ? [["archived", "Deleted"]] : []),
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={filter === key ? "selected" : ""}
                      aria-pressed={filter === key}
                      onClick={() => setFilter(key)}
                    >
                      {label}
                      {key === "needs_review" && <span>{review.length}</span>}
                      {key === "archived" && <span>{deleted.length}</span>}
                    </button>
                  ))}
                </div>
              )}
              <div className="post-grid photo-gallery">
                {posts.map((p, i) => (
                  <article key={p.id} className="post-card photo-gallery-card">
                    <button
                      className="post-art"
                      aria-label={`Preview ${p.title}`}
                      onClick={() => setEditing(p)}
                    >
                      <SlideImage post={p} eager={i < 4} />
                      <span className="slide-count">
                        <Layers3 size={12} />
                        {plural(p.slides.length, "slide")}
                      </span>
                    </button>
                    <div className="post-info">
                      <div className="post-meta">
                        <span className={`status ${p.status}`}>
                          <i />
                          {statusLabel[p.status]}
                        </span>
                        <span>{p.aspect === "portrait" ? "4:5" : "9:16"}</span>
                      </div>
                      <button
                        className="post-title"
                        onClick={() => setEditing(p)}
                      >
                        {p.title}
                      </button>
                      <div className="post-footer">
                        <span>
                          {state.brands.find((b) => b.id === p.brandId)?.name ||
                            "Personal post"}
                        </span>
                        <button
                          aria-label={`Open ${p.title}`}
                          onClick={() => setEditing(p)}
                        >
                          <ArrowUpRight size={17} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
                <button
                  className="new-post-card"
                  hidden={filter === "archived"}
                  onClick={() => setCreate(true)}
                >
                  <span>
                    <Plus size={25} />
                  </span>
                  <strong>Your next idea goes here.</strong>
                  <small>Create a slideshow</small>
                </button>
              </div>
              {posts.length === 0 && search && (
                <p className="empty-copy">
                  No posts match “{search}”. Try another search.
                </p>
              )}
              {filter === "archived" && (
                <p className="empty-copy">
                  Deleted slideshows keep their revisions. Open one and choose
                  Restore to bring it back for review.
                </p>
              )}
            </section>
          )}
          {view === "Formats" && (
            <div className="format-grid">
              {state.formats.map((f) => (
                <article className="format-card" key={f.id}>
                  <button
                    className={`format-preview ${f.font === "tiktok" ? "photo-format" : ""}`}
                    aria-label={`Open ${f.name}`}
                    style={{
                      background: f.color,
                      color: f.ink,
                      fontFamily:
                        f.font === "serif"
                          ? "Georgia, serif"
                          : "Helvetica, sans-serif",
                    }}
                    onClick={() => setFormatEdit(f)}
                  >
                    <span>THE SLIDEO COLLECTION</span>
                    <b>
                      {f.name}
                      <em style={{ color: f.accent }}>
                        No.{" "}
                        {String(state.formats.indexOf(f) + 1).padStart(2, "0")}
                      </em>
                    </b>
                    <small>
                      {f.slideCount} SLIDES <ArrowUpRight size={20} />
                    </small>
                  </button>
                  <div>
                    <h2>{f.name}</h2>
                    <p>{f.description}</p>
                    <button
                      className="text-button"
                      onClick={() => setFormatEdit(f)}
                    >
                      Customize format <ArrowRight size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {view === "Brands" && (
            <div className="brand-grid">
              {state.brands.map((b) => (
                <article className="brand-card" key={b.id}>
                  <span className="brand-initial">{b.name.charAt(0)}</span>
                  <h2>{b.name}</h2>
                  <p>{b.product}</p>
                  <div className="brand-detail">
                    <span>VOICE</span>
                    {b.tone}
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => setBrandEdit(b)}
                  >
                    Edit brand brief <ArrowUpRight size={16} />
                  </button>
                </article>
              ))}
            </div>
          )}
          {view === "Assets" &&
            (library.length ? (
              <AssetLibrary
                library={library}
                onEdit={(asset) => {
                  setError("");
                  setAssetEdit(asset);
                }}
                onDelete={(request) => {
                  setError("");
                  setAssetDelete(request);
                }}
              />
            ) : (
              <div className="empty-state">
                <ImagePlus size={42} strokeWidth={1} />
                <h2>Start with what’s yours.</h2>
                <p>
                  Upload photos you own or have permission to use.
                  <br />
                  Organize them into collections for your slideshows.
                </p>
                <button
                  className="button primary"
                  onClick={() => setUpload(true)}
                >
                  <Plus size={16} />
                  Add your first images
                </button>
              </div>
            ))}
          {view === "Calendar" && (
            <CalendarView
              posts={visible}
              brands={state.brands}
              formats={state.formats}
              onOpen={(post, editSchedule = false) => {
                setEditDirectly(editSchedule);
                setEditorTab(editSchedule ? "post" : "text");
                setEditing(post);
              }}
            />
          )}
          {view === "Analytics" && (
            <Results
              posts={published}
              busy={busy}
              error={error}
              onClearError={() => setError("")}
              onSave={(id, data) =>
                run(async () => {
                  await api("metrics", { id, data });
                  setToast("Results saved.");
                })
              }
            />
          )}
          {view === "Settings" && (
            <div className="settings-grid">
              <section className="settings-card">
                <span className="stat-icon sage">
                  <ShieldCheck size={23} />
                </span>
                <h2>Local by design.</h2>
                <p>
                  Your briefs, images, revisions, and exports are saved in this
                  project’s <code>data/</code> folder. Back up that whole folder
                  with the app stopped.
                </p>
                <dl>
                  <dt>Workspace access</dt>
                  <dd>This computer only</dd>
                  <dt>Publishing</dt>
                  <dd>Manual export, with approval</dd>
                  <dt>Storage</dt>
                  <dd>SQLite + local image files</dd>
                </dl>
              </section>
              <section className="settings-card">
                <span className="stat-icon peach">
                  <Sparkles size={23} />
                </span>
                <h2>Your writing assistant.</h2>
                <p>
                  {state.settings.aiReady
                    ? "OpenAI is configured. Website ideas and AI drafts use your brand facts and format instructions."
                    : "Add OPENAI_API_KEY to .env.local in the project folder, then restart. Never paste keys into a brand brief."}
                </p>
                <dl>
                  <dt>Connection</dt>
                  <dd>
                    {state.settings.aiReady
                      ? "Configured · live call not verified"
                      : "Not configured"}
                  </dd>
                  <dt>Model</dt>
                  <dd>{state.settings.model}</dd>
                  <dt>Daily attempts</dt>
                  <dd>
                    {state.settings.usedToday} / {state.settings.dailyLimit}
                  </dd>
                </dl>
                <small>
                  Limit resets at midnight UTC. Failed attempts count. Provider
                  billing applies separately.
                </small>
              </section>
              <section className="settings-card">
                <h2>What’s in this first build</h2>
                <p>
                  Manual and AI drafts, brand briefs, reusable formats, local
                  assets, versioned editing, exact previews, approval, JPEG
                  packages, planned dates, and manual results.
                </p>
                <p>
                  Recurring generation, cloud authentication, MP4 exports, and
                  publishing-provider integration are upcoming milestones.
                </p>
              </section>
            </div>
          )}
          <footer className="page-footer">
            <SlideoMark size={14} />
            <span>Nothing ships without your approval.</span>
            <span>SLIDEO · PERSONAL STUDIO</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {create && (
        <CreateSlideshowModal
          state={state}
          initialFormat={createContext?.format}
          initialHook={createContext?.hook}
          busy={busy}
          error={error}
          onClose={closeCreate}
          onOpenSettings={() => {
            closeCreate();
            setFormatEdit(null);
            navigate("Settings");
          }}
          onCreate={(data) =>
            run(async () => {
              const post = await api("create", data);
              setCreate(false);
              setCreateContext(null);
              setEditDirectly(true);
              setEditing(post);
              setToast("Your draft is ready.");
            })
          }
        />
      )}
      {brandEdit && (
        <Modal
          title={
            brandEdit.id ? "Your brand, in a few words." : "Meet your brand."
          }
          onClose={() => {
            setBrandEdit(null);
            setError("");
          }}
          error={error}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await api("brand", {
                  data: { id: brandEdit.id, ...Object.fromEntries(f) },
                });
                setBrandEdit(null);
                setToast("Brand brief saved.");
              });
            }}
          >
            {(
              [
                ["name", "Brand name", 80],
                ["product", "What do you offer?", 2000],
                ["audience", "Who is it for?", 1000],
                ["tone", "Voice & tone", 300],
                ["facts", "Verified product facts", 3000],
                ["prohibited", "Claims to avoid", 1000],
                ["destination", "Destination / website", 500],
              ] as const
            ).map(([key, label, maxLength]) => (
              <Field
                key={key}
                label={label}
                hint={
                  key === "destination"
                    ? "A full web address, such as https://example.com"
                    : undefined
                }
              >
                {key === "name" || key === "tone" || key === "destination" ? (
                  <input
                    name={key}
                    type={key === "destination" ? "url" : "text"}
                    maxLength={maxLength}
                    defaultValue={String(brandEdit[key] || "")}
                    required={key === "name"}
                  />
                ) : (
                  <textarea
                    name={key}
                    rows={2}
                    maxLength={maxLength}
                    defaultValue={String(brandEdit[key] || "")}
                  />
                )}
              </Field>
            ))}
            <div className="modal-actions">
              <button disabled={busy} className="button primary">
                Save brand brief
              </button>
            </div>
          </form>
        </Modal>
      )}
      {formatEdit && (
        <FormatDashboard
          key={formatEdit.id || "new-format"}
          initial={formatEdit}
          state={state}
          suspended={!!editing || create}
          onClose={() => setFormatEdit(null)}
          onSave={async (format) => {
            const saved = await api("format", {
              data: { ...format, id: format.id || undefined },
            });
            await refresh();
            return saved;
          }}
          onOpenPost={(post) => {
            setEditing(post);
            setEditDirectly(false);
            setEditorTab("text");
          }}
          onCreate={(format, hook) => {
            setCreateContext({ format, hook });
            setCreate(true);
          }}
          schedule={(posts) => (
            <CalendarView
              posts={posts}
              brands={state.brands}
              formats={state.formats}
              onOpen={(post, editSchedule = false) => {
                setEditDirectly(editSchedule);
                setEditorTab(editSchedule ? "post" : "text");
                setEditing(post);
              }}
            />
          )}
        />
      )}
      {upload && (
        <Modal
          title="Gather your images."
          subtitle="JPEG, PNG, or WebP. Up to 20 MB per image."
          onClose={() => {
            setUpload(false);
            setUploadFiles([]);
            setError("");
          }}
          error={error}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!uploadFiles.length) {
                setError("Choose at least one image to upload.");
                return;
              }
              const data = new FormData(e.currentTarget);
              void run(async () => {
                let added = 0,
                  duplicates = 0;
                for (const file of uploadFiles) {
                  const fd = new FormData();
                  fd.set("file", file);
                  fd.set("collection", String(data.get("collection")));
                  fd.set("rights", String(data.get("rights")));
                  const r = await fetch("/api/studio", {
                    method: "POST",
                    body: fd,
                  });
                  const body = await r.json().catch(() => ({}));
                  if (!r.ok)
                    throw new Error(
                      `${added ? `${plural(added, "image")} added. ` : ""}${file.name}: ${body.error || "Upload failed."}`,
                    );
                  if (body.duplicate) duplicates++;
                  else added++;
                }
                setUpload(false);
                setUploadFiles([]);
                setToast(
                  `${plural(added, "image")} added to your library.` +
                    (duplicates
                      ? ` ${plural(duplicates, "image")} already in that collection.`
                      : ""),
                );
              });
            }}
          >
            <FileUpload
              files={uploadFiles}
              onFilesChange={(files) => {
                setUploadFiles(files);
                setError("");
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
      )}
      {assetEdit && (
        <AssetModal
          asset={assetEdit}
          busy={busy}
          error={error}
          onClose={() => {
            setAssetEdit(null);
            setError("");
          }}
          onSave={(data) =>
            run(async () => {
              await api("asset", { id: assetEdit.id, data });
              setAssetEdit(null);
              setToast("Image details saved.");
            })
          }
          onRemove={() =>
            run(async () => {
              const result = await api("removeAsset", { id: assetEdit.id });
              setAssetEdit(null);
              setToast(
                result.kept
                  ? "Removed from your library. Slideshows that use it keep it."
                  : "Image deleted.",
              );
            })
          }
        />
      )}
      {assetDelete && (
        <Modal
          title={assetDelete.title}
          onClose={() => {
            setAssetDelete(null);
            setError("");
          }}
          error={error}
        >
          <p>
            {assetDelete.detail} Images that a slideshow uses can’t be deleted:
            those slideshows keep them, and they leave your library.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setAssetDelete(null);
                setError("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = (await api("removeAssets", {
                    ids: assetDelete.ids,
                  })) as { deleted: Asset[]; kept: Asset[] };
                  setAssetDelete(null);
                  setToast(deletionMessage(result));
                })
              }
            >
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              Delete
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <SlideshowEditor
          initial={editing}
          startEditing={editDirectly}
          startTab={editorTab}
          onFormat={(id) => {
            setEditing(null);
            setEditDirectly(false);
            setEditorTab("text");
            navigate("Formats");
            setFormatEdit(
              state.formats.find((format) => format.id === id) ?? null,
            );
          }}
          state={state}
          onClose={() => {
            setEditing(null);
            setEditDirectly(false);
            setEditorTab("text");
          }}
          onSaved={async () => {
            await refresh();
          }}
          onToast={setToast}
        />
      )}
    </div>
  );
}
function CalendarView({
  posts,
  brands,
  formats,
  onOpen,
}: {
  posts: Post[];
  brands: Brand[];
  formats: Format[];
  onOpen: (p: Post, editSchedule?: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = posts.find((post) => post.id === selectedId);
  const closeDetails = useCallback(() => setSelectedId(null), []);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const postingTime = (value: string) =>
    new Date(value).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [today] = useState(() => new Date().toDateString());
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from(
    { length: Math.ceil((start.getDay() + days) / 7) * 7 },
    (_, i) => i - start.getDay() + 1,
  );
  return (
    <section className="calendar">
      <header>
        <h2>
          {month.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </h2>
        <div>
          <button
            className="button secondary"
            onClick={() =>
              setMonth(
                new Date(new Date().getFullYear(), new Date().getMonth(), 1),
              )
            }
          >
            Today
          </button>
          <IconButton
            label="Previous month"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            <ChevronLeft size={19} />
          </IconButton>
          <IconButton
            label="Next month"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            <ChevronRight size={19} />
          </IconButton>
        </div>
      </header>
      <div className="calendar-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div className="day-name" key={d}>
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          const date = new Date(month.getFullYear(), month.getMonth(), d);
          const sameDay = (value: string) =>
            new Date(value).toDateString() === date.toDateString();
          return (
            <div
              key={i}
              className={`calendar-day ${d < 1 || d > days ? "outside" : ""} ${date.toDateString() === today ? "today" : ""}`}
            >
              <span>{date.getDate()}</span>
              {d > 0 &&
                d <= days &&
                posts
                  .filter((p) => p.plannedAt && sameDay(p.plannedAt))
                  .sort(
                    (a, b) => Date.parse(a.plannedAt) - Date.parse(b.plannedAt),
                  )
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      aria-label={`View scheduled details for ${p.title}, ${postingTime(p.plannedAt)}`}
                    >
                      <time
                        className="calendar-event-time"
                        dateTime={p.plannedAt}
                      >
                        {postingTime(p.plannedAt)}
                      </time>
                      <span className="calendar-event-title">{p.title}</span>
                      <small>{statusLabel[p.status]}</small>
                    </button>
                  ))}
            </div>
          );
        })}
      </div>
      <p className="calendar-note">
        Dates and times are shown in {timeZone}. Select a post to view its
        schedule and details. Publishing is manual.
      </p>
      {selected && (
        <Modal title="Scheduled post" onClose={closeDetails} wide>
          <div className="schedule-details">
            <div className="schedule-content">
              <SlideImage post={selected} className="schedule-cover" />
              <div className="schedule-summary">
                <span className={`schedule-status ${selected.status}`}>
                  {statusLabel[selected.status]}
                </span>
                <h3>{selected.title}</h3>
                <div className="schedule-time">
                  <Clock3 size={21} aria-hidden="true" />
                  <div>
                    <span>Planned posting time</span>
                    <time dateTime={selected.plannedAt}>
                      <strong>
                        {new Date(selected.plannedAt).toLocaleDateString(
                          undefined,
                          {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                          },
                        )}
                      </strong>
                      <b>{postingTime(selected.plannedAt)}</b>
                    </time>
                    <small>{timeZone}</small>
                  </div>
                </div>
                <dl className="schedule-facts">
                  <div>
                    <dt>Target account</dt>
                    <dd>{selected.account.trim() || "Not set"}</dd>
                  </div>
                  <div>
                    <dt>Brand</dt>
                    <dd>
                      {brands.find((brand) => brand.id === selected.brandId)
                        ?.name || "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>
                      {formats.find((format) => format.id === selected.formatId)
                        ?.name || "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt>Slideshow</dt>
                    <dd>
                      {plural(selected.slides.length, "slide")} ·{" "}
                      {selected.aspect === "story" ? "9:16" : "4:5"}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
            <section className="schedule-copy">
              <h3>Caption</h3>
              <p>{selected.caption.trim() || "No caption added."}</p>
            </section>
            <section className="schedule-copy">
              <h3>Disclosure / music notes</h3>
              <p>{selected.notes.trim() || "No notes added."}</p>
            </section>
            <p className="schedule-delivery">
              {selected.status === "published"
                ? "This post has been marked as published. The time above is its original planned posting time."
                : "Publish manually at the planned time after approving your slideshow."}
            </p>
            <div className="modal-actions schedule-actions">
              {selected.status !== "published" && (
                <button
                  className="button secondary"
                  onClick={() => {
                    closeDetails();
                    onOpen(selected, true);
                  }}
                >
                  <CalendarDays size={16} /> Edit schedule
                </button>
              )}
              <button
                className="button primary"
                onClick={() => {
                  closeDetails();
                  onOpen(selected);
                }}
              >
                View slideshow <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
function Results({
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
function AssetModal({
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
