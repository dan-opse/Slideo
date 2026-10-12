"use client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import Image from "next/image";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Grid2X2,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { PhotoText, Post, Slide, StudioState } from "@/lib/schema";
import {
  DEFAULT_ROUNDNESS,
  canvasHeight,
  clamp,
  defaultText,
  fitText,
  layoutText,
  photoSlide,
  recolorStyle,
  restyle,
  textProblem,
} from "@/lib/photo-layout";
import { PhotoCanvas, usePhotoFonts } from "./photo-canvas";
import { Control, NumberControl, SliderControl, Tool } from "./editor-controls";
import { ActionSheet, localDate, type Sheet } from "./editor-sheet";
import { Slider } from "./ui/slider";
import { arrowStep } from "./keys";
import { trapTab, useScrollLock } from "./dialog";
import { exportPackage, studioAction } from "./request";
import { ColorPicker } from "./ui/color-picker";
import { Dropdown } from "./ui/dropdown";
import { canvasItems, fontItems, positionItems, styleItems } from "./options";
import { collectionsOf, libraryAssets, plural } from "@/lib/defaults";

// Lock onto grid snaps text-box moves to 10-unit cells (24 across the
// 240-wide canvas), the same cells on every slide.
const GRID_STEP = 10;
const snapTo = (value: number, max: number) =>
  clamp(Math.round(value / GRID_STEP) * GRID_STEP, 0, max);
const SNAP_KEY = "slideo.lockToGrid";

