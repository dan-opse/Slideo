"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PipetteIcon } from "lucide-react";
import { Dropdown } from "./dropdown";

// Adapted from the 21st.dev color picker: the same parts (saturation area,
// hue slider, eyedropper, format switch and fields), with the Tailwind classes
// moved to app/controls.css and the Radix slider and shadcn select swapped for
// a native range and our dropdown. Colors are stored as #rrggbb, so there is
// no alpha slider. The picker opens from a swatch in a portal, like the
// dropdown menu, so modals and scrolling panels can't clip it.

const EASE = [0.23, 1, 0.32, 1] as const;
const EXIT = [0.4, 0, 1, 1] as const;
const OPEN = {
  type: "spring",
  stiffness: 620,
  damping: 38,
  mass: 0.6,
} as const;
const NONE = { duration: 0 } as const;

const PANEL_W = 240;
const GAP = 6;
const EDGE = 8;

// Hue 0–360, saturation and value (brightness) 0–100. Kept as HSV rather than
// hex so the hue survives dragging through grays and black.
type Hsv = { h: number; s: number; v: number };
type Rgb = [number, number, number];

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

function parseHex(text: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  const n = parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const sat = s / 100;
  const val = v / 100;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (val - val * sat * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

// Grays have no hue and black has no saturation; keep the previous ones so the
// area and hue slider don't jump.
function rgbToHsv([r, g, b]: Rgb, prev?: Hsv): Hsv {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = prev?.h ?? 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = max ? (d / max) * 100 : (prev?.s ?? 0);
  return { h, s, v: (max / 255) * 100 };
}

function hsvToHsl({ h, s, v }: Hsv): Rgb {
  const sat = s / 100;
  const val = v / 100;
  const l = val * (1 - sat / 2);
  const sl = l === 0 || l === 1 ? 0 : (val - l) / Math.min(l, 1 - l);
  return [h, sl * 100, l * 100];
}

function hslToHsv([h, s, l]: Rgb, prev: Hsv): Hsv {
  const sat = s / 100;
  const light = l / 100;
  const v = light + sat * Math.min(light, 1 - light);
  return { h, s: v ? 2 * (1 - light / v) * 100 : prev.s, v: v * 100 };
}

const hexOf = (hsv: Hsv) => toHex(hsvToRgb(hsv));

export type ColorFormat = "hex" | "rgb" | "hsl";

type ColorPickerContextValue = {
  hsv: Hsv;
  hex: string;
  setHsv: (next: Hsv) => void;
  mode: ColorFormat;
  setMode: (mode: ColorFormat) => void;
};

const ColorPickerContext = createContext<ColorPickerContextValue | null>(null);

export function useColorPicker() {
  const context = useContext(ColorPickerContext);
  if (!context)
    throw new Error("useColorPicker must be used within a ColorPicker");
  return context;
}

type Placement = { above: boolean; style: CSSProperties };

// Fixed position under the trigger, flipped above it when there is more room
// there, and kept inside the viewport.
function place(trigger: HTMLElement, height: number): Placement {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = vh - r.bottom - GAP - EDGE;
  const aboveRoom = r.top - GAP - EDGE;
  const above = below < height && aboveRoom > below;
  const width = Math.min(PANEL_W, vw - EDGE * 2);
  return {
    above,
    style: {
      width,
      left: clamp(r.left, EDGE, vw - EDGE - width),
      ...(above ? { bottom: vh - r.top + GAP } : { top: r.bottom + GAP }),
    },
  };
}

const subscribe = () => () => {};

export type ColorPickerProps = {
  /** A #rrggbb color. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the trigger and the panel. */
  label?: string;
  /** "swatch" is a bare chip; "field" is a bordered control with the hex. */
  variant?: "swatch" | "field";
  disabled?: boolean;
  className?: string;
};

export function ColorPicker({
  value,
  onChange,
  label = "Color",
  variant = "swatch",
  disabled = false,
  className = "",
}: ColorPickerProps) {
  const reduced = useReducedMotion();
  const client = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const [hsv, setLocal] = useState(() =>
    rgbToHsv(parseHex(value) ?? [0, 0, 0]),
  );
  const [mode, setMode] = useState<ColorFormat>("hex");
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Follow the controlled value when it changes from outside (a preset, a
  // style change, undo) without resetting the hue we're holding for grays.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const rgb = parseHex(value);
    if (rgb && toHex(rgb) !== hexOf(hsv)) setLocal(rgbToHsv(rgb, hsv));
  }

  const hex = hexOf(hsv);
  const emit = useRef(onChange);
  useEffect(() => {
    emit.current = onChange;
  }, [onChange]);
  const setHsv = useCallback(
    (next: Hsv) => {
      setLocal(next);
      const nextHex = hexOf(next);
      if (nextHex !== value.toLowerCase()) emit.current(nextHex);
    },
    [value],
  );

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = (event?: Event) => {
      if (event && panelRef.current?.contains(event.target as Node)) return;
      if (triggerRef.current)
        setPlacement(
          place(triggerRef.current, panelRef.current?.offsetHeight ?? 300),
        );
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>(".color-picker-area")
      ?.focus({ preventScroll: true });
    const onDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Element;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      // The format dropdown's menu lives in its own portal.
      if (target.closest?.(".dropdown-menu")) return;
      // A wrapping <label> forwards its click to the trigger, which toggles.
      const labels = triggerRef.current?.labels ?? [];
      if (Array.from(labels).some((label) => label.contains(target))) return;
      close(false);
    };
    // Escape must not reach the dialogs' document-level listeners, which
    // would close the whole dialog along with the picker. An open format
    // menu takes the first Escape itself.
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".dropdown-menu"))
        return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [open, close]);

  const above = placement?.above ?? false;
  const valueRgb = parseHex(value);
  const shown = (valueRgb ? toHex(valueRgb) : hex).toUpperCase();

  return (
    <ColorPickerContext.Provider value={{ hsv, hex, setHsv, mode, setMode }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        onClick={() => (open ? close() : setOpen(true))}
        className={`color-${variant}${open ? " is-open" : ""} ${className}`.trim()}
      >
        <span
          aria-hidden
          className="color-chip"
          style={{ background: shown }}
        />
        {variant === "field" && <code>{shown}</code>}
      </button>
      {client &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={panelRef}
                role="dialog"
                aria-label={label}
                initial={
                  reduced
                    ? { opacity: 0 }
                    : { opacity: 0, scale: 0.94, y: above ? 8 : -8 }
                }
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  y: above ? 6 : -6,
                  transition: reduced ? NONE : { duration: 0.12, ease: EXIT },
                }}
                transition={
                  reduced
                    ? NONE
                    : { ...OPEN, opacity: { duration: 0.12, ease: EASE } }
                }
                style={{
                  ...(placement?.style ?? { top: -9999, left: -9999 }),
                  transformOrigin: above ? "bottom left" : "top left",
                }}
                className="color-picker"
              >
                <ColorPickerSelection />
                <div className="color-picker-row">
                  <ColorPickerEyeDropper />
                  <ColorPickerHue />
                </div>
                <div className="color-picker-row">
                  <ColorPickerOutput />
                  <ColorPickerFormat />
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </ColorPickerContext.Provider>
  );
}

