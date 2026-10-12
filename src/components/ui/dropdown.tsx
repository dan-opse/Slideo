"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

// Adapted from the 21st.dev dropdown: same hook, springs and animation, with
// the Tailwind classes moved to app/controls.css. The menu renders in a portal
// so modals and scrolling panels can't clip it.

const EASE = [0.23, 1, 0.32, 1] as const;
const EXIT = [0.4, 0, 1, 1] as const;
const CELL = {
  type: "spring",
  stiffness: 520,
  damping: 34,
  mass: 0.45,
} as const;
const NUDGE = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;
const NONE = { duration: 0 } as const;
const SLIDE = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;
const OPEN = {
  type: "spring",
  stiffness: 620,
  damping: 38,
  mass: 0.6,
} as const;

const ROW_H = 32;
const LIST_MAX = 216;
// 5px padding and a 1px border on each side of the list.
const MENU_CHROME = 12;
const MENU_MIN_W = 224;
const GAP = 6;
const EDGE = 8;

export type DropdownItem<T extends string = string> = {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export type UseDropdownOptions<T extends string = string> = {
  items: DropdownItem<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
  typeaheadDelay?: number;
  defaultOpen?: boolean;
};

export function useDropdown<T extends string = string>({
  items,
  value,
  defaultValue,
  onChange,
  disabled = false,
  typeaheadDelay = 600,
  defaultOpen = false,
}: UseDropdownOptions<T>) {
  const uid = useId();
  const listId = `${uid}-list`;
  const itemId = useCallback((i: number) => `${uid}-opt-${i}`, [uid]);

  const [uncontrolled, setUncontrolled] = useState<T | null>(
    defaultValue ?? null,
  );
  const selectedValue = value !== undefined ? value : uncontrolled;
  const selectedIndex = items.findIndex((it) => it.value === selectedValue);

  const [open, setOpen] = useState(defaultOpen);
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const viaKey = useRef(false);
  const buffer = useRef("");
  const bufferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Callers pass inline handlers; read the latest through a ref.
  const emit = useRef(onChange);
  useEffect(() => {
    emit.current = onChange;
  }, [onChange]);

  const step = useCallback(
    (from: number, dir: 1 | -1) => {
      const n = items.length;
      if (n === 0) return -1;
      let i = from;
      for (let k = 0; k < n; k++) {
        i = (i + dir + n) % n;
        if (!items[i].disabled) return i;
      }
      return from;
    },
    [items],
  );

  const edge = useCallback(
    (dir: 1 | -1) => step(dir === 1 ? -1 : items.length, dir),
    [step, items.length],
  );

  const openMenu = useCallback(
    (index?: number) => {
      if (disabled || items.length === 0) return;
      const usable = selectedIndex >= 0 && !items[selectedIndex].disabled;
      viaKey.current = true;
      setActiveIndex(index ?? (usable ? selectedIndex : edge(1)));
      setOpen(true);
    },
    [disabled, items, selectedIndex, edge],
  );

  const close = useCallback((restoreFocus = true) => {
    buffer.current = "";
    setOpen(false);
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const select = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item || item.disabled) return;
      if (value === undefined) setUncontrolled(item.value);
      emit.current?.(item.value);
      close();
    },
    [items, value, close],
  );

  const typeahead = useCallback(
    (char: string) => {
      if (bufferTimer.current) clearTimeout(bufferTimer.current);
      buffer.current += char.toLowerCase();
      bufferTimer.current = setTimeout(() => {
        buffer.current = "";
      }, typeaheadDelay);

      const q = buffer.current;
      const n = items.length;
      const from = activeIndex < 0 ? 0 : activeIndex;
      const start = q.length > 1 ? from : from + 1;
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        const it = items[i];
        if (!it.disabled && it.label.toLowerCase().startsWith(q)) {
          viaKey.current = true;
          setActiveIndex(i);
          return;
        }
      }
    },
    [items, activeIndex, typeaheadDelay],
  );

  useEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      // A wrapping <label> forwards its click to the trigger, which toggles.
      const labels = triggerRef.current?.labels ?? [];
      if (Array.from(labels).some((label) => label.contains(target))) return;
      close(false);
    };
    const onWindowBlur = () => close(false);
    // Escape must not reach the dialogs' document-level listeners, which
    // would close the whole dialog along with the menu, so catch it first.
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || activeIndex < 0 || !viaKey.current) return;
    viaKey.current = false;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  useEffect(
    () => () => {
      if (bufferTimer.current) clearTimeout(bufferTimer.current);
    },
    [],
  );

  const triggerProps = {
    ref: triggerRef,
    type: "button" as const,
    disabled,
    "aria-haspopup": "listbox" as const,
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    onClick: () => (open ? close() : openMenu()),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        openMenu(edge(-1));
      }
    },
  };

  const listProps = {
    ref: listRef,
    id: listId,
    role: "listbox" as const,
    tabIndex: -1,
    "aria-activedescendant": activeIndex >= 0 ? itemId(activeIndex) : undefined,
    onKeyDown: (e: KeyboardEvent<HTMLUListElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        viaKey.current = true;
        setActiveIndex((i) => step(i, dir));
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        viaKey.current = true;
        setActiveIndex(edge(e.key === "Home" ? 1 : -1));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(activeIndex);
      } else if (e.key === "Tab") {
        e.preventDefault();
        close();
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        typeahead(e.key);
      }
    },
  };

  const getItemProps = useCallback(
    (index: number) => ({
      id: itemId(index),
      role: "option" as const,
      "aria-selected": index === selectedIndex,
      "aria-disabled": items[index]?.disabled ? (true as const) : undefined,
      ref: (el: HTMLLIElement | null) => {
        itemRefs.current[index] = el;
      },
      onPointerMove: () => {
        if (items[index]?.disabled) return;
        viaKey.current = false;
        setActiveIndex(index);
      },
      onClick: () => select(index),
    }),
    [itemId, items, selectedIndex, select],
  );

  return {
    open,
    openMenu,
    close,
    select,
    activeIndex,
    selectedIndex,
    selectedItem: selectedIndex >= 0 ? items[selectedIndex] : null,
    itemId,
    rootRef,
    menuRef,
    triggerRef,
    triggerProps,
    listProps,
    getItemProps,
  };
}

