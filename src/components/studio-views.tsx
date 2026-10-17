"use client";
// The studio's main pages. Each receives only the data and actions it shows.
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  CheckCheck,
  FileText,
  FolderOpen,
  Layers3,
  LayoutDashboard,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type {
  Brand,
  Format,
  Post,
  StudioState,
  TikTokAccount,
} from "@/lib/schema";
import { plural } from "@/lib/defaults";
import { SlideImage, statusLabel } from "./studio-ui";
import { TikTokCard } from "./tiktok-settings";

export type View =
  | "Overview"
  | "Review queue"
  | "Formats"
  | "Assets"
  | "Brands"
  | "Calendar"
  | "Analytics"
  | "Settings";
export const views: { name: View; icon: typeof LayoutDashboard }[] = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Review queue", icon: CheckCheck },
  { name: "Formats", icon: Layers3 },
  { name: "Assets", icon: FolderOpen },
  { name: "Brands", icon: FileText },
  { name: "Calendar", icon: CalendarDays },
  { name: "Analytics", icon: BarChart3 },
];
// Page title and introduction for each view.
const viewCopy: Record<View, [string, string]> = {
  Overview: ["Your slideshows.", "Turn a good idea into your next great post."],
  "Review queue": ["Ready for review.", "A final look before anything ships."],
  Formats: [
    "Your formats.",
    "Reusable layouts and writing directions. Consistency, without repetition.",
  ],
  Assets: ["Your assets.", "Your own images, collected and ready to use."],
  Brands: ["Your brands.", "The facts, audience, and tone behind every draft."],
  Calendar: [
    "Your calendar.",
    "Your planned posting dates. Publishing stays in your hands.",
  ],
  Analytics: [
    "Your analytics.",
    "Owner-recorded results from your published posts.",
  ],
  Settings: ["Settings.", "A private workspace built around your process."],
};

export function ViewHeading({ view }: { view: View }) {
  const [title, intro] = viewCopy[view];
  return (
    <div>
      <div className="eyebrow">SLIDEO / {view.toUpperCase()}</div>
      <h1>{title}</h1>
      <p>{intro}</p>
    </div>
  );
}

export function PostsView({
  view,
  posts,
  brands,
  search,
  onSearch,
  filter,
  onFilter,
  reviewCount,
  deletedCount,
  onOpen,
  onCreate,
}: {
  view: "Overview" | "Review queue";
  posts: Post[];
  brands: Brand[];
  search: string;
  onSearch: (search: string) => void;
  filter: string;
  onFilter: (filter: string) => void;
  reviewCount: number;
  deletedCount: number;
  onOpen: (post: Post) => void;
  onCreate: () => void;
}) {
  return (
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
            onChange={(e) => onSearch(e.target.value)}
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
            ...(deletedCount ? [["archived", "Deleted"]] : []),
          ].map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? "selected" : ""}
              aria-pressed={filter === key}
              onClick={() => onFilter(key)}
            >
              {label}
              {key === "needs_review" && <span>{reviewCount}</span>}
              {key === "archived" && <span>{deletedCount}</span>}
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
              onClick={() => onOpen(p)}
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
              <button className="post-title" onClick={() => onOpen(p)}>
                {p.title}
              </button>
              <div className="post-footer">
                <span>
                  {brands.find((b) => b.id === p.brandId)?.name ||
                    "Personal post"}
                </span>
                <button
                  aria-label={`Open ${p.title}`}
                  onClick={() => onOpen(p)}
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
          onClick={onCreate}
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
          Deleted slideshows keep their revisions. Open one and choose Restore
          to bring it back for review.
        </p>
      )}
    </section>
  );
}