// Saturation runs left to right and brightness bottom to top. Arrow keys
// nudge it by 1 (10 with Shift).
export function ColorPickerSelection() {
  const { hsv, setHsv } = useColorPicker();
  const areaRef = useRef<HTMLDivElement>(null);

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHsv({
      h: hsv.h,
      s: clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100),
      v: clamp((1 - (e.clientY - rect.top) / rect.height) * 100, 0, 100),
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? 10 : 1;
    const [ds, dv] =
      {
        ArrowLeft: [-by, 0],
        ArrowRight: [by, 0],
        ArrowUp: [0, by],
        ArrowDown: [0, -by],
      }[e.key] ?? [];
    if (ds === undefined) return;
    e.preventDefault();
    setHsv({
      h: hsv.h,
      s: clamp(hsv.s + ds, 0, 100),
      v: clamp(hsv.v + dv, 0, 100),
    });
  };

  return (
    <div
      ref={areaRef}
      role="slider"
      tabIndex={0}
      aria-label="Saturation and brightness"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(hsv.s)}
      aria-valuetext={`Saturation ${Math.round(hsv.s)}%, brightness ${Math.round(hsv.v)}%`}
      className="color-picker-area"
      style={{ "--hue": hsv.h } as CSSProperties}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        pick(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e);
      }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className="color-picker-thumb"
        style={{
          left: `${hsv.s}%`,
          top: `${100 - hsv.v}%`,
          background: hexOf(hsv),
        }}
      />
    </div>
  );
}

