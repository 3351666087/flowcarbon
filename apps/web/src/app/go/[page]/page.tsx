import { redirect } from "next/navigation";

/** Stable links into the app that do not know the organisation or building, e.g. Android launcher shortcuts. */
export default async function Go({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  redirect(`/?page=${encodeURIComponent(page)}`);
}
