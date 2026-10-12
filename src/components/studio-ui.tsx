"use client";
// Small building blocks shared by the studio's pages and dialogs.
import { useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AlertCircle, X } from "lucide-react";
import type { Post } from "@/lib/schema";
import { PHOTO_RENDER_VERSION } from "@/lib/photo-layout";
import { RenderFallback } from "./render-fallback";
import { useModalFocus } from "./dialog";

export const statusLabel = {
  needs_review: "Needs review",
  approved: "Approved",
  published: "Published",
  archived: "Deleted",
};
export const imgUrl = (p: Post, i = 0) =>
  `/api/render/${p.id}/${p.revision}/${i}${p.slides[i]?.design === "photo" ? `?v=${PHOTO_RENDER_VERSION}` : ""}`;

export function SlideoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="8.5"
        y="2.5"
        width="11"
        height="15"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="4.5"
        y="6.5"
        width="11"
        height="15"
        rx="2.5"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
export function IconButton({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
  error,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onClose);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {error && (
          <div className="alert modal-alert" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function SlideImage({
  post,
  index = 0,
  className = "",
  eager = false,
}: {
  post: Post;
  index?: number;
  className?: string;
  // Above-the-fold covers load immediately; they are the page's largest paint.
  eager?: boolean;
}) {
  const src = imgUrl(post, index);
  // Remember which render failed so a new revision gets a fresh attempt.
  const [failed, setFailed] = useState("");
  const slide = post.slides[index];
  return (
    <div
      className={`slide-image ${className}`}
      style={{
        aspectRatio: post.aspect === "portrait" ? "4 / 5" : "9 / 16",
        background: slide?.background,
      }}
    >
      {failed === src ? (
        <RenderFallback />
      ) : (
        <Image
          unoptimized
          src={src}
          alt={`Slide ${index + 1}${slide?.title ? `: ${slide.title}` : ""}`}
          fill
          sizes="(max-width: 800px) 90vw, 400px"
          loading={eager ? "eager" : "lazy"}
          style={{ objectFit: "contain" }}
          onError={() => setFailed(src)}
        />
      )}
    </div>
  );
}
