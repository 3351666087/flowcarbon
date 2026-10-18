"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Backdrop } from "@/components/glass";
import { ErrorBox, Loading } from "@/components/ui";
import { ApiError } from "@/lib/api";
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
  if (me.data && memberships.length === 0)
    return (
      <div className="p-6">
        <ErrorBox error={new Error("Your account is not a member of any organisation yet.")} />
      </div>
    );
  return (
    <>
      <Backdrop />
      <Loading full />
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
