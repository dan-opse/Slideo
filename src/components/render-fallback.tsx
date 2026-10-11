import { AlertCircle } from "lucide-react";

// Shown when a slide preview cannot be rendered (for example, text overflow).
export function RenderFallback() {
  return (
    <span className="render-fallback">
      <AlertCircle size={20} aria-hidden="true" />
      <strong>Preview unavailable</strong>
      <small>Open the slideshow to fix text that doesn’t fit.</small>
    </span>
  );
}
