import { redirect } from "next/navigation";

/** A building's bare address (a trimmed or hand-typed link) opens its first page, Floors, instead of a 404. */
export default async function BuildingHome({
  params,
}: {
  params: Promise<{ orgId: string; buildingId: string }>;
}) {
  const { orgId, buildingId } = await params;
  redirect(`/o/${encodeURIComponent(orgId)}/b/${encodeURIComponent(buildingId)}/floors`);
}
