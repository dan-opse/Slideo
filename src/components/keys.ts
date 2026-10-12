// Left/Right arrows step between slides, except while a field that uses the
// arrows itself (text caret, slider, select) has focus or a modifier is held.
export function arrowStep(event: KeyboardEvent): -1 | 0 | 1 {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return 0;
  const step =
    event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  if (!step) return 0;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("input, textarea, select, [contenteditable='true']"))
    return 0;
  return step;
}
