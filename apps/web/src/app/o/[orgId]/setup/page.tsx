"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AccountMenu } from "@/components/account-sheet";
import { AuthStage, FieldGroup, GroupField, groupInput, StepHeader } from "@/components/auth-stage";
import { Mark } from "@/components/mark";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useBuildings, useMe } from "@/lib/session";

/** Cities offered for a first building, with the regional grid whose emission factor applies there. */
const CITIES = [
  { key: "shanghai", en: "Shanghai", zh: "上海", grid: "CN-East" },
  { key: "suzhou", en: "Suzhou", zh: "苏州", grid: "CN-East" },
  { key: "hangzhou", en: "Hangzhou", zh: "杭州", grid: "CN-East" },
  { key: "beijing", en: "Beijing", zh: "北京", grid: "CN-North" },
  { key: "shenzhen", en: "Shenzhen", zh: "深圳", grid: "CN-South" },
  { key: "guangzhou", en: "Guangzhou", zh: "广州", grid: "CN-South" },
  { key: "wuhan", en: "Wuhan", zh: "武汉", grid: "CN-Central" },
  { key: "chengdu", en: "Chengdu", zh: "成都", grid: "CN-Central" },
  { key: "xian", en: "Xi'an", zh: "西安", grid: "CN-Northwest" },
  { key: "shenyang", en: "Shenyang", zh: "沈阳", grid: "CN-Northeast" },
] as const;

/**
 * A new organisation's first building: a name, a city, how many floors and how big a typical one is. Everything
 * else starts from defaults (a flat tariff of CNY 0.85/kWh, office hours 08:00–18:00) and can be changed later in
 * the building's settings; the floors get rated loads scaled from their area.
 */
export default function SetupPage() {
  const { t, locale } = useI18n();
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const membership = me.data?.memberships.find((m) => m.orgId === orgId);
  const [name, setName] = useState("");
  const [city, setCity] = useState<(typeof CITIES)[number]["key"]>("suzhou");
  const [floors, setFloors] = useState(12);
  const [area, setArea] = useState(1500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const canBuild = membership && ["owner", "admin"].includes(membership.role);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = CITIES.find((x) => x.key === city)!;
      const b = await unwrap(
        api.POST("/api/v1/orgs/{orgId}/buildings", {
          params: { path: { orgId } },
          body: {
            name,
            timezone: "Asia/Shanghai",
            currency: "CNY",
            gridRegion: c.grid,
            tariff: { kind: "flat", rate: 0.85 },
          },
        }),
      );
      const levels = Array.from({ length: floors }, (_, i) => i + 1);
      for (let i = 0; i < levels.length; i += 6)
        await Promise.all(
          levels.slice(i, i + 6).map((level) =>
            unwrap(
              api.POST("/api/v1/orgs/{orgId}/buildings/{buildingId}/floors", {
                params: { path: { orgId, buildingId: b.id } },
                body: {
                  label: `F${level}`,
                  level,
                  areaM2: area,
                  // typical rated loads for a Chinese office floor: ~70 W/m² cooling, ~9 W/m² lighting
                  ratedHvacKw: Math.round(area * 0.07),
                  ratedLightingKw: Math.round(area * 0.009 * 10) / 10,
                },
              }),
            ),
          ),
        );
      await qc.invalidateQueries({ queryKey: ["buildings", orgId] });
      router.replace(`/o/${orgId}/b/${b.id}/floors`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.problems.length
          ? `${err.message} ${err.problems.join(" ")}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setRefusals((n) => n + 1);
      setBusy(false);
    }
  }

  // a demo building of one's own is built in the background: wait for it instead of asking for one
  if (membership?.orgSlug.startsWith("demo-")) return <DemoPreparing orgId={orgId} />;

  if (me.data && !canBuild)
    return (
      <AuthStage>
        <StepHeader
          title={t.setup.title}
          subtitle={t.setup.noAccess.replace("{org}", membership?.orgName ?? "")}
        />
        <AccountMenu variant="row" />
      </AuthStage>
    );

  return (
    <AuthStage shake={refusals}>
      <form onSubmit={create}>
        <StepHeader title={t.setup.title} subtitle={t.setup.sub} />
        <FieldGroup>
          <GroupField label={t.setup.name}>
            <input
              required
              // biome-ignore lint/a11y/noAutofocus: the first field of a one-form screen
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={groupInput}
            />
          </GroupField>
          <GroupField label={t.setup.city}>
            <select
              value={city}
              onChange={(e) => setCity(e.target.value as typeof city)}
              className={`${groupInput} appearance-none`}
            >
              {CITIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {locale === "zh" ? c.zh : c.en}
                </option>
              ))}
            </select>
          </GroupField>
          <div className="grid grid-cols-2 divide-x divide-[var(--glass-hairline)]">
            <GroupField label={t.setup.floors}>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={80}
                required
                value={floors}
                onChange={(e) => setFloors(Math.max(1, Math.min(80, Number(e.target.value) || 1)))}
                className={`${groupInput} num`}
              />
            </GroupField>
            <GroupField label={t.setup.area}>
              <input
                type="number"
                inputMode="numeric"
                min={50}
                max={100000}
                step={50}
                required
                value={area}
                onChange={(e) => setArea(Math.max(50, Number(e.target.value) || 50))}
                className={`${groupInput} num`}
              />
            </GroupField>
          </div>
        </FieldGroup>
        {error ? (
          <p role="alert" className="fc-rise mt-3 px-1 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !me.data}
          className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
        >
          {busy ? <Mark motion="breathe" className="size-5" /> : null}
          {t.setup.submit}
          {busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
        </button>
      </form>
    </AuthStage>
  );
}

/** While the worker builds a person's demo tower: what is happening, then straight into it. */
function DemoPreparing({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const buildings = useBuildings(orgId);
  const [slow, setSlow] = useState(false);
  useQuery({
    queryKey: ["buildings", orgId, "wait"],
    queryFn: async () => {
      const list = await unwrap(api.GET("/api/v1/orgs/{orgId}/buildings", { params: { path: { orgId } } }));
      if (list.length) buildings.refetch();
      return list.length;
    },
    refetchInterval: (q) => (q.state.data ? false : 1500),
  });
  const ready = buildings.data?.[0];
  useEffect(() => {
    if (ready) router.replace(`/o/${orgId}/b/${ready.id}/floors`);
  }, [ready, orgId, router]);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 45_000);
    return () => clearTimeout(id);
  }, []);
  return (
    <AuthStage>
      <div className="flex flex-col items-center py-6 text-center">
        <Mark motion="breathe" className="size-14" />
        <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-tight">{t.demo.preparing}</h1>
        <p className="mt-2 max-w-xs text-sm text-muted">{t.demo.preparingSub}</p>
        <div className="fc-skel mt-6 h-1.5 w-48 rounded-full" />
        {slow ? (
          <div className="mt-6 space-y-2">
            <p className="text-sm text-muted">{t.demo.slow}</p>
            <button
              type="button"
              className="text-sm font-medium text-accent"
              onClick={async () => {
                setSlow(false);
                await api.POST("/api/v1/orgs/demo");
              }}
            >
              {t.demo.retry}
            </button>
          </div>
        ) : null}
      </div>
    </AuthStage>
  );
}
