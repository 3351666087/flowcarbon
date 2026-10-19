"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { AccountMenu } from "@/components/account-sheet";
import { AuthStage, FieldGroup, GroupField, groupInput, StepHeader } from "@/components/auth-stage";
import { useOwnDemo } from "@/components/demo-banner";
import { Backdrop } from "@/components/glass";
import { Mark } from "@/components/mark";
import { ErrorBox, Loading } from "@/components/ui";
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
 * or open a demo building of one's own. The account menu stays at hand to switch accounts or sign out.
 */
function NoOrganisation() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const demo = useOwnDemo();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const fail = (err: unknown) => {
    setError(
      err instanceof ApiError && err.problems.length
        ? `${err.message} ${err.problems.join(" ")}`
        : err instanceof Error
          ? err.message
          : String(err),
    );
    setRefusals((n) => n + 1);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await unwrap(api.POST("/api/v1/orgs", { body: { name } }));
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.replace(`/o/${org.id}/setup`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };
  return (
    <AuthStage shake={refusals} account={<AccountMenu variant="avatar" />}>
      <form onSubmit={create}>
        <StepHeader title={t.account.noOrgTitle} subtitle={t.account.noOrgBody} />
        <FieldGroup>
          <GroupField label={t.account.orgName}>
            <input
              required
              minLength={2}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={groupInput}
            />
          </GroupField>
        </FieldGroup>
        {error ? (
          <p role="alert" className="fc-rise mt-3 px-1 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="fc-prominent fc-press mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-80"
        >
          {busy ? <Mark motion="breathe" className="size-5" /> : null}
          {t.account.newOrg}
          {busy ? null : <ArrowRight className="size-[18px]" aria-hidden />}
        </button>
      </form>
      <div className="mt-3">
        <FieldGroup>
          <button
            type="button"
            disabled={demo.busy}
            onClick={() => demo.start().catch(fail)}
            className="fc-press flex w-full items-center gap-3 px-3.5 py-3 text-left disabled:opacity-60"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--glass-field)] text-accent shadow-[inset_0_0_0_1px_var(--glass-hairline)]">
              {demo.busy ? (
                <Mark motion="breathe" className="size-5" />
              ) : (
                <Sparkles className="size-5" aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium">{t.account.joinDemo}</span>
              <span className="block text-xs text-muted">{t.account.joinDemoNote}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
        </FieldGroup>
      </div>
    </AuthStage>
  );
}

export default function HomePage() {
  return (
    <Suspense>
      <Home />
    </Suspense>
  );
}
