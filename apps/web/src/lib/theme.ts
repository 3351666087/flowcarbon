/** Light, dark, or whatever the system says. The choice is applied before first paint by the root layout. */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "flowcarbon.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Applies a theme with the same dissolve as a language switch. */
export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  const apply = () => {
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && typeof document.startViewTransition === "function") document.startViewTransition(apply);
  else apply();
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage unavailable: the choice lasts this visit
  }
}

/**
 * Runs in <head> before the first paint: the saved theme, and whether this page is inside the FlowCarbon app (the
 * Android shell), so app-only styling never flashes.
 */
export const EARLY_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;if(/FlowCarbonAndroid\\//.test(navigator.userAgent))document.documentElement.dataset.app=""}catch(e){}`;
