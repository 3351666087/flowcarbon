"use client";

import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  BarChart3,
  Building2,
  CalendarClock,
  ChevronDown,
  Cpu,
  FileText,
  Languages,
  Layers,
  LogOut,
  Settings,
  Sparkles,
  SunMoon,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { PAGES, useBuilding, useBuildings, useIds, useMe, useMembership } from "@/lib/session";
import { Backdrop, useLens } from "./glass";
import { useLiquid } from "./liquid";
import { MarkTile } from "./mark";
import { TabBar } from "./tab-bar";
import { ErrorBox, Loading } from "./ui";

const NAV = [
  { key: "floors", icon: Layers },
  { key: "findings", icon: Sparkles },
  { key: "forecast", icon: TrendingUp },
  { key: "simulate", icon: BarChart3 },
  { key: "requests", icon: CalendarClock },
  { key: "report", icon: FileText },
  { key: "data", icon: Cpu },
  { key: "settings", icon: Settings },
] as const;

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("flowcarbon.theme");
      if (saved === "light" || saved === "dark") {
        setTheme(saved);
        document.documentElement.dataset.theme = saved;
      }
    } catch {
      // storage unavailable: follow the system
    }
  }, []);
  const toggle = () => {
    const current = theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("flowcarbon.theme", next);
    } catch {
      // ignore
    }
  };
  return { theme, toggle };
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const me = useMe();
  const { orgId, buildingId } = useIds();
  const membership = useMembership();
  const buildings = useBuildings(orgId);
  const { building } = useBuilding();
  const { toggle } = useTheme();
  const side = useLens<HTMLDivElement>({ bezel: 26, depth: 16 });
  const place = useLens<HTMLDivElement>({ bezel: 14, depth: 10 });
  const tools = useLens<HTMLDivElement>({ bezel: 14, depth: 10 });
  const [sideList, setSideList] = useState<HTMLDivElement | null>(null);
  const [sideMark, setSideMark] = useState<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (me.error && (me.error as { status?: number }).status === 401)
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.error, router, pathname]);

  // the language the user reads is the language AI explanations are written in
  const storedLocale = me.data?.user.locale;
  useEffect(() => {
    if (storedLocale && storedLocale !== locale)
      api.PATCH("/api/v1/me", { body: { locale } }).then(({ data }) => data && qc.setQueryData(["me"], data));
  }, [storedLocale, locale, qc]);

  const role = membership?.role;
  const items = role ? NAV.filter((n) => PAGES[n.key]?.includes(role)) : [];
  const base = `/o/${orgId}/b/${buildingId}`;
  const current = items.find(({ key }) => pathname.startsWith(`${base}/${key}`))?.key ?? null;
  useLiquid("y", current, sideList, sideMark);

  if (me.isPending || buildings.isPending)
    return (
      <>
        <Backdrop />
        <Loading full />
      </>
    );
  if (me.error || !membership)
    return (
      <div className="mx-auto grid min-h-dvh max-w-lg place-items-center p-6">
        <Backdrop />
        <ErrorBox
          error={me.error ?? new Error("You are not a member of this organisation.")}
          onRetry={me.error ? () => me.refetch() : undefined}
        />
      </div>
    );

  async function signOut() {
    await api.POST("/api/v1/auth/logout");
    qc.clear();
    router.replace("/login");
  }

  const roleName = t.settings.roles[membership.role];
  const sideButton =
    "fc-press flex w-full items-center gap-3 rounded-full px-3 py-2 text-muted hover:bg-[var(--glass-field)] hover:text-text";

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[288px_minmax(0,1fr)]">
      <Backdrop />
      <aside className="hidden lg:sticky lg:top-0 lg:block lg:h-dvh lg:p-3 lg:pr-0">
        <div
          ref={side.ref}
          style={side.style}
          className="fc-glass flex h-full flex-col gap-7 rounded-[30px] p-3"
        >
          {side.defs}
          <div className="flex items-center gap-3 px-2 pt-2">
            <MarkTile className="size-9" motion="settle" />
            <div className="min-w-0 leading-tight">
              <div className="text-[15px] font-semibold tracking-tight">{t.appName}</div>
              <div className="truncate text-xs text-muted">{membership.orgName}</div>
            </div>
          </div>
          <nav aria-label="Main">
            <div ref={setSideList} className="relative flex flex-col gap-0.5">
              <span
                ref={setSideMark}
                className="fc-liquid bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_22%,transparent)]"
              />
              {items.map(({ key, icon: Icon }) => (
                <Link
                  key={key}
                  href={`${base}/${key}`}
                  data-liquid-key={key}
                  className={clsx(
                    "fc-press relative flex items-center gap-3 rounded-full px-3.5 py-2.5 text-sm font-medium",
                    current === key ? "text-accent" : "text-muted hover:text-text",
                  )}
                  aria-current={current === key ? "page" : undefined}
                >
                  <Icon
                    className="size-[18px] shrink-0"
                    strokeWidth={current === key ? 2.3 : 2}
                    aria-hidden
                  />
                  {t.nav[key]}
                </Link>
              ))}
            </div>
          </nav>
          <div className="mt-auto space-y-0.5 border-t border-[var(--glass-hairline)] pt-3 text-sm">
            <div className="truncate px-3 pb-1 text-xs text-muted">
              {me.data?.user.name} · {roleName}
            </div>
            <button
              type="button"
              onClick={() => setLocale(locale === "en" ? "zh" : "en")}
              className={sideButton}
            >
              <Languages className="size-4" aria-hidden /> {t.common.language}
            </button>
            <button type="button" onClick={toggle} className={sideButton}>
              <SunMoon className="size-4" aria-hidden /> {t.common.theme}
            </button>
            <button type="button" onClick={signOut} className={sideButton}>
              <LogOut className="size-4" aria-hidden /> {t.common.signOut}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="fc-scroll-edge sticky top-0 z-20 flex items-center gap-2 px-3 pt-3 pb-2 sm:px-6 lg:pt-4">
          <MarkTile className="size-9 lg:hidden" />
          <div
            ref={place.ref}
            style={place.style}
            className="fc-glass flex h-10 min-w-0 items-center gap-2 rounded-full pr-3 pl-3.5 text-sm"
          >
            {place.defs}
            <Building2 className="size-4 shrink-0 text-muted" aria-hidden />
            {buildings.data && buildings.data.length > 1 ? (
              <span className="relative flex min-w-0 items-center">
                <select
                  aria-label={t.common.building}
                  className="min-w-0 appearance-none truncate bg-transparent pr-5 font-medium outline-none"
                  value={buildingId}
                  onChange={(e) => router.push(pathname.replace(`/b/${buildingId}`, `/b/${e.target.value}`))}
                >
                  {buildings.data.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-0 size-3.5 text-muted"
                  aria-hidden
                />
              </span>
            ) : (
              <span className="truncate font-medium">{building?.name}</span>
            )}
            <span
              title={t.simulated}
              className="ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-waste-soft px-2 py-0.5 text-[11px] font-medium text-waste"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-waste" aria-hidden />
              <span className="hidden min-[400px]:inline">{t.simulated}</span>
            </span>
          </div>
          <div
            ref={tools.ref}
            style={tools.style}
            className="fc-glass ml-auto flex h-10 shrink-0 items-center rounded-full px-0.5 lg:hidden"
          >
            {tools.defs}
            <button
              type="button"
              aria-label={t.common.language}
              title={t.common.language}
              onClick={() => setLocale(locale === "en" ? "zh" : "en")}
              className="fc-press grid size-9 place-items-center rounded-full text-muted"
            >
              <Languages className="size-[18px]" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t.common.theme}
              title={t.common.theme}
              onClick={toggle}
              className="fc-press grid size-9 place-items-center rounded-full text-muted"
            >
              <SunMoon className="size-[18px]" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t.common.signOut}
              title={t.common.signOut}
              onClick={signOut}
              className="fc-press grid size-9 place-items-center rounded-full text-muted"
            >
              <LogOut className="size-[18px]" aria-hidden />
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-4 pb-32 sm:px-6 lg:pt-6 lg:pb-10">
          {building ? children : <Loading />}
        </main>
        <TabBar
          tabs={items.map(({ key, icon }) => ({ key, icon, href: `${base}/${key}`, label: t.navShort[key] }))}
          active={current}
          moreLabel={t.common.more}
        />
      </div>
    </div>
  );
}
