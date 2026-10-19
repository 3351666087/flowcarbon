"use client";

/**
 * The Android app around the page: what it can do for the page (window.FlowCarbonShell) and what it tells the page
 * back (window.fcShell), so that downloads, updates and permission requests show in the page's own interface.
 */

export type UpdateState = "permission" | "denied" | "downloading" | "confirm" | "cancelled" | "failed";
export type DownloadState = "started" | "saved" | "failed" | "noapp" | "denied";

export type ShellMessage =
  | { type: "update"; state: UpdateState; progress?: number; detail?: string }
  | { type: "download"; state: DownloadState; name?: string; canOpen?: boolean };

interface Shell {
  install?: (url: string) => void;
  openDownload?: () => void;
  openExternal?: (url: string) => void;
}

const listeners = new Set<(m: ShellMessage) => void>();

if (typeof window !== "undefined")
  (window as unknown as { fcShell?: (m: ShellMessage) => void }).fcShell = (m) => {
    for (const l of listeners) l(m);
  };

export function onShell(listener: (m: ShellMessage) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function shell(): Shell | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as { FlowCarbonShell?: Shell }).FlowCarbonShell;
}

/** the Android app's own version, which it puts in its user agent */
export const shellVersion = () =>
  typeof navigator === "undefined"
    ? null
    : (/FlowCarbonAndroid\/(\d+\.\d+\.\d+)/.exec(navigator.userAgent)?.[1] ?? null);

/** a is a later version than b */
export const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** from this version the app fetches updates itself and reports each step (see Updater.java) */
export const REPORTING_SHELL = "0.1.17";
export const shellReports = () => {
  const v = shellVersion();
  return !!v && !newer(REPORTING_SHELL, v);
};
