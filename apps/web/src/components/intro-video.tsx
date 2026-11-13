"use client";

import { clsx } from "clsx";
import { Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tick } from "@/components/glass";
import { useBackClose } from "@/lib/back";
import { useI18n } from "@/lib/i18n";

/**
 * The one-minute intro film, re-encoded for the web (H.264 720p, AAC, faststart) from the release masters in
 * fc-promo/out/v3_release. Captions are burned in, so it makes sense with the sound off.
 */
const FILMS = {
  landscape: {
    src: "/intro/flowcarbon-intro-landscape-en.mp4",
    poster: "/intro/flowcarbon-intro-landscape-poster.jpg",
    width: 1280,
    height: 720,
  },
  vertical: {
    src: "/intro/flowcarbon-intro-vertical-en.mp4",
    poster: "/intro/flowcarbon-intro-vertical-poster.jpg",
    width: 720,
    height: 1280,
  },
} as const;

type Orientation = keyof typeof FILMS;

/** A phone held upright gets the vertical cut; everything else the landscape one. */
function pickOrientation(): Orientation {
  try {
    return matchMedia("(max-width: 640px) and (orientation: portrait)").matches ? "vertical" : "landscape";
  } catch {
    return "landscape";
  }
}

/** The "Watch the 1-minute intro" link; the film is only fetched once it is opened. */
export function IntroVideoLink({ className }: { className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          tick();
          setOpen(true);
        }}
        className={clsx(
          "fc-press inline-flex min-h-11 items-center gap-1.5 font-medium sm:min-h-0",
          className,
        )}
      >
        <Play className="size-3.5" aria-hidden />
        {t.intro.watch}
      </button>
      {open ? <IntroVideo onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The film in a light modal player. It never starts with sound: unless the viewer prefers reduced motion it
 * starts muted (the captions carry it) and the player's own controls turn the sound on; with reduced motion it
 * waits on its poster for the viewer to press play.
 */
export function IntroVideo({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const video = useRef<HTMLVideoElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useBackClose(onClose);

  useEffect(() => {
    setOrientation(pickOrientation());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    closeButton.current?.focus();
    const v = video.current;
    if (!v) return;
    let reduced = false;
    try {
      reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // no media queries: treat as no preference
    }
    if (!reduced) {
      v.muted = true;
      // a browser may still refuse; the poster and controls are there either way
      v.play().catch(() => {});
    }
    return () => v.pause();
  }, [mounted]);

  if (!mounted) return null;
  const film = FILMS[orientation];
  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-4 sm:p-6" role="presentation">
      <button
        type="button"
        aria-label={t.common.close}
        tabIndex={-1}
        onClick={onClose}
        className="fc-scrim absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.intro.title}
        className={clsx(
          "relative overflow-hidden rounded-2xl bg-black shadow-2xl",
          orientation === "vertical" ? "h-[min(85dvh,calc((100vw-2rem)*16/9))]" : "w-[min(100%,960px)]",
        )}
        style={{ aspectRatio: `${film.width} / ${film.height}` }}
      >
        {/* biome-ignore lint/a11y/useMediaCaption: the captions are burned into the picture */}
        <video
          ref={video}
          src={film.src}
          poster={film.poster}
          width={film.width}
          height={film.height}
          controls
          playsInline
          preload="metadata"
          className="block size-full bg-black object-contain"
        />
        <button
          ref={closeButton}
          type="button"
          aria-label={t.common.close}
          title={t.common.close}
          onClick={onClose}
          className="fc-press absolute top-2 right-2 grid size-11 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
    </div>,
    document.body,
  );
}
