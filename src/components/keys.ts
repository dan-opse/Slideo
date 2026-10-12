// Left/Right arrows step between slides, except while a field that uses the
// arrows itself (text caret, slider, select, dropdown) has focus or a modifier
// is held.
export function arrowStep(event: KeyboardEvent): -1 | 0 | 1 {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return 0;
  const step =
    event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  if (!step) return 0;
  const target = event.target as HTMLElement | null;
  if (
    target?.closest?.(
      "input, textarea, select, [contenteditable='true'], [role='listbox'], [aria-haspopup='listbox']",
    )
  )
    return 0;
  return step;
}

// How to scroll a slide into view: glide when stepping to another slide, jump
// when only the layout changed (opening, zoom, grid), and always jump for
// people who prefer reduced motion.
export function slideScroll(stepped: boolean): ScrollBehavior {
  return stepped && !matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "smooth"
    : "instant";
}
