"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Image from "next/image";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  Grid2X2,
  Home,
  ImageIcon,
  Layers3,
  List,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  Format,
  Post,
  RoleTemplate,
  Slide,
  StructureSlide,
  StudioState,
} from "@/lib/schema";
import { formatSchema } from "@/lib/schema";
import {
  roleNames,
  slideStructure,
  templateFor,
  templateSlide,
  toneGuidance,
  tonePresets,
} from "@/lib/format-template";
import {
  DEFAULT_ROUNDNESS,
  PHOTO_RENDER_VERSION,
  recolorStyle,
  restyle,
} from "@/lib/photo-layout";
import { collectionsOf, defaultBrandId, libraryAssets } from "@/lib/defaults";
import { describeIssues } from "@/lib/errors";
import { PhotoCanvas, usePhotoFonts } from "./photo-canvas";
import { NumberInput } from "./number-input";
import { arrowStep } from "./keys";
import { trapTab, useLatest, useScrollLock } from "./dialog";
import { studioAction } from "./request";
import { RenderFallback } from "./render-fallback";
import { ColorPicker } from "./ui/color-picker";
import { Dropdown } from "./ui/dropdown";
import { Slider } from "./ui/slider";
import { ScrollRail } from "./ui/scroll-rail";
import {
  canvasItems,
  fontItems,
  positionItems,
  roleItems,
  styleItems,
} from "./options";

type Page = "overview" | "template" | "hooks" | "schedule" | "settings";
const pages = [
  ["overview", "Overview", Home],
  ["template", "Slideshow Format", Pencil],
  ["hooks", "Hooks & Style", MessageSquare],
  ["schedule", "Schedule", CalendarDays],
  ["settings", "Settings", Settings2],
] as const;
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="fd-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="fd-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}
const styleLabel = (style: RoleTemplate["style"]) =>
  style === "box" ? "Background" : style === "shadow" ? "Shadow" : "Outline";
function normalize(format: Format, state: StudioState): Format {
  const brandId = defaultBrandId(state, format);
  return {
    ...format,
    brandId,
    websiteUrl:
      format.websiteUrl ??
      state.brands.find((brand) => brand.id === brandId)?.destination ??
      "",
    hooks: format.hooks ?? [],
    tonePreset: format.tonePreset ?? "custom",
    toneInstructions: format.toneInstructions ?? "",
  };
}