export default function SlideshowEditor({
  initial,
  state,
  startEditing = false,
  startTab = "text",
  onClose,
  onSaved,
  onToast,
  onFormat,
}: {
  initial: Post;
  state: StudioState;
  startEditing?: boolean;
  startTab?: "text" | "image" | "post";
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToast: (value: string) => void;
  onFormat: (id: string) => void;
}) {
  const [post, setPost] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState(startEditing);
  const [selected, setSelected] = useState(0);
  const [layerId, setLayerId] = useState("");
  const [tab, setTab] = useState<"text" | "image" | "post">(startTab);
  const [past, setPast] = useState<Post[]>([]);
  const [future, setFuture] = useState<Post[]>([]);
  const [zoom, setZoom] = useState(100);
  const [compact, setCompact] = useState(false);
  const [grid, setGrid] = useState(false);
  const [lockGrid, setLockGrid] = useState(() => {
    try {
      return sessionStorage.getItem(SNAP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [collection, setCollection] = useState("");
  const { fonts, error: fontError } = usePhotoFonts();
  const root = useRef<HTMLDivElement>(null);
  const sheetOpener = useRef<HTMLElement | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const centerSlide = useRef(() => {});
  // Changes that share a gesture key (one slider drag) undo as one step.
  const gesture = useRef("");
  // Whether a dropdown or color picker was open when the pointer went down,
  // so a backdrop click that dismisses one does not also close the editor.
  const popoverOpen = useRef(false);
  const latest = useRef({ close: () => {}, step: (_offset: number) => {} });
  const dirty = JSON.stringify(post) !== JSON.stringify(saved);
  const slide = post.slides[selected] ?? post.slides[0];
  const layers = slide.textLayers ?? [];
  const layer = layers.find((item) => item.id === layerId) ?? layers[0];
  const immutable = post.status === "published";
  const approved = saved.status === "approved" || saved.status === "published";
  const deleted = saved.status === "archived";
  // Removed images stay selectable only where a slide already uses them.
  const pickable = (current?: string | null) =>
    state.assets.filter((asset) => !asset.removedAt || asset.id === current);
  const assetItems = (empty: string, current?: string | null) => [
    { value: "", label: empty },
    ...pickable(current).map((asset) => ({
      value: asset.id,
      label: asset.name,
    })),
  ];
  const height = canvasHeight(post.aspect);
  const textIssue =
    fonts && layer ? textProblem(layer, fonts[layer.font], height) : null;
  const missingGlyphs = !!(
    fonts &&
    layer &&
    layoutText(layer, fonts[layer.font]).missing.length
  );

  function update(next: Post, key = "") {
    if (immutable || busy) return;
    if (!key || key !== gesture.current)
      setPast((items) => [...items.slice(-49), post]);
    gesture.current = key;
    setFuture([]);
    setPost(next);
  }
  // Photo slides keep title/body in step with their text boxes, so captions,
  // alt text and hook history never describe text that is no longer there.
  function withCopy(slide: Slide): Slide {
    if (slide.design !== "photo" || !slide.textLayers) return slide;
    const text = slide.textLayers
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n\n");
    return { ...slide, title: text.slice(0, 180), body: text.slice(180, 630) };
  }
  function patch(data: Partial<Slide>, key?: string) {
    update(
      {
        ...post,
        slides: post.slides.map((item, index) =>
          index === selected ? withCopy({ ...item, ...data }) : item,
        ),
      },
      key,
    );
  }
  function patchLayer(data: Partial<PhotoText>, key?: string) {
    if (!layer) return;
    patch(
      {
        textLayers: layers.map((item) =>
          item.id === layer.id ? { ...item, ...data } : item,
        ),
      },
      key,
    );
  }
  const startGesture = () => {
    gesture.current = "";
  };
  function choose(index: number) {
    setSelected(clamp(index, 0, post.slides.length - 1));
    setLayerId("");
  }
  function close() {
    if (busy) return;
    if (sheet) {
      setSheet(null);
      return;
    }
    if (dirty) openSheet("discard");
    else onClose();
  }
  useEffect(() => {
    latest.current.close = close;
    // Arrow keys page through slides unless an action sheet is open.
    latest.current.step = (offset) => {
      if (!sheet) choose(selected + offset);
    };
  });
  useScrollLock();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        latest.current.close();
      }
      const step = arrowStep(event);
      if (step) {
        event.preventDefault();
        latest.current.step(step);
      }
      // An open action sheet holds focus; otherwise the whole window does.
      trapTab(
        event,
        root.current?.querySelector<HTMLElement>(".photo-sheet") ??
          root.current,
        root.current,
      );
    }
    // Registered before any popover opens, so this runs ahead of the
    // dropdown's and color picker's own outside-click listeners.
    function pointer() {
      popoverOpen.current = !!document.querySelector(
        ".dropdown-menu, .color-picker",
      );
    }
    // A mousedown on the dimmed area (around the window, or around an open
    // sheet) closes like X. Clicks in the window or a sheet have another
    // target, and portalled popovers are outside this element entirely.
    const backdrop = root.current;
    function outside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (popoverOpen.current) return;
      if (
        target === backdrop ||
        target.classList.contains("photo-sheet-backdrop")
      )
        latest.current.close();
    }
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer, true);
    backdrop?.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer, true);
      backdrop?.removeEventListener("mousedown", outside);
      previous?.focus();
    };
  }, []);
  // Move focus into an action sheet when it opens and back when it closes.
  useEffect(() => {
    if (!sheet) return;
    const opener = sheetOpener.current;
    const sheetEl = root.current?.querySelector<HTMLElement>(".photo-sheet");
    (
      sheetEl?.querySelector<HTMLElement>("input:not(:disabled)") ?? sheetEl
    )?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [sheet]);
  function openSheet(next: Sheet) {
    sheetOpener.current = document.activeElement as HTMLElement | null;
    setSheet(next);
  }
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    // Frames are positioned inside the track, so offsetLeft is already
    // measured from its scroll origin.
    centerSlide.current = () => {
      const container = track.current;
      const target = container?.children[selected] as HTMLElement | undefined;
      if (container && target)
        container.scrollTo({
          left:
            target.offsetLeft -
            (container.clientWidth - target.clientWidth) / 2,
          behavior: "instant",
        });
    };
    centerSlide.current();
  }, [selected, editing, compact, zoom]);
  // Frame widths follow the stage height, which settles after the first
  // paint (a new slideshow's dock, fonts and images), so center again
  // whenever the track or a frame changes size.
  useEffect(() => {
    const container = track.current;
    if (!container) return;
    const observer = new ResizeObserver(() => centerSlide.current());
    observer.observe(container);
    for (const frame of Array.from(container.children)) observer.observe(frame);
    return () => observer.disconnect();
  }, [post.slides.length, editing]);
  function toggleLockGrid(value: boolean) {
    setLockGrid(value);
    try {
      sessionStorage.setItem(SNAP_KEY, value ? "1" : "0");
    } catch {}
  }
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
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
  async function save() {
    if (!dirty) return saved;
    const next: Post = await studioAction("save", {
      id: post.id,
      expected: saved.revision,
      data: post,
    });
    setSaved(next);
    setPost(next);
    setPast([]);
    setFuture([]);
    await onSaved();
    return next;
  }
  async function review() {
    const next = await save();
    await studioAction("render", { id: next.id, revision: next.revision });
    setEditing(false);
  }
  async function download() {
    const url = URL.createObjectURL(await exportPackage(saved));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${saved.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 70)}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onToast("Images and caption downloaded.");
  }
  function restore(next: Post) {
    gesture.current = "";
    setPost(next);
    setSelected((index) => Math.min(index, next.slides.length - 1));
    setLayerId("");
  }
  function convert(all: boolean) {
    if (!fonts) return;
    update({
      ...post,
      slides: post.slides.map((item, index) =>
        all || index === selected
          ? photoSlide(item, post.aspect, fonts.default)
          : item,
      ),
    });
  }
  function reorder(offset: number) {
    const nextIndex = selected + offset;
    if (nextIndex < 0 || nextIndex >= post.slides.length) return;
    const slides = [...post.slides];
    [slides[selected], slides[nextIndex]] = [
      slides[nextIndex],
      slides[selected],
    ];
    update({ ...post, slides });
    choose(nextIndex);
  }
  function drag(
    event: PointerEvent<HTMLElement>,
    target: PhotoText,
    resize: boolean,
  ) {
    if (immutable || busy) return;
    event.preventDefault();
    const element = event.currentTarget;
    const canvas = element.closest(".photo-canvas")!.getBoundingClientRect();
    const startX = event.clientX,
      startY = event.clientY;
    const initialPost = post;
    let moved = false;
    let nextPost = post;
    element.setPointerCapture(event.pointerId);
    const move = (event: globalThis.PointerEvent) => {
      const dx = ((event.clientX - startX) * 240) / canvas.width;
      const dy = ((event.clientY - startY) * height) / canvas.height;
      if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
      moved = true;
      const next = resize
        ? {
            ...target,
            width: Math.round(clamp(target.width + dx, 20, 240 - target.x)),
            height: Math.round(
              clamp(target.height + dy, 12, height - target.y),
            ),
          }
        : lockGrid
          ? {
              ...target,
              x: snapTo(target.x + dx, 240 - target.width),
              y: snapTo(target.y + dy, height - target.height),
            }
          : {
              ...target,
              x: Math.round(clamp(target.x + dx, 0, 240 - target.width)),
              y: Math.round(clamp(target.y + dy, 0, height - target.height)),
            };
      nextPost = {
        ...initialPost,
        slides: initialPost.slides.map((item, index) =>
          index === selected
            ? {
                ...item,
                textLayers: item.textLayers?.map((layer) =>
                  layer.id === target.id ? next : layer,
                ),
              }
            : item,
        ),
      };
      setPost(nextPost);
    };
    const finish = (event: globalThis.PointerEvent) => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
      if (moved) {
        gesture.current = "";
        setPast((items) => [...items.slice(-49), initialPost]);
        setFuture([]);
      }
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
  }

  const slideMarkup = (item: Slide, index: number) =>
    item.design === "photo" ? (
      <PhotoCanvas
        assets={state.assets}
        slide={item}
        aspect={post.aspect}
        asset={state.assets.find((asset) => asset.id === item.assetId)}
        fonts={fonts}
        activeLayer={
          editing && selected === index && tab === "text"
            ? layer?.id
            : undefined
        }
        onSelect={
          editing && selected === index && !immutable
            ? (id) => {
                setLayerId(id);
                setTab("text");
              }
            : undefined
        }
        onDrag={editing && selected === index ? drag : undefined}
        grid={editing && grid}
        snap={
          editing && lockGrid && selected === index && tab === "text"
            ? GRID_STEP
            : undefined
        }
      />
    ) : editing ? (
      <div
        className="draft-canvas legacy-slide"
        style={{
          aspectRatio: post.aspect === "story" ? "9/16" : "4/5",
          background: item.background,
          color: item.ink,
          fontFamily:
            item.font === "serif" ? "Georgia, serif" : "Helvetica, sans-serif",
        }}
      >
        {item.assetId && (
          <Image
            fill
            unoptimized
            src={`/api/media/${item.assetId}`}
            alt="Background"
            sizes="420px"
            style={{ objectFit: "cover" }}
          />
        )}
        {item.assetId && (
          <div
            className="draft-overlay"
            style={{ background: `rgba(0,0,0,${item.overlay})` }}
          />
        )}
        <span className="draft-accent" style={{ background: item.accent }} />
        <div
          className={`draft-copy ${item.position}`}
          style={{ textAlign: item.align }}
        >
          <h2 style={{ fontSize: `${item.fontSize / 10.8}cqw` }}>
            {item.title}
          </h2>
          <p>{item.body}</p>
        </div>
      </div>
    ) : (
      <div
        className="legacy-slide"
        style={{ aspectRatio: post.aspect === "story" ? "9/16" : "4/5" }}
      >
        <Image
          fill
          unoptimized
          src={`/api/render/${saved.id}/${saved.revision}/${index}`}
          alt={item.title}
          sizes="420px"
          style={{ objectFit: "contain" }}
        />
      </div>
    );

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={editing ? "Slideshow editor" : "Slideshow preview"}
      className={`photo-backdrop ${editing ? "is-editing" : "is-preview"}`}
    >
      <section className={`photo-window ${compact ? "compact" : ""}`}>
        {editing ? (
          <header className="photo-editor-header">
            <div className="photo-tools">
              <Tool
                label="Undo"
                disabled={!past.length || busy || immutable}
                onClick={() => {
                  const next = past.at(-1)!;
                  setFuture((items) => [post, ...items]);
                  setPast((items) => items.slice(0, -1));
                  restore(next);
                }}
              >
                <Undo2 size={14} /> Undo
              </Tool>
              <Tool
                label="Redo"
                disabled={!future.length || busy || immutable}
                onClick={() => {
                  setPast((items) => [...items, post]);
                  restore(future[0]);
                  setFuture((items) => items.slice(1));
                }}
              >
                <Redo2 size={14} /> Redo
              </Tool>
              <Tool
                label={compact ? "Expand" : "Shrink"}
                pressed={compact}
                onClick={() => setCompact((value) => !value)}
              >
                {compact ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
                {compact ? "Expand" : "Shrink"}
              </Tool>
              <Tool
                label="Grid"
                pressed={grid}
                onClick={() => setGrid((value) => !value)}
              >
                <Grid2X2 size={14} /> Grid
              </Tool>
            </div>
            <span className="photo-save-state">
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <div className="photo-tools">
              <button
                className="photo-tool"
                disabled={busy}
                onClick={() =>
                  dirty ? openSheet("discard") : setEditing(false)
                }
              >
                Cancel edits
              </button>
              <button
                className="photo-action orange"
                disabled={busy}
                onClick={() => action(review)}
              >
                <Check size={15} />
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </header>
        ) : (
          <button
            className="preview-close photo-tool"
            aria-label="Close preview"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        )}
        {(error || fontError) && (
          <div className="photo-error" role="alert">
            {error || fontError}
          </div>
        )}
        <div className="photo-workspace">
          <div
            className="photo-stage"
            style={
              {
                "--slide-ratio": 240 / height,
                "--zoom": zoom / 100,
              } as CSSProperties
            }
          >
            <div ref={track} className="photo-track">
              {post.slides.map((item, index) => (
                <div
                  key={item.id}
                  role="presentation"
                  className={`photo-frame ${selected === index ? "selected" : ""}`}
                  onClick={() => {
                    if (selected !== index) choose(index);
                  }}
                >
                  {slideMarkup(item, index)}
                  {selected !== index && (
                    <button
                      className="slide-select-cover"
                      aria-label={`Select slide ${index + 1}`}
                      onClick={() => choose(index)}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="photo-pagination">
              <Tool
                label="Previous slide"
                disabled={selected === 0}
                onClick={() => choose(selected - 1)}
              >
                <ChevronLeft size={17} />
              </Tool>
              <div className="photo-dots">
                {post.slides.map((item, index) => (
                  <button
                    key={item.id}
                    className={selected === index ? "selected" : ""}
                    onClick={() => choose(index)}
                    aria-label={`Go to slide ${index + 1}`}
                    aria-current={selected === index ? "step" : undefined}
                  />
                ))}
              </div>
              <Tool
                label="Next slide"
                disabled={selected === post.slides.length - 1}
                onClick={() => choose(selected + 1)}
              >
                <ChevronRight size={17} />
              </Tool>
            </div>
            {editing && (
              <div className="photo-zoom">
                <Tool
                  label="Zoom out"
                  disabled={zoom <= 50}
                  onClick={() => setZoom((value) => Math.max(50, value - 10))}
                >
                  <Minus size={13} />
                </Tool>
                <button onClick={() => setZoom(100)} title="Reset zoom">
                  {zoom}%
                </button>
                <Tool
                  label="Zoom in"
                  disabled={zoom >= 150}
                  onClick={() => setZoom((value) => Math.min(150, value + 10))}
                >
                  <Plus size={13} />
                </Tool>
              </div>
            )}
          </div>
          {!editing && (
            <aside className="photo-preview-actions">
              <button
                className="photo-action orange"
                onClick={() => setEditing(true)}
              >
                <Pencil size={16} />
                {immutable ? "View slideshow" : "Edit slideshow"}
              </button>
              <button
                className="photo-action blue"
                disabled={busy || !approved}
                title={
                  !approved
                    ? "Approve this slideshow before downloading"
                    : "Download the approved images and caption"
                }
                onClick={() => action(download)}
              >
                <Download size={17} />
                Download images
              </button>
              {approved ? (
                <button className="photo-action approved" disabled>
                  <Check size={17} />
                  Approved
                </button>
              ) : (
                !deleted && (
                  <button
                    className="photo-action"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await studioAction("render", {
                          id: saved.id,
                          revision: saved.revision,
                        });
                        const next = await studioAction("approve", {
                          id: saved.id,
                          revision: saved.revision,
                        });
                        setPost(next);
                        setSaved(next);
                        await onSaved();
                        onToast("Slideshow approved for export.");
                      })
                    }
                  >
                    <ShieldCheck size={17} />
                    Approve slideshow
                  </button>
                )
              )}
              <button
                className="photo-action"
                disabled={!approved}
                onClick={() => openSheet("publish")}
              >
                <Send size={17} />
                {saved.status === "published"
                  ? "Correct TikTok link"
                  : "Publish to TikTok"}
              </button>
              <button
                className="photo-action"
                disabled={immutable || deleted}
                onClick={() => openSheet("queue")}
              >
                <CalendarPlus size={17} />
                Add to queue
              </button>
              <button
                className="photo-jump"
                onClick={() => onFormat(post.formatId)}
              >
                Jump to format <ArrowUpRight size={15} />
              </button>
              <div className="preview-caption">
                <strong>{post.title}</strong>
                <span>
                  {plural(post.slides.length, "slide")} ·{" "}
                  {
                    {
                      needs_review: "Needs review",
                      approved: "Approved",
                      published: "Published",
                      archived: "Deleted",
                    }[saved.status]
                  }
                </span>
                {post.flags.length > 0 && <p>{post.flags.join(" · ")}</p>}
              </div>
              <button
                className="photo-jump"
                onClick={() =>
                  action(async () => {
                    await navigator.clipboard.writeText(post.caption);
                    onToast("Caption copied.");
                  })
                }
              >
                <Copy size={14} />
                Copy caption
              </button>
              {deleted ? (
                <button
                  className="photo-action delete-post"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const next = await studioAction("restore", {
                        id: saved.id,
                      });
                      setPost(next);
                      setSaved(next);
                      await onSaved();
                      onToast("Slideshow restored. Review it before export.");
                    })
                  }
                >
                  <RotateCcw size={17} />
                  Restore slideshow
                </button>
              ) : saved.status === "published" ? (
                <p className="photo-note delete-post">
                  Published posts stay in Analytics with their link and metrics.
                </p>
              ) : (
                <button
                  className="photo-action danger delete-post"
                  disabled={busy}
                  onClick={() => openSheet("delete")}
                >
                  <Trash2 size={17} />
                  Delete
                </button>
              )}
            </aside>
          )}
        </div>
        {editing && (
          <div className="photo-dock-area">
            <div className="photo-slide-actions">
              <span>
                Slide {selected + 1} / {post.slides.length}
              </span>
              <Tool
                label="Move slide earlier"
                disabled={selected === 0 || busy || immutable}
                onClick={() => reorder(-1)}
              >
                <ArrowUp size={14} />
              </Tool>
              <Tool
                label="Move slide later"
                disabled={
                  selected === post.slides.length - 1 || busy || immutable
                }
                onClick={() => reorder(1)}
              >
                <ArrowDown size={14} />
              </Tool>
              <Tool
                label="Add slide"
                disabled={post.slides.length >= 10 || busy || immutable}
                onClick={() => {
                  const id = crypto.randomUUID();
                  const newSlide = {
                    ...slide,
                    id,
                    role: "body" as const,
                    title: "Your next idea",
                    body: "",
                    textLayers:
                      slide.design === "photo"
                        ? [defaultText("Your next idea", `${id}-text`)]
                        : undefined,
                  };
                  update({ ...post, slides: [...post.slides, newSlide] });
                  setSelected(post.slides.length);
                  setLayerId("");
                }}
              >
                <Plus size={14} /> Slide
              </Tool>
              <Tool
                label="Delete slide"
                disabled={post.slides.length <= 1 || busy || immutable}
                onClick={() => {
                  update({
                    ...post,
                    slides: post.slides.filter(
                      (_, index) => index !== selected,
                    ),
                  });
                  setSelected(Math.max(0, selected - 1));
                  setLayerId("");
                }}
              >
                <Trash2 size={14} />
              </Tool>
            </div>
            <div
              className="photo-dock-tabs"
              role="tablist"
              aria-label="Slide settings"
            >
              {(["text", "image", "post"] as const).map((value) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  aria-controls={`photo-panel-${value}`}
                  onClick={() => setTab(value)}
                >
                  {value === "post"
                    ? "Post details"
                    : value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            <fieldset
              disabled={immutable || busy}
              className={`photo-dock ${tab}`}
              id={`photo-panel-${tab}`}
              role="tabpanel"
            >
              {slide.design !== "photo" && tab !== "post" ? (
                <div className="legacy-controls">
                  <div className="legacy-conversion">
                    <strong>This slideshow uses an editorial layout.</strong>
                    <p>
                      Apply the TikTok photo style to use the font, outline, and
                      text-box controls shown in your references.
                    </p>
                    <button
                      className="photo-action orange"
                      disabled={!fonts}
                      onClick={() => convert(true)}
                    >
                      Apply TikTok style to all slides
                    </button>
                  </div>
                  <div className="photo-post-fields">
                    <Control label="Heading">
                      <textarea
                        value={slide.title}
                        maxLength={180}
                        rows={2}
                        onChange={(event) =>
                          patch({ title: event.target.value })
                        }
                      />
                    </Control>
                    <Control label="Supporting copy">
                      <textarea
                        value={slide.body}
                        maxLength={450}
                        rows={2}
                        onChange={(event) =>
                          patch({ body: event.target.value })
                        }
                      />
                    </Control>
                    <NumberControl
                      label="Heading size"
                      value={slide.fontSize}
                      min={40}
                      max={110}
                      onChange={(fontSize) => patch({ fontSize })}
                    />
                    <Control label="Background image">
                      <Dropdown
                        label="Background image"
                        value={slide.assetId ?? ""}
                        items={assetItems("Solid color", slide.assetId)}
                        onChange={(assetId) =>
                          patch({ assetId: assetId || null })
                        }
                      />
                    </Control>
                    <Control label="Typography">
                      <Dropdown
                        label="Typography"
                        value={slide.font}
                        items={[
                          { value: "serif", label: "Serif" },
                          { value: "sans", label: "Sans" },
                        ]}
                        onChange={(font) => patch({ font })}
                      />
                    </Control>
                    <Control label="Position">
                      <Dropdown
                        label="Position"
                        value={slide.position}
                        items={positionItems}
                        onChange={(position) => patch({ position })}
                      />
                    </Control>
                  </div>
                </div>
              ) : tab === "text" ? (
                <>
                  {layer ? (
                    <>
                      <div className="photo-text-edit">
                        <Control label="Text">
                          <textarea
                            rows={2}
                            maxLength={630}
                            value={layer.text}
                            onChange={(event) =>
                              patchLayer({ text: event.target.value })
                            }
                          />
                        </Control>
                      </div>
                      <div className="photo-text-top">
                        <Control label="Font">
                          <Dropdown
                            label="Font"
                            value={layer.font}
                            items={fontItems}
                            onChange={(font) => patchLayer({ font })}
                          />
                        </Control>
                        <NumberControl
                          label="Size"
                          value={layer.size}
                          min={6}
                          max={48}
                          step={0.5}
                          onChange={(size) => patchLayer({ size })}
                        />
                        <Control label="Color">
                          <div className="photo-color">
                            <ColorPicker
                              label="Custom text color"
                              value={layer.color}
                              onChange={(color) => patchLayer({ color })}
                            />
                            <Dropdown
                              variant="bare"
                              label="Text color"
                              value={
                                [
                                  "#ffffff",
                                  "#000000",
                                  "#ffe44d",
                                  "#ff5252",
                                ].includes(layer.color)
                                  ? layer.color
                                  : "custom"
                              }
                              items={[
                                { value: "#ffffff", label: "White" },
                                { value: "#000000", label: "Black" },
                                { value: "#ffe44d", label: "Yellow" },
                                { value: "#ff5252", label: "Red" },
                                { value: "custom", label: "Custom" },
                              ]}
                              onChange={(color) => {
                                if (color !== "custom") patchLayer({ color });
                              }}
                            />
                          </div>
                        </Control>
                        <Control label="Style">
                          <div className="photo-color">
                            {layer.style !== "plain" && (
                              <ColorPicker
                                label={`${layer.style === "box" ? "Background" : layer.style === "shadow" ? "Shadow" : "Outline"} color`}
                                value={layer.styleColor ?? "#000000"}
                                onChange={(styleColor) => {
                                  const next = recolorStyle(layer, styleColor);
                                  patchLayer({
                                    styleColor: next.styleColor,
                                    color: next.color,
                                  });
                                }}
                              />
                            )}
                            <Dropdown
                              variant="bare"
                              label="Text style"
                              value={layer.style}
                              items={styleItems}
                              onChange={(style) => {
                                const next = restyle(layer, style);
                                patchLayer({
                                  style: next.style,
                                  color: next.color,
                                  styleColor: next.styleColor,
                                });
                              }}
                            />
                          </div>
                        </Control>
                      </div>
                      {layer.style === "box" && (
                        <Control
                          label={`Roundness · ${layer.roundness ?? DEFAULT_ROUNDNESS}%`}
                        >
                          <Slider
                            min={0}
                            max={100}
                            value={layer.roundness ?? DEFAULT_ROUNDNESS}
                            onPointerDown={startGesture}
                            onChange={(event) =>
                              patchLayer(
                                { roundness: Number(event.target.value) },
                                "roundness",
                              )
                            }
                          />
                        </Control>
                      )}
                      <div className="photo-text-bottom">
                        <div className="photo-control">
                          <span>Align</span>
                          <div className="photo-align">
                            {(
                              [
                                ["left", AlignLeft],
                                ["center", AlignCenter],
                                ["right", AlignRight],
                              ] as const
                            ).map(([align, Icon]) => (
                              <Tool
                                key={align}
                                label={`Align ${align}`}
                                pressed={layer.align === align}
                                onClick={() => patchLayer({ align })}
                              >
                                <Icon size={15} />
                              </Tool>
                            ))}
                          </div>
                        </div>
                        <NumberControl
                          label="Width"
                          value={layer.width}
                          min={20}
                          max={240 - layer.x}
                          onChange={(width) => patchLayer({ width })}
                        />
                        <NumberControl
                          label="Height"
                          value={layer.height}
                          min={12}
                          max={height - layer.y}
                          onChange={(height) => patchLayer({ height })}
                        />
                        <NumberControl
                          label="X"
                          value={layer.x}
                          min={0}
                          max={240 - layer.width}
                          step={lockGrid ? GRID_STEP : 1}
                          onChange={(x) =>
                            patchLayer({
                              x: lockGrid ? snapTo(x, 240 - layer.width) : x,
                            })
                          }
                        />
                        <NumberControl
                          label="Y"
                          value={layer.y}
                          min={0}
                          max={height - layer.height}
                          step={lockGrid ? GRID_STEP : 1}
                          onChange={(y) =>
                            patchLayer({
                              y: lockGrid
                                ? snapTo(y, height - layer.height)
                                : y,
                            })
                          }
                        />
                        <Tool
                          label="Center text box"
                          onClick={() =>
                            patchLayer({
                              x: (240 - layer.width) / 2,
                              y: Math.round((height - layer.height) / 2),
                            })
                          }
                        >
                          <AlignCenter size={15} />
                        </Tool>
                        <div className="photo-layer-nav">
                          <Tool
                            label="Previous text box"
                            disabled={layers.indexOf(layer) === 0}
                            onClick={() =>
                              setLayerId(layers[layers.indexOf(layer) - 1].id)
                            }
                          >
                            <ChevronLeft size={14} />
                          </Tool>
                          <span>
                            {layers.indexOf(layer) + 1}/{layers.length}
                          </span>
                          <Tool
                            label="Next text box"
                            disabled={
                              layers.indexOf(layer) === layers.length - 1
                            }
                            onClick={() =>
                              setLayerId(layers[layers.indexOf(layer) + 1].id)
                            }
                          >
                            <ChevronRight size={14} />
                          </Tool>
                        </div>
                        <Tool
                          label="Delete text box"
                          onClick={() => {
                            patch({
                              textLayers: layers.filter(
                                (item) => item.id !== layer.id,
                              ),
                            });
                            setLayerId("");
                          }}
                        >
                          <Trash2 size={15} />
                        </Tool>
                      </div>
                      {textIssue && (
                        <div className="photo-overflow" role="alert">
                          {textIssue}{" "}
                          {!missingGlyphs && (
                            <button
                              onClick={() =>
                                fonts &&
                                patchLayer(
                                  fitText(
                                    layer,
                                    fonts[layer.font],
                                    post.aspect,
                                  ),
                                )
                              }
                            >
                              Fit box to text
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="photo-empty-text">
                      This slide has no text. Add a text box to begin.
                    </p>
                  )}
                  <div className="photo-dock-footer">
                    <button
                      disabled={layers.length >= 12}
                      onClick={() => {
                        const next = {
                          ...defaultText("Your text", crypto.randomUUID()),
                          y: Math.min(197 + layers.length * 38, height - 34),
                        };
                        patch({ textLayers: [...layers, next] });
                        setLayerId(next.id);
                      }}
                    >
                      <Plus size={13} /> Add text
                    </button>
                    <label className="photo-toggle">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={lockGrid}
                        checked={lockGrid}
                        onChange={(event) =>
                          toggleLockGrid(event.target.checked)
                        }
                      />
                      <i aria-hidden="true" />
                      Lock onto grid
                    </label>
                    {layer && (
                      <button
                        onClick={() =>
                          update({
                            ...post,
                            slides: post.slides.map((item) => ({
                              ...item,
                              textLayers: item.textLayers?.map((text) => ({
                                ...layer,
                                id: text.id,
                                text: text.text,
                              })),
                            })),
                          })
                        }
                      >
                        Apply text settings to all slides
                      </button>
                    )}
                  </div>
                </>
              ) : tab === "image" ? (
                <>
                  <div className="photo-image-top">
                    <Control label="Background image">
                      <Dropdown
                        label="Background image"
                        value={slide.assetId ?? ""}
                        items={assetItems("Solid color", slide.assetId)}
                        onChange={(assetId) =>
                          patch({ assetId: assetId || null })
                        }
                      />
                    </Control>
                    <Control label="Collection">
                      <Dropdown
                        label="Collection"
                        value={collection}
                        items={[
                          { value: "", label: "All images" },
                          ...collectionsOf(state.assets).map((value) => ({
                            value,
                            label: value,
                          })),
                        ]}
                        onChange={setCollection}
                      />
                    </Control>
                  </div>
                  <div className="photo-image-strip">
                    {libraryAssets(state.assets)
                      .filter(
                        (asset) =>
                          !collection || asset.collection === collection,
                      )
                      .map((asset) => (
                        <button
                          className={
                            slide.assetId === asset.id ? "selected" : ""
                          }
                          key={asset.id}
                          aria-label={`Use image ${asset.name}`}
                          onClick={() => patch({ assetId: asset.id })}
                        >
                          <Image
                            src={`/api/media/${asset.id}`}
                            alt={asset.name}
                            width={48}
                            height={60}
                            unoptimized
                            style={{ objectFit: "cover" }}
                          />
                        </button>
                      ))}
                    {!libraryAssets(state.assets).length && (
                      <p>
                        Upload photos in Assets to give this slideshow a
                        background.
                      </p>
                    )}
                  </div>
                  <div className="photo-image-controls">
                    <Control label="Image grid">
                      <Dropdown
                        label="Image grid"
                        value={slide.imageGrid ?? "none"}
                        items={[
                          { value: "none", label: "Single image" },
                          { value: "split", label: "2 images · stacked" },
                          { value: "quad", label: "4 images · grid" },
                        ]}
                        onChange={(imageGrid) =>
                          // A smaller grid drops the slots it no longer shows,
                          // so hidden images never count as slide content.
                          patch({
                            imageGrid,
                            additionalAssetIds: (
                              slide.additionalAssetIds ?? []
                            ).slice(
                              0,
                              imageGrid === "quad"
                                ? 3
                                : imageGrid === "split"
                                  ? 1
                                  : 0,
                            ),
                          })
                        }
                      />
                    </Control>
                    {Array.from(
                      {
                        length:
                          slide.imageGrid === "quad"
                            ? 3
                            : slide.imageGrid === "split"
                              ? 1
                              : 0,
                      },
                      (_, index) => (
                        <Control key={index} label={`Grid image ${index + 2}`}>
                          <Dropdown
                            label={`Grid image ${index + 2}`}
                            value={slide.additionalAssetIds?.[index] ?? ""}
                            items={assetItems(
                              "No image",
                              slide.additionalAssetIds?.[index],
                            )}
                            onChange={(id) => {
                              // Fill skipped slots with "" so the array never
                              // has holes (holes serialize as null and fail).
                              const current = slide.additionalAssetIds ?? [];
                              const ids = Array.from(
                                { length: Math.max(index + 1, current.length) },
                                (_, i) => current[i] ?? "",
                              );
                              ids[index] = id;
                              patch({ additionalAssetIds: ids });
                            }}
                          />
                        </Control>
                      ),
                    )}
                    <Control label="Fit">
                      <Dropdown
                        label="Fit"
                        value={slide.imageFit ?? "cover"}
                        items={[
                          { value: "cover", label: "Fill / crop" },
                          { value: "contain", label: "Fit / letterbox" },
                        ]}
                        onChange={(imageFit) => patch({ imageFit })}
                      />
                    </Control>
                    <SliderControl
                      label={`Image zoom · ${Math.round((slide.imageZoom ?? 1) * 100)}%`}
                      value={(slide.imageZoom ?? 1) * 100}
                      min={100}
                      max={300}
                      onStart={startGesture}
                      onChange={(value) =>
                        patch({ imageZoom: value / 100 }, "imageZoom")
                      }
                    />
                    <SliderControl
                      label={`Horizontal · ${Math.round(slide.imageX ?? 50)}%`}
                      value={slide.imageX ?? 50}
                      min={0}
                      max={100}
                      onStart={startGesture}
                      onChange={(imageX) => patch({ imageX }, "imageX")}
                    />
                    <SliderControl
                      label={`Vertical · ${Math.round(slide.imageY ?? 50)}%`}
                      value={slide.imageY ?? 50}
                      min={0}
                      max={100}
                      onStart={startGesture}
                      onChange={(imageY) => patch({ imageY }, "imageY")}
                    />
                    <SliderControl
                      label={`Darkening · ${Math.round(slide.overlay * 100)}%`}
                      value={Math.round(slide.overlay * 100)}
                      min={0}
                      max={85}
                      onStart={startGesture}
                      onChange={(value) =>
                        patch({ overlay: value / 100 }, "overlay")
                      }
                    />
                    <Control label="Background">
                      <ColorPicker
                        variant="field"
                        label="Background"
                        value={slide.background}
                        onChange={(background) => patch({ background })}
                      />
                    </Control>
                  </div>
                </>
              ) : (
                <div className="photo-post-fields">
                  <Control label="Post title">
                    <input
                      value={post.title}
                      maxLength={160}
                      onChange={(event) =>
                        update({ ...post, title: event.target.value })
                      }
                    />
                  </Control>
                  <Control label="Caption">
                    <textarea
                      rows={3}
                      value={post.caption}
                      maxLength={2200}
                      onChange={(event) =>
                        update({ ...post, caption: event.target.value })
                      }
                    />
                  </Control>
                  <Control label="Canvas">
                    <Dropdown
                      label="Canvas"
                      value={post.aspect}
                      items={canvasItems}
                      onChange={(aspect) => {
                        update({
                          ...post,
                          aspect,
                          slides: post.slides.map((item) => ({
                            ...item,
                            textLayers: item.textLayers?.map((text) => ({
                              ...text,
                              height: Math.min(
                                text.height,
                                canvasHeight(aspect),
                              ),
                              y: clamp(
                                text.y,
                                0,
                                canvasHeight(aspect) -
                                  Math.min(text.height, canvasHeight(aspect)),
                              ),
                            })),
                          })),
                        });
                      }}
                    />
                  </Control>
                  <Control label="Target account">
                    <input
                      value={post.account}
                      maxLength={100}
                      onChange={(event) =>
                        update({ ...post, account: event.target.value })
                      }
                    />
                  </Control>
                  <Control label="Planned posting time">
                    <input
                      type="datetime-local"
                      value={localDate(post.plannedAt)}
                      onChange={(event) =>
                        update({
                          ...post,
                          plannedAt: event.target.value
                            ? new Date(event.target.value).toISOString()
                            : "",
                        })
                      }
                    />
                  </Control>
                  <Control label="Disclosure / music notes">
                    <input
                      value={post.notes}
                      maxLength={1000}
                      onChange={(event) =>
                        update({ ...post, notes: event.target.value })
                      }
                    />
                  </Control>
                  <button
                    className="photo-tool"
                    onClick={() =>
                      action(async () => {
                        const current = await save();
                        await studioAction("duplicate", { id: current.id });
                        await onSaved();
                        onToast("A copy is ready in your slideshow gallery.");
                      })
                    }
                  >
                    <Copy size={14} />
                    Duplicate slideshow
                  </button>
                </div>
              )}
            </fieldset>
            {immutable && (
              <div className="photo-readonly">
                Published posts are read-only. Duplicate the slideshow to edit
                it.
                <button
                  className="photo-tool"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await studioAction("duplicate", { id: saved.id });
                      await onSaved();
                      onToast("A copy is ready in your slideshow gallery.");
                    })
                  }
                >
                  <Copy size={14} />
                  Duplicate slideshow
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      {sheet && (
        <ActionSheet
          sheet={sheet}
          saved={saved}
          plannedAt={post.plannedAt}
          busy={busy}
          error={error}
          onDismiss={() => setSheet(null)}
          onDiscard={() => {
            setPost(saved);
            setPast([]);
            setFuture([]);
            choose(0);
            setSheet(null);
            setEditing(false);
          }}
          onSaveChanges={() =>
            action(async () => {
              await review();
              setSheet(null);
            })
          }
          onDelete={() =>
            action(async () => {
              await studioAction("archive", { id: saved.id });
              await onSaved();
              onClose();
            })
          }
          onQueue={(plannedAt, reapprove) =>
            action(async () => {
              let next: Post = await studioAction("save", {
                id: saved.id,
                expected: saved.revision,
                data: {
                  ...post,
                  plannedAt,
                },
              });
              if (reapprove) {
                await studioAction("render", {
                  id: next.id,
                  revision: next.revision,
                });
                next = await studioAction("approve", {
                  id: next.id,
                  revision: next.revision,
                });
              }
              setPost(next);
              setSaved(next);
              await onSaved();
              setSheet(null);
              onToast(
                reapprove
                  ? "Scheduled and approved again for export."
                  : saved.status === "approved"
                    ? "Scheduled. Approve it again before downloading."
                    : "Added to your calendar for review.",
              );
            })
          }
          onDownload={() => action(download)}
          onPublish={(url) => {
            const replace = saved.status === "published";
            action(async () => {
              const next = await studioAction("publish", {
                id: saved.id,
                revision: saved.revision,
                url,
                replace,
              });
              setPost(next);
              setSaved(next);
              await onSaved();
              setSheet(null);
              onToast(
                replace ? "TikTok link corrected." : "Published post recorded.",
              );
            });
          }}
        />
      )}
    </div>
  );
}
