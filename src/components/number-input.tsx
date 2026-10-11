"use client";
import { useState, type InputHTMLAttributes } from "react";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "min" | "max" | "type"
> & {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

// Keeps what the person is typing until they finish. Clamping every keystroke
// turned "14" into 48: the "1" was raised to the minimum, then "64" capped.
// In-range values apply immediately for live previews; anything else is
// clamped on blur or Enter, and an empty field restores the last value.
export function NumberInput({ value, min, max, onChange, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(n)) {
      const next = clamp(n, min, max);
      if (next !== value) onChange(next);
    }
    setDraft(null);
  };
  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(Number(value.toFixed(2)))}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const n = event.target.valueAsNumber;
        if (raw !== "" && Number.isFinite(n) && n >= min && n <= max)
          onChange(n);
      }}
      onBlur={(event) => {
        commit();
        rest.onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        rest.onKeyDown?.(event);
      }}
    />
  );
}
