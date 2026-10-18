"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { tick } from "@/components/glass";
import { useI18n } from "@/lib/i18n";
import { useIds } from "@/lib/session";

/** Opportunities and the measures agreed for them, side by side under one tab. */
export function FindingsTabs({ active }: { active: "findings" | "measures" }) {
  const { t } = useI18n();
  const { orgId, buildingId } = useIds();
  const base = `/o/${orgId}/b/${buildingId}`;
  return (
    <nav className="mb-4 inline-flex rounded-full bg-surface-2 p-1" aria-label={t.findings.title}>
      {(["findings", "measures"] as const).map((k) => (
        <Link
          key={k}
          href={`${base}/${k}`}
          onClick={() => k !== active && tick()}
          aria-current={k === active ? "page" : undefined}
          className={clsx(
            "fc-press rounded-full px-4 py-1.5 text-sm font-medium",
            k === active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {k === "findings" ? t.findings.tabFindings : t.findings.tabMeasures}
        </Link>
      ))}
    </nav>
  );
}
