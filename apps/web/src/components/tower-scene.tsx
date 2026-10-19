"use client";

import { useEffect, useRef } from "react";

/**
 * The sign-in scene: a twelve-floor office tower in isometric view, alive the way FlowCarbon sees a building.
 * Floors stack in from the ground, their windows glow with the people on them, and now and then one floor glows
 * amber — cooled while empty, leaking energy — until a teal scan sweeps across and fixes it. The tower itself
 * stands still: the mouse wheel steps a highlight up and down its floors, and a tap sends a pulse of light up them.
 * Canvas 2D only, paused off screen, one still frame for reduced motion. Where the tower stands in the canvas and
 * how large it is come from CSS (--tower-x, --tower-y as fractions, --tower-scale), so layouts can place it per
 * breakpoint — for instance with its lower floors running on behind a glass sheet.
 */

const FLOORS = 12;
const WINDOWS = 7;

interface Floor {
  occ: number;
  target: number;
  waste: number;
  fix: number;
  pulseAt: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  amber: boolean;
}

interface Palette {
  accent: string;
  waste: string;
  slab: string;
  edge: string;
  dark: boolean;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  const dark = s.getPropertyValue("color-scheme").includes("dark");
  return {
    accent: v("--accent", "#3cc7b6"),
    waste: v("--waste", "#f2a33a"),
    slab: v("--surface", "#151a22"),
    edge: v("--border", "#283039"),
    dark,
  };
}

const easeOut = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/** A real floor for the live view: how full it is (0–1) and whether it is cooled or lit with nobody there. */
export interface LiveFloor {
  occ: number;
  waste: boolean;
}

/**
 * Without `live` the tower tells FlowCarbon's story by itself (the sign-in stage). With `live` (floors bottom to top)
 * it is the building as it is now: each floor glows with its people and turns amber while it wastes, and tapping a
 * floor (or turning the mouse wheel over the tower) calls `onPick` with its index; `picked` lifts that floor.
 * `reserveBottom` (px) keeps the tower clear of something laid over the bottom of the scene, such as a floor card.
 */
