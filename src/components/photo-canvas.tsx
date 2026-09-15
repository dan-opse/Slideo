"use client";
import { memo, useEffect, useState, type PointerEvent } from "react";
import { parse, type Font } from "opentype.js/dist/opentype.mjs";
import {
  FONT_FILES,
  canvasHeight,
  imageRect,
  layoutText,
  photoTextSvg,
} from "@/lib/photo-layout";
import type { Asset, PhotoText, Post, Slide } from "@/lib/schema";
import { imageSlots } from "@/lib/format-template";

export type PhotoFonts = Record<PhotoText["font"], Font>;
let fontPromise: Promise<PhotoFonts> | undefined;
export function loadPhotoFonts() {
  return (fontPromise ??= Promise.all(
    Object.entries(FONT_FILES).map(async ([name, file]) => {
      const response = await fetch(`/fonts/${file}`);
      if (!response.ok)
        throw new Error(
          "The TikTok font could not load. Reload the studio and try again.",
        );
      return [name, parse(await response.arrayBuffer())] as const;
    }),
  )
    .then((entries) => Object.fromEntries(entries) as PhotoFonts)
    .catch((error) => {
      fontPromise = undefined;
      throw error;
    }));
}
export function usePhotoFonts() {
  const [fonts, setFonts] = useState<PhotoFonts | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    loadPhotoFonts()
      .then((value) => {
        if (alive) setFonts(value);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { fonts, error };
}

export const PhotoCanvas = memo(function PhotoCanvas({
  slide,
  aspect,
  asset,
  assets,
  fonts,
  activeLayer,
  onSelect,
  onDrag,
  grid = false,
}: {
  slide: Slide;
  aspect: Post["aspect"];
  asset?: Asset;
  assets?: Asset[];
  fonts: PhotoFonts | null;
  activeLayer?: string;
  onSelect?: (id: string) => void;
  onDrag?: (
    event: PointerEvent<HTMLElement>,
    layer: PhotoText,
    resize: boolean,
  ) => void;
  grid?: boolean;
}) {
  const height = canvasHeight(aspect);
  const slots = imageSlots(slide, height).flatMap((slot) => {
    const image =
      assets?.find((item) => item.id === slot.id) ??
      (asset?.id === slot.id ? asset : undefined);
    return image
      ? [
          {
            ...slot,
            rect: imageRect(
              slide,
              image.width,
              image.height,
              slot.height,
              slot.width,
            ),
          },
        ]
      : [];
  });
  return (
    <div
      className="photo-canvas"
      style={{ aspectRatio: `240 / ${height}`, background: slide.background }}
    >
      <svg
        viewBox={`0 0 240 ${height}`}
        role="img"
        aria-label={
          slide.textLayers?.map((layer) => layer.text).join(". ") ||
          "Photo slide"
        }
      >
        {slots.map(({ id, rect, ...slot }) => (
          <svg
            key={`${id}-${slot.x}-${slot.y}`}
            {...slot}
            viewBox={`0 0 ${slot.width} ${slot.height}`}
            overflow="hidden"
          >
            <image
              href={`/api/media/${id}`}
              {...rect}
              preserveAspectRatio="none"
            />
          </svg>
        ))}
        {slots.length > 0 && (
          <rect
            width="240"
            height={height}
            fill="#000"
            opacity={slide.overlay}
          />
        )}
        {fonts &&
          (slide.textLayers ?? []).map((layer) => (
            <g
              key={layer.id}
              dangerouslySetInnerHTML={{
                __html: photoTextSvg(layer, fonts[layer.font]),
              }}
            />
          ))}
        {grid && (
          <g
            stroke="#fff"
            strokeOpacity=".45"
            strokeWidth=".45"
            strokeDasharray="2 2"
          >
            <path
              d={`M80 0V${height}M160 0V${height}M0 ${height / 3}H240M0 ${(height * 2) / 3}H240`}
            />
          </g>
        )}
      </svg>
      {onSelect &&
        (slide.textLayers ?? []).map((layer) => {
          const active = activeLayer === layer.id;
          const overflow =
            fonts && layoutText(layer, fonts[layer.font]).overflow;
          return (
            <div
              key={layer.id}
              className={`text-selection ${active ? "active" : ""} ${overflow ? "overflow" : ""}`}
              style={{
                left: `${layer.x / 2.4}%`,
                top: `${(layer.y / height) * 100}%`,
                width: `${layer.width / 2.4}%`,
                height: `${(layer.height / height) * 100}%`,
              }}
            >
              <button
                className="text-move"
                aria-label={`Select text: ${layer.text.slice(0, 60)}`}
                onClick={() => onSelect(layer.id)}
                onPointerDown={(event) => {
                  onSelect(layer.id);
                  onDrag?.(event, layer, false);
                }}
              />
              {active && (
                <>
                  <span className="selection-size">
                    {Math.round(layer.width)} × {Math.round(layer.height)}
                  </span>
                  <i className="handle nw" />
                  <i className="handle ne" />
                  <i className="handle sw" />
                  <button
                    className="handle se"
                    aria-label="Resize text box"
                    onPointerDown={(event) => onDrag?.(event, layer, true)}
                  />
                </>
              )}
            </div>
          );
        })}
    </div>
  );
});
