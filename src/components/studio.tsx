"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Image from "next/image";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderOpen,
  ImagePlus,
  Layers3,
  Leaf,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  Undo2,
  Redo2,
  PanelLeftClose,
  AlertCircle,
} from "lucide-react";
import type {
  Asset,
  Brand,
  Format,
  Post,
  PostContent,
  Slide,
  StudioState,
} from "@/lib/schema";
type View =
  | "Overview"
  | "Review queue"
  | "Formats"
  | "Assets"
  | "Brands"
  | "Calendar"
  | "Results"
  | "Settings";
const views: { name: View; icon: typeof Leaf }[] = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Review queue", icon: CheckCheck },
  { name: "Formats", icon: Layers3 },
  { name: "Assets", icon: FolderOpen },
  { name: "Brands", icon: FileText },
  { name: "Calendar", icon: CalendarDays },
  { name: "Results", icon: BarChart3 },
];
const statusLabel = {
  needs_review: "Needs review",
  approved: "Approved",
  published: "Published",
  archived: "Archived",
};
const imgUrl = (p: Post, i = 0) => `/api/render/${p.id}/${p.revision}/${i}`;
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
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "Request failed");
  return body;
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
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>("input,button,select,textarea")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
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
        {children}
      </div>
    </div>
  );
}

type WebsiteIdea = { topic: string; angle: string };

