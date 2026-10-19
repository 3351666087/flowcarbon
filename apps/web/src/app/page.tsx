"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { useOwnDemo } from "@/components/demo-banner";
import { Backdrop } from "@/components/glass";
import { Button, ErrorBox, Loading } from "@/components/ui";
import { ApiError, api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { PAGES, useBuildings, useMe } from "@/lib/session";

const LAST_ORG = "flowcarbon.org";

/**
 * Where a signed-in person lands: the organisation they used last (or `?org=`), its first building, and the page
 * they asked for (`?page=`, e.g. from an app shortcut) when their role has it. An organisation without buildings
 * goes to setting one up.
 */
function Home() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const memberships = me.data?.memberships ?? [];
  let remembered: string | null = null;
  try {
    remembered = typeof window === "undefined" ? null : localStorage.getItem(LAST_ORG);
  } catch {
    // storage unavailable
  }
  const wanted = params.get("org") ?? remembered;
  const membership = memberships.find((m) => m.orgId === wanted) ?? memberships[0];
  const buildings = useBuildings(membership?.orgId);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      const page = params.get("page");
      router.replace(page ? `/login?next=${encodeURIComponent(`/?page=${page}`)}` : "/login");
      return;
    }
    if (!membership || !buildings.data) return;
    try {
      localStorage.setItem(LAST_ORG, membership.orgId);
    } catch {
      // ignore
    }
    const b = buildings.data[0];
    if (!b) {
      router.replace(`/o/${membership.orgId}/setup`);
      return;
    }
    const asked = params.get("page");
    const page =
      asked && PAGES[asked]?.includes(membership.role)
        ? asked
        : membership.role === "tenant_admin"
          ? "requests"
          : "floors";
    router.replace(`/o/${membership.orgId}/b/${b.id}/${page}`);
  }, [me.error, membership, buildings.data, router, params]);

  if (me.error && !(me.error instanceof ApiError && me.error.status === 401))
    return (
      <div className="p-6">
        <ErrorBox error={me.error} />
      </div>
    );
  if (me.data && memberships.length === 0) return <NoOrganisation />;
  return (
    <>
      <Backdrop />
      <Loading full />
    </>
  );
}

/**
 * For an account in no organisation (new, or after leaving or deleting the last one): make one for a real building,
 * or open a demo building of one's own.
 */
function NoOrganisation() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const demo = useOwnDemo();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await unwrap(api.POST("/api/v1/orgs", { body: { name } }));
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.push(`/?org=${org.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    const res = await unwrap(api.POST("/api/v1/auth/logout", { body: { everyone: false } }));
    qc.clear();
    router.replace(res.next ? "/" : "/login");
  };
  return (
    <>
      <Backdrop />
      <main className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.account.noOrgTitle}</h1>
          <p className="mt-2 text-[15px] text-muted">{t.account.noOrgBody}</p>
        </div>
        <form onSubmit={create} className="flex gap-2">
          <input
            required
            minLength={2}
            maxLength={120}
            aria-label={t.account.orgName}
            placeholder={t.account.orgName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="fc-field h-11 min-w-0 flex-1 rounded-xl px-3 text-[15px] outline-none focus-visible:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="fc-prominent fc-press h-11 shrink-0 rounded-full px-5 text-[15px] font-semibold disabled:opacity-50"
          >
            {t.account.create}
          </button>
        </form>
        <Button
          variant="secondary"
          className="justify-center"
          busy={demo.busy}
          onClick={() => demo.start().catch(setError)}
        >
          <Sparkles className="size-4" aria-hidden /> {t.account.joinDemo}
        </Button>
        {error ? <ErrorBox error={error} /> : null}
        <button type="button" onClick={() => signOut().catch(setError)} className="text-sm text-muted">
          {t.account.signOut}
        </button>
      </main>
    </>
  );
}

export default function HomePage() {
  return (
    <Suspense>
      <Home />
    </Suspense>
  );
}
