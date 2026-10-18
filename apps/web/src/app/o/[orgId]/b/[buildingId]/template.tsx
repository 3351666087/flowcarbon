import type { ReactNode } from "react";

/** Re-mounted on every navigation inside a building, so each page settles in as it arrives. */
export default function BuildingTemplate({ children }: { children: ReactNode }) {
  return <div className="fc-route">{children}</div>;
}