export function FormatGrid({
  formats,
  onOpen,
}: {
  formats: Format[];
  onOpen: (format: Format) => void;
}) {
  return (
    <div className="format-grid">
      {formats.map((f) => (
        <article className="format-card" key={f.id}>
          <button
            className={`format-preview ${f.font === "tiktok" ? "photo-format" : ""}`}
            aria-label={`Open ${f.name}`}
            style={{
              background: f.color,
              color: f.ink,
              fontFamily:
                f.font === "serif" ? "Georgia, serif" : "Helvetica, sans-serif",
            }}
            onClick={() => onOpen(f)}
          >
            <span>THE SLIDEO COLLECTION</span>
            <b>
              {f.name}
              <em style={{ color: f.accent }}>
                No. {String(formats.indexOf(f) + 1).padStart(2, "0")}
              </em>
            </b>
            <small>
              {f.slideCount} SLIDES <ArrowUpRight size={20} />
            </small>
          </button>
          <div>
            <h2>{f.name}</h2>
            <p>{f.description}</p>
            <button className="text-button" onClick={() => onOpen(f)}>
              Customize format <ArrowRight size={15} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function BrandGrid({
  brands,
  onEdit,
}: {
  brands: Brand[];
  onEdit: (brand: Brand) => void;
}) {
  return (
    <div className="brand-grid">
      {brands.map((b) => (
        <article className="brand-card" key={b.id}>
          <span className="brand-initial">{b.name.charAt(0)}</span>
          <h2>{b.name}</h2>
          <p>{b.product}</p>
          <div className="brand-detail">
            <span>VOICE</span>
            {b.tone}
          </div>
          <button className="button secondary" onClick={() => onEdit(b)}>
            Edit brand brief <ArrowUpRight size={16} />
          </button>
        </article>
      ))}
    </div>
  );
}

export function SettingsView({
  settings,
  onDisconnectTikTok,
}: {
  settings: StudioState["settings"];
  onDisconnectTikTok: (account: TikTokAccount) => void;
}) {
  // Only text from a request you make reaches OpenAI.
  const ai = settings.aiReady
    ? " When you use AI writing, the brief and slide text for that request are sent to OpenAI."
    : "";
  return (
    <div className="settings-grid">
      {settings.hosted ? (
        <section className="settings-card">
          <span className="stat-icon sage">
            <ShieldCheck size={23} />
          </span>
          <h2>Private to your account.</h2>
          <p>
            Your briefs, images, revisions, and exports are stored in this
            studio’s Supabase project: records in its Postgres database, files
            in private storage. Only your signed-in account can open them.
            {ai}
          </p>
          <dl>
            <dt>Workspace access</dt>
            <dd>{settings.email ?? "Your account"}</dd>
            <dt>Sign-in</dt>
            <dd>Email and password</dd>
            <dt>Publishing</dt>
            <dd>Manual export, with approval</dd>
            <dt>Storage</dt>
            <dd>Supabase Postgres + private storage</dd>
            <dt>Backups</dt>
            <dd>Made by the studio’s operator in Supabase</dd>
          </dl>
          <small>
            To keep your own copy of a finished slideshow, download its approved
            package.
          </small>
        </section>
      ) : (
        <section className="settings-card">
          <span className="stat-icon sage">
            <ShieldCheck size={23} />
          </span>
          <h2>Local by design.</h2>
          <p>
            Your briefs, images, revisions, and exports are saved in this
            project’s <code>data/</code> folder: an embedded Postgres database
            and image files. Back up that whole folder with the app stopped.
            {ai}
          </p>
          <dl>
            <dt>Workspace access</dt>
            <dd>This computer only</dd>
            <dt>Publishing</dt>
            <dd>Manual export, with approval</dd>
            <dt>Storage</dt>
            <dd>PGlite (embedded Postgres) + local image files</dd>
            <dt>Backups</dt>
            <dd>
              Copy <code>data/</code> with the app stopped
            </dd>
          </dl>
        </section>
      )}
      <section className="settings-card">
        <span className="stat-icon peach">
          <Sparkles size={23} />
        </span>
        <h2>Your writing assistant.</h2>
        <p>
          {settings.aiReady
            ? "OpenAI is configured. Website ideas and AI drafts use your brand facts and format instructions."
            : settings.hosted
              ? "AI writing isn’t set up for this studio yet. Manual drafts work without it."
              : "Add OPENAI_API_KEY to .env.local in the project folder, then restart. Never paste keys into a brand brief."}
        </p>
        <dl>
          <dt>Connection</dt>
          <dd>
            {settings.aiReady
              ? "Configured · live call not verified"
              : "Not configured"}
          </dd>
          <dt>Model</dt>
          <dd>{settings.model}</dd>
          <dt>Daily attempts</dt>
          <dd>
            {settings.usedToday} / {settings.dailyLimit}
          </dd>
        </dl>
        <small>
          Limit resets at midnight UTC. Failed attempts count. Provider billing
          applies separately.
        </small>
      </section>
      <TikTokCard tiktok={settings.tiktok} onDisconnect={onDisconnectTikTok} />
      <section className="settings-card">
        <h2>What’s in this build</h2>
        <p>
          Manual and AI drafts, brand briefs, reusable formats, an image
          library, versioned editing, exact previews, approval, JPEG packages,
          planned dates, and manual results. Hosted studios add accounts with
          email sign-in.
        </p>
        <p>
          Recurring generation, MP4 exports, and publishing-provider integration
          are upcoming milestones.
        </p>
      </section>
    </div>
  );
}
