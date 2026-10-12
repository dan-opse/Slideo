import type { ComponentProps, CSSProperties } from "react";

type SliderProps = Omit<ComponentProps<"input">, "type"> & {
  min?: number;
  max?: number;
  value: number;
};

// A native range input styled to match the dropdown (app/controls.css).
// WebKit has no progress pseudo-element, so the filled share of the track is
// passed in as --fill (0–1).
export function Slider({
  min = 0,
  max = 100,
  value,
  className = "",
  style,
  ...props
}: SliderProps) {
  const fill =
    max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <input
      {...props}
      type="range"
      min={min}
      max={max}
      value={value}
      className={`slider ${className}`.trim()}
      style={{ ...style, "--fill": fill } as CSSProperties}
    />
  );
}
