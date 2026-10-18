"use client";

import { ArrowLeft, Download, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { encode } from "uqr";
import { Backdrop, useLens } from "@/components/glass";
import { LanguageSwitch } from "@/components/language-switch";
import { MarkTile } from "@/components/mark";
import { useI18n } from "@/lib/i18n";

const APK = "/download/FlowCarbon.apk";

/** What the server holds: the current APK's version and checksum (SHA256SUMS) and its size. */
function useRelease() {
  const [release, setRelease] = useState<{ version?: string; sha256?: string; mb?: string }>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sums = await (await fetch("/download/SHA256SUMS", { cache: "no-store" })).text();
        const [sha256, file] = sums.trim().split(/\s+/);
        const version = /FlowCarbon-(\d+\.\d+\.\d+)\.apk/.exec(file ?? "")?.[1];
        const head = await fetch(APK, { method: "HEAD", cache: "no-store" });
        const bytes = Number(head.headers.get("content-length"));
        if (alive) setRelease({ version, sha256, mb: bytes ? (bytes / 1_048_576).toFixed(1) : undefined });
      } catch {
        // served without the download folder (development): the button still works where the file exists
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return release;
}

/** A QR code as one path, so a phone can pick up the download from a desktop screen. */
function Qr({ value }: { value: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 1 });
  const d = data
    .flatMap((row, y) => row.map((on, x) => (on ? `M${x + 0.05},${y + 0.05}h0.9v0.9h-0.9z` : "")))
    .join("");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-full" role="img" aria-label={value}>
      <rect width={size} height={size} rx={1.6} fill="#fff" />
      <path d={d} fill="#0b2a27" />
    </svg>
  );
}

export default function AndroidApp() {
  const { t } = useI18n();
  const release = useRelease();
  const card = useLens<HTMLDivElement>({ bezel: 28, depth: 22 });
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(location.origin), []);
  const d = t.download;

  return (
    <main className="relative min-h-dvh px-5 pt-[calc(var(--app-top)+20px)] pb-12 sm:px-8">
      <Backdrop intense />
      <div className="mx-auto flex max-w-4xl items-center gap-3">
        <Link
          href="/"
          className="fc-press -ml-2 inline-flex items-center gap-1 rounded-full py-1 pr-3 pl-2 text-sm font-medium text-accent"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {d.back}
        </Link>
        <LanguageSwitch className="ml-auto" />
      </div>

      <div className="mx-auto mt-10 grid max-w-4xl items-center gap-10 lg:mt-16 lg:grid-cols-[1fr_320px]">
        <section className="fc-rise">
          <MarkTile className="size-[72px] rounded-[22px]" motion="settle" />
          <h1 className="mt-6 text-[34px] leading-tight font-bold tracking-tight text-balance sm:text-[42px]">
            {d.title}
          </h1>
          <p className="mt-3 max-w-lg text-[15px] text-muted text-pretty">{d.sub}</p>
          <a
            href={APK}
            download
            className="fc-prominent fc-press mt-7 inline-flex h-[52px] items-center gap-2.5 rounded-full px-6 text-[15px] font-semibold"
          >
            <Download className="size-[18px]" aria-hidden />
            {d.button}
          </a>
          <p className="mt-3 text-xs text-muted">
            {[
              release.version && d.version.replace("{v}", release.version),
              release.mb && `${release.mb} MB`,
              d.requires,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>

          <h2 className="mt-10 text-sm font-semibold">{d.steps}</h2>
          <ol className="mt-3 space-y-3">
            {[d.step1, d.step2, d.step3].map((s, i) => (
              <li key={s} className="flex gap-3 text-sm">
                <span className="num grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                  {i + 1}
                </span>
                <span className="text-pretty">{s}</span>
              </li>
            ))}
          </ol>
          {release.sha256 ? (
            <p className="mt-8 flex items-start gap-2 text-xs text-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="selectable min-w-0 break-all">
                SHA-256 <code className="font-mono">{release.sha256}</code>
              </span>
            </p>
          ) : null}
        </section>

        {/* a desktop visitor scans this with the phone that will run the app */}
        <div
          ref={card.ref}
          style={card.style}
          className="fc-glass fc-condense hidden rounded-[32px] p-6 [animation-delay:200ms] lg:block"
        >
          {card.defs}
          <div className="aspect-square w-full overflow-hidden rounded-2xl bg-white p-2 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)]">
            {origin ? <Qr value={`${origin}${APK}`} /> : null}
          </div>
          <p className="mt-4 text-center text-sm font-medium">{d.scan}</p>
        </div>
      </div>
    </main>
  );
}
