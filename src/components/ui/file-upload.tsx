"use client";

import { useRef, useState, type DragEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FileImage, Upload, X } from "lucide-react";

// Adapted from the 21st.dev animated file upload (SmoothUI): the same
// dropzone, springs, file list and remove controls, with the Tailwind classes
// moved to app/controls.css and the inline icons swapped for lucide. The file
// list is controlled so a form can read it, and dropped files are checked
// against `accept` as well as `maxSize`, since a drop skips the picker filter.

const SPRING = { type: "spring", bounce: 0.1, duration: 0.25 } as const;
const BOUNCY = { type: "spring", bounce: 0.2, duration: 0.3 } as const;
const NONE = { duration: 0 } as const;

// 1.5 MB, 20 MB (not 20.0 MB).
export function formatFileSize(bytes: number) {
  const short = (n: number) => `${Number(n.toFixed(1))}`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${short(bytes / 1024)} KB`;
  return `${short(bytes / (1024 * 1024))} MB`;
}

// The same rules as the input's accept attribute: MIME types, type/* wildcards
// and .extensions.
function accepts(file: File, accept?: string) {
  if (!accept) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

const fileKey = (file: File) =>
  `${file.name}-${file.size}-${file.lastModified}`;

export type FileUploadProps = {
  files: File[];
  onFilesChange: (files: File[]) => void;
  accept?: string;
  /** Largest allowed file, in bytes. */
  maxSize?: number;
  multiple?: boolean;
  disabled?: boolean;
  /** Prompt shown in the dropzone, also its accessible name. */
  label?: string;
  /** Second line under the prompt; defaults to the accepted types and limit. */
  hint?: string;
  className?: string;
};

export function FileUpload({
  files,
  onFilesChange,
  accept,
  maxSize,
  multiple = true,
  disabled = false,
  label = "Drag & drop or click to upload",
  hint,
  className = "",
}: FileUploadProps) {
  const reduced = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = (incoming: File[]) => {
    const wrongType = incoming.filter((f) => !accepts(f, accept));
    const tooBig = incoming.filter(
      (f) => accepts(f, accept) && maxSize && f.size > maxSize,
    );
    const rejected = [...wrongType, ...tooBig];
    const problems = [
      wrongType.length &&
        `${wrongType.length === 1 ? wrongType[0].name : `${wrongType.length} files`} ${wrongType.length === 1 ? "isn't" : "aren't"} a supported type`,
      tooBig.length &&
        `${tooBig.length === 1 ? tooBig[0].name : `${tooBig.length} files`} ${tooBig.length === 1 ? "is" : "are"} over ${formatFileSize(maxSize ?? 0)}`,
    ].filter(Boolean);
    setError(problems.length ? `${problems.join("; ")}.` : null);

    const valid = incoming.filter((f) => !rejected.includes(f));
    if (!valid.length) return;
    if (!multiple) return onFilesChange(valid.slice(0, 1));
    // Picking the same file twice keeps one copy.
    const seen = new Set(files.map(fileKey));
    onFilesChange([...files, ...valid.filter((f) => !seen.has(fileKey(f)))]);
  };

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? "none" : "copy";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!disabled) add(Array.from(e.dataTransfer.files));
  };

  const shownHint =
    hint ??
    [
      accept ? accept.split(",").join(", ") : "Any file type",
      maxSize ? `Max ${formatFileSize(maxSize)}` : "",
    ]
      .filter(Boolean)
      .join(" • ");

  return (
    <div className={`file-upload ${className}`.trim()}>
      {/* Only ever clicked through the ref; the dropzone button is the
          control, so this stays out of the tab order and the a11y tree. */}
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-hidden
        tabIndex={-1}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <motion.button
        type="button"
        disabled={disabled}
        aria-label={`${label}. ${shownHint}`}
        className={`file-upload-zone${dragging ? " is-dragging" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        animate={reduced ? undefined : { scale: dragging ? 1.02 : 1 }}
        transition={reduced ? NONE : SPRING}
      >
        <motion.span
          aria-hidden
          className="file-upload-icon"
          animate={
            reduced
              ? undefined
              : dragging
                ? { scale: 1.15, y: -4 }
                : { scale: 1, y: 0 }
          }
          transition={reduced ? NONE : BOUNCY}
        >
          <Upload size={30} strokeWidth={1.5} />
        </motion.span>
        <AnimatePresence initial={false} mode="wait">
          <motion.strong
            key={dragging ? "drop" : "idle"}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reduced ? NONE : { duration: 0.15 }}
          >
            {dragging ? "Drop to add" : label}
          </motion.strong>
        </AnimatePresence>
        <span className="file-upload-hint">{shownHint}</span>
      </motion.button>

      <AnimatePresence>
        {error && (
          <motion.p
            role="alert"
            className="file-upload-error"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={
              reduced ? { opacity: 0, transition: NONE } : { opacity: 0, y: -4 }
            }
            transition={reduced ? NONE : SPRING}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      {files.length > 0 && (
        <ul aria-label="Selected files" className="file-upload-list">
          <AnimatePresence initial={false}>
            {files.map((file) => (
              <motion.li
                key={fileKey(file)}
                layout={!reduced}
                initial={
                  reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, x: -16 }
                }
                animate={
                  reduced ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0 }
                }
                exit={
                  reduced
                    ? { opacity: 0, transition: NONE }
                    : {
                        opacity: 0,
                        scale: 0.95,
                        x: 24,
                        transition: { duration: 0.15 },
                      }
                }
                transition={reduced ? NONE : SPRING}
                className="file-upload-item"
              >
                <FileImage aria-hidden size={16} strokeWidth={1.5} />
                <span className="file-upload-meta">
                  <span className="file-upload-name">{file.name}</span>
                  <span className="file-upload-size">
                    {formatFileSize(file.size)}
                  </span>
                </span>
                <motion.button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                  className="file-upload-remove"
                  onClick={() => onFilesChange(files.filter((f) => f !== file))}
                  whileHover={reduced || disabled ? undefined : { scale: 1.1 }}
                  whileTap={reduced || disabled ? undefined : { scale: 0.9 }}
                >
                  <X aria-hidden size={14} />
                </motion.button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
