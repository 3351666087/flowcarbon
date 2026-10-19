"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { feel } from "@/components/glass";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { fill, useI18n } from "@/lib/i18n";
import { newer, onShell, type ShellMessage, shell, shellReports, shellVersion } from "@/lib/shell";

/** the release this page was loaded from */
const LOADED = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
/** how long the page must have been out of sight before a newer release reloads it without asking */
const AWAY_MS = 30_000;
const CHECK_MS = 15 * 60_000;
const SNOOZE_MS = 3 * 86_400_000;
const SNOOZE_KEY = "fc-app-update-snoozed";
/** an older app reports nothing back: after this long without a sign of the download, offer the browser instead */
const STALL_MS = 8_000;

type Phase =
  | { kind: "offer" }
  | { kind: "starting" }
  | { kind: "permission" }
  | { kind: "denied" }
  | { kind: "downloading"; progress: number }
  | { kind: "confirm" }
  | { kind: "cancelled" }
  | { kind: "failed"; detail?: string }
  | { kind: "stalled" };

/**
 * Keeps people on the current release. A page left open across a deploy reloads itself when it comes back into view
 * (or offers to, if it stayed in view). Inside the Android app, an app older than the published APK offers the update:
 * from 0.1.17 the app asks Android for the permission it needs, fetches the APK itself and reports each step here;
 * older apps get the download link for the browser if nothing happens. Files the app saves to Downloads are announced
 * here too, since some Android builds hide the app's own toasts.
 */
