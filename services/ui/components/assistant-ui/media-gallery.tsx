"use client";

/**
 * Conversation-wide image gallery. Every image shown in the thread (user attachments, images
 * the agent sent, tool-result screenshots, markdown images) renders through a GalleryItem,
 * which marks its element with `data-gallery-src`. Opening one collects every marked element
 * in document order, so the lightbox can page through all of the conversation's images with
 * the arrow keys, the on-screen buttons, or a swipe.
 */

import { type FC, type ReactNode, type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive, Slot } from "radix-ui";
import { create } from "zustand";

import { cn } from "@/lib/utils";

export interface GalleryEntry {
  src: string;
  alt: string;
}

interface GalleryState {
  items: GalleryEntry[];
  index: number;
  open: boolean;
  show: (items: GalleryEntry[], index: number) => void;
  close: () => void;
  step: (delta: number) => void;
}

export const useGallery = create<GalleryState>((set) => ({
  items: [],
  index: 0,
  open: false,
  show: (items, index) => set({ items, index: Math.max(0, Math.min(index, items.length - 1)), open: items.length > 0 }),
  close: () => set({ open: false }),
  step: (delta) =>
    set((s) => (s.items.length ? { index: (s.index + delta + s.items.length) % s.items.length } : s)),
}));

/** The attribute a gallery member carries; the gallery is every element that has it. */
const SRC_ATTR = "data-gallery-src";
const ALT_ATTR = "data-gallery-alt";

/** Collect the gallery from the DOM in document order, deduping repeats of the same image. */
export function collectGallery(root: ParentNode = document): GalleryEntry[] {
  const out: GalleryEntry[] = [];
  const seen = new Set<string>();
  root.querySelectorAll<HTMLElement>(`[${SRC_ATTR}]`).forEach((el) => {
    const src = el.getAttribute(SRC_ATTR);
    if (!src || seen.has(src)) return;
    seen.add(src);
    out.push({ src, alt: el.getAttribute(ALT_ATTR) ?? "" });
  });
  return out;
}

/** Open the gallery at `src`, among every image currently in the page. */
export function openGalleryAt(src: string, alt = "") {
  const items = collectGallery();
  let index = items.findIndex((i) => i.src === src);
  if (index < 0) {
    items.push({ src, alt });
    index = items.length - 1;
  }
  useGallery.getState().show(items, index);
}

/**
 * Make its child a gallery member: tagged for collection, and opening the gallery at this
 * image on click or Enter/Space.
 */
export const GalleryItem: FC<{ src: string; alt?: string; children: ReactNode; className?: string }> = ({
  src,
  alt = "",
  children,
  className,
}) => {
  const open = () => openGalleryAt(src, alt);
  return (
    <Slot.Root
      {...{ [SRC_ATTR]: src, [ALT_ATTR]: alt }}
      role="button"
      tabIndex={0}
      aria-label={alt ? `Open image: ${alt}` : "Open image"}
      className={cn("cursor-zoom-in", className)}
      onClick={(e: { preventDefault: () => void }) => {
        e.preventDefault();
        open();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {children}
    </Slot.Root>
  );
};

/**
 * An inline image in the thread: lazy, bounded in size, and a gallery member. A failed load
 * (an asset whose staged write lost a race, a flaky network) retries once before showing a
 * placeholder.
 */
export const MediaImage: FC<{ src: string; alt?: string; className?: string }> = ({ src, alt = "", className }) => {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const shown = attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
  if (failed) {
    return (
      <span
        data-slot="media-image-failed"
        className={cn("bg-muted text-muted-foreground inline-flex items-center rounded-lg px-3 py-2 text-xs", className)}
      >
        Image unavailable{alt ? `: ${alt}` : ""}
      </span>
    );
  }
  return (
    <GalleryItem src={src} alt={alt}>
      <img
        data-slot="media-image"
        src={shown}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => {
          if (attempt < 1) setTimeout(() => setAttempt((a) => a + 1), 750);
          else setFailed(true);
        }}
        className={cn(
          "border-border/50 bg-muted/30 my-2 block h-auto max-h-80 w-auto max-w-full rounded-lg border object-contain",
          className,
        )}
      />
    </GalleryItem>
  );
};

/** A row of inline images (an assistant message's or a tool result's). */
export const MediaStrip: FC<{ images: GalleryEntry[]; className?: string }> = ({ images, className }) => {
  if (!images.length) return null;
  return (
    <div data-slot="media-strip" className={cn("flex flex-wrap gap-2", className)}>
      {images.map((img) => (
        <MediaImage key={img.src} src={img.src} alt={img.alt} className={images.length > 1 ? "max-h-48" : undefined} />
      ))}
    </div>
  );
};

/** The lightbox; mount once (it is driven by useGallery). */
export const MediaGallery: FC = () => {
  const { items, index, open, close, step } = useGallery();
  const cur = items[index];
  const many = items.length > 1;
  const swipeStart = useRef<number | null>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
    },
    [step],
  );

  // Preload the neighbours so paging feels instant.
  useEffect(() => {
    if (!open || !many) return;
    for (const d of [1, -1]) {
      const n = items[(index + d + items.length) % items.length];
      if (n) new Image().src = n.src;
    }
  }, [open, many, index, items]);

  const onPointerDown = (e: PointerEvent) => {
    swipeStart.current = e.clientX;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (swipeStart.current === null) return;
    const dx = e.clientX - swipeStart.current;
    swipeStart.current = null;
    if (many && Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  };

  return (
    <DialogPrimitive.Root open={open && !!cur} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/85" />
        <DialogPrimitive.Content
          data-testid="media-gallery"
          onKeyDown={onKeyDown}
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            {cur?.alt || "Image"}
            {many ? ` (${index + 1} of ${items.length})` : ""}
          </DialogPrimitive.Title>
          <div className="absolute top-3 right-3 left-3 flex items-center justify-between gap-2 text-white">
            <span data-testid="media-gallery-counter" className="rounded-full bg-black/50 px-3 py-1 text-xs tabular-nums">
              {many ? `${index + 1} / ${items.length}` : ""}
            </span>
            <div className="flex items-center gap-1">
              {cur && (
                <a
                  href={cur.src}
                  download
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-black/50 p-2 hover:bg-black/70"
                  aria-label="Download image"
                >
                  <DownloadIcon className="size-4" />
                </a>
              )}
              <DialogPrimitive.Close className="rounded-full bg-black/50 p-2 hover:bg-black/70" aria-label="Close">
                <XIcon className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </div>

          {cur && (
            <img
              key={cur.src}
              data-testid="media-gallery-image"
              src={cur.src}
              alt={cur.alt}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              className="animate-in fade-in-0 max-h-[85dvh] max-w-[92vw] touch-pan-y object-contain select-none"
              draggable={false}
            />
          )}
          {cur?.alt && <p className="mt-3 max-w-[80vw] text-center text-sm text-white/80">{cur.alt}</p>}

          {many && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={() => step(-1)}
                className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
              >
                <ChevronLeftIcon className="size-6" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={() => step(1)}
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
              >
                <ChevronRightIcon className="size-6" />
              </button>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