type Placement = {
  above: boolean;
  style: CSSProperties;
  listMax: number;
};

// Fixed position under the trigger, flipped above it when there is more room
// there, and kept inside the viewport.
function place(trigger: HTMLElement, rows: number): Placement {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const want = Math.min(LIST_MAX, Math.max(rows, 1) * ROW_H) + MENU_CHROME;
  const below = vh - r.bottom - GAP - EDGE;
  const aboveRoom = r.top - GAP - EDGE;
  const above = below < want && aboveRoom > below;
  const room = above ? aboveRoom : below;
  const minWidth = Math.min(Math.max(r.width, MENU_MIN_W), vw - EDGE * 2);
  const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - minWidth));
  return {
    above,
    listMax: Math.max(ROW_H * 2, Math.min(LIST_MAX, room - MENU_CHROME)),
    style: {
      left,
      minWidth,
      maxWidth: Math.max(minWidth, Math.min(440, vw - left - EDGE)),
      ...(above ? { bottom: vh - r.top + GAP } : { top: r.bottom + GAP }),
    },
  };
}

const subscribe = () => () => {};

export type DropdownProps<T extends string = string> = {
  items: DropdownItem<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  /** Accessible name for the trigger and the list. */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
  /** "field" is a bordered form control; "bare" blends into its container. */
  variant?: "field" | "bare";
  className?: string;
  defaultOpen?: boolean;
};

