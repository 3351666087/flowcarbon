"use client";

import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  BarChart3,
  Building2,
  CalendarClock,
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

  if (me.isPending || buildings.isPending)
    return (
      <div className="p-6">
        <Loading />
      </div>
    );
  if (me.error)
    return (
      <div className="p-6">
        <ErrorBox error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  if (!membership)
    return (
      <div className="p-6">
        <ErrorBox error={new Error("You are not a member of this organisation.")} />
      </div>
    );

  const role = membership.role;
  const items = NAV.filter((n) => PAGES[n.key]?.includes(role));
  const base = `/o/${orgId}/b/${buildingId}`;
  const active = (key: string) => pathname.startsWith(`${base}/${key}`);

  async function signOut() {
    await api.POST("/api/v1/auth/logout");
    qc.clear();
    router.replace("/login");
  }

  const sidebar = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map(({ key, icon: Icon }) => (
        <Link
          key={key}
          href={`${base}/${key}`}
          className={clsx(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
            active(key) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
          aria-current={active(key) ? "page" : undefined}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {t.nav[key]}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="hidden border-r border-border bg-surface lg:flex lg:min-h-dvh lg:flex-col lg:gap-6 lg:p-4">
        <div className="px-2">
          <div className="flex items-center gap-2 text-base font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-on-accent">
              <Layers className="size-4" aria-hidden />
            </span>
            {t.appName}
          </div>
          <div className="mt-1 text-xs text-muted">{membership.orgName}</div>
        </div>
        {sidebar}
        <div className="mt-auto space-y-1 border-t border-border pt-4 text-sm">
          <div className="px-3 text-xs text-muted">
            {me.data?.user.name} · {t.settings.roles[role]}
          </div>
          <button
            type="button"
            onClick={() => setLocale(locale === "en" ? "zh" : "en")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-muted hover:bg-surface-2"
          >
            <Languages className="size-4" aria-hidden /> {t.common.language}
          </button>
          <button
            type="button"
            onClick={toggle}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-muted hover:bg-surface-2"
          >
            <SunMoon className="size-4" aria-hidden /> {t.common.theme}
          </button>
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-muted hover:bg-surface-2"
          >
            <LogOut className="size-4" aria-hidden /> {t.common.signOut}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur">
          <span className="font-semibold lg:hidden">{t.appName}</span>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Building2 className="hidden size-4 shrink-0 text-muted sm:block" aria-hidden />
            {buildings.data && buildings.data.length > 1 ? (
              <select
                aria-label={t.common.building}
                className="min-w-0 truncate rounded-md border border-border bg-surface px-2 py-1"
                value={buildingId}
                onChange={(e) => router.push(pathname.replace(`/b/${buildingId}`, `/b/${e.target.value}`))}
              >
                {buildings.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="truncate font-medium">{building?.name}</span>
            )}
          </div>
          <span className="ml-auto rounded-full bg-waste-soft px-2 py-0.5 text-xs font-medium text-waste">
            {t.simulated}
          </span>
          <button
            type="button"
            aria-label={t.common.language}
            onClick={() => setLocale(locale === "en" ? "zh" : "en")}
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 lg:hidden"
          >
            <Languages className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.common.signOut}
            onClick={signOut}
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 lg:hidden"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-24 sm:px-6 lg:pb-10">
          {building ? children : <Loading />}
        </main>
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-10 flex overflow-x-auto border-t border-border bg-surface lg:hidden"
        >
          {items.map(({ key, icon: Icon }) => (
            <Link
              key={key}
              href={`${base}/${key}`}
              className={clsx(
                "flex min-w-[72px] flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px]",
                active(key) ? "text-accent" : "text-muted",
              )}
            >
              <Icon className="size-5" aria-hidden />
              <span className="max-w-full truncate">{t.navShort[key]}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
