"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { tick } from "@/components/glass";
import { useI18n } from "@/lib/i18n";
import { useIds } from "@/lib/session";

/** The strategies, the opportunities behind them and the measures agreed for them, side by side under one tab. */
export function FindingsTabs({ active }: { active: "strategies" | "findings" | "measures" }) {
  const { t } = useI18n();
  const { orgId, buildingId } = useIds();
  const base = `/o/${orgId}/b/${buildingId}`;
  const labels = {
    strategies: t.strategies.title,
    findings: t.findings.tabFindings,
    measures: t.findings.tabMeasures,
  };
  return (
    <nav className="mb-4 inline-flex rounded-full bg-surface-2 p-1" aria-label={t.strategies.title}>
      {(["strategies", "findings", "measures"] as const).map((k) => (
        <Link
          key={k}
          href={`${base}/${k}`}
          onClick={() => k !== active && tick()}
          aria-current={k === active ? "page" : undefined}
          className={clsx(
            "fc-press inline-flex min-h-11 items-center rounded-full px-3.5 text-sm font-medium sm:min-h-9 sm:px-4",
            k === active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {labels[k]}
        </Link>
      ))}
    </nav>
  );
}
