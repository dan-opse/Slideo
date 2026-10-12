"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";

// A thin, trackless horizontal scrollbar for a container whose native one is
// hidden with the .scroll-rail-target class. Browsers draw native tracks
// inconsistently (Safari ignores scrollbar-color), so this one is drawn here.
// It is decorative: the content stays reachable by trackpad, wheel and focus.
export function ScrollRail({
  target,
  className = "",
}: {
  target: RefObject<HTMLElement | null>;
  className?: string;
}) {
  // Thumb size and position as fractions of the rail.
  const [view, setView] = useState({ size: 1, start: 0 });
  const [dragging, setDragging] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; scroll: number } | null>(null);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const measure = () => {
      const size = el.scrollWidth ? el.clientWidth / el.scrollWidth : 1;
      const max = el.scrollWidth - el.clientWidth;
      setView({
        size,
        start: max > 0 ? (el.scrollLeft / max) * (1 - size) : 0,
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    // Slides added or removed, or the grid view toggled, change the content
    // width without resizing the container.
    const mutate = new MutationObserver(measure);
    mutate.observe(el, {
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      el.removeEventListener("scroll", measure);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [target]);

  const overflows = view.size < 0.999;

  function grab(event: PointerEvent<HTMLDivElement>) {
    const el = target.current;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, scroll: el.scrollLeft };
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const el = target.current;
    const width = rail.current?.clientWidth;
    if (!drag.current || !el || !width) return;
    el.scrollTo({
      left:
        drag.current.scroll +
        (event.clientX - drag.current.x) * (el.scrollWidth / width),
    });
  }
  function release() {
    drag.current = null;
    setDragging(false);
  }
  // Clicking the empty rail pages toward the click, like a native track.
  function page(event: PointerEvent<HTMLDivElement>) {
    const el = target.current;
    const box = rail.current?.getBoundingClientRect();
    if (!el || !box) return;
    const thumbStart = box.left + view.start * box.width;
    el.scrollBy({
      left: (event.clientX < thumbStart ? -1 : 1) * el.clientWidth * 0.8,
      behavior: "smooth",
    });
  }

  return (
    <div
      ref={rail}
      aria-hidden
      className={`scroll-rail ${className}`.trim()}
      onPointerDown={overflows ? page : undefined}
    >
      <div
        hidden={!overflows}
        className={`scroll-rail-thumb${dragging ? " is-dragging" : ""}`}
        style={{
          left: `${view.start * 100}%`,
          width: `${view.size * 100}%`,
        }}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
      />
    </div>
  );
}
