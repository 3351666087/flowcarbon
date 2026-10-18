"use client";

import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";

/**
 * Liquid Glass, after Apple's material (iOS 26): a layer for controls and navigation that floats above the content,
 * bends that content at its rim the way a thick pane of glass does, carries a highlight that follows the light, and
 * takes its tint from what is behind it. Content itself stays solid; glass is kept to the few elements that navigate.
 *
 * The rim refraction is an SVG displacement map used as a backdrop filter. Only Chromium renders SVG filters there
 * (Chrome, Edge, the Android WebView); Safari and Firefox get the same glass without the bending — blur, saturation,
 * tint and the specular rim, which are plain CSS (`.fc-glass` in globals.css).
 */

/**
 * Refraction through a convex squircle bezel (n = 1.5), sampled from the rim (x = 0, steepest, offset 1) to where the
 * surface turns flat (x = 1, offset 0).
 */
const PROFILE = (() => {
  const n = 1.5;
  const height = (x: number) => (1 - (1 - x) ** 4) ** 0.25;
  const raw = Array.from({ length: 65 }, (_, i) => {
    const x = Math.min(i / 64, 0.999);
    const slope = (height(Math.min(1, x + 0.001)) - height(x)) / 0.001;
    const incidence = Math.atan(slope);
    const refracted = Math.asin(Math.sin(incidence) / n);
    return Math.tan(incidence - refracted);
  });
  const max = Math.max(...raw);
  return raw.map((v) => v / max);
})();

const profile = (x: number) => {
  const f = Math.max(0, Math.min(1, x)) * 64;
  const i = Math.floor(f);
  const a = PROFILE[i] ?? 0;
  const b = PROFILE[Math.min(64, i + 1)] ?? 0;
  return a + (b - a) * (f - i);
};

/**
 * A displacement map for a rounded rectangle: red and green carry the x and y offset (128 = none). Inside the bezel
 * each pixel samples the backdrop further in, along the inward normal, so the content behind compresses toward the
 * rim like it does under a real glass edge; the flat middle passes the backdrop through untouched.
 */
function lensMap(
  width: number,
  height: number,
  radius: number,
  bezel: number,
  zoom: number,
  depth: number,
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.min(radius, w / 2, h / 2);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(w, h);
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - h / 2;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - w / 2;
      // signed distance to the rounded rectangle and its outward normal
      const qx = Math.abs(px) - hx;
      const qy = Math.abs(py) - hy;
      let d: number;
      let nx: number;
      let ny: number;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        d = len - r;
        nx = qx / len;
        ny = qy / len;
      } else if (qx > qy) {
        d = qx - r;
        nx = 1;
        ny = 0;
      } else {
        d = qy - r;
        nx = 0;
        ny = 1;
      }
      nx *= Math.sign(px) || 1;
      ny *= Math.sign(py) || 1;
      const m = d >= 0 ? 1 : -d < bezel ? profile(-d / bezel) : 0;
      // a magnifier samples toward the centre as well
      const vx = Math.max(-1, Math.min(1, -nx * m + (px * (1 / zoom - 1)) / depth));
      const vy = Math.max(-1, Math.min(1, -ny * m + (py * (1 / zoom - 1)) / depth));
      const o = (y * w + x) * 4;
      img.data[o] = 128 + vx * 127;
      img.data[o + 1] = 128 + vy * 127;
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

let supported: boolean | null = null;

/**
 * SVG filters in `backdrop-filter`: Chromium only, not when the system asks for less transparency, and not on touch
 * devices, where re-running the displacement for every glass surface on every scrolled frame cost a quarter of the
 * frames on a mid-range phone; they get the same glass without the bending.
 */
export function lensSupported(): boolean {
  if (supported !== null) return supported;
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  supported =
    /Chrome\/\d|Chromium\/\d/.test(ua) &&
    !/Firefox|FxiOS|CriOS|EdgiOS/.test(ua) &&
    !matchMedia("(prefers-reduced-transparency: reduce)").matches &&
    !matchMedia("(pointer: coarse)").matches;
  return supported;
}

interface LensOptions {
  /** width of the refracting rim, px */
  bezel?: number;
  /** how far the rim pulls the backdrop in at its edge, px */
  depth?: number;
  /** magnification of the flat middle; 1 passes it through */
  zoom?: number;
  /** turn the lens off without unmounting (e.g. while collapsed) */
  disabled?: boolean;
}

/**
 * Attaches rim refraction to an element styled `.fc-glass`: pass `ref`, spread `style` on it and render `defs`
 * anywhere inside it. The map follows the element's size and corner radius, and waits for the element to mount.
 */
export function useLens<T extends HTMLElement>({
  bezel = 22,
  depth = 18,
  zoom = 1,
  disabled = false,
}: LensOptions = {}): {
  ref: (node: T | null) => void;
  el: T | null;
  style: CSSProperties | undefined;
  defs: ReactNode;
} {
  const [el, setEl] = useState<T | null>(null);
  const id = `fc-lens-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [map, setMap] = useState<{ href: string; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!el || disabled || !lensSupported()) {
      setMap(null);
      return;
    }
    let frame = 0;
    let last = "";
    const build = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (!w || !h) return;
        const radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
        const key = `${w}x${h}r${radius}`;
        if (key === last) return;
        last = key;
        setMap({ href: lensMap(w, h, radius, Math.min(bezel, w / 2, h / 2), zoom, depth), w, h });
      });
    };
    const observer = new ResizeObserver(build);
    observer.observe(el);
    build();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [el, bezel, depth, zoom, disabled]);

  const on = map && !disabled;
  return {
    ref: setEl,
    el,
    style: on ? ({ "--lens": `url(#${id})` } as CSSProperties) : undefined,
    defs: on ? (
      <svg aria-hidden width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }}>
        <filter id={id} colorInterpolationFilters="sRGB">
          <feImage
            href={map.href}
            x="0"
            y="0"
            width={map.w}
            height={map.h}
            preserveAspectRatio="none"
            result="map"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={depth * 2}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
    ) : null,
  };
}

