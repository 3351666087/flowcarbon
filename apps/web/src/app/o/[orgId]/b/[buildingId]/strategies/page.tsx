"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BuildingBrief } from "@/components/building-brief";
import { FindingsTabs } from "@/components/findings-tabs";
import { type ComparedPriority, StrategyCompare } from "@/components/strategy-compare";
import { PageHeader } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useIds } from "@/lib/session";

export default function StrategiesPage() {
  const { t } = useI18n();
  const { orgId, buildingId } = useIds();
  const router = useRouter();
  // a priority of the AI overview on show in the comparison, instead of one of the options
  const [priority, setPriority] = useState<ComparedPriority | null>(null);
  return (
    <>
      <PageHeader title={t.strategies.title} subtitle={t.strategies.subtitle} />
      <FindingsTabs active="strategies" />
      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start xl:gap-6">
        {/* the assistant's overall advice comes first on a phone, beside the comparison on a wide screen */}
        <div className="mb-5 xl:sticky xl:top-20 xl:order-2 xl:mb-0 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto">
          <BuildingBrief
            compared={priority}
            onCompare={setPriority}
            onShow={(floorId, ruleId) =>
              router.push(`/o/${orgId}/b/${buildingId}/findings?${new URLSearchParams({ floorId, ruleId })}`)
            }
          />
        </div>
        <div className="min-w-0 xl:order-1">
          <StrategyCompare priority={priority} onPick={() => setPriority(null)} />
        </div>
      </div>
    </>
  );
}
