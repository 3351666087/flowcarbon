"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { feel } from "@/components/glass";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { fill, useI18n } from "@/lib/i18n";

/** the release this page was loaded from */
const LOADED = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
/** how long the page must have been out of sight before a newer release reloads it without asking */
const AWAY_MS = 30_000;
const CHECK_MS = 15 * 60_000;
const SNOOZE_MS = 3 * 86_400_000;
const SNOOZE_KEY = "fc-app-update-snoozed";

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** the Android app's own version, which it puts in its user agent */
const shellVersion = () => /FlowCarbonAndroid\/(\d+\.\d+\.\d+)/.exec(navigator.userAgent)?.[1] ?? null;

interface Shell {
  install?: (url: string) => void;
}

/**
 * Keeps people on the current release. A page left open across a deploy reloads itself when it comes back into view
 * (or offers to, if it stayed in view); inside the Android app, an app older than the published APK offers the update
 * and installs it in place where the app can (from 0.1.8), or downloads it otherwise.
 */
export function Updates() {
  const { t } = useI18n();
  const hiddenAt = useRef<number | null>(null);
  const offered = useRef(false);
  const [apk, setApk] = useState<{ version: string; mb?: string } | null>(null);

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
  const close = () => setApk(null);
  return (
    <Sheet title={t.update.appTitle} onClose={close}>
      {(dismiss) => (
        <>
          <div className="flex items-center gap-3">
            <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
              <Download className="size-6" aria-hidden />
            </span>
            <div>
              <p className="font-semibold">FlowCarbon {apk.version}</p>
              <p className="text-sm text-muted">
                {fill(t.update.appFrom, { installed: shellVersion() ?? "" })}
                {apk.mb ? ` · ${apk.mb} MB` : ""}
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm text-muted">{t.update.appHint}</p>
          <div className="mt-5 flex flex-col gap-2">
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={() => {
                feel("press");
                const url = `${location.origin}/download/FlowCarbon-${apk.version}.apk`;
                const shell = (window as unknown as { FlowCarbonShell?: Shell }).FlowCarbonShell;
                if (shell?.install) shell.install(url);
                else {
                  // older apps: the download lands in Downloads, and its notification installs it
                  location.href = url;
                  toast(t.update.downloading);
                }
                dismiss();
              }}
            >
              {t.update.install}
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-center"
              onClick={() => {
                try {
                  localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version: apk.version, at: Date.now() }));
                } catch {
                  // storage unavailable
                }
                dismiss();
              }}
            >
              {t.update.later}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
