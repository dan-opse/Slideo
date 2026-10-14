"use client";
import {
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  Layers3,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import type { Format, StudioState } from "@/lib/schema";
import { defaultBrandId } from "@/lib/defaults";
import { Dropdown } from "./ui/dropdown";
import { studioAction } from "./request";
import { Field, Modal } from "./studio-ui";

type WebsiteIdea = { topic: string; angle: string };

export function CreateSlideshowModal({
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
      const result = (await studioAction("ideas", {
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
              hint="Public HTTPS pages only. The studio reads the page to suggest ideas and doesn’t save it."
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