/**
 * The light the glass reflects. Its angle follows the pointer, or the phone's tilt, and every `.fc-glass` rim turns
 * its highlight toward it, easing there instead of jumping. The same listener lights the edge of `[data-spotlight]`
 * cards under a mouse, and marks where a `.fc-press` control was touched so its bloom starts under the finger.
 * Mount once.
 */
export function MaterialLight() {
  useEffect(() => {
    // on touch devices the light stays put: following the gyroscope repainted every rim many times a second
    const still = matchMedia("(pointer: coarse)").matches;
    const reduced = still || matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let current = 315; // top left, where interface light conventionally comes from
    let target = current;
    let spot: HTMLElement | null = null;
    let pressed: HTMLElement | null = null;

    // set on the few glass elements rather than the root, so a moving light restyles them and not the document
    const paint = () => {
      const delta = ((target - current + 540) % 360) - 180;
      current += Math.abs(delta) < 0.4 ? delta : delta * 0.14;
      for (const el of document.querySelectorAll<HTMLElement>(".fc-glass"))
        el.style.setProperty("--glass-light", `${current.toFixed(1)}deg`);
      frame = Math.abs(delta) < 0.4 ? 0 : requestAnimationFrame(paint);
    };
    const aim = (deg: number) => {
      target = deg;
      if (!frame && !reduced) frame = requestAnimationFrame(paint);
    };

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - innerWidth / 2;
      const dy = e.clientY - innerHeight * 0.4;
      if (Math.hypot(dx, dy) > 24) aim((Math.atan2(dy, dx) * 180) / Math.PI + 90);
      if (e.pointerType !== "mouse") return;
      const hit = (e.target as Element | null)?.closest?.("[data-spotlight]") as HTMLElement | null;
      if (spot && spot !== hit) spot.style.setProperty("--spot", "0");
      spot = hit;
      if (!hit) return;
      const r = hit.getBoundingClientRect();
      hit.style.setProperty("--mx", `${e.clientX - r.left}px`);
      hit.style.setProperty("--my", `${e.clientY - r.top}px`);
      hit.style.setProperty("--spot", "1");
    };
    const onLeave = () => {
      spot?.style.setProperty("--spot", "0");
      spot = null;
    };
    const onDown = (e: PointerEvent) => {
      const hit = (e.target as Element | null)?.closest?.(".fc-press") as HTMLElement | null;
      if (!hit || (hit as HTMLButtonElement).disabled) return;
      const r = hit.getBoundingClientRect();
      hit.style.setProperty("--px", `${e.clientX - r.left}px`);
      hit.style.setProperty("--py", `${e.clientY - r.top}px`);
      hit.dataset.pressed = "";
      pressed = hit;
    };
    const onUp = () => {
      if (pressed) delete pressed.dataset.pressed;
      pressed = null;
    };
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      // phone held upright, light above and to the left: rolling it swings the highlight around the rim
      const roll = Math.max(-45, Math.min(45, e.gamma));
      const pitch = Math.max(-30, Math.min(30, e.beta - 55));
      aim(315 + roll * 1.6 - pitch);
    };

    if (!still) addEventListener("pointermove", onMove, { passive: true });
    addEventListener("pointerdown", onDown, { passive: true });
    addEventListener("pointerup", onUp, { passive: true });
    addEventListener("pointercancel", onUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    if (!still) addEventListener("deviceorientation", onTilt, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerdown", onDown);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onUp);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      removeEventListener("deviceorientation", onTilt);
    };
  }, []);
  return null;
}

type Feel = "tick" | "confirm" | "reject" | "press";
const VIBRATE: Record<Feel, number | number[]> = {
  tick: 6,
  press: 10,
  confirm: [8, 40, 12],
  reject: [14, 50, 14],
};

/**
 * Haptic feedback: the native shell's haptics inside the app (tick, confirm, reject, press), a short vibration in a
 * browser that has one, nothing elsewhere.
 */
export function feel(kind: Feel) {
  const shell = (
    window as unknown as { FlowCarbonShell?: { feel?: (k: string) => void; haptic?: () => void } }
  ).FlowCarbonShell;
  if (shell?.feel) shell.feel(kind);
  else if (shell?.haptic) shell.haptic();
  else navigator.vibrate?.(VIBRATE[kind]);
}

/** A light tick under the finger, as a selection moves. */
export function tick() {
  feel("tick");
}

/**
 * The content layer under the glass when a page has little of its own: slow, soft fields of the brand colours.
 * Transforms only, so it stays on the compositor.
 */
export function Backdrop({ intense = false }: { intense?: boolean }) {
  return (
    <div aria-hidden className="fc-backdrop" data-intense={intense || undefined}>
      <span />
      <span />
      <span />
    </div>
  );
}
