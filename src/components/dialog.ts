import { useEffect, useRef, type RefObject } from "react";

// Shared modal-dialog behavior. Each dialog keeps its own extras (action
// sheets, close confirmation, arrow-key paging); this is the common core.
// Portalled dropdowns and color pickers take Escape in the capture phase and
// stop it, so the document-level listeners here never see it.

const FOCUSABLE =
  "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary";

// Enabled, rendered controls in tab order.
export function focusableIn(container: ParentNode | null | undefined) {
  return [
    ...(container?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
  ].filter((item) => item.getClientRects().length);
}

// Keeps Tab and Shift+Tab inside `container`, wrapping at either end. Focus
// resting on `self` (a dialog root that takes focus itself) wraps as well.
export function trapTab(
  event: KeyboardEvent,
  container: HTMLElement | null | undefined,
  self?: HTMLElement | null,
) {
  if (event.key !== "Tab") return;
  const items = focusableIn(container);
  const first = items[0],
    last = items.at(-1);
  const active = document.activeElement;
  const onSelf = !!self && active === self;
  if (event.shiftKey && (active === first || onSelf)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (active === last || onSelf)) {
    event.preventDefault();
    first?.focus();
  }
}

// The latest value, readable from long-lived listeners. Callers pass inline
// handlers; reading them through a ref keeps focus effects from re-running
// (and stealing focus) on every render.
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

// Stops the page behind a full-screen dialog from scrolling.
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
    };
  }, [active]);
}

// A simple modal: focus its first control, close on Escape, keep Tab inside,
// and return focus to whatever opened it.
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const close = useLatest(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    focusableIn(element)[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      trapTab(event, element);
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [ref, close]);
}
