"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthMethods } from "@/components/auth-code";
import { api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { can, useMembership } from "@/lib/session";

/** Gets (or makes) the person's own demo building and goes there; it may still be being built. */
export function useOwnDemo() {
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const org = await unwrap(api.POST("/api/v1/orgs/demo"));
      // the new organisation has to be among the memberships before the start page picks it
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.push(`/?org=${org.id}`);
    } finally {
      setBusy(false);
    }
  };
  return { start, busy };
}

/**
 * In the shared demonstration, which everyone sees read-only, a quiet line offering a demo building of one's own,
 * where the findings can be handled and measures adopted.
 */
export function DemoBanner() {
  const { t } = useI18n();
  const methods = useAuthMethods();
  const membership = useMembership();
  const own = useOwnDemo();
  const shared = !!methods.data?.demo && membership?.orgSlug === methods.data.demo.slug;
  if (!shared || can.reviewFindings(membership?.role)) return null;
  return (
    <div className="fc-glass mb-4 flex items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-sm">
      <span className="min-w-0 flex-1 truncate text-muted">{t.demo.shared}</span>
      <button
        type="button"
        disabled={own.busy}
        onClick={own.start}
        className="fc-press fc-prominent shrink-0 rounded-full px-3.5 py-1.5 font-semibold disabled:opacity-60"
      >
        {t.demo.getOwn}
      </button>
    </div>
  );
}
