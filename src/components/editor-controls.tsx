"use client";
// Labelled inputs and icon buttons for the slideshow editor's dock.
import type { ReactNode } from "react";
import { NumberInput } from "./number-input";
import { Slider } from "./ui/slider";

export function Control({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="photo-control">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function NumberControl({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Control label={label}>
      <NumberInput
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
      />
    </Control>
  );
}
// A slider in the editor dock, laid out like format customize: the value
// rides in the label. onStart marks a new drag so it undoes as one step.
export function SliderControl({
  label,
  value,
  min,
  max,
  step = 1,
  onStart,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onStart: () => void;
  onChange: (value: number) => void;
}) {
  return (
    <Control label={label}>
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Control>
  );
}
export function Tool({
  label,
  children,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      className="photo-tool"
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