export function Dropdown<T extends string = string>({
  items,
  value,
  defaultValue,
  onChange,
  label = "Options",
  placeholder = "Select an option",
  disabled = false,
  emptyLabel = "Nothing to choose",
  variant = "field",
  className = "",
  defaultOpen = false,
}: DropdownProps<T>) {
  const reduced = useReducedMotion();
  const client = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const {
    open,
    activeIndex,
    selectedIndex,
    selectedItem,
    rootRef,
    menuRef,
    triggerRef,
    triggerProps,
    listProps,
    getItemProps,
  } = useDropdown({
    items,
    value,
    defaultValue,
    onChange,
    disabled,
    defaultOpen,
  });

  const [placement, setPlacement] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = (event?: Event) => {
      // Scrolling the list itself doesn't move the trigger.
      if (event && menuRef.current?.contains(event.target as Node)) return;
      if (triggerRef.current)
        setPlacement(place(triggerRef.current, items.length));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, items.length, menuRef, triggerRef]);

  const cell = reduced ? NONE : CELL;
  const above = placement?.above ?? false;
  const shown = selectedItem ? selectedItem.label : placeholder;

  return (
    <div
      ref={rootRef}
      className={`dropdown dropdown-${variant} ${className}`.trim()}
    >
      <button
        {...triggerProps}
        aria-label={`${label}: ${shown}`}
        className={`dropdown-trigger${open ? " is-open" : ""}`}
      >
        <span
          className={`dropdown-value${selectedItem ? "" : " is-placeholder"}`}
        >
          {shown}
        </span>
        <motion.svg
          aria-hidden
          viewBox="0 0 12 12"
          className="dropdown-chevron"
          initial={false}
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduced ? NONE : NUDGE}
        >
          <path
            d="M3 4.75 6 7.75 9 4.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </motion.svg>
      </button>
      {client &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
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
                  // Until measured, park it off-screen rather than hiding it:
                  // a hidden list can't take focus when it opens.
                  ...(placement?.style ?? { top: -9999, left: -9999 }),
                  transformOrigin: above ? "bottom left" : "top left",
                }}
                className="dropdown-menu"
              >
                <ul
                  {...listProps}
                  aria-label={label}
                  className="dropdown-list"
                  style={{ maxHeight: placement?.listMax ?? LIST_MAX }}
                >
                  <motion.span
                    aria-hidden
                    className="dropdown-highlight"
                    initial={false}
                    animate={{
                      y: activeIndex < 0 ? 0 : activeIndex * ROW_H,
                      opacity: activeIndex < 0 ? 0 : 1,
                    }}
                    transition={
                      reduced
                        ? NONE
                        : { ...SLIDE, opacity: { duration: 0.1, ease: EASE } }
                    }
                  />
                  {items.map((item, i) => {
                    const active = i === activeIndex && !item.disabled;
                    const picked = i === selectedIndex;
                    return (
                      <li
                        key={`${i}:${item.value}`}
                        {...getItemProps(i)}
                        title={item.label.length > 48 ? item.label : undefined}
                        className={`dropdown-item${
                          item.disabled
                            ? " is-disabled"
                            : active
                              ? " is-active"
                              : ""
                        }`}
                      >
                        <span className="dropdown-item-text">
                          <span className="dropdown-item-label">
                            {item.label}
                          </span>
                          {item.hint ? (
                            <span className="dropdown-item-hint">
                              {item.hint}
                            </span>
                          ) : null}
                        </span>
                        <motion.span
                          aria-hidden
                          initial={false}
                          animate={{
                            opacity: picked ? 1 : 0,
                            scale: picked ? 1 : 0.7,
                          }}
                          transition={cell}
                          className="dropdown-check"
                        >
                          <svg viewBox="0 0 14 14">
                            <path
                              d="M3 7.4 5.8 10.2 11 4.4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </motion.span>
                      </li>
                    );
                  })}

                  {items.length === 0 && (
                    <li role="presentation" className="dropdown-empty">
                      {emptyLabel}
                    </li>
                  )}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

export default Dropdown;
