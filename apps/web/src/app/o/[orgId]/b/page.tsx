import { redirect } from "next/navigation";

/** The bare /b address of an organisation opens its first building, the way the start page picks it, instead of a 404. */
export default async function OrgBuildings({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(`/?org=${encodeURIComponent(orgId)}`);
}