export default function FormatDashboard({
  initial,
  state,
  onClose,
  onSave,
  onOpenPost,
  onCreate,
  schedule,
  suspended = false,
}: {
  initial: Format;
  state: StudioState;
  onClose: () => void;
  // `expected` is the version an update was edited from.
  onSave: (format: Format, expected?: number) => Promise<Format>;
  onOpenPost: (post: Post) => void;
  onCreate: (format: Format, topic?: string) => void;
  schedule: (posts: Post[]) => ReactNode;
  suspended?: boolean;
}) {
  const [draft, setDraft] = useState(() => normalize(initial, state));
  const [saved, setSaved] = useState(() => normalize(initial, state));
  const [page, setPage] = useState<Page>(initial.id ? "overview" : "settings");
  const [writingTab, setWritingTab] = useState<"hooks" | "tone">("hooks");
  const [role, setRole] = useState<Slide["role"]>("hook");
  const [slot, setSlot] = useState(0);
  const [grid, setGrid] = useState(false);
  const [hooksText, setHooksText] = useState((initial.hooks ?? []).join("\n"));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [order, setOrder] = useState("recent");
  const root = useRef<HTMLDivElement>(null);
  const previewTrack = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const { fonts, error: fontError } = usePhotoFonts();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const posts = state.posts.filter(
    (post) => post.formatId === saved.id && post.status !== "archived",
  );
  const brand = state.brands.find((item) => item.id === draft.brandId);
  const template = templateFor(draft, role);
  const structure = slideStructure(draft);
  const current = Math.min(slot, structure.length - 1);
  const selectSlot = (index: number) => {
    setSlot(index);
    setRole(structure[index].role);
  };
  const collections = collectionsOf(state.assets);
  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [busy, dirty, onClose]);
  const closeRef = useLatest(requestClose);
  // Arrow keys move between preview slides on the Slideshow Format page.
  const stepRef = useRef<(offset: number) => boolean>(() => false);
  useEffect(() => {
    stepRef.current = (offset) => {
      if (page !== "template") return false;
      selectSlot(Math.max(0, Math.min(structure.length - 1, current + offset)));
      return true;
    };
  });
  useScrollLock(!suspended);
  useEffect(() => {
    if (suspended) return;
    root.current?.focus();
    const key = (event: KeyboardEvent) => {
      const confirmation =
        root.current?.querySelector<HTMLElement>(".fd-confirm");
      // Defer to any other open dialog (such as calendar details).
      const otherDialog = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ].some((dialog) => dialog !== root.current && dialog !== confirmation);
      if (!confirmation && otherDialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmation) setConfirmClose(false);
        else closeRef.current();
      }
      const step = arrowStep(event);
      if (step && !confirmation && stepRef.current(step))
        event.preventDefault();
      // The close confirmation, when shown, holds focus by itself.
      trapTab(event, confirmation ?? root.current);
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, [suspended, closeRef]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const container = previewTrack.current;
    const selected = container?.querySelector<HTMLElement>(
      `[data-index="${current}"]`,
    );
    if (container && selected && !grid)
      container.scrollTo({
        left: selected.offsetLeft - container.offsetLeft - 22,
        behavior: "instant",
      });
  }, [current, grid, page, fonts]);
  const patch = (change: Partial<Format>) => {
    setDraft((value) => ({ ...value, ...change }));
    setNotice("");
  };
  const patchTemplate = (change: Partial<RoleTemplate>) =>
    patch({
      font: "tiktok",
      design: "photo",
      templates: {
        hook: templateFor(draft, "hook"),
        body: templateFor(draft, "body"),
        cta: templateFor(draft, "cta"),
        [role]: { ...template, ...change },
      },
    });
  // Editing the outline saves it on the format, which then fixes the count.
  const patchStructure = (next: StructureSlide[]) =>
    patch({ structure: next, slideCount: next.length });
  const patchSlot = (index: number, change: Partial<StructureSlide>) =>
    patchStructure(
      structure.map((slide, i) =>
        i === index ? { ...slide, ...change } : slide,
      ),
    );
  const moveSlot = (index: number, offset: number) => {
    const next = [...structure];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    patchStructure(next);
    setSlot(index + offset);
  };
  const addSlot = () => {
    // New content goes before a closing CTA rather than after it.
    const at =
      structure.at(-1)?.role === "cta"
        ? structure.length - 1
        : structure.length;
    patchStructure([
      ...structure.slice(0, at),
      { label: "New slide", role: "body", text: "" },
      ...structure.slice(at),
    ]);
    setSlot(at);
    setRole("body");
  };
  const setHooks = (text: string) => {
    setHooksText(text);
    patch({
      hooks: text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
  };
  async function persist() {
    const parsed = formatSchema.safeParse({
      ...draft,
      id: draft.id || undefined,
    });
    if (!parsed.success) throw new Error(describeIssues(parsed.error.issues));
    const next = normalize(
      await onSave({ ...parsed.data, id: draft.id }, saved.version ?? 0),
      state,
    );
    setSaved(next);
    setDraft(next);
    setNotice("Format saved. New slideshows will use these settings.");
    return next;
  }
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function generateHooks() {
    await action(async () => {
      const result = await studioAction(
        "hooks",
        {
          brandId: draft.brandId,
          format: { ...draft, id: draft.id || undefined },
          prompt,
          url: draft.websiteUrl,
        },
        "Could not generate hooks.",
      );
      setHooks([...(draft.hooks ?? []), ...result.hooks].join("\n"));
      setNotice("10 hooks added. Review them, then save your format.");
    });
  }
  const create = (topic?: string) =>
    action(async () =>
      onCreate(dirty || !saved.id ? await persist() : saved, topic),
    );
  const ordered = [...posts].sort((a, b) =>
    order === "oldest"
      ? a.createdAt.localeCompare(b.createdAt)
      : b.createdAt.localeCompare(a.createdAt),
  );
  const previewSlides = fonts
    ? structure.map((slot, index) => {
        const kind = slot.role;
        const slide: Slide = {
          id: `preview-${index}`,
          role: kind,
          title:
            (index === 0 && draft.hooks?.[0]) ||
            slot.text ||
            (kind === "hook"
              ? "A fresh perspective starts here"
              : kind === "cta"
                ? "Make your next step count"
                : `One useful idea, clearly told`),
          body:
            kind === "body" && !slot.text
              ? "Keep each slide focused on one thought your audience can use."
              : "",
          assetId: null,
          background: draft.color,
          ink: draft.ink,
          accent: draft.accent,
          font: "tiktok",
          align: "center",
          position: "center",
          fontSize: 82,
          overlay: 0.25,
        };
        return templateSlide(slide, draft, fonts, state.assets, index);
      })
    : [];
  return (
    <div className="fd-backdrop" hidden={suspended}>
      <section
        className="fd-window"
        ref={root}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Format dashboard"
      >
        <aside className="fd-sidebar">
          <button className="fd-back" onClick={requestClose}>
            <ArrowLeft size={16} /> All formats
          </button>
          <div className="fd-brand">
            <span>{brand?.name.slice(0, 1) || "F"}</span>
            <div className="fd-brand-picker">
              <small>Brand context</small>
              <Dropdown
                variant="bare"
                label="Format brand"
                placeholder="Choose a brand"
                value={draft.brandId}
                disabled={busy}
                items={state.brands.map((brand) => ({
                  value: brand.id,
                  label: brand.name,
                }))}
                onChange={(brandId) =>
                  patch({
                    brandId,
                    websiteUrl:
                      state.brands.find((brand) => brand.id === brandId)
                        ?.destination || "",
                  })
                }
              />
            </div>
          </div>
          <nav aria-label="Format sections">
            {pages.map(([id, label, Icon]) => (
              <button
                key={id}
                className={page === id ? "active" : ""}
                aria-current={page === id ? "page" : undefined}
                onClick={() => {
                  setPage(id);
                  setError("");
                }}
              >
                <Icon size={18} />
                <span>
                  {label}
                  {id === "hooks" && (
                    <small> ({draft.hooks?.length ?? 0})</small>
                  )}
                </span>
                {page === id && <ChevronRight size={15} />}
              </button>
            ))}
          </nav>
          <div className="fd-sidebar-bottom">
            <p>
              <Layers3 size={16} /> {draft.slideCount} slides ·{" "}
              {draft.aspect === "story" ? "9:16" : "4:5"}
            </p>
            <small>Changes apply to new slideshows.</small>
            <button
              className="fd-duplicate"
              disabled={busy || !saved.id}
              onClick={() =>
                action(async () => {
                  const duplicate = await onSave({
                    ...draft,
                    id: "",
                    name: `${draft.name.slice(0, 73)} (copy)`,
                  });
                  const next = normalize(duplicate, state);
                  setDraft(next);
                  setSaved(next);
                  setNotice("Format duplicated. You’re editing the copy.");
                  setPage("settings");
                })
              }
            >
              <Copy size={15} /> Duplicate format
            </button>
          </div>
        </aside>
        <div className="fd-main">
          <header className="fd-toolbar">
            <span>
              FORMATS <ChevronRight size={12} /> {draft.name}
            </span>
            <div>
              <small>
                {busy
                  ? "Working…"
                  : dirty
                    ? "Unsaved changes"
                    : "All changes saved"}
              </small>
              <button
                className="fd-save"
                disabled={busy || (!dirty && !!saved.id)}
                onClick={() =>
                  action(async () => {
                    await persist();
                  })
                }
              >
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                Save changes
              </button>
              <button
                aria-label="Close format dashboard"
                className="icon-button"
                onClick={requestClose}
              >
                <X size={19} />
              </button>
            </div>
          </header>
          {(error || fontError) && (
            <p className="fd-error" role="alert">
              {error || fontError}
            </p>
          )}
          {notice && (
            <p className="fd-notice" role="status">
              {notice}
            </p>
          )}
          <fieldset disabled={busy} className={`fd-page fd-page-${page}`}>
            {page === "overview" && (
              <>
                <div className="fd-cover">
                  <Layers3 size={54} strokeWidth={0.8} />
                </div>
                <div className="fd-profile">
                  <div className="fd-avatar">
                    {brand?.name.slice(0, 1) || "F"}
                  </div>
                  <h1>
                    {draft.name}
                    <button
                      aria-label="Rename format"
                      onClick={() => setPage("settings")}
                    >
                      <Pencil size={15} />
                    </button>
                  </h1>
                  <p>
                    {brand?.name || "Your personal format"} · {draft.slideCount}
                    -slide {draft.aspect === "story" ? "9:16" : "4:5"} slideshow
                  </p>
                  <p>{draft.description}</p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => create()}
                  >
                    <Plus size={16} /> Create slideshow
                  </button>
                </div>
                <div className="fd-recent">
                  <header>
                    <h2>
                      Slideshows <span>({posts.length})</span>
                    </h2>
                    <div>
                      <Dropdown
                        variant="bare"
                        label="Sort slideshows"
                        value={order}
                        items={[
                          { value: "recent", label: "Recent first" },
                          { value: "oldest", label: "Oldest first" },
                        ]}
                        onChange={setOrder}
                      />
                      {posts.length > 6 && (
                        <button onClick={() => setShowAll(!showAll)}>
                          {showAll ? "Show recent" : "View all"}
                        </button>
                      )}
                    </div>
                  </header>
                  {posts.length ? (
                    <div className="fd-post-grid">
                      {(showAll ? ordered : ordered.slice(0, 6)).map((post) => (
                        <button
                          key={post.id}
                          className="fd-post"
                          onClick={() => onOpenPost(post)}
                        >
                          <div
                            style={{
                              aspectRatio:
                                post.aspect === "story" ? "9 / 16" : "4 / 5",
                            }}
                          >
                            <CoverImage post={post} />
                            <span>
                              {post.status === "published"
                                ? "Published"
                                : post.plannedAt
                                  ? "Queued"
                                  : "Not published"}
                            </span>
                          </div>
                          <strong>{post.title}</strong>
                          {post.plannedAt && (
                            <small>
                              {new Date(post.plannedAt).toLocaleString(
                                undefined,
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                },
                              )}
                            </small>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="fd-empty">
                      <ImageIcon size={32} />
                      <h3>Your first slideshow starts here.</h3>
                      <p>
                        Set up your visuals and writing style, then create a
                        draft with this format.
                      </p>
                      <button
                        className="button secondary"
                        onClick={() => setPage("template")}
                      >
                        Design the format <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {page === "hooks" && (
              <div className="fd-writing">
                <div
                  role="tablist"
                  aria-label="Writing settings"
                  className="fd-tabs"
                >
                  <button
                    role="tab"
                    aria-selected={writingTab === "hooks"}
                    onClick={() => setWritingTab("hooks")}
                  >
                    Hooks ({draft.hooks?.length ?? 0})
                  </button>
                  <button
                    role="tab"
                    aria-selected={writingTab === "tone"}
                    onClick={() => setWritingTab("tone")}
                  >
                    Tone & Style
                  </button>
                </div>
                {writingTab === "hooks" ? (
                  <>
                    <h1>Slideshow Hooks</h1>
                    <p>
                      Each line is a separate opening hook. Edit your collection
                      or generate more.
                    </p>
                    <div className="fd-hook-generator">
                      <Field
                        label="What should these hooks be about?"
                        hint="Optional. Leave this blank to use the website below as context."
                      >
                        <textarea
                          rows={2}
                          value={prompt}
                          maxLength={2000}
                          disabled={busy}
                          placeholder="e.g. Questions people should ask before comparing a promotion"
                          onChange={(event) => setPrompt(event.target.value)}
                        />
                      </Field>
                      <Field label="Website context">
                        <input
                          type="url"
                          value={draft.websiteUrl}
                          disabled={busy}
                          placeholder="https://example.com"
                          onChange={(event) =>
                            patch({ websiteUrl: event.target.value })
                          }
                        />
                      </Field>
                      <button
                        className="button secondary"
                        disabled={
                          busy ||
                          !state.settings.aiReady ||
                          !draft.brandId ||
                          (draft.hooks?.length ?? 0) > 190
                        }
                        onClick={generateHooks}
                      >
                        {busy ? (
                          <Loader2 className="spin" size={16} />
                        ) : (
                          <Sparkles size={16} />
                        )}{" "}
                        Generate 10 more
                      </button>
                      {!state.settings.aiReady && (
                        <small>
                          Add OPENAI_API_KEY in the workspace Settings
                          instructions to enable generation. You can still enter
                          hooks below.
                        </small>
                      )}
                    </div>
                    <Field
                      label="Saved hooks"
                      hint={`${draft.hooks?.length ?? 0} / 200 hooks · Up to 180 characters per line`}
                    >
                      <textarea
                        className="fd-hook-list"
                        rows={15}
                        value={hooksText}
                        disabled={busy}
                        placeholder="Write your first hook here…"
                        onChange={(event) => setHooks(event.target.value)}
                      />
                    </Field>
                    {!!draft.hooks?.length && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => create(draft.hooks?.[0])}
                      >
                        Create from first hook <ArrowRight size={15} />
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <h1>Tone & Style</h1>
                    <p>
                      Define how your slideshow should sound — voice,
                      perspective, reading level, and style rules.
                    </p>
                    <Field label="Writing style">
                      <Dropdown
                        label="Writing style"
                        value={draft.tonePreset}
                        items={Object.entries(tonePresets).map(
                          ([key, label]) => ({ value: key, label }),
                        )}
                        onChange={(value) =>
                          patch({
                            tonePreset: value as Format["tonePreset"],
                          })
                        }
                      />
                    </Field>
                    {draft.tonePreset !== "custom" && (
                      <p className="fd-preset-note">
                        {toneGuidance[draft.tonePreset ?? "custom"]}
                      </p>
                    )}
                    <Field label="Custom writing instructions">
                      <textarea
                        rows={18}
                        value={draft.toneInstructions}
                        maxLength={8000}
                        placeholder="e.g. Write conversationally. Keep each slide focused on one idea. Explain technical terms in plain language."
                        onChange={(event) =>
                          patch({ toneInstructions: event.target.value })
                        }
                      />
                    </Field>
                    <p className="fd-help">
                      Applies to slide text after the opening hook and to
                      captions. Saved hooks are preserved exactly and generated
                      separately. Brand facts and claims to avoid still apply.
                    </p>
                  </>
                )}
              </div>
            )}
            {page === "settings" && (
              <div className="fd-settings">
                <h1>Format settings</h1>
                <p>
                  Your format’s name, defaults, and original writing
                  instructions.
                </p>
                <Field label="Format name">
                  <input
                    required
                    maxLength={80}
                    value={draft.name}
                    onChange={(event) => patch({ name: event.target.value })}
                  />
                </Field>
                <Field label="Short description">
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={draft.description}
                    onChange={(event) =>
                      patch({ description: event.target.value })
                    }
                  />
                </Field>
                <Field label="Writing instructions">
                  <textarea
                    rows={5}
                    maxLength={2000}
                    value={draft.instructions}
                    onChange={(event) =>
                      patch({ instructions: event.target.value })
                    }
                  />
                </Field>
                <div className="fd-field-row">
                  <Field
                    label="Default slide count"
                    hint={
                      draft.structure
                        ? "Set by the slide structure. Add or remove slides on the Slideshow Format page."
                        : "The creation popup can override this number."
                    }
                  >
                    <NumberInput
                      min={2}
                      max={10}
                      disabled={!!draft.structure}
                      value={draft.slideCount}
                      onChange={(slideCount) =>
                        patch({ slideCount: Math.round(slideCount) })
                      }
                    />
                  </Field>
                  <Field label="Canvas">
                    <Dropdown
                      label="Canvas"
                      value={draft.aspect}
                      items={canvasItems}
                      onChange={(aspect) => patch({ aspect })}
                    />
                  </Field>
                </div>
                <Field label="Typography">
                  <Dropdown
                    label="Typography"
                    value={draft.font}
                    items={[
                      {
                        value: "tiktok",
                        label: "Default · TikTok Sans / photo style",
                      },
                      { value: "serif", label: "Editorial serif" },
                      { value: "sans", label: "Clean sans serif" },
                    ]}
                    onChange={(font) =>
                      // Role templates are kept (unused by editorial layouts)
                      // so switching back restores them.
                      patch({
                        font,
                        design: font === "tiktok" ? "photo" : "editorial",
                      })
                    }
                  />
                </Field>
                <div className="fd-field-row">
                  {[
                    ["color", "Background"],
                    ["ink", "Text"],
                    ["accent", "Accent"],
                  ].map(([key, label]) => (
                    <Field key={key} label={label}>
                      <ColorPicker
                        variant="field"
                        label={label}
                        value={draft[key as "color" | "ink" | "accent"]}
                        onChange={(value) => patch({ [key]: value })}
                      />
                    </Field>
                  ))}
                </div>
                <p className="fd-help">
                  Photo templates can customize text color separately for Hook,
                  Content, and CTA. Existing posts keep their original settings.
                </p>
              </div>
            )}
            {page === "schedule" && (
              <div className="fd-schedule">
                <h1>Schedule</h1>
                <p>
                  Planned posts using this format. Select an entry for its date,
                  time, and details.
                </p>
                {schedule(posts)}
                {!posts.some((post) => post.plannedAt) && (
                  <p className="fd-help">
                    No posts queued yet. Open a slideshow and choose “Add to
                    queue.”
                  </p>
                )}
              </div>
            )}
            {page === "template" && (
              <div className="fd-template">
                <aside className="fd-template-controls">
                  <div
                    className="fd-tabs"
                    role="tablist"
                    aria-label="Slide role"
                  >
                    {Object.entries(roleNames).map(([key, label]) => (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={role === key}
                        onClick={() => setRole(key as Slide["role"])}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="fd-template-options">
                    <Field label={`${roleNames[role]} image collection`}>
                      <Dropdown
                        label={`${roleNames[role]} image collection`}
                        value={template.collection}
                        items={[
                          { value: "", label: "Solid background" },
                          ...collections.map((collection) => ({
                            value: collection,
                            label: collection,
                          })),
                        ]}
                        onChange={(collection) => patchTemplate({ collection })}
                      />
                    </Field>
                    <div className="fd-collection-strip">
                      {libraryAssets(state.assets)
                        .filter(
                          (asset) => asset.collection === template.collection,
                        )
                        .slice(0, 5)
                        .map((asset) => (
                          <Image
                            key={asset.id}
                            width={50}
                            height={44}
                            unoptimized
                            src={`/api/media/${asset.id}`}
                            alt={asset.name}
                          />
                        ))}
                      {!template.collection && (
                        <small>
                          Choose a collection from your Assets library.
                        </small>
                      )}
                    </div>
                    <Field label="Aspect ratio">
                      <Dropdown
                        label="Aspect ratio"
                        value={draft.aspect}
                        items={canvasItems}
                        onChange={(aspect) => patch({ aspect })}
                      />
                    </Field>
                    <Field label="Image grid">
                      <Dropdown
                        label="Image grid"
                        value={template.imageGrid}
                        items={[
                          { value: "none", label: "None · single image" },
                          { value: "split", label: "2 images · stacked" },
                          { value: "quad", label: "4 images · grid" },
                        ]}
                        onChange={(imageGrid) => patchTemplate({ imageGrid })}
                      />
                    </Field>
                    <Toggle
                      label="Dark overlay"
                      checked={template.overlay > 0}
                      onChange={(value) =>
                        patchTemplate({ overlay: value ? 0.25 : 0 })
                      }
                    />
                    {template.overlay > 0 && (
                      <Field
                        label={`Darkening · ${Math.round(template.overlay * 100)}%`}
                      >
                        <Slider
                          min={0}
                          max={85}
                          value={template.overlay * 100}
                          onChange={(event) =>
                            patchTemplate({
                              overlay: Number(event.target.value) / 100,
                            })
                          }
                        />
                      </Field>
                    )}
                    <Toggle
                      label="Display text"
                      checked={template.displayText}
                      onChange={(value) =>
                        patchTemplate({ displayText: value })
                      }
                    />
                    <details>
                      <summary>Advanced</summary>
                      <Field label="Image fit">
                        <Dropdown
                          label="Image fit"
                          value={template.imageFit}
                          items={[
                            { value: "cover", label: "Crop to fill" },
                            { value: "contain", label: "Fit entire image" },
                          ]}
                          onChange={(imageFit) => patchTemplate({ imageFit })}
                        />
                      </Field>
                      <Field
                        label={`Image zoom · ${template.imageZoom.toFixed(1)}×`}
                      >
                        <Slider
                          min={1}
                          max={3}
                          step={0.1}
                          value={template.imageZoom}
                          onChange={(event) =>
                            patchTemplate({
                              imageZoom: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      {(["imageX", "imageY"] as const).map((key) => (
                        <Field
                          key={key}
                          label={`Image ${key === "imageX" ? "horizontal" : "vertical"} position · ${template[key]}%`}
                        >
                          <Slider
                            min={0}
                            max={100}
                            value={template[key]}
                            onChange={(event) =>
                              patchTemplate({
                                [key]: Number(event.target.value),
                              })
                            }
                          />
                        </Field>
                      ))}
                    </details>
                    <p className="fd-help">
                      These controls apply to every {roleNames[role]} slide.
                      Saving visual changes uses the photo layout.
                    </p>
                  </div>
                </aside>
                <div className="fd-template-stage">
                  <header>
                    <span>LIVE PREVIEW</span>
                    <div>
                      <button
                        aria-label="Carousel preview"
                        aria-pressed={!grid}
                        onClick={() => setGrid(false)}
                      >
                        <List size={17} />
                      </button>
                      <button
                        aria-label="Grid preview"
                        aria-pressed={grid}
                        onClick={() => setGrid(true)}
                      >
                        <Grid2X2 size={17} />
                      </button>
                    </div>
                  </header>
                  <div
                    ref={previewTrack}
                    className={`fd-template-slides scroll-rail-target ${grid ? "grid" : ""}`}
                  >
                    {previewSlides.map((slide, index) => (
                      <button
                        key={slide.id}
                        data-index={index}
                        aria-pressed={index === current}
                        className={
                          index === current
                            ? "selected"
                            : slide.role === role
                              ? "same-style"
                              : ""
                        }
                        onClick={() => selectSlot(index)}
                      >
                        <span>
                          {structure[index]?.label ||
                            `${roleNames[slide.role]} ${index + 1}`}
                        </span>
                        <PhotoCanvas
                          slide={slide}
                          aspect={draft.aspect}
                          assets={state.assets}
                          fonts={fonts}
                        />
                      </button>
                    ))}
                    {structure.length < 10 && (
                      <button className="fd-add-slide" onClick={addSlot}>
                        <span>&nbsp;</span>
                        <div>
                          <Plus size={20} />
                          Add slide
                        </div>
                      </button>
                    )}
                  </div>
                  <ScrollRail
                    target={previewTrack}
                    className="fd-template-rail"
                  />
                  <section
                    className="fd-slide-panel"
                    aria-label={`Slide ${current + 1}`}
                  >
                    <header>
                      <h2>
                        Slide {current + 1}
                        <small> of {structure.length}</small>
                      </h2>
                      <div className="fd-slide-actions">
                        <button
                          aria-label="Move slide left"
                          disabled={current === 0}
                          onClick={() => moveSlot(current, -1)}
                        >
                          <ArrowLeft size={15} />
                        </button>
                        <button
                          aria-label="Move slide right"
                          disabled={current === structure.length - 1}
                          onClick={() => moveSlot(current, 1)}
                        >
                          <ArrowRight size={15} />
                        </button>
                        <button
                          aria-label="Remove slide"
                          disabled={structure.length <= 2}
                          onClick={() => {
                            patchStructure(
                              structure.filter((_, i) => i !== current),
                            );
                            setSlot(Math.max(0, current - 1));
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </header>
                    <div className="fd-field-row">
                      <Field label="Label">
                        <input
                          maxLength={40}
                          value={structure[current].label}
                          placeholder="e.g. #5, The problem, Reveal"
                          onChange={(event) =>
                            patchSlot(current, { label: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Design">
                        <Dropdown
                          label="Design"
                          value={structure[current].role}
                          items={roleItems}
                          onChange={(next) => {
                            patchSlot(current, { role: next });
                            setRole(next);
                          }}
                        />
                      </Field>
                    </div>
                    <Field label="Slide text">
                      <input
                        maxLength={180}
                        value={structure[current].text}
                        placeholder={
                          structure[current].role === "hook"
                            ? "e.g. 5 apps that fixed my sleep schedule"
                            : structure[current].role === "cta"
                              ? "e.g. Which one are you trying first?"
                              : "e.g. #5 Rise — tracks your sleep debt"
                        }
                        onChange={(event) =>
                          patchSlot(current, { text: event.target.value })
                        }
                      />
                    </Field>
                    <p className="fd-help">
                      Manual drafts start with each slide’s text; AI drafts
                      follow its pattern.{" "}
                      {draft.structure ? (
                        <>
                          The structure sets the slide count.{" "}
                          <button
                            className="fd-link"
                            onClick={() => {
                              patch({ structure: undefined });
                              setSlot(0);
                            }}
                          >
                            Reset to a simple outline
                          </button>
                        </>
                      ) : (
                        "Editing a slide saves this outline and fixes the slide count."
                      )}
                    </p>
                  </section>
                  <div className="fd-visual-settings">
                    <h2>
                      {roleNames[role]} design
                      <small> · applies to every {roleNames[role]} slide</small>
                    </h2>
                    <div className="fd-design-grid">
                      <Field label="Font">
                        <Dropdown
                          label="Font"
                          value={template.font}
                          items={fontItems}
                          onChange={(font) => patchTemplate({ font })}
                        />
                      </Field>
                      <Field label="Size">
                        <NumberInput
                          min={6}
                          max={48}
                          value={template.size}
                          onChange={(size) => patchTemplate({ size })}
                        />
                      </Field>
                      <Field label="Text color">
                        <ColorPicker
                          variant="field"
                          label="Text color"
                          value={template.color}
                          onChange={(color) => patchTemplate({ color })}
                        />
                      </Field>
                      <Field label="Style">
                        <Dropdown
                          label="Style"
                          value={template.style}
                          items={styleItems}
                          onChange={(style) => {
                            const next = restyle(template, style);
                            patchTemplate({
                              style: next.style,
                              color: next.color,
                              styleColor: next.styleColor,
                            });
                          }}
                        />
                      </Field>
                      {template.style === "plain" ? (
                        <span aria-hidden="true" />
                      ) : (
                        <Field label={`${styleLabel(template.style)} color`}>
                          <ColorPicker
                            variant="field"
                            label={`${styleLabel(template.style)} color`}
                            value={template.styleColor ?? "#000000"}
                            onChange={(styleColor) => {
                              const next = recolorStyle(template, styleColor);
                              patchTemplate({
                                styleColor: next.styleColor,
                                color: next.color,
                              });
                            }}
                          />
                        </Field>
                      )}
                      {template.style === "box" ? (
                        <Field
                          label={`Roundness · ${template.roundness ?? DEFAULT_ROUNDNESS}%`}
                        >
                          <span className="fd-range">
                            <Slider
                              min={0}
                              max={100}
                              value={template.roundness ?? DEFAULT_ROUNDNESS}
                              onChange={(event) =>
                                patchTemplate({
                                  roundness: Number(event.target.value),
                                })
                              }
                            />
                          </span>
                        </Field>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      <Field label="Position">
                        <Dropdown
                          label="Position"
                          value={template.position}
                          items={positionItems}
                          onChange={(position) => patchTemplate({ position })}
                        />
                      </Field>
                      <Field label="Width (%)">
                        <NumberInput
                          min={20}
                          max={100}
                          value={template.width}
                          onChange={(width) => patchTemplate({ width })}
                        />
                      </Field>
                      <Field label="Alignment">
                        <Dropdown
                          label="Alignment"
                          value={template.align}
                          items={[
                            { value: "left", label: "Left" },
                            { value: "center", label: "Center" },
                            { value: "right", label: "Right" },
                          ]}
                          onChange={(align) => patchTemplate({ align })}
                        />
                      </Field>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </fieldset>
        </div>
        {confirmClose && (
          <div
            className="fd-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved format changes"
          >
            <div>
              <h2>Save your format changes?</h2>
              <p>Your edits have not been saved yet.</p>
              <button
                ref={closeButton}
                autoFocus
                className="button secondary"
                onClick={() => setConfirmClose(false)}
              >
                Keep editing
              </button>
              <button className="button secondary" onClick={onClose}>
                Discard changes
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await persist();
                    onClose();
                  })
                }
              >
                Save and close
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function CoverImage({ post }: { post: Post }) {
  const src = `/api/render/${post.id}/${post.revision}/0?v=${PHOTO_RENDER_VERSION}`;
  const [failed, setFailed] = useState("");
  return failed === src ? (
    <RenderFallback />
  ) : (
    <Image
      fill
      unoptimized
      sizes="240px"
      src={src}
      alt={post.title}
      onError={() => setFailed(src)}
    />
  );
}