export function ColorPickerHue() {
  const { hsv, setHsv } = useColorPicker();
  return (
    <input
      type="range"
      min={0}
      max={360}
      step={1}
      value={Math.round(hsv.h)}
      aria-label="Hue"
      className="color-picker-hue"
      onChange={(e) => setHsv({ ...hsv, h: Number(e.target.value) })}
    />
  );
}

type EyeDropperApi = new () => { open: () => Promise<{ sRGBHex: string }> };

// The EyeDropper API is Chromium-only, so the button hides elsewhere.
export function ColorPickerEyeDropper() {
  const { hsv, setHsv } = useColorPicker();
  const EyeDropper = (window as { EyeDropper?: EyeDropperApi }).EyeDropper;
  if (!EyeDropper) return null;
  return (
    <button
      type="button"
      aria-label="Pick a color from the screen"
      title="Pick from screen"
      className="color-picker-dropper"
      onClick={async () => {
        try {
          const { sRGBHex } = await new EyeDropper().open();
          const rgb = parseHex(sRGBHex);
          if (rgb) setHsv(rgbToHsv(rgb, hsv));
        } catch {
          // Dismissed with Escape.
        }
      }}
    >
      <PipetteIcon size={15} aria-hidden />
    </button>
  );
}

const formatItems: { value: ColorFormat; label: string }[] = [
  { value: "hex", label: "HEX" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
];

export function ColorPickerOutput() {
  const { mode, setMode } = useColorPicker();
  return (
    <Dropdown
      label="Color format"
      value={mode}
      items={formatItems}
      onChange={setMode}
      className="color-picker-mode"
    />
  );
}

// Shows the value while idle and keeps what's typed while focused, applying
// each edit as soon as it parses.
function DraftInput<T>({
  value,
  parse,
  onCommit,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  parse: (text: string) => T | null;
  onCommit: (value: T) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...props}
      type="text"
      spellCheck={false}
      autoComplete="off"
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parse(e.target.value);
        if (parsed !== null) onCommit(parsed);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

const channel = (max: number) => (text: string) => {
  if (!/^\s*\d{1,3}\s*$/.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
};

export function ColorPickerFormat() {
  const { hsv, hex, setHsv, mode } = useColorPicker();

  if (mode === "hex")
    return (
      <div className="color-picker-fields">
        <span aria-hidden className="color-picker-hash">
          #
        </span>
        <DraftInput
          aria-label="Hex"
          maxLength={7}
          value={hex.slice(1).toUpperCase()}
          parse={parseHex}
          onCommit={(rgb) => setHsv(rgbToHsv(rgb, hsv))}
          className="color-picker-hex"
        />
      </div>
    );

  const isRgb = mode === "rgb";
  const values = (isRgb ? hsvToRgb(hsv) : hsvToHsl(hsv)).map(Math.round);
  const names = isRgb
    ? ["Red", "Green", "Blue"]
    : ["Hue", "Saturation", "Lightness"];
  const maxes = isRgb ? [255, 255, 255] : [360, 100, 100];

  return (
    <div className="color-picker-fields">
      {values.map((n, i) => (
        <DraftInput
          key={`${mode}-${i}`}
          aria-label={names[i]}
          inputMode="numeric"
          maxLength={3}
          value={String(n)}
          parse={channel(maxes[i])}
          onCommit={(next) => {
            const parts = [...values] as Rgb;
            parts[i] = next;
            setHsv(isRgb ? rgbToHsv(parts, hsv) : hslToHsv(parts, hsv));
          }}
        />
      ))}
    </div>
  );
}
