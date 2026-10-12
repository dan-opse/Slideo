"use client";
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { Brand, Format, Post } from "@/lib/schema";
import { plural } from "@/lib/defaults";
import { IconButton, Modal, SlideImage, statusLabel } from "./studio-ui";

export function CalendarView({
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