export function Updates() {
  const { t } = useI18n();
  const hiddenAt = useRef<number | null>(null);
  const offered = useRef(false);
  const [apk, setApk] = useState<{ version: string; mb?: string } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "offer" });
  const stall = useRef<ReturnType<typeof setTimeout> | null>(null);

  // what the app reports: the update's steps, and files saved to Downloads
  useEffect(
    () =>
      onShell((m: ShellMessage) => {
        if (m.type === "update") {
          if (stall.current) clearTimeout(stall.current);
          stall.current = null;
          if (m.state === "downloading") setPhase({ kind: "downloading", progress: m.progress ?? 0 });
          else if (m.state === "failed") setPhase({ kind: "failed", detail: m.detail });
          else setPhase({ kind: m.state });
          if (m.state === "failed" || m.state === "denied") feel("reject");
          return;
        }
        const u = t.update;
        const name = m.name ?? "";
        if (m.state === "started") toast(fill(u.saveStarted, { name }));
        else if (m.state === "saved")
          toast(
            fill(u.saved, { name }),
            m.canOpen ? { label: u.open, run: () => shell()?.openDownload?.() } : undefined,
          );
        else if (m.state === "failed") toast(fill(u.saveFailed, { name }));
        else if (m.state === "noapp") toast(u.noApp);
        else if (m.state === "denied") toast(u.storageDenied);
      }),
    [t],
  );
  useEffect(
    () => () => {
      if (stall.current) clearTimeout(stall.current);
    },
    [],
  );

  // a newer web release
  useEffect(() => {
    let alive = true;
    const check = async (resumed: boolean) => {
      try {
        const r = await fetch("/app-version", { cache: "no-store" });
        const { version } = (await r.json()) as { version: string };
        if (!alive || !newer(version, LOADED)) return;
        if (resumed) location.reload();
        else if (!offered.current) {
          offered.current = true;
          toast(fill(t.update.webReady, { version }), {
            label: t.update.reload,
            run: () => location.reload(),
          });
        }
      } catch {
        // offline or between deploys: try again later
      }
    };
    const onVisibility = () => {
      if (document.hidden) hiddenAt.current = Date.now();
      else {
        const away = hiddenAt.current !== null && Date.now() - hiddenAt.current > AWAY_MS;
        hiddenAt.current = null;
        check(away);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const id = setInterval(() => !document.hidden && check(false), CHECK_MS);
    check(false);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(id);
    };
  }, [t]);

  // a newer Android app
  useEffect(() => {
    const installed = shellVersion();
    if (!installed) return;
    (async () => {
      try {
        const sums = await (await fetch("/download/SHA256SUMS", { cache: "no-store" })).text();
        const latest = /FlowCarbon-(\d+\.\d+\.\d+)\.apk/.exec(sums)?.[1];
        if (!latest || !newer(latest, installed)) return;
        let snoozed: { version: string; at: number } | null = null;
        try {
          snoozed = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "null");
        } catch {
          // storage unavailable: offer it every time
        }
        if (snoozed?.version === latest && Date.now() - snoozed.at < SNOOZE_MS) return;
        const head = await fetch(`/download/FlowCarbon-${latest}.apk`, { method: "HEAD", cache: "no-store" });
        const bytes = Number(head.headers.get("content-length"));
        setApk({ version: latest, mb: bytes ? (bytes / 1_048_576).toFixed(1) : undefined });
      } catch {
        // no download folder here (development)
      }
    })();
  }, []);

  if (!apk) return null;
  const u = t.update;
  const url = `${typeof location === "undefined" ? "" : location.origin}/download/FlowCarbon-${apk.version}.apk`;
  const close = () => {
    setApk(null);
    setPhase({ kind: "offer" });
  };
  const install = () => {
    feel("press");
    const app = shell();
    if (!app?.install) {
      // not inside the app (or one from before 0.1.8): the download lands in Downloads
      location.href = url;
      toast(u.downloading);
      close();
      return;
    }
    setPhase({ kind: "starting" });
    app.install(url);
    if (!shellReports())
      stall.current = setTimeout(
        () => setPhase((p) => (p.kind === "starting" ? { kind: "stalled" } : p)),
        STALL_MS,
      );
  };
  const browser = () => {
    const app = shell();
    if (app?.openExternal) app.openExternal(url);
    else
      navigator.clipboard?.writeText(url).then(
        () => toast(t.common.copied),
        () => {},
      );
  };
  const busy = phase.kind === "starting" || phase.kind === "downloading" || phase.kind === "confirm";
  const percent = phase.kind === "downloading" ? Math.round(phase.progress * 100) : 0;

  return (
    <Sheet title={phase.kind === "permission" ? u.permissionTitle : u.appTitle} onClose={close}>
      {(dismiss) => (
        <>
          <div className="flex items-center gap-3">
            <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
              <Download className="size-6" aria-hidden />
            </span>
            <div>
              <p className="font-semibold">FlowCarbon {apk.version}</p>
              <p className="text-sm text-muted">
                {fill(u.appFrom, { installed: shellVersion() ?? "" })}
                {apk.mb ? ` · ${apk.mb} MB` : ""}
              </p>
            </div>
          </div>

          <div className="mt-4 text-sm" aria-live="polite">
            {phase.kind === "offer" ? <p className="text-muted">{u.appHint}</p> : null}
            {phase.kind === "starting" || phase.kind === "downloading" ? (
              <>
                <p>{fill(u.fetching, { percent: phase.kind === "downloading" ? `${percent} %` : "" })}</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={
                      phase.kind === "starting"
                        ? "fc-skel h-full w-full"
                        : "h-full bg-accent transition-[width]"
                    }
                    style={phase.kind === "downloading" ? { width: `${Math.max(4, percent)}%` } : undefined}
                  />
                </div>
              </>
            ) : null}
            {phase.kind === "permission" ? <p>{u.permissionBody}</p> : null}
            {phase.kind === "denied" ? <p className="text-danger">{u.denied}</p> : null}
            {phase.kind === "confirm" ? <p>{u.confirm}</p> : null}
            {phase.kind === "cancelled" ? <p className="text-muted">{u.cancelled}</p> : null}
            {phase.kind === "failed" ? (
              <p className="text-danger">
                {u.failed}
                {phase.detail ? <span className="mt-1 block text-xs text-muted">{phase.detail}</span> : null}
              </p>
            ) : null}
            {phase.kind === "stalled" ? (
              <>
                <p>{u.stalled}</p>
                <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs break-all select-all">
                  {url}
                </p>
              </>
            ) : null}
          </div>

          <div className="mt-5 flex flex-col gap-2">
            {phase.kind === "offer" ? (
              <Button variant="primary" className="w-full justify-center" onClick={install}>
                {u.install}
              </Button>
            ) : null}
            {phase.kind === "denied" || phase.kind === "cancelled" || phase.kind === "failed" ? (
              <>
                <Button variant="primary" className="w-full justify-center" onClick={install}>
                  {t.common.retry}
                </Button>
                <Button variant="secondary" className="w-full justify-center" onClick={browser}>
                  {u.browser}
                </Button>
              </>
            ) : null}
            {phase.kind === "stalled" ? (
              <Button variant="primary" className="w-full justify-center" onClick={browser}>
                {u.copyLink}
              </Button>
            ) : null}
            {!busy ? (
              <Button
                variant="ghost"
                className="w-full justify-center"
                onClick={() => {
                  if (phase.kind === "offer")
                    try {
                      localStorage.setItem(
                        SNOOZE_KEY,
                        JSON.stringify({ version: apk.version, at: Date.now() }),
                      );
                    } catch {
                      // storage unavailable
                    }
                  dismiss();
                }}
              >
                {phase.kind === "offer" ? u.later : t.common.close}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Sheet>
  );
}
