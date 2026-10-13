"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
const SlideshowEditor = dynamic(() => import("./slideshow-editor"), {
  ssr: false,
});
const FormatDashboard = dynamic(() => import("./format-dashboard"), {
  ssr: false,
});
import {
  AlertCircle,
  Check,
  ChevronRight,
  ImagePlus,
  Loader2,
  LogOut,
  Plus,
  Settings2,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type { Asset, Brand, Format, Post, StudioState } from "@/lib/schema";
import { blankFormat, defaultBrandId, libraryAssets } from "@/lib/defaults";
import { loadStudio, studioAction } from "./request";
import { IconButton, SlideoMark, workspaceLabels } from "./studio-ui";
import {
  BrandGrid,
  FormatGrid,
  PostsView,
  SettingsView,
  ViewHeading,
  views,
  type View,
} from "./studio-views";
import { BrandModal, blankBrand } from "./brand-modal";
import {
  AssetDeleteModal,
  AssetLibrary,
  AssetModal,
  UploadModal,
  deletionMessage,
  type AssetDeletion,
} from "./asset-library";
import { CreateSlideshowModal } from "./create-slideshow-modal";
import { CalendarView } from "./calendar-view";
import { Results } from "./results-view";

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
    [assetEdit, setAssetEdit] = useState<Asset | null>(null),
    [assetDelete, setAssetDelete] = useState<AssetDeletion | null>(null);
  const refresh = useCallback(async () => {
    setState(await loadStudio());
  }, []);
  useEffect(() => {
    let alive = true;
    loadStudio()
      .then((data) => {
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
  const labels = workspaceLabels(state.settings.hosted);
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
            <small>{labels.workspace}</small>
          </div>
          <span className="local-dot" title={labels.workspace} />
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
          {state.settings.hosted ? (
            <div className="profile">
              <span className="profile-avatar">
                {(state.settings.email || "?").charAt(0).toUpperCase()}
              </span>
              <div>
                <strong>{state.settings.email || "Your workspace"}</strong>
                <small>
                  <i /> Private to your account
                </small>
              </div>
              <form method="post" action="/auth/signout">
                <button
                  className="icon-button profile-signout"
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut size={16} />
                </button>
              </form>
            </div>
          ) : (
            <div className="profile">
              <span className="profile-avatar">D</span>
              <div>
                <strong>Daniel’s workspace</strong>
                <small>
                  <i /> Local & private
                </small>
              </div>
            </div>
          )}
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
            <span className="local-dot" /> {labels.note}
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
            <ViewHeading view={view} />
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
            <PostsView
              view={view}
              posts={posts}
              brands={state.brands}
              search={search}
              onSearch={setSearch}
              filter={filter}
              onFilter={setFilter}
              reviewCount={review.length}
              deletedCount={deleted.length}
              onOpen={setEditing}
              onCreate={() => setCreate(true)}
            />
          )}
          {view === "Formats" && (
            <FormatGrid formats={state.formats} onOpen={setFormatEdit} />
          )}
          {view === "Brands" && (
            <BrandGrid brands={state.brands} onEdit={setBrandEdit} />
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
                  await studioAction("metrics", { id, data });
                  setToast("Results saved.");
                })
              }
            />
          )}
          {view === "Settings" && <SettingsView settings={state.settings} />}
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
              const post = await studioAction("create", data);
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
        <BrandModal
          brand={brandEdit}
          busy={busy}
          error={error}
          onClose={() => {
            setBrandEdit(null);
            setError("");
          }}
          onSave={(data) =>
            run(async () => {
              await studioAction("brand", {
                data,
                expected: brandEdit.version ?? 0,
              });
              setBrandEdit(null);
              setToast("Brand brief saved.");
            })
          }
        />
      )}
      {formatEdit && (
        <FormatDashboard
          key={formatEdit.id || "new-format"}
          initial={formatEdit}
          state={state}
          suspended={!!editing || create}
          onClose={() => setFormatEdit(null)}
          onSave={async (format, expected) => {
            const saved = await studioAction("format", {
              data: { ...format, id: format.id || undefined },
              expected,
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
        <UploadModal
          busy={busy}
          error={error}
          onClose={() => {
            setUpload(false);
            setError("");
          }}
          onClearError={() => setError("")}
          onUpload={(task) =>
            run(async () => {
              const message = await task();
              setUpload(false);
              setToast(message);
            })
          }
        />
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
              await studioAction("asset", { id: assetEdit.id, data });
              setAssetEdit(null);
              setToast("Image details saved.");
            })
          }
          onRemove={() =>
            run(async () => {
              const result = await studioAction("removeAsset", {
                id: assetEdit.id,
              });
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
        <AssetDeleteModal
          request={assetDelete}
          busy={busy}
          error={error}
          onClose={() => {
            setAssetDelete(null);
            setError("");
          }}
          onConfirm={() =>
            run(async () => {
              const result = (await studioAction("removeAssets", {
                ids: assetDelete.ids,
              })) as { deleted: Asset[]; kept: Asset[] };
              setAssetDelete(null);
              setToast(deletionMessage(result));
            })
          }
        />
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
