/**
 * Text size and accent colour, chosen in the account menu and kept on this device. Like the theme, both are data
 * attributes on <html> (`data-text-size`, `data-accent`) that globals.css turns into tokens, and both are applied
 * before the first paint by the root layout.
 */
export const TEXT_SIZES = ["small", "default", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** teal is FlowCarbon's own. No amber or red: those mean waste and danger here */
export const ACCENTS = ["teal", "blue", "green", "violet", "rose"] as const;
export type Accent = (typeof ACCENTS)[number];

export const TEXT_SIZE_KEY = "flowcarbon.textSize";
export const ACCENT_KEY = "flowcarbon.accent";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string, fallback: string) {
  try {
    if (value === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice lasts this visit
  }
}

export const readTextSize = () => read<TextSize>(TEXT_SIZE_KEY, TEXT_SIZES, "default");
export const readAccent = () => read<Accent>(ACCENT_KEY, ACCENTS, "teal");

export function applyTextSize(size: TextSize) {
  const root = document.documentElement;
  if (size === "default") delete root.dataset.textSize;
  else root.dataset.textSize = size;
  save(TEXT_SIZE_KEY, size, "default");
}

export function applyAccent(accent: Accent) {
  const root = document.documentElement;
  const apply = () => {
    if (accent === "teal") delete root.dataset.accent;
    else root.dataset.accent = accent;
    // the 3D tower reads its colours when <html>'s class changes; nudge it so it repaints in the new accent
    root.classList.add("fc-accent-changed");
    requestAnimationFrame(() => root.classList.remove("fc-accent-changed"));
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && typeof document.startViewTransition === "function") document.startViewTransition(apply);
  else apply();
  save(ACCENT_KEY, accent, "teal");
}

/** Runs in <head> before the first paint, next to the theme's script. */
export const APPEARANCE_SCRIPT = `try{var d=document.documentElement,s=localStorage.getItem("${TEXT_SIZE_KEY}"),a=localStorage.getItem("${ACCENT_KEY}");if(s==="small"||s==="large")d.dataset.textSize=s;if(${JSON.stringify(ACCENTS.filter((x) => x !== "teal"))}.indexOf(a)>=0)d.dataset.accent=a}catch(e){}`;
