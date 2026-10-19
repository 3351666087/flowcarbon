/** The release this server runs. A page compares it with the release it was loaded from (see Updates). */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0" },
    { headers: { "cache-control": "no-store" } },
  );
}