function CreateSlideshowModal({
  state,
  busy,
  onClose,
  onCreate,
  onOpenSettings,
}: {
  state: StudioState;
  busy: boolean;
  onClose: () => void;
  onCreate: (data: Record<string, unknown>) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const firstBrand = state.brands[0];
  const firstFormat = state.formats[0];
  const clampCount = (count: number) =>
    Math.max(2, Math.min(10, Math.round(count || 2)));
  const [brandId, setBrandId] = useState(firstBrand?.id || "");
  const [formatId, setFormatId] = useState(firstFormat?.id || "");
  const [topic, setTopic] = useState("");
  const [sourceUrl, setSourceUrl] = useState(firstBrand?.destination || "");
  const [slideCount, setSlideCount] = useState(
    clampCount(firstFormat?.slideCount || 6),
  );
  const [collection, setCollection] = useState("");
  const [mode, setMode] = useState<"manual" | "ai">(
    state.settings.aiReady ? "ai" : "manual",
  );
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [ideas, setIdeas] = useState<WebsiteIdea[]>([]);
  const [ideaLoading, setIdeaLoading] = useState(false);
  const [ideaError, setIdeaError] = useState("");
  const canCreate = Boolean(brandId && formatId && topic.trim());

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
      wide={ideasOpen}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            brandId,
            formatId,
            topic,
            collection,
            mode,
            slideCount,
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
            <select
              value={brandId}
              onChange={(event) => {
                const nextId = event.target.value;
                setBrandId(nextId);
                setSourceUrl(
                  state.brands.find((brand) => brand.id === nextId)
                    ?.destination || "",
                );
                setIdeas([]);
                setIdeaError("");
              }}
            >
              {state.brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Format">
            <select
              value={formatId}
              onChange={(event) => {
                const nextId = event.target.value;
                setFormatId(nextId);
                const next = state.formats.find(
                  (format) => format.id === nextId,
                );
                if (next) setSlideCount(clampCount(next.slideCount));
              }}
            >
              {state.formats.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.name} · {format.slideCount} slides
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field
            label="Number of slides"
            hint="Changing the format resets this to its default."
          >
            <input
              type="number"
              min={2}
              max={10}
              step={1}
              required
              value={slideCount}
              onChange={(event) => setSlideCount(Number(event.target.value))}
              onBlur={() => setSlideCount(clampCount(slideCount))}
            />
          </Field>
          <Field label="Background collection">
            <select
              value={collection}
              onChange={(event) => setCollection(event.target.value)}
            >
              <option value="">Use the format’s solid colors</option>
              {[...new Set(state.assets.map((asset) => asset.collection))].map(
                (name) => (
                  <option key={name}>{name}</option>
                ),
              )}
            </select>
          </Field>
        </div>
        <p className="slide-count-note">
          <Layers3 size={15} />
          This slideshow will contain <strong>{slideCount} slides</strong>.
        </p>
        <Field label="Writing mode">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as "manual" | "ai")}
          >
            <option value="manual">
              Manual — start with an editable outline
            </option>
            <option value="ai" disabled={!state.settings.aiReady}>
              AI writing{" "}
              {state.settings.aiReady
                ? "— use my OpenAI key"
                : "— add credentials in Settings"}
            </option>
          </select>
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
            disabled={busy || !canCreate || slideCount < 2 || slideCount > 10}
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
}: {
  post: Post;
  index?: number;
  className?: string;
}) {
  return (
    <div
      className={`slide-image ${className}`}
      style={{
        aspectRatio: post.aspect === "portrait" ? "4 / 5" : "9 / 16",
        background: post.slides[index]?.background,
      }}
    >
      <Image
        unoptimized
        src={imgUrl(post, index)}
        alt={`Slide ${index + 1}: ${post.slides[index]?.title}`}
        fill
        sizes="(max-width: 800px) 90vw, 400px"
        style={{ objectFit: "contain" }}
      />
    </div>
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
    [editing, setEditing] = useState<Post | null>(null),
    [brandEdit, setBrandEdit] = useState<Partial<Brand> | null>(null),
    [formatEdit, setFormatEdit] = useState<Format | null>(null),
    [upload, setUpload] = useState(false);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/studio");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    setState(data);
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  if (!state)
    return (
      <main className="loading">
        <Leaf size={40} />
        <h1>Opening your studio</h1>
        {error ? <p role="alert">{error}</p> : <Loader2 className="spin" />}
      </main>
    );
  const visible = state.posts.filter((p) => p.status !== "archived");
  const review = visible.filter((p) => p.status === "needs_review");
  const approved = visible.filter((p) => p.status === "approved");
  const published = visible.filter((p) => p.status === "published");
  const posts = visible.filter(
    (p) =>
      (view !== "Review queue" || p.status === "needs_review") &&
      (filter === "all" || p.status === filter) &&
      `${p.title} ${p.topic}`.toLowerCase().includes(search.toLowerCase()),
  );
  const navigate = (v: View) => {
    setView(v);
    setFilter("all");
    setSearch("");
    setError("");
  };
  const closeCreate = () => setCreate(false);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="wordmark" href="/" aria-label="Fieldwork home">
          <span className="brand-icon">
            <Leaf size={22} />
          </span>
          fieldwork<span className="wordmark-dot">®</span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">D</span>
          <div>
            <strong>Personal studio</strong>
            <small>Your own little corner</small>
          </div>
          <span className="local-dot" title="Local workspace" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {views.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={view === name ? "active" : ""}
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
            <strong>A human touch, always.</strong>
            <p>Every post waits for your approval before export.</p>
          </div>
          <button
            className={view === "Settings" ? "settings active" : "settings"}
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
        <main className="content">
          {error && (
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
              <div className="eyebrow">YOUR CONTENT, CULTIVATED.</div>
              <h1>
                {view === "Overview"
                  ? "Good things start here."
                  : view === "Review queue"
                    ? "Ready for your eyes."
                    : view === "Formats"
                      ? "Find your signature."
                      : view === "Assets"
                        ? "A library of possibilities."
                        : view === "Brands"
                          ? "Give your content a voice."
                          : view === "Calendar"
                            ? "A little room to plan."
                            : view === "Results"
                              ? "Learn from what you share."
                              : "Make yourself at home."}
              </h1>
              <p>
                {view === "Overview"
                  ? "Turn a good idea into your next great post."
                  : view === "Review queue"
                    ? "A final look before your ideas head out into the world."
                    : view === "Formats"
                      ? "Reusable layouts and writing directions. Consistency, without repetition."
                      : view === "Assets"
                        ? "Your own images, thoughtfully collected and ready to use."
                        : view === "Brands"
                          ? "The facts, audience, and tone behind every draft."
                          : view === "Calendar"
                            ? "Your planned posting dates. Publishing stays in your hands."
                            : view === "Results"
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
                  setFormatEdit({
                    ...state.formats[0],
                    id: "",
                    name: "My new format",
                  })
                }
              >
                <Plus size={18} />
                New format
              </button>
            )}
          </div>
          {view === "Overview" && (
            <>
              <section className="intro-grid">
                <div className="hero-card">
                  <div className="hero-copy">
                    <span className="hero-kicker">
                      <Sparkles size={14} /> LESS BUSYWORK. MORE GOOD IDEAS.
                    </span>
                    <h2>
                      Make something
                      <br />
                      <em>worth sharing.</em>
                    </h2>
                    <p>
                      Start with a format. Add your point of view.
                      <br />
                      We’ll help you bring it all together.
                    </p>
                    <button
                      className="button dark"
                      onClick={() => setCreate(true)}
                    >
                      Let’s create a slideshow <ArrowUpRight size={17} />
                    </button>
                  </div>
                  <div className="hero-art" aria-hidden="true">
                    <div className="paper paper-back">
                      <span>THE REALITY CHECK</span>
                      <b>
                        Small steps.
                        <br />
                        Real progress.
                      </b>
                      <i>04 — MAKE IT YOURS</i>
                    </div>
                    <div className="paper paper-front">
                      <span>FIELD NOTES — VOL. 01</span>
                      <div className="paper-drawing">
                        <Leaf size={83} strokeWidth={0.8} />
                      </div>
                      <b>
                        A little space
                        <br />
                        for a good idea.
                      </b>
                      <i>SWIPE TO EXPLORE →</i>
                    </div>
                    <span className="art-star">✳</span>
                  </div>
                </div>
                <div className="readiness-card">
                  <span className="section-kicker">STUDIO CHECK-IN</span>
                  <h3>
                    Your ideas are
                    <br />
                    taking shape.
                  </h3>
                  <button onClick={() => navigate("Review queue")}>
                    <span className="stat-icon peach">
                      <CheckCheck size={20} />
                    </span>
                    <span>
                      <strong>{review.length}</strong>
                      <small>waiting for your review</small>
                    </span>
                    <ArrowUpRight size={17} />
                  </button>
                  <button
                    onClick={() => {
                      navigate("Overview");
                      setFilter("approved");
                    }}
                  >
                    <span className="stat-icon sage">
                      <Download size={20} />
                    </span>
                    <span>
                      <strong>{approved.length}</strong>
                      <small>approved & ready to export</small>
                    </span>
                    <ArrowUpRight size={17} />
                  </button>
                  <div className="checkin-footer">
                    <ShieldCheck size={14} /> You have the final say.
                  </div>
                </div>
              </section>
              <section className="format-strip">
                <div>
                  <Layers3 size={22} />
                  <span>
                    <strong>A familiar format. A fresh perspective.</strong>
                    <small>
                      Three original starting points for your next idea.
                    </small>
                  </span>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate("Formats")}
                >
                  Explore formats <ArrowRight size={16} />
                </button>
              </section>
            </>
          )}
          {(view === "Overview" || view === "Review queue") && (
            <section className="posts-section">
              <div className="section-heading">
                <h2>
                  {view === "Overview"
                    ? "Your content garden"
                    : "The review queue"}{" "}
                  <span>{posts.length}</span>
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
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={filter === key ? "selected" : ""}
                      onClick={() => setFilter(key)}
                    >
                      {label}
                      {key === "needs_review" && <span>{review.length}</span>}
                    </button>
                  ))}
                </div>
              )}
              <div className="post-grid">
                {posts.map((p) => (
                  <article key={p.id} className="post-card">
                    <button className="post-art" onClick={() => setEditing(p)}>
                      <SlideImage post={p} />
                      <span className="slide-count">
                        <Layers3 size={12} />
                        {p.slides.length} slides
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
            </section>
          )}
          {view === "Formats" && (
            <div className="format-grid">
              {state.formats.map((f) => (
                <article className="format-card" key={f.id}>
                  <button
                    className="format-preview"
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
                    <span>THE FIELDWORK COLLECTION</span>
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
                    <h3>{f.name}</h3>
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
            (state.assets.length ? (
              <>
                <div className="section-heading">
                  <h2>
                    {state.assets.length} images{" "}
                    <span>
                      · {new Set(state.assets.map((a) => a.collection)).size}{" "}
                      collections
                    </span>
                  </h2>
                </div>
                <div className="asset-grid">
                  {state.assets.map((a) => (
                    <article key={a.id} className="asset-card">
                      <div className="asset-image">
                        <Image
                          unoptimized
                          fill
                          sizes="300px"
                          src={`/api/media/${a.id}`}
                          alt={a.name}
                          style={{ objectFit: "cover" }}
                        />
                      </div>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {a.collection} · {a.width} × {a.height}
                        </small>
                        <span
                          className={a.rights ? "rights" : "rights missing"}
                        >
                          {a.rights ? (
                            <Check size={13} />
                          ) : (
                            <AlertCircle size={13} />
                          )}{" "}
                          {a.rights || "Rights not recorded — cannot approve"}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </>
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
            <CalendarView posts={visible} onOpen={setEditing} />
          )}
          {view === "Results" && (
            <Results
              posts={published}
              busy={busy}
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
            <Leaf size={14} />
            <span>A little intention goes a long way.</span>
            <span>FIELDWORK · PERSONAL STUDIO</span>
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
          busy={busy}
          onClose={closeCreate}
          onOpenSettings={() => {
            closeCreate();
            navigate("Settings");
          }}
          onCreate={(data) =>
            run(async () => {
              const post = await api("create", data);
              setCreate(false);
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
          onClose={() => setBrandEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              run(async () => {
                await api("brand", {
                  data: { id: brandEdit.id, ...Object.fromEntries(f) },
                });
                setBrandEdit(null);
                setToast("Brand brief saved.");
              });
            }}
          >
            {[
              ["name", "Brand name"],
              ["product", "What do you offer?"],
              ["audience", "Who is it for?"],
              ["tone", "Voice & tone"],
              ["facts", "Verified product facts"],
              ["prohibited", "Claims to avoid"],
              ["destination", "Destination / website"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                {["name", "tone", "destination"].includes(key) ? (
                  <input
                    name={key}
                    defaultValue={String(brandEdit[key as keyof Brand] || "")}
                    required={key === "name"}
                  />
                ) : (
                  <textarea
                    name={key}
                    rows={2}
                    defaultValue={String(brandEdit[key as keyof Brand] || "")}
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
        <Modal
          title="Make this format yours."
          onClose={() => setFormatEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              run(async () => {
                await api("format", {
                  data: {
                    ...Object.fromEntries(f),
                    id: formatEdit.id || undefined,
                    slideCount: Number(f.get("slideCount")),
                  },
                });
                setFormatEdit(null);
                setToast(
                  "Format saved. Existing posts keep their original design.",
                );
              });
            }}
          >
            <Field label="Format name">
              <input required name="name" defaultValue={formatEdit.name} />
            </Field>
            <Field label="Short description">
              <input name="description" defaultValue={formatEdit.description} />
            </Field>
            <Field label="Writing instructions">
              <textarea
                name="instructions"
                rows={3}
                defaultValue={formatEdit.instructions}
              />
            </Field>
            <div className="form-row">
              <Field label="Slides">
                <input
                  type="number"
                  name="slideCount"
                  min={2}
                  max={10}
                  defaultValue={formatEdit.slideCount}
                />
              </Field>
              <Field label="Canvas">
                <select name="aspect" defaultValue={formatEdit.aspect}>
                  <option value="portrait">4:5 · 1080 × 1350</option>
                  <option value="story">9:16 · 1080 × 1920</option>
                </select>
              </Field>
            </div>
            <Field label="Typography">
              <select name="font" defaultValue={formatEdit.font}>
                <option value="serif">Editorial serif</option>
                <option value="sans">Clean sans serif</option>
              </select>
            </Field>
            <div className="form-row colors">
              {[
                ["color", "Background"],
                ["ink", "Text"],
                ["accent", "Accent"],
              ].map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    type="color"
                    name={key}
                    defaultValue={formatEdit[key as keyof Format] as string}
                  />
                </Field>
              ))}
            </div>
            <div className="modal-actions">
              <button className="button primary" disabled={busy}>
                Save format
              </button>
            </div>
          </form>
        </Modal>
      )}
      {upload && (
        <Modal
          title="Gather your images."
          subtitle="JPEG, PNG, or WebP. Up to 20 MB per image."
          onClose={() => setUpload(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const files = data.getAll("file") as File[];
              run(async () => {
                let count = 0;
                for (const file of files) {
                  const fd = new FormData();
                  fd.set("file", file);
                  fd.set("collection", String(data.get("collection")));
                  fd.set("rights", String(data.get("rights")));
                  const r = await fetch("/api/studio", {
                    method: "POST",
                    body: fd,
                  });
                  const body = await r.json();
                  if (!r.ok)
                    throw new Error(
                      `${count} uploaded. ${file.name}: ${body.error}`,
                    );
                  count++;
                }
                setUpload(false);
                setToast(`${count} images added to your library.`);
              });
            }}
          >
            <div className="upload-zone">
              <Upload size={30} />
              <strong>Give your ideas a backdrop.</strong>
              <input
                aria-label="Choose images"
                type="file"
                name="file"
                required
                multiple
                accept="image/jpeg,image/png,image/webp"
              />
            </div>
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
      {editing && (
        <Editor
          initial={editing}
          state={state}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
          }}
          onToast={setToast}
        />
      )}
    </div>
  );
}
function Editor({
  initial,
  state,
  onClose,
  onSaved,
  onToast,
}: {
  initial: Post;
  state: StudioState;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToast: (s: string) => void;
}) {
  const [post, setPost] = useState(initial),
    [saved, setSaved] = useState(initial),
    [selected, setSelected] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false),
    [ready, setReady] = useState(false),
    [past, setPast] = useState<Post[]>([]),
    [future, setFuture] = useState<Post[]>([]),
    [confirming, setConfirming] = useState(false);
  const dirty = JSON.stringify(post) !== JSON.stringify(saved);
  const slide = post.slides[selected];
  const immutable = post.status === "published";
  const update = (next: Post) => {
    setPast((p) => [...p.slice(-39), post]);
    setFuture([]);
    setPost(next);
    setReady(false);
  };
  const patch = (data: Partial<Slide>) =>
    update({
      ...post,
      slides: post.slides.map((s, i) =>
        i === selected ? { ...s, ...data } : s,
      ),
    });
  const close = () => {
    if (dirty) {
      setConfirming(true);
      return;
    }
    onClose();
  };
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete action.");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!dirty) return saved;
    const result: Post = await api("save", {
      id: post.id,
      expected: saved.revision,
      data: post,
    });
    setPost(result);
    setSaved(result);
    await onSaved();
    return result;
  };
  const render = () =>
    action(async () => {
      const current = await save();
      await api("render", { id: current.id, revision: current.revision });
      setPreview(true);
      setReady(true);
    });
  const reorder = (offset: number) => {
    const next = selected + offset;
    if (next < 0 || next >= post.slides.length) return;
    const slides = [...post.slides];
    [slides[selected], slides[next]] = [slides[next], slides[selected]];
    update({ ...post, slides });
    setSelected(next);
  };
  const download = () =>
    action(async () => {
      const r = await fetch(`/api/export/${saved.id}`);
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${saved.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 70)}-v${saved.revision}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast("Package downloaded. Publish manually when you’re ready.");
    });
  return (
    <div
      className="editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Slideshow editor"
    >
      <header className="editor-header">
        <div>
          <IconButton label="Close editor" onClick={close}>
            <ArrowLeft size={20} />
          </IconButton>
          <span className="editor-divider" />
          <div>
            <strong>{post.title}</strong>
            <small>
              {dirty ? "Unsaved changes" : `Saved · revision ${saved.revision}`}{" "}
              <span
                className={`status ${dirty ? "needs_review" : post.status}`}
              >
                {dirty ? "Needs review" : statusLabel[post.status]}
              </span>
            </small>
          </div>
        </div>
        <div className="editor-actions">
          <IconButton
            label="Undo"
            disabled={!past.length || busy || immutable}
            onClick={() => {
              const p = past.at(-1)!;
              setFuture((f) => [post, ...f]);
              setPost(p);
              setPast((p) => p.slice(0, -1));
              setReady(false);
            }}
          >
            <Undo2 size={17} />
          </IconButton>
          <IconButton
            label="Redo"
            disabled={!future.length || busy || immutable}
            onClick={() => {
              setPast((p) => [...p, post]);
              setPost(future[0]);
              setFuture((f) => f.slice(1));
              setReady(false);
            }}
          >
            <Redo2 size={17} />
          </IconButton>
          <button
            className="button secondary"
            disabled={busy || !dirty}
            onClick={() =>
              action(async () => {
                await save();
                onToast("Revision saved.");
              })
            }
          >
            Save changes
          </button>
          <button className="button primary" disabled={busy} onClick={render}>
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}
            Review & export
          </button>
        </div>
      </header>
      {error && (
        <div className="alert editor-error" role="alert">
          <AlertCircle size={17} />
          {error}
        </div>
      )}
      <div className="editor-body">
        <aside className="slide-rail">
          <div className="rail-heading">
            <span>YOUR SLIDES</span>
            <b>{post.slides.length}</b>
          </div>
          <div className="slide-thumbnails">
            {post.slides.map((s, i) => (
              <button
                key={s.id}
                className={`slide-thumb ${selected === i ? "selected" : ""}`}
                onClick={() => setSelected(i)}
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div
                  style={{
                    background: s.background,
                    color: s.ink,
                    fontFamily: s.font === "serif" ? "Georgia" : "Helvetica",
                  }}
                >
                  <b>{s.title || "Your heading"}</b>
                </div>
                <small>{s.role}</small>
              </button>
            ))}
          </div>
          <button
            className="button secondary add-slide"
            disabled={immutable || post.slides.length >= 10 || busy}
            onClick={() => {
              update({
                ...post,
                slides: [
                  ...post.slides,
                  {
                    ...slide,
                    id: crypto.randomUUID(),
                    role: "body",
                    title: "A fresh perspective",
                    body: "",
                  },
                ],
              });
              setSelected(post.slides.length);
            }}
          >
            <Plus size={15} />
            Add slide
          </button>
        </aside>
        <section className="canvas-area">
          <div className="canvas-toolbar">
            <span>{preview ? "FINAL RENDER" : "LAYOUT DRAFT"}</span>
            <div className="segmented">
              <button
                className={!preview ? "selected" : ""}
                onClick={() => setPreview(false)}
              >
                Edit
              </button>
              <button
                className={preview ? "selected" : ""}
                disabled={busy}
                onClick={render}
              >
                Final preview
              </button>
            </div>
            <span>
              {post.aspect === "portrait" ? "1080 × 1350" : "1080 × 1920"}
            </span>
          </div>
          <div className="canvas-wrap">
            {preview && !dirty ? (
              <SlideImage
                post={saved}
                index={selected}
                className="editor-canvas"
              />
            ) : (
              <div
                className="draft-canvas editor-canvas"
                style={{
                  aspectRatio: post.aspect === "portrait" ? "4 / 5" : "9 / 16",
                  background: slide.background,
                  color: slide.ink,
                  fontFamily:
                    slide.font === "serif"
                      ? "Georgia, serif"
                      : "Helvetica, sans-serif",
                }}
              >
                {slide.assetId && (
                  <Image
                    unoptimized
                    fill
                    sizes="480px"
                    src={`/api/media/${slide.assetId}`}
                    alt="Selected background"
                    style={{ objectFit: "cover" }}
                  />
                )}
                {slide.assetId && (
                  <div
                    className="draft-overlay"
                    style={{ background: `rgba(0,0,0,${slide.overlay})` }}
                  />
                )}
                <span
                  className="draft-accent"
                  style={{ background: slide.accent }}
                />
                <div
                  className={`draft-copy ${slide.position}`}
                  style={{ textAlign: slide.align }}
                >
                  <h2 style={{ fontSize: `${slide.fontSize / 10.8}cqw` }}>
                    {slide.title || "Your heading here"}
                  </h2>
                  <p>{slide.body}</p>
                </div>
                <div className="draft-footer">
                  <span>{slide.role.toUpperCase()}</span>
                  <span>
                    {String(selected + 1).padStart(2, "0")} /{" "}
                    {String(post.slides.length).padStart(2, "0")}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="canvas-nav">
            <IconButton
              label="Previous slide"
              disabled={selected === 0}
              onClick={() => setSelected((i) => i - 1)}
            >
              <ChevronLeft size={18} />
            </IconButton>
            <span>
              Slide {selected + 1} of {post.slides.length}
            </span>
            <IconButton
              label="Next slide"
              disabled={selected === post.slides.length - 1}
              onClick={() => setSelected((i) => i + 1)}
            >
              <ChevronRight size={18} />
            </IconButton>
          </div>
          <p className="canvas-help">
            {preview
              ? "This is the exact JPEG used in your export."
              : "Layout draft · render the final preview to check exact text placement."}
          </p>
        </section>
        <aside className="inspector">
          <div className="inspector-heading">
            <h3>The details</h3>
            <Settings2 size={17} />
          </div>
          <fieldset disabled={busy || immutable}>
            <Field label="Post title">
              <input
                value={post.title}
                maxLength={160}
                onChange={(e) => update({ ...post, title: e.target.value })}
              />
            </Field>
            <div className="inspector-section">
              <div className="section-label">
                SLIDE {selected + 1}
                <div>
                  <IconButton
                    label="Move slide earlier"
                    onClick={() => reorder(-1)}
                    disabled={selected === 0}
                  >
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    label="Move slide later"
                    onClick={() => reorder(1)}
                    disabled={selected === post.slides.length - 1}
                  >
                    <ArrowDown size={14} />
                  </IconButton>
                  <IconButton
                    label="Delete slide"
                    disabled={post.slides.length === 1}
                    onClick={() => {
                      update({
                        ...post,
                        slides: post.slides.filter((_, i) => i !== selected),
                      });
                      setSelected(Math.max(0, selected - 1));
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
              <Field label="Role">
                <select
                  value={slide.role}
                  onChange={(e) =>
                    patch({ role: e.target.value as Slide["role"] })
                  }
                >
                  <option value="hook">Hook</option>
                  <option value="body">Body</option>
                  <option value="cta">Call to action</option>
                </select>
              </Field>
              <Field label="Heading">
                <textarea
                  rows={3}
                  maxLength={180}
                  value={slide.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </Field>
              <Field label="Supporting copy">
                <textarea
                  rows={4}
                  maxLength={450}
                  value={slide.body}
                  onChange={(e) => patch({ body: e.target.value })}
                />
              </Field>
              <div className="form-row">
                <Field label="Typography">
                  <select
                    value={slide.font}
                    onChange={(e) =>
                      patch({ font: e.target.value as Slide["font"] })
                    }
                  >
                    <option value="serif">Serif</option>
                    <option value="sans">Sans</option>
                  </select>
                </Field>
                <Field label="Heading size">
                  <input
                    type="number"
                    min={40}
                    max={110}
                    value={slide.fontSize}
                    onChange={(e) =>
                      patch({ fontSize: Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
              <div className="form-row">
                <Field label="Text align">
                  <select
                    value={slide.align}
                    onChange={(e) =>
                      patch({ align: e.target.value as Slide["align"] })
                    }
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                  </select>
                </Field>
                <Field label="Position">
                  <select
                    value={slide.position}
                    onChange={(e) =>
                      patch({ position: e.target.value as Slide["position"] })
                    }
                  >
                    <option value="top">Top</option>
                    <option value="center">Center</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </Field>
              </div>
              <div className="form-row colors">
                {(["background", "ink", "accent"] as const).map((k) => (
                  <Field
                    key={k}
                    label={
                      k === "ink"
                        ? "Text"
                        : k.charAt(0).toUpperCase() + k.slice(1)
                    }
                  >
                    <input
                      type="color"
                      value={slide[k]}
                      onChange={(e) => patch({ [k]: e.target.value })}
                    />
                  </Field>
                ))}
              </div>
              <Field label="Background image">
                <select
                  value={slide.assetId || ""}
                  onChange={(e) => patch({ assetId: e.target.value || null })}
                >
                  <option value="">Solid color</option>
                  {state.assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              {slide.assetId && (
                <Field
                  label={`Dark overlay · ${Math.round(slide.overlay * 100)}%`}
                >
                  <input
                    type="range"
                    min={0}
                    max={0.85}
                    step={0.05}
                    value={slide.overlay}
                    onChange={(e) => patch({ overlay: Number(e.target.value) })}
                  />
                </Field>
              )}
            </div>
            <div className="inspector-section">
              <span className="section-label">POST DETAILS</span>
              <Field label="Canvas">
                <select
                  value={post.aspect}
                  onChange={(e) =>
                    update({
                      ...post,
                      aspect: e.target.value as Post["aspect"],
                    })
                  }
                >
                  <option value="portrait">4:5 · Portrait</option>
                  <option value="story">9:16 · Full height</option>
                </select>
              </Field>
              <Field label="Caption">
                <textarea
                  rows={4}
                  maxLength={2200}
                  value={post.caption}
                  onChange={(e) => update({ ...post, caption: e.target.value })}
                />
              </Field>
              <Field label="Target account">
                <input
                  placeholder="@youraccount"
                  value={post.account}
                  onChange={(e) => update({ ...post, account: e.target.value })}
                />
              </Field>
              <Field
                label="Planned posting time"
                hint="Your computer’s local timezone. This does not schedule publication."
              >
                <input
                  type="datetime-local"
                  value={post.plannedAt ? localDateInput(post.plannedAt) : ""}
                  onChange={(e) =>
                    update({
                      ...post,
                      plannedAt: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : "",
                    })
                  }
                />
              </Field>
              <Field label="Disclosure / music notes">
                <textarea
                  rows={2}
                  value={post.notes}
                  maxLength={1000}
                  onChange={(e) => update({ ...post, notes: e.target.value })}
                />
              </Field>
            </div>
          </fieldset>
          <button
            className="button secondary full"
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api("duplicate", { id: saved.id });
                await onSaved();
                onToast("A new copy is in your content garden.");
              })
            }
          >
            <Copy size={15} />
            Duplicate post
          </button>
          <button
            className="text-button archive"
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api("archive", { id: post.id });
                await onSaved();
                onClose();
              })
            }
          >
            Archive post
          </button>
        </aside>
      </div>
      {preview && ready && !dirty && (
        <div className="review-bar">
          <div>
            <ShieldCheck size={23} />
            <span>
              <strong>
                {post.status === "approved" || post.status === "published"
                  ? "This revision is approved."
                  : "Give it one final look."}
              </strong>
              <small>
                {post.slides.length} slides ·{" "}
                {post.account || "No account label"} ·{" "}
                {post.plannedAt
                  ? new Date(post.plannedAt).toLocaleString()
                  : "No planned date"}
                {post.flags.length
                  ? ` · ${post.flags.length} quality flags`
                  : ""}
              </small>
            </span>
          </div>
          <div>
            <button
              className="button secondary"
              onClick={() =>
                action(async () => {
                  await navigator.clipboard.writeText(post.caption);
                  onToast("Caption copied.");
                })
              }
            >
              Copy caption
            </button>
            {post.status === "approved" || post.status === "published" ? (
              <>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={download}
                >
                  <Download size={17} />
                  Download package
                </button>
                {post.status === "approved" && (
                  <button
                    className="button secondary"
                    onClick={() => setConfirming(true)}
                  >
                    Record published post
                  </button>
                )}
              </>
            ) : (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const updated = await api("approve", {
                      id: post.id,
                      revision: post.revision,
                    });
                    setPost(updated);
                    setSaved(updated);
                    await onSaved();
                    onToast("Approved for manual export.");
                  })
                }
              >
                <Check size={17} />
                Approve this export
              </button>
            )}
          </div>
          {post.flags.length > 0 && (
            <p className="review-flags">{post.flags.join(" · ")}</p>
          )}
        </div>
      )}
      {confirming &&
        (dirty ? (
          <Modal
            title="Keep your changes?"
            onClose={() => setConfirming(false)}
          >
            <p>You have edits that haven’t been saved.</p>
            <div className="modal-actions">
              <button className="button secondary" onClick={onClose}>
                Discard changes
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await save();
                    onClose();
                  })
                }
              >
                Save & close
              </button>
            </div>
          </Modal>
        ) : (
          <Modal
            title="Record your published post."
            subtitle="Publish the package in TikTok first, then paste its URL here."
            onClose={() => setConfirming(false)}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                action(async () => {
                  const updated = await api("publish", {
                    id: post.id,
                    url: f.get("url"),
                  });
                  setPost(updated);
                  setSaved(updated);
                  setConfirming(false);
                  await onSaved();
                  onToast("Publication recorded as owner-confirmed.");
                });
              }}
            >
              <Field label="TikTok post URL">
                <input
                  type="url"
                  name="url"
                  required
                  placeholder="https://www.tiktok.com/@you/photo/…"
                />
              </Field>
              <div className="modal-actions">
                <button className="button primary" disabled={busy}>
                  Confirm publication
                </button>
              </div>
            </form>
          </Modal>
        ))}
    </div>
  );
}
function localDateInput(value: string) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function CalendarView({
  posts,
  onOpen,
}: {
  posts: Post[];
  onOpen: (p: Post) => void;
}) {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
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
              className={`calendar-day ${d < 1 || d > days ? "outside" : ""} ${sameDay(new Date().toISOString()) ? "today" : ""}`}
            >
              <span>{date.getDate()}</span>
              {d > 0 &&
                d <= days &&
                posts
                  .filter((p) => p.plannedAt && sameDay(p.plannedAt))
                  .map((p) => (
                    <button key={p.id} onClick={() => onOpen(p)}>
                      <i className={p.status} />
                      {p.title}
                      <small>{statusLabel[p.status]}</small>
                    </button>
                  ))}
            </div>
          );
        })}
      </div>
      <p className="calendar-note">
        Dates are shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.
        Add a planned time in any slideshow’s Post details. No automatic
        publishing.
      </p>
    </section>
  );
}
function Results({
  posts,
  busy,
  onSave,
}: {
  posts: Post[];
  busy: boolean;
  onSave: (id: string, data: Record<string, number | null>) => void;
}) {
  const [edit, setEdit] = useState<Post | null>(null);
  const csv = () => {
    const rows = [
      ["Post", "URL", "Views", "Likes", "Comments", "Shares", "Measured at"],
      ...posts.map((p) => [
        p.title,
        p.publishedUrl || "",
        p.metrics?.views ?? "",
        p.metrics?.likes ?? "",
        p.metrics?.comments ?? "",
        p.metrics?.shares ?? "",
        p.metrics?.measuredAt || "",
      ]),
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
    a.download = "fieldwork-results.csv";
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
        <h2>{posts.length} published posts</h2>
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
                </td>
                <td>
                  <button className="text-button" onClick={() => setEdit(p)}>
                    Add results
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
          subtitle="Leave unknown values empty. All results are manually recorded."
          onClose={() => setEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              onSave(
                edit.id,
                Object.fromEntries(
                  [...f.entries()].map(([k, v]) => [
                    k,
                    v === "" ? null : Number(v),
                  ]),
                ),
              );
              setEdit(null);
            }}
          >
            {(["views", "likes", "comments", "shares"] as const).map((k) => (
              <Field key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
                <input
                  type="number"
                  name={k}
                  min={0}
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
