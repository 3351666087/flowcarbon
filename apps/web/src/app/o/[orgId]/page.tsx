import { redirect } from "next/navigation";

/** An organisation's bare address opens its first building, the way the start page picks it, instead of a 404. */
export default async function OrgHome({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(`/?org=${encodeURIComponent(orgId)}`);
}