export function TowerScene({
  className,
  live,
  onPick,
  picked = null,
  reserveBottom = 0,
}: {
  className?: string;
  live?: LiveFloor[];
  onPick?: (index: number) => void;
  picked?: number | null;
  reserveBottom?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const reserveRef = useRef(reserveBottom);
  reserveRef.current = reserveBottom;
  const count = live?.length || FLOORS;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let palette = readPalette();
    let width = 0;
    let height = 0;
    let dpr = 1;
    let place = { x: 0.5, y: 0.5, scale: 1 };
    const floors: Floor[] = Array.from({ length: count }, (_, i) => ({
      occ: 0.15 + ((i * 37) % 11) / 14,
      target: Math.random(),
      waste: 0,
      fix: 0,
      pulseAt: -1,
    }));
    const particles: Particle[] = [];
    // room kept free under the tower, eased so the tower glides up when a card appears
    let reserve = reserveRef.current;
    // the floor the wheel has reached on the sign-in stage, where there is nothing to pick
    let storyFocus: number | null = null;
    let wheel = 0;
    let wasteFloor = -1;
    let nextWasteAt = 2600;
    let wasteStartedAt = 0;
    let lastSpawn = 0;
    let raf = 0;
    let running = false;
    let visible = true;
    const t0 = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      const css = getComputedStyle(canvas);
      const num = (name: string, fallback: number) =>
        Number.parseFloat(css.getPropertyValue(name)) || fallback;
      place = { x: num("--tower-x", 0.5), y: num("--tower-y", 0.5), scale: num("--tower-scale", 1) };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced) draw(performance.now());
    };

    // geometry of floor i: top-face corners plus slab thickness, in the room above `reserve`
    const geometry = (i: number) => {
      const room = Math.max(height * 0.45, height - reserve);
      const a = Math.min(width * 0.3, room * 0.34) * place.scale;
      const b = a * 0.5;
      // taller buildings stack tighter, so any number of floors fits the same frame
      const fit = Math.min(1, 12 / count);
      const gap = a * 0.165 * fit;
      const thick = a * 0.065 * Math.sqrt(fit);
      const total = (count - 1) * gap + thick;
      const cx = width * place.x;
      const baseY = room * place.y + total / 2 + b * 0.4;
      const y = baseY - i * gap - thick;
      return { x: cx, y, left: a, right: a, b, thick };
    };
    const focused = () => (pickRef.current ? pickedRef.current : storyFocus);

    const draw = (now: number) => {
      const t = reduced ? 1e6 : now - t0;
      ctx.clearRect(0, 0, width, height);
      const accent = palette.accent;

      for (let i = 0; i < count; i++) {
        const f = floors[i]!;
        const arrive = reduced ? 1 : easeOut(Math.max(0, (t - 120 - i * 85) / 750));
        if (arrive <= 0) continue;
        const g = geometry(i);
        const drop = (1 - arrive) * -26;
        const chosen = focused() === i;
        const x = g.x;
        const y = g.y + drop - (chosen ? Math.min(8, g.b * 0.3) : 0);
        const L = [x - g.left, y] as const;
        const T = [x, y - g.b] as const;
        const R = [x + g.right, y] as const;
        const B = [x, y + g.b] as const;
        const pulse = f.pulseAt >= 0 ? Math.max(0, 1 - (now - f.pulseAt) / 700) : 0;
        ctx.globalAlpha = arrive;

        // side faces
        ctx.beginPath();
        ctx.moveTo(L[0], L[1]);
        ctx.lineTo(B[0], B[1]);
        ctx.lineTo(B[0], B[1] + g.thick);
        ctx.lineTo(L[0], L[1] + g.thick);
        ctx.closePath();
        ctx.fillStyle = palette.dark ? "rgb(10 14 19 / 0.92)" : "rgb(222 230 236 / 0.95)";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(B[0], B[1]);
        ctx.lineTo(R[0], R[1]);
        ctx.lineTo(R[0], R[1] + g.thick);
        ctx.lineTo(B[0], B[1] + g.thick);
        ctx.closePath();
        ctx.fillStyle = palette.dark ? "rgb(18 24 31 / 0.92)" : "rgb(236 241 245 / 0.95)";
        ctx.fill();

        // top face
        ctx.beginPath();
        ctx.moveTo(L[0], L[1]);
        ctx.lineTo(T[0], T[1]);
        ctx.lineTo(R[0], R[1]);
        ctx.lineTo(B[0], B[1]);
        ctx.closePath();
        ctx.fillStyle = palette.slab;
        ctx.fill();
        if (chosen) {
          ctx.globalAlpha = arrive * 0.22;
          ctx.fillStyle = f.waste > 0.02 ? palette.waste : accent;
          ctx.fill();
        }
        const edgeGlow = chosen ? 1 : 0.28 + f.occ * 0.35 + pulse * 0.6;
        ctx.strokeStyle = f.waste > 0.02 ? palette.waste : accent;
        ctx.globalAlpha = arrive * Math.min(1, edgeGlow);
        ctx.lineWidth = chosen ? 1.8 : 1;
        ctx.stroke();

        // windows along both side faces: teal with people, amber when cooled while empty
        const lit = f.waste > 0.02 ? f.waste : f.occ;
        for (let k = 0; k < WINDOWS; k++) {
          const s = (k + 0.5) / WINDOWS;
          const on = (Math.sin(k * 12.9898 + i * 78.233) * 43758.5453) % 1;
          const bright = Math.max(0, Math.min(1, lit * 1.3 - Math.abs(on) * 0.6)) + pulse;
          if (bright < 0.05) continue;
          ctx.globalAlpha = arrive * Math.min(1, bright);
          ctx.fillStyle = f.waste > 0.02 ? palette.waste : accent;
          const lx = L[0] + (B[0] - L[0]) * s;
          const ly = L[1] + (B[1] - L[1]) * s + g.thick * 0.3;
          ctx.fillRect(lx - 1.6, ly, 3.2, g.thick * 0.45);
          const rx = B[0] + (R[0] - B[0]) * s;
          const ry = B[1] + (R[1] - B[1]) * s + g.thick * 0.3;
          ctx.fillRect(rx - 1.6, ry, 3.2, g.thick * 0.45);
        }

        // the fix: a teal scan across the top face
        if (f.fix > 0 && f.fix < 1) {
          const sx = L[0] + (R[0] - L[0]) * f.fix;
          const grad = ctx.createLinearGradient(sx - 40, 0, sx + 6, 0);
          grad.addColorStop(0, "transparent");
          grad.addColorStop(1, accent);
          ctx.globalAlpha = arrive * 0.9;
          ctx.strokeStyle = grad;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx, y - g.b * 0.9);
          ctx.lineTo(sx, y + g.b * 0.9);
          ctx.stroke();
        }
      }

      // energy rising along the tower; amber leaking from a wasting floor
      for (const p of particles) {
        const age = (now - p.born) / p.life;
        if (age >= 1) continue;
        ctx.globalAlpha = Math.sin(Math.PI * age) * (p.amber ? 0.9 : 0.7);
        ctx.fillStyle = p.amber ? palette.waste : accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.amber ? 1.6 : 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      const t = now - t0;
      reserve += (reserveRef.current - reserve) * 0.14;

      const data = liveRef.current;
      if (data) {
        // the real building: each floor eases toward what it is doing now
        floors.forEach((f, i) => {
          const d = data[i];
          f.target = d?.occ ?? 0;
          f.occ += (f.target - f.occ) * 0.06;
          f.waste += ((d?.waste ? 1 : 0) - f.waste) * 0.06;
        });
      } else {
        // occupancy drifts toward targets that change every few seconds
        for (const f of floors) {
          if (Math.random() < 0.004) f.target = Math.random() ** 1.4;
          f.occ += (f.target - f.occ) * 0.012;
        }
      }

      // the waste story (sign-in stage only): a quiet floor starts cooling for nobody, then gets fixed
      if (!data && wasteFloor < 0 && t > nextWasteAt) {
        let quietest = 0;
        for (let i = 1; i < count; i++) if (floors[i]!.occ < floors[quietest]!.occ) quietest = i;
        wasteFloor = quietest;
        wasteStartedAt = t;
        floors[quietest]!.target = 0;
      }
      if (wasteFloor >= 0) {
        const f = floors[wasteFloor]!;
        const age = t - wasteStartedAt;
        if (age < 2600) f.waste = Math.min(1, f.waste + 0.03);
        else if (age < 3500) {
          f.fix = (age - 2600) / 900;
          f.waste = Math.max(0, 1 - f.fix * 1.2);
        } else {
          f.fix = 0;
          f.waste = 0;
          wasteFloor = -1;
          nextWasteAt = t + 3500 + Math.random() * 2500;
        }
      }

      // particles
      if (now - lastSpawn > (data ? 140 : 70) && particles.length < (data ? 36 : 70) && t > 900) {
        lastSpawn = now;
        const i = Math.floor(Math.random() * count);
        const g = geometry(i);
        const side = Math.random() < 0.5 ? -g.left : g.right;
        particles.push({
          x: g.x + side * (0.6 + Math.random() * 0.4),
          y: g.y + g.thick,
          vx: (Math.random() - 0.5) * 0.004,
          vy: -(0.012 + Math.random() * 0.02),
          born: now,
          life: 1600 + Math.random() * 1400,
          amber: false,
        });
        // amber leaks from a wasting floor: the story's one, or any real one wasting now
        const wasting = data
          ? floors.flatMap((f, k) => (f.waste > 0.5 ? [k] : []))
          : wasteFloor >= 0 && floors[wasteFloor]!.waste > 0.5
            ? [wasteFloor]
            : [];
        if (wasting.length) {
          const w = geometry(wasting[Math.floor(Math.random() * wasting.length)]!);
          const dir = Math.random() < 0.5 ? -1 : 1;
          particles.push({
            x: w.x + dir * (dir < 0 ? w.left : w.right) * 0.95,
            y: w.y + w.thick * 0.5,
            vx: dir * (0.02 + Math.random() * 0.02),
            vy: -(0.004 + Math.random() * 0.01),
            born: now,
            life: 1200 + Math.random() * 800,
            amber: true,
          });
        }
      }
      for (let k = particles.length - 1; k >= 0; k--) {
        const p = particles[k]!;
        if (now - p.born > p.life) {
          particles.splice(k, 1);
          continue;
        }
        p.x += p.vx * 16;
        p.y += p.vy * 16;
      }

      draw(now);
      raf = running ? requestAnimationFrame(step) : 0;
    };

    const start = () => {
      if (reduced || running || !visible || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(step);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onPointerDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const now = performance.now();
      const pick = pickRef.current;
      if (pick) {
        // the floor at the height of the finger, within the tower's width
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < count; i++) {
          const g = geometry(i);
          if (Math.abs(px - g.x) > Math.max(g.left, g.right)) continue;
          const distance = Math.abs(py - (g.y + g.b * 0.5));
          if (distance < bestDistance) {
            best = i;
            bestDistance = distance;
          }
        }
        if (best >= 0) {
          floors[best]!.pulseAt = now;
          pick(best);
        }
        return;
      }
      floors.forEach((f, i) => {
        f.pulseAt = now + i * 45;
      });
    };
    // the wheel over the tower walks the highlight from floor to floor; past the top or bottom floor the page
    // scrolls as usual
    const onWheel = (e: WheelEvent) => {
      const current = focused();
      const down = e.deltaY > 0;
      const next = current === null ? (down ? count - 1 : 0) : current + (down ? -1 : 1);
      if (current !== null && (next < 0 || next >= count)) return;
      e.preventDefault();
      wheel += e.deltaY;
      // a mouse notch moves one floor at once; a trackpad has to travel a little first
      if (current !== null && Math.abs(wheel) < 40 && Math.abs(e.deltaY) < 40) return;
      wheel = 0;
      floors[next]!.pulseAt = performance.now();
      const pick = pickRef.current;
      if (pick) pick(next);
      else storyFocus = next;
      if (reduced) draw(performance.now());
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onTheme = () => {
      palette = readPalette();
      if (reduced) draw(performance.now());
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      if (visible) start();
      else stop();
    });
    intersection.observe(canvas);
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", onTheme);
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      scheme.removeEventListener("change", onTheme);
      window.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [count]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
