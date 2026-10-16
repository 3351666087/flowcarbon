"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ErrorBox, Loading } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useBuildings, useMe } from "@/lib/session";

/** Sends the user to the first building of their first organisation, or to sign-in. */
export default function Home() {
  const router = useRouter();
  const me = useMe();
  const orgId = me.data?.memberships[0]?.orgId;
  const role = me.data?.memberships[0]?.role;
  const buildings = useBuildings(orgId);
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace("/login");
    const b = buildings.data?.[0];
    if (orgId && b)
      router.replace(`/o/${orgId}/b/${b.id}/${role === "tenant_admin" ? "requests" : "floors"}`);
  }, [me.error, orgId, role, buildings.data, router]);
  if (me.error && !(me.error instanceof ApiError && me.error.status === 401))
    return (
      <div className="p-6">
        <ErrorBox error={me.error} />
      </div>
    );
  if (me.data && me.data.memberships.length === 0)
    return (
      <div className="p-6">
        <ErrorBox error={new Error("Your account is not a member of any organisation yet.")} />
      </div>
    );
  return (
    <div className="p-6">
      <Loading />
    </div>
  );
}
